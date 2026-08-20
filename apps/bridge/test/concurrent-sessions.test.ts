import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createBridgeApp } from "../src/bridge-app.js";
import { silentLogger } from "../src/logger.js";
import { ProcessSessionManager } from "../src/process-session-manager.js";
import { createWorkerHandler } from "../../worker/src/worker-app.js";

const BEARER_TOKEN = "mastra-bearer-token";

type JsonRpcLine = {
  id?: string | number;
  method?: string;
  params?: any;
};

/**
 * Stands in for `gem exec skylight-mcp`: a stdio JSON-RPC server whose tool
 * calls depend on previously selected state, so any cross-talk between
 * concurrent sessions or interleaving within one session shows up as an error.
 */
class FakeSkylightProcess extends EventEmitter {
  readonly stdout = new (class extends EventEmitter {
    setEncoding() {
      return this;
    }
  })();

  readonly stderr = new (class extends EventEmitter {
    setEncoding() {
      return this;
    }
  })();

  readonly stdin: { write: (chunk: string) => boolean };

  readonly pid = Math.floor(Math.random() * 10_000);

  concurrentInFlight = 0;
  maxConcurrentInFlight = 0;
  killed = false;

  private selectedApp: string | null = null;

  constructor(private readonly latencyMs = 1) {
    super();

    this.stdin = {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) {
            this.handle(JSON.parse(line) as JsonRpcLine);
          }
        }

        return true;
      }
    };
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  private handle(message: JsonRpcLine): void {
    if (message.id === undefined) {
      return;
    }

    this.concurrentInFlight += 1;
    this.maxConcurrentInFlight = Math.max(
      this.maxConcurrentInFlight,
      this.concurrentInFlight
    );

    const respond = (payload: Record<string, unknown>) => {
      setTimeout(() => {
        this.concurrentInFlight -= 1;
        this.stdout.emit(
          "data",
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload })}\n`
        );
      }, this.latencyMs);
    };

    switch (message.method) {
      case "initialize":
        respond({
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "skylight-mcp", version: "0.1.0" }
          }
        });
        return;
      case "tools/list":
        respond({
          result: {
            tools: [{ name: "select_application" }, { name: "read_endpoint" }]
          }
        });
        return;
      case "tools/call": {
        const toolName = message.params?.name;

        if (toolName === "select_application") {
          this.selectedApp = message.params?.arguments?.app ?? null;
          respond({ result: { selected: this.selectedApp } });
          return;
        }

        if (this.selectedApp === null) {
          respond({
            error: { code: -32_001, message: "No application selected." }
          });
          return;
        }

        respond({ result: { app: this.selectedApp, endpoint: "UsersController#index" } });
        return;
      }
      default:
        respond({ result: {} });
    }
  }
}

type TestHarness = {
  children: FakeSkylightProcess[];
  manager: ProcessSessionManager;
  request: (input: {
    method?: string;
    body?: unknown;
    sessionId?: string;
  }) => Promise<Response>;
};

function createHarness(): TestHarness {
  const children: FakeSkylightProcess[] = [];
  const manager = new ProcessSessionManager({
    idleTimeoutMs: 300_000,
    logger: silentLogger,
    requestTimeoutMs: 120_000,
    skylightToken: "skylight-secret",
    spawn: () => {
      const child = new FakeSkylightProcess();
      children.push(child);
      return child as any;
    }
  });
  const app = createBridgeApp({ sessionManager: manager });
  const handleWorkerRequest = createWorkerHandler();
  const env = {
    MCP_SHARED_BEARER_TOKEN: BEARER_TOKEN,
    SKYLIGHT_BRIDGE: { fetch: (request: Request) => app.handleRequest(request) }
  };

  return {
    children,
    manager,
    request: ({ method = "POST", body, sessionId }) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${BEARER_TOKEN}`
      };

      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }

      if (sessionId) {
        headers["mcp-session-id"] = sessionId;
      }

      return handleWorkerRequest(
        new Request("https://mastra-skylight-mcp.workers.dev/mcp", {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        }),
        env
      );
    }
  };
}

