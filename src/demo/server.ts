import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Cacheline } from "../cache.js";

const JSON_PLACEHOLDER_POSTS = "https://jsonplaceholder.typicode.com/posts";
const DEFAULT_TTL_MS = 15_000;
const DEFAULT_PORT = 3000;

export class DemoHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DemoHttpError";
    this.statusCode = statusCode;
  }
}

export type DemoServerOptions = {
  /** Cache used for post loads. Defaults to an in-memory cache. */
  cache?: Cacheline;
  /** Defaults to JSONPlaceholder `GET /posts/:id` (no API key). */
  loadPost?: (id: number) => Promise<unknown>;
  /** TTL when `cache` is omitted. Default 15 seconds. */
  ttlMs?: number;
};

/**
 * Local demo: `GET /posts/:id` loads through Cacheline, `GET /metrics`
 * returns hit / miss / coalesce counts.
 */
export function createDemoServer(options: DemoServerOptions = {}): Server {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = options.cache ?? new Cacheline({ defaultTtlMs: ttlMs });
  const loadPost = options.loadPost ?? loadJsonPlaceholderPost;

  return createServer((req, res) => {
    void handleRequest(req, res, cache, loadPost).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = err instanceof Error ? err.message : "internal error";
      sendJson(res, 500, { error: message });
    });
  });
}

async function loadJsonPlaceholderPost(id: number): Promise<unknown> {
  const response = await fetch(`${JSON_PLACEHOLDER_POSTS}/${id}`);
  if (response.status === 404) {
    throw new DemoHttpError(404, `post ${id} not found`);
  }
  if (!response.ok) {
    throw new DemoHttpError(502, `JSONPlaceholder responded ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cache: Cacheline,
  loadPost: (id: number) => Promise<unknown>,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

  if (pathname === "/") {
    sendJson(res, 200, {
      service: "cacheline-demo",
      routes: {
        post: "/posts/:id",
        metrics: "/metrics",
      },
    });
    return;
  }

  if (pathname === "/metrics") {
    sendJson(res, 200, cache.metrics());
    return;
  }

  const postMatch = /^\/posts\/(\d+)$/.exec(pathname);
  if (!postMatch) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const id = Number(postMatch[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    sendJson(res, 400, { error: "post id must be a positive integer" });
    return;
  }

  try {
    const post = await cache.getOrSet(`post:${id}`, () => loadPost(id));
    sendJson(res, 200, post);
  } catch (err) {
    if (err instanceof DemoHttpError) {
      sendJson(res, err.statusCode, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "load failed";
    sendJson(res, 502, { error: message });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function resolvePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got ${raw}`);
  }
  return port;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const port = resolvePort(process.env.PORT ?? String(DEFAULT_PORT));
  const server = createDemoServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Cacheline demo listening on http://127.0.0.1:${port}`);
    console.log("  GET /posts/1");
    console.log("  GET /metrics");
  });
}
