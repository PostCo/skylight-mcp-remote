import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createBridgeApp } from "../src/bridge-app.js";
import { ProcessSessionManager } from "../src/process-session-manager.js";

class FakeReadable extends EventEmitter {
  setEncoding() {
    return this;
  }
}

class FakeWritable {
  writes: string[] = [];

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

describe("createBridgeApp", () => {
  it("returns a readiness payload from /healthz", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/healthz")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true
    });
  });

  it("creates a session during initialize and echoes the session header", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(async (sessionId, message) => {
          expect(sessionId).toMatch(/^session-/);
          expect(message).toEqual({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26"
            }
          });

          return {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: {
                name: "skylight-mcp",
                version: "0.1.0"
              }
            }
          };
        }),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26"
          }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toMatch(/^session-/);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: {
          name: "skylight-mcp",
          version: "0.1.0"
        }
      }
    });
  });

  it("normalizes initialize responses to the client-requested protocol version", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(async () => {
          return {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: {
                name: "skylight-mcp",
                version: "0.1.0"
              }
            }
          };
        }),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25"
          }
        })
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: {
          name: "skylight-mcp",
          version: "0.1.0"
        }
      }
    });
  });

  it("bootstraps an ephemeral session for non-initialize requests without an MCP session header", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        jsonrpc: "2.0",
        id: "bootstrap-1",
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: {
            name: "skylight-mcp",
            version: "0.1.0"
          }
        }
      })
      .mockResolvedValueOnce({
        jsonrpc: "2.0",
        id: 9,
        result: {
          tools: []
        }
      });
    const destroySession = vi.fn();
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest,
        destroySession,
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/list",
          params: {}
        })
      })
    );

    expect(response.status).toBe(200);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest.mock.calls[0]?.[0]).toMatch(/^session-/);
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25"
      }
    });
    expect(sendRequest.mock.calls[1]?.[0]).toBe(sendRequest.mock.calls[0]?.[0]);
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "tools/list"
    });
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: {
        tools: []
      }
    });
    expect(destroySession).toHaveBeenCalledWith(sendRequest.mock.calls[0]?.[0]);
  });

  it("answers HEAD requests on /mcp", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "HEAD"
      })
    );

    expect(response.status).toBe(200);
  });

  it("converts upstream bridge failures into a 502 response", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => true),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(async () => {
          throw new Error("skylight-mcp exited");
        }),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-123"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {}
        })
      })
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("skylight-mcp exited");
  });

  it("returns 400 for malformed JSON requests", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{jsonrpc:2.0}"
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid JSON");
  });

  it("accepts notifications/initialized without requiring an id", async () => {
    const sendNotification = vi.fn(async () => {});
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => true),
        sendNotification,
        sendRequest: vi.fn(),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-123"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      })
    );

    expect(response.status).toBe(202);
    expect(sendNotification).toHaveBeenCalledWith("session-123", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
  });

  it("bootstraps unknown provided session ids before forwarding notifications", async () => {
    const sendRequest = vi.fn(async () => {
      return {
        jsonrpc: "2.0",
        id: "bootstrap-1",
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: {
            name: "skylight-mcp",
            version: "0.1.0"
          }
        }
      };
    });
    const sendNotification = vi.fn(async () => {});
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification,
        sendRequest,
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-unknown",
          "mcp-protocol-version": "2025-11-25"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      })
    );

    expect(response.status).toBe(202);
    expect(sendRequest).toHaveBeenCalledWith(
      "session-unknown",
      expect.objectContaining({
        method: "initialize"
      })
    );
    expect(sendNotification).toHaveBeenCalledWith("session-unknown", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
  });
});

describe("ProcessSessionManager", () => {
  it("spawns skylight-mcp once per session and forwards correlated JSON-RPC responses", async () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();
    const app = new EventEmitter() as EventEmitter & {
      stdout: FakeReadable;
      stderr: FakeReadable;
      stdin: FakeWritable;
      kill: ReturnType<typeof vi.fn>;
    };
    app.stdout = stdout;
    app.stderr = stderr;
    app.stdin = stdin;
    app.kill = vi.fn();

    const spawn = vi.fn(() => app);
    const manager = new ProcessSessionManager({
      skylightToken: "skylight-secret",
      spawn,
      requestTimeoutMs: 1_000
    });

    const pending = manager.sendRequest("session-abc", {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/list",
      params: {}
    });

    expect(spawn).toHaveBeenCalledWith("gem", [
      "exec",
      "skylight-mcp",
      "--token",
      "skylight-secret"
    ]);
    expect(stdin.writes).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/list",
        params: {}
      }) + "\n"
    ]);

    stdout.emit(
      "data",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        result: {
          tools: [
            {
              name: "profiles"
            }
          ]
        }
      }) + "\n"
    );

    await expect(pending).resolves.toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {
        tools: [
          {
            name: "profiles"
          }
        ]
      }
    });

    await manager.destroyAll();
  });

  it("fails cleanly when the Skylight token is missing", async () => {
    const manager = new ProcessSessionManager({
      skylightToken: "",
      spawn: vi.fn(),
      requestTimeoutMs: 1_000
    });

    await expect(
      manager.sendRequest("session-abc", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      })
    ).rejects.toThrow("SKYLIGHT_MCP_TOKEN");
  });
});