async function runClientSession(
  harness: TestHarness,
  clientIndex: number
): Promise<{ getStatuses: number[]; readResult: any; sessionId: string }> {
  const initialize = await harness.request({
    body: {
      jsonrpc: "2.0",
      id: `${clientIndex}-init`,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: `mastra-client-${clientIndex}`, version: "1.0" }
      }
    }
  });

  expect(initialize.status).toBe(200);

  const sessionId = initialize.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const initialized = await harness.request({
    sessionId: sessionId!,
    body: { jsonrpc: "2.0", method: "notifications/initialized" }
  });
  expect(initialized.status).toBe(202);

  // An MCP client opens its SSE listener exactly once and stops on 405.
  const getStatuses: number[] = [];
  let listening = true;

  while (listening && getStatuses.length < 5) {
    const response = await harness.request({ method: "GET", sessionId: sessionId! });
    getStatuses.push(response.status);
    listening = response.status !== 405;
  }

  const toolsList = await harness.request({
    sessionId: sessionId!,
    body: { jsonrpc: "2.0", id: `${clientIndex}-tools`, method: "tools/list" }
  });
  expect(toolsList.status).toBe(200);

  const select = await harness.request({
    sessionId: sessionId!,
    body: {
      jsonrpc: "2.0",
      id: `${clientIndex}-select`,
      method: "tools/call",
      params: {
        name: "select_application",
        arguments: { app: `app-${clientIndex}` }
      }
    }
  });
  expect(select.status).toBe(200);

  const read = await harness.request({
    sessionId: sessionId!,
    body: {
      jsonrpc: "2.0",
      id: `${clientIndex}-read`,
      method: "tools/call",
      params: { name: "read_endpoint", arguments: {} }
    }
  });
  expect(read.status).toBe(200);

  return {
    getStatuses,
    readResult: ((await read.json()) as any).result,
    sessionId: sessionId!
  };
}

describe("four concurrent Mastra sessions", () => {
  it("initializes four clients at once without cross-talk or repeating GETs", async () => {
    const harness = createHarness();

    const results = await Promise.all(
      [0, 1, 2, 3].map((clientIndex) => runClientSession(harness, clientIndex))
    );

    // Every client gets its own Ruby child and its own selected application.
    expect(harness.children).toHaveLength(4);
    expect(harness.manager.activeSessionCount).toBe(4);
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(4);

    results.forEach((result, clientIndex) => {
      expect(result.readResult).toEqual({
        app: `app-${clientIndex}`,
        endpoint: "UsersController#index"
      });
      // Exactly one GET, answered 405, no reconnect loop.
      expect(result.getStatuses).toEqual([405]);
    });

    // Serialization means a child never sees two in-flight requests at once.
    for (const child of harness.children) {
      expect(child.maxConcurrentInFlight).toBe(1);
    }
  });

  it("stays consistent across ten rounds and returns to baseline after DELETE", async () => {
    const harness = createHarness();

    for (let round = 0; round < 10; round += 1) {
      const results = await Promise.all(
        [0, 1, 2, 3].map((clientIndex) => runClientSession(harness, clientIndex))
      );

      expect(harness.manager.activeSessionCount).toBe(4);

      const terminations = await Promise.all(
        results.map((result) =>
          harness.request({ method: "DELETE", sessionId: result.sessionId })
        )
      );

      for (const termination of terminations) {
        expect(termination.status).toBe(204);
      }

      // Active Ruby process count is back to baseline before the next round.
      expect(harness.manager.activeSessionCount).toBe(0);
    }

    expect(harness.children).toHaveLength(40);
    expect(harness.children.every((child) => child.killed)).toBe(true);
  });

  it("keeps sessions independent when one of them fails", async () => {
    const harness = createHarness();

    const [healthy, doomed] = await Promise.all([
      runClientSession(harness, 0),
      runClientSession(harness, 1)
    ]);

    // Kill only the second client's Ruby process.
    const doomedChild = harness.children[1]!;
    doomedChild.kill();

    const survivorRead = await harness.request({
      sessionId: healthy.sessionId,
      body: {
        jsonrpc: "2.0",
        id: "survivor-read",
        method: "tools/call",
        params: { name: "read_endpoint", arguments: {} }
      }
    });

    expect(survivorRead.status).toBe(200);
    expect(((await survivorRead.json()) as any).result).toEqual({
      app: "app-0",
      endpoint: "UsersController#index"
    });

    // The dead session is gone rather than lingering as a broken entry.
    expect(harness.manager.hasSession(doomed.sessionId)).toBe(false);
  });
});
