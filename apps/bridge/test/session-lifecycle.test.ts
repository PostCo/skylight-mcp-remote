import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBridgeApp } from "../src/bridge-app.js";
import { silentLogger } from "../src/logger.js";
import {
  BridgeAbortedError,
  BridgeTimeoutError,
  ProcessSessionManager
} from "../src/process-session-manager.js";

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

type FakeChild = EventEmitter & {
  stdout: FakeReadable;
  stderr: FakeReadable;
  stdin: FakeWritable;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

let nextPid = 1000;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;

  child.stdout = new FakeReadable();
  child.stderr = new FakeReadable();
  child.stdin = new FakeWritable();
  child.pid = (nextPid += 1);
  child.kill = vi.fn(() => {
    child.emit("exit", null, "SIGTERM");
    return true;
  });

  return child;
}

function respond(child: FakeChild, id: number | string, result: unknown): void {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function lastRequestIds(child: FakeChild): Array<string | number> {
  return child.stdin.writes
    .map((line) => JSON.parse(line) as { id?: string | number })
    .map((message) => message.id)
    .filter((id): id is string | number => id !== undefined);
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("session lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates a session through DELETE /mcp and returns 204", async () => {
    const children: FakeChild[] = [];
    const manager = new ProcessSessionManager({
      logger: silentLogger,
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      }
    });
    const app = createBridgeApp({ sessionManager: manager });

    const pending = manager.sendRequest("session-abc", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    });
    await flush();
    respond(children[0]!, 1, { tools: [] });
    await pending;

    expect(manager.activeSessionCount).toBe(1);

    const response = await app.handleRequest(
      new Request("http://bridge.local/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "session-abc" }
      })
    );

    expect(response.status).toBe(204);
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(manager.activeSessionCount).toBe(0);
    expect(manager.hasSession("session-abc")).toBe(false);
  });

  it("rejects DELETE /mcp without a session header", async () => {
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
      new Request("http://bridge.local/mcp", { method: "DELETE" })
    );

    expect(response.status).toBe(400);
  });

  it("treats DELETE for an unknown session as a no-op success", async () => {
    const destroySession = vi.fn(async () => {});
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => false),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(),
        destroySession,
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.local/mcp", {
        method: "DELETE",
        headers: { "mcp-session-id": "session-gone" }
      })
    );

    expect(response.status).toBe(204);
    expect(destroySession).toHaveBeenCalledWith("session-gone", "client_delete");
  });

  it("expires an idle session and frees its Ruby process", async () => {
    const children: FakeChild[] = [];
    const manager = new ProcessSessionManager({
      idleTimeoutMs: 300_000,
      logger: silentLogger,
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      }
    });

    const pending = manager.sendRequest("session-idle", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    });
    await flush();
    respond(children[0]!, 1, { tools: [] });
    await pending;

    expect(manager.activeSessionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(299_000);
    expect(manager.activeSessionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(manager.activeSessionCount).toBe(0);
    expect(children[0]!.kill).toHaveBeenCalled();
  });

  it("resets the child on timeout and serves the next request from a clean session", async () => {
    const children: FakeChild[] = [];
    const manager = new ProcessSessionManager({
      logger: silentLogger,
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      }
    });
    const app = createBridgeApp({ sessionManager: manager });

    const slowRequest = app.handleRequest(
      new Request("http://bridge.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-slow"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {}
        })
      })
    );

    await flush();
    // The bridge bootstraps the unknown session first; answer that handshake.
    respond(children[0]!, lastRequestIds(children[0]!)[0]!, {
      protocolVersion: "2025-11-25"
    });
    await flush();

    await vi.advanceTimersByTimeAsync(120_001);
    const response = await slowRequest;

    expect(response.status).toBe(504);
    // The stalled Ruby operation is cancelled and the child torn down.
    expect(children[0]!.stdin.writes.at(-1)).toContain("notifications/cancelled");
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(manager.activeSessionCount).toBe(0);

    const recovered = manager.sendRequest("session-slow", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list"
    });
    await flush();

    expect(children).toHaveLength(2);
    respond(children[1]!, 8, { tools: [] });
    await expect(recovered).resolves.toMatchObject({ id: 8 });
  });

  it("returns 502 for a genuine child-process failure", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => true),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(async () => {
          throw new Error("skylight-mcp exited.");
        }),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-dead"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      })
    );

    expect(response.status).toBe(502);
  });

  it("returns 504 only for bridge timeouts", async () => {
    const app = createBridgeApp({
      sessionManager: {
        hasSession: vi.fn(() => true),
        sendNotification: vi.fn(),
        sendRequest: vi.fn(async () => {
          throw new BridgeTimeoutError("session-slow", "Timed out.");
        }),
        destroySession: vi.fn(),
        destroyAll: vi.fn()
      }
    });

    const response = await app.handleRequest(
      new Request("http://bridge.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-slow"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      })
    );

    expect(response.status).toBe(504);
  });

  it("tears down the session when the caller aborts the HTTP connection", async () => {
    const children: FakeChild[] = [];
    const manager = new ProcessSessionManager({
      logger: silentLogger,
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      }
    });
    const controller = new AbortController();

    const pending = manager.sendRequest(
      "session-abort",
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      { signal: controller.signal }
    );
    await flush();

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(BridgeAbortedError);
    expect(children[0]!.stdin.writes.at(-1)).toContain("notifications/cancelled");
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(manager.activeSessionCount).toBe(0);
  });

  it("serialises calls inside one session but keeps sessions concurrent", async () => {
    const children = new Map<string, FakeChild>();
    let spawnCount = 0;
    const manager = new ProcessSessionManager({
      logger: silentLogger,
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.set(`child-${(spawnCount += 1)}`, child);
        return child;
      }
    });

    const first = manager.sendRequest("session-a", {
      jsonrpc: "2.0",
      id: 1,
      method: "select_app"
    });
    const second = manager.sendRequest("session-a", {
      jsonrpc: "2.0",
      id: 2,
      method: "read_endpoint"
    });
    const other = manager.sendRequest("session-b", {
      jsonrpc: "2.0",
      id: 3,
      method: "select_app"
    });

    await flush();

    const childA = children.get("child-1")!;
    const childB = children.get("child-2")!;

    // Stateful app selection must not interleave: only request 1 is in flight.
    expect(lastRequestIds(childA)).toEqual([1]);
    // A different session runs at the same time on its own child process.
    expect(lastRequestIds(childB)).toEqual([3]);

    respond(childA, 1, { ok: true });
    await first;
    await flush();

    expect(lastRequestIds(childA)).toEqual([1, 2]);

    respond(childA, 2, { ok: true });
    respond(childB, 3, { ok: true });

    await expect(second).resolves.toMatchObject({ id: 2 });
    await expect(other).resolves.toMatchObject({ id: 3 });
    expect(manager.activeSessionCount).toBe(2);
  });

  it("drains child stderr without logging request payloads", async () => {
    const lines: string[] = [];
    const children: FakeChild[] = [];
    const manager = new ProcessSessionManager({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
        error: () => {}
      },
      requestTimeoutMs: 120_000,
      skylightToken: "skylight-secret",
      spawn: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      }
    });

    const pending = manager.sendRequest("session-noisy", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { secretArgument: "do-not-log-me" }
    });
    await flush();

    children[0]!.stderr.emit("data", "W, [warn] deprecated option\n");
    respond(children[0]!, 1, { tools: [] });
    await pending;

    const stderrLines = lines.filter((line) => line.includes("mcp.child.stderr"));

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("deprecated option");
    expect(lines.join("\n")).not.toContain("do-not-log-me");
    expect(lines.join("\n")).not.toContain("skylight-secret");
  });
});
