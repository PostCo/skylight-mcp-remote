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
  kill?: () => void;
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
  pending: Map<JsonRpcId, PendingRequest>;
};

export type SpawnProcess = (
  command: string,
  args: string[]
) => ChildProcessLike;

export type ProcessSessionManagerOptions = {
  requestTimeoutMs: number;
  skylightToken: string;
  spawn: SpawnProcess;
};

export class ProcessSessionManager {
  private readonly requestTimeoutMs: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly skylightToken: string;
  private readonly spawn: SpawnProcess;

  constructor(options: ProcessSessionManagerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.skylightToken = options.skylightToken;
    this.spawn = options.spawn;
  }

  async destroyAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.destroySession(sessionId);
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Session ${sessionId} was destroyed.`));
    }

    session.pending.clear();
    session.child.kill?.();
    this.sessions.delete(sessionId);
  }

  async sendRequest(
    sessionId: string,
    message: JsonRpcMessage
  ): Promise<JsonRpcMessage> {
    if (!this.skylightToken) {
      throw new Error("SKYLIGHT_MCP_TOKEN is required.");
    }

    const session = this.getOrCreateSession(sessionId);
    const requestId = message.id;

    if (requestId === undefined) {
      throw new Error("JSON-RPC request id is required.");
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(
          new Error(
            `Timed out waiting for response to request ${String(requestId)}.`
          )
        );
      }, this.requestTimeoutMs);

      session.pending.set(requestId, {
        resolve,
        reject,
        timer
      });

      session.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
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
      pending: new Map()
    };

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(sessionId, session, String(chunk));
    });
    child.stderr?.setEncoding?.("utf8");
    child.on("error", (error: unknown) => {
      this.failSession(sessionId, error);
    });
    child.on("exit", () => {
      this.failSession(sessionId, new Error("skylight-mcp exited."));
    });

    this.sessions.set(sessionId, session);

    return session;
  }

  private failSession(sessionId: string, error: unknown): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    session.pending.clear();
    this.sessions.delete(sessionId);
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
        this.failSession(
          sessionId,
          new Error(
            `Received invalid JSON from skylight-mcp: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
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
