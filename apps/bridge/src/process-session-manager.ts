import { silentLogger, type Logger } from "./logger.js";

type JsonRpcId = string | number | null;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  jsonrpc: "2.0";
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type WritableLike = {
  write: (chunk: string) => boolean;
};

type ReadableLike = {
  on: (event: string, listener: (...args: any[]) => void) => void;
  setEncoding?: (encoding: BufferEncoding) => unknown;
};

type ChildProcessLike = {
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr?: ReadableLike;
  kill?: (signal?: any) => unknown;
  pid?: number;
  on: (event: string, listener: (...args: any[]) => void) => void;
};

type PendingRequest = {
  reject: (error: unknown) => void;
  resolve: (message: JsonRpcMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SessionRecord = {
  buffer: string;
  child: ChildProcessLike;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  pending: Map<JsonRpcId, PendingRequest>;
  stderrBuffer: string;
  terminating: boolean;
};

export type SpawnProcess = (
  command: string,
  args: string[]
) => ChildProcessLike;

export type ProcessSessionManagerOptions = {
  idleTimeoutMs?: number;
  logger?: Logger;
  requestTimeoutMs: number;
  skylightToken: string;
  spawn: SpawnProcess;
};

export type SendOptions = {
  signal?: AbortSignal;
};

/** Raised when the Ruby child does not answer within the request timeout. */
export class BridgeTimeoutError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string) {
    super(message);
    this.name = "BridgeTimeoutError";
    this.sessionId = sessionId;
  }
}

/** Raised when the caller's HTTP connection went away before the child replied. */
export class BridgeAbortedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, message: string) {
    super(message);
    this.name = "BridgeAbortedError";
    this.sessionId = sessionId;
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDERR_LINE_LENGTH = 512;

export class ProcessSessionManager {
  private readonly idleTimeoutMs: number;
  private readonly logger: Logger;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly requestTimeoutMs: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly skylightToken: string;
  private readonly spawn: SpawnProcess;

  constructor(options: ProcessSessionManagerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.skylightToken = options.skylightToken;
    this.spawn = options.spawn;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async destroyAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.destroySession(sessionId, "shutdown");
    }
  }

  async destroySession(
    sessionId: string,
    reason: string = "client_delete"
  ): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    session.terminating = true;
    this.clearIdleTimer(session);
    this.sessions.delete(sessionId);

    for (const [requestId, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Session ${sessionId} was destroyed.`));
      this.logger.debug("mcp.request.cancelled", {
        sessionId,
        requestId: String(requestId),
        reason
      });
    }

    session.pending.clear();
    this.terminateChild(session);

    this.logger.info("mcp.session.destroyed", {
      sessionId,
      reason,
      pid: session.child.pid,
      lifetimeMs: Date.now() - session.createdAt,
      activeSessions: this.sessions.size
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Application and component selection is stateful inside skylight-mcp, so
   * every call for one session runs to completion before the next one starts.
   * Separate sessions stay fully concurrent because each owns its own queue.
   */
  async sendRequest(
    sessionId: string,
    message: JsonRpcMessage,
    options: SendOptions = {}
  ): Promise<JsonRpcMessage> {
    return this.runSerialized(sessionId, () =>
      this.dispatchRequest(sessionId, message, options)
    );
  }

  async sendNotification(
    sessionId: string,
    message: JsonRpcMessage,
    options: SendOptions = {}
  ): Promise<void> {
    return this.runSerialized(sessionId, async () => {
      this.assertToken();

      if (message.id !== undefined) {
        throw new Error("JSON-RPC notification must not include an id.");
      }

      const session = this.getOrCreateSession(sessionId);
      this.touch(session);
      session.child.stdin.write(`${JSON.stringify(message)}\n`);

      this.logger.debug("mcp.notification.sent", {
        sessionId,
        method: message.method
      });
    });
  }

  private async dispatchRequest(
    sessionId: string,
    message: JsonRpcMessage,
    options: SendOptions
  ): Promise<JsonRpcMessage> {
    this.assertToken();

    const requestId = message.id;

    if (requestId === undefined) {
      throw new Error("JSON-RPC request id is required.");
    }

    const session = this.getOrCreateSession(sessionId);
    this.touch(session);

    const startedAt = Date.now();
    const method = message.method;

    try {
      const response = await this.awaitResponse(
        sessionId,
        session,
        message,
        requestId,
        options
      );

      this.logger.info("mcp.request.completed", {
        sessionId,
        method,
        durationMs: Date.now() - startedAt,
        ok: response.error === undefined
      });

      return response;
    } catch (error) {
      this.logger.warn("mcp.request.failed", {
        sessionId,
        method,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "Error"
      });

      throw error;
    } finally {
      const liveSession = this.sessions.get(sessionId);

      if (liveSession) {
        this.touch(liveSession);
      }
    }
  }

  private awaitResponse(
    sessionId: string,
    session: SessionRecord,
    message: JsonRpcMessage,
    requestId: JsonRpcId,
    options: SendOptions
  ): Promise<JsonRpcMessage> {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      let settled = false;

      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        settle();
      };

      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        this.logger.warn("mcp.request.timeout", {
          sessionId,
          method: message.method,
          timeoutMs: this.requestTimeoutMs
        });

        // A timed-out Ruby operation keeps running against Skylight unless the
        // child is torn down, so cancel it and reset the whole session.
        this.abandonRequest(sessionId, requestId, "timeout");
        finish(() =>
          reject(
            new BridgeTimeoutError(
              sessionId,
              `Timed out after ${this.requestTimeoutMs}ms waiting for ${
                message.method ?? "request"
              }.`
            )
          )
        );
      }, this.requestTimeoutMs);

      const onAbort = () => {
        session.pending.delete(requestId);
        this.logger.warn("mcp.request.aborted", {
          sessionId,
          method: message.method
        });

        clearTimeout(timer);
        this.abandonRequest(sessionId, requestId, "client_abort");
        finish(() =>
          reject(
            new BridgeAbortedError(
              sessionId,
              `Client aborted ${message.method ?? "request"}.`
            )
          )
        );
      };

      if (options.signal?.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }

      options.signal?.addEventListener("abort", onAbort, { once: true });

      session.pending.set(requestId, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        timer
      });

      session.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  /**
   * Best-effort MCP cancellation followed by a hard session reset. The child is
   * single-threaded over stdio, so a request we stopped waiting for would
   * otherwise desynchronise every later response on the same pipe.
   */
  private abandonRequest(
    sessionId: string,
    requestId: JsonRpcId,
    reason: string
  ): void {
    const session = this.sessions.get(sessionId);

    if (!session || session.terminating) {
      return;
    }

    try {
      session.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId,
            reason
          }
        })}\n`
      );
    } catch (error) {
      this.logger.debug("mcp.cancel.write_failed", {
        sessionId,
        errorName: error instanceof Error ? error.name : "Error"
      });
    }

