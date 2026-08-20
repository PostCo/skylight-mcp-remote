import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { createBridgeApp } from "./bridge-app.js";
import { createLogger } from "./logger.js";
import {
  ProcessSessionManager,
  type SpawnProcess
} from "./process-session-manager.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
// Skylight queries over large apps regularly run past a minute, so the default
// budget is generous; the session is reset on expiry rather than left running.
const requestTimeoutMs = Number.parseInt(
  process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? "120000",
  10
);
const idleTimeoutMs = Number.parseInt(
  process.env.SESSION_IDLE_TIMEOUT_MS ?? "300000",
  10
);
const logger = createLogger(process.env.LOG_LEVEL ?? "info");
const sessionManager = new ProcessSessionManager({
  idleTimeoutMs,
  logger,
  requestTimeoutMs,
  skylightToken: process.env.SKYLIGHT_MCP_TOKEN ?? "",
  spawn: ((command: string, args: string[]) =>
    spawnChild(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    })) satisfies SpawnProcess
});
const app = createBridgeApp({ sessionManager });
const server = createServer(async (req, res) => {
  try {
    const request = toRequest(req);
    const response = await app.handleRequest(request);
    await writeResponse(res, response);
  } catch (error) {
    logger.error("bridge.request.unhandled", {
      errorName: error instanceof Error ? error.name : "Error"
    });
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(error instanceof Error ? error.message : "Internal Server Error");
  }
});

server.listen(port, () => {
  logger.info("bridge.listening", {
    port,
    requestTimeoutMs,
    idleTimeoutMs
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info("bridge.shutdown", {
      signal,
      activeSessions: sessionManager.activeSessionCount
    });
    await sessionManager.destroyAll();
    server.close(() => {
      process.exit(0);
    });
  });
}

function toRequest(req: IncomingMessage): Request {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`
  );
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (Readable.toWeb(req) as ReadableStream);

  return new Request(url, {
    body,
    headers: new Headers(toHeaderEntries(req.headers)),
    method: req.method,
    ...(body ? ({ duplex: "half" } as const) : {})
  } as RequestInit);
}

function toHeaderEntries(
  headers: IncomingMessage["headers"]
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    entries.push([key, Array.isArray(value) ? value.join(", ") : value]);
  }

  return entries;
}

async function writeResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  res.statusCode = response.status;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as any);

    stream.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolve);
    stream.pipe(res);
  });
}
