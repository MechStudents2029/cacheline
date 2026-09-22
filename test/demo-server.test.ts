import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoServer, DemoHttpError } from "../src/demo/server.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("demo server", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
                reject(err);
                return;
              }
              resolve();
            });
          }),
      ),
    );
  });

  it("caches JSONPlaceholder-shaped loads and exposes hit/miss/coalesce metrics", async () => {
    const load = deferred<{ id: number; title: string }>();
    const loadPost = vi.fn(() => load.promise);
    const server = createDemoServer({ ttlMs: 60_000, loadPost });
    servers.push(server);
    const base = await listen(server);

    const first = fetch(`${base}/posts/1`);
    await vi.waitFor(() => {
      expect(loadPost).toHaveBeenCalledTimes(1);
    });
    const second = fetch(`${base}/posts/1`);
    await vi.waitFor(async () => {
      const metrics = await fetch(`${base}/metrics`).then((res) => res.json());
      expect(metrics).toEqual({ hits: 0, misses: 1, coalesced: 1 });
    });

    load.resolve({ id: 1, title: "hello" });
    const [firstBody, secondBody] = await Promise.all([
      first.then(async (res) => {
        expect(res.status).toBe(200);
        return res.json();
      }),
      second.then(async (res) => {
        expect(res.status).toBe(200);
        return res.json();
      }),
    ]);
    expect(firstBody).toEqual({ id: 1, title: "hello" });
    expect(secondBody).toEqual({ id: 1, title: "hello" });

    const hit = await fetch(`${base}/posts/1`);
    expect(hit.status).toBe(200);
    await expect(hit.json()).resolves.toEqual({ id: 1, title: "hello" });
    expect(loadPost).toHaveBeenCalledTimes(1);

    const metrics = await fetch(`${base}/metrics`).then((res) => res.json());
    expect(metrics).toEqual({ hits: 1, misses: 1, coalesced: 1 });
  });

  it("maps loader failures to HTTP status and does not cache them", async () => {
    const loadPost = vi
      .fn()
      .mockRejectedValueOnce(new DemoHttpError(404, "post 9 not found"))
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce({ id: 9, title: "recovered" });
    const server = createDemoServer({ ttlMs: 60_000, loadPost });
    servers.push(server);
    const base = await listen(server);

    const missing = await fetch(`${base}/posts/9`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "post 9 not found" });

    const failed = await fetch(`${base}/posts/9`);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "upstream down" });

    const recovered = await fetch(`${base}/posts/9`);
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ id: 9, title: "recovered" });
    expect(loadPost).toHaveBeenCalledTimes(3);
  });

  it("serves a route index and rejects unknown paths and methods", async () => {
    const server = createDemoServer({
      ttlMs: 60_000,
      loadPost: async () => ({ id: 1 }),
    });
    servers.push(server);
    const base = await listen(server);

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    await expect(index.json()).resolves.toEqual({
      service: "cacheline-demo",
      routes: { post: "/posts/:id", metrics: "/metrics" },
    });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);

    const badId = await fetch(`${base}/posts/0`);
    expect(badId.status).toBe(400);

    const posted = await fetch(`${base}/posts/1`, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });
});