    void this.destroySession(sessionId, reason);
  }

  private runSerialized<T>(
    sessionId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const chain = result.then(
      () => undefined,
      () => undefined
    );

    this.queues.set(sessionId, chain);

    void chain.then(() => {
      if (this.queues.get(sessionId) === chain) {
        this.queues.delete(sessionId);
      }
    });

    return result;
  }

  private assertToken(): void {
    if (!this.skylightToken) {
      throw new Error("SKYLIGHT_MCP_TOKEN is required.");
    }
  }

  private getOrCreateSession(sessionId: string): SessionRecord {
    const existingSession = this.sessions.get(sessionId);

    if (existingSession) {
      return existingSession;
    }

    const child = this.spawn("gem", [
      "exec",
      "skylight-mcp",
      "--token",
      this.skylightToken
    ]);
    const session: SessionRecord = {
      buffer: "",
      child,
      createdAt: Date.now(),
      pending: new Map(),
      stderrBuffer: "",
      terminating: false
    };

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(sessionId, session, String(chunk));
    });

    // The child blocks on a full stderr pipe if nobody reads it, which shows up
    // as a hung session under load. Drain it and surface it as structured logs.
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.handleStderr(sessionId, session, String(chunk));
    });

    child.on("error", (error: unknown) => {
      this.logger.error("mcp.child.error", {
        sessionId,
        errorName: error instanceof Error ? error.name : "Error"
      });
      this.failSession(sessionId, error, "child_error");
    });
    child.on("exit", (code: number | null, signal: string | null) => {
      this.logger.warn("mcp.child.exit", {
        sessionId,
        pid: child.pid,
        exitCode: code,
        signal,
        expected: session.terminating
      });
      this.failSession(sessionId, new Error("skylight-mcp exited."), "child_exit");
    });

    this.sessions.set(sessionId, session);
    this.touch(session);

    this.logger.info("mcp.session.created", {
      sessionId,
      pid: child.pid,
      idleTimeoutMs: this.idleTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      activeSessions: this.sessions.size
    });

    return session;
  }

  private touch(session: SessionRecord): void {
    this.clearIdleTimer(session);

    const sessionId = this.findSessionId(session);

    if (sessionId === undefined) {
      return;
    }

    session.idleTimer = setTimeout(() => {
      void this.destroySession(sessionId, "idle_expired");
    }, this.idleTimeoutMs);

    session.idleTimer.unref?.();
  }

  private findSessionId(session: SessionRecord): string | undefined {
    for (const [sessionId, candidate] of this.sessions) {
      if (candidate === session) {
        return sessionId;
      }
    }

    return undefined;
  }

  private clearIdleTimer(session: SessionRecord): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
  }

  private terminateChild(session: SessionRecord): void {
    try {
      session.child.kill?.();
    } catch (error) {
      this.logger.warn("mcp.child.kill_failed", {
        errorName: error instanceof Error ? error.name : "Error"
      });
    }
  }

  private failSession(
    sessionId: string,
    error: unknown,
    reason: string
  ): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    session.terminating = true;
    this.clearIdleTimer(session);
    this.sessions.delete(sessionId);

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    session.pending.clear();

    this.logger.info("mcp.session.destroyed", {
      sessionId,
      reason,
      pid: session.child.pid,
      lifetimeMs: Date.now() - session.createdAt,
      activeSessions: this.sessions.size
    });
  }

  private handleStderr(
    sessionId: string,
    session: SessionRecord,
    chunk: string
  ): void {
    session.stderrBuffer += chunk;
    const lines = session.stderrBuffer.split("\n");
    session.stderrBuffer = lines.pop() ?? "";

    if (session.stderrBuffer.length > MAX_STDERR_LINE_LENGTH) {
      session.stderrBuffer = session.stderrBuffer.slice(
        0,
        MAX_STDERR_LINE_LENGTH
      );
    }

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      this.logger.warn("mcp.child.stderr", {
        sessionId,
        message: trimmed.slice(0, MAX_STDERR_LINE_LENGTH)
      });
    }
  }

  private handleStdout(
    sessionId: string,
    session: SessionRecord,
    chunk: string
  ): void {
    session.buffer += chunk;
    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      let message: JsonRpcMessage;

      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch (error) {
        this.logger.error("mcp.child.invalid_json", { sessionId });
        this.failSession(
          sessionId,
          new Error(
            `Received invalid JSON from skylight-mcp: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
          "invalid_json"
        );
        return;
      }

      if (message.id === undefined) {
        continue;
      }

      const pending = session.pending.get(message.id);

      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      session.pending.delete(message.id);
      pending.resolve(message);
    }
  }
}
