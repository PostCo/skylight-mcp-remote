export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

/**
 * Emits one JSON object per line so Cloudflare's log pipeline can index fields.
 *
 * Callers are responsible for passing only non-sensitive fields: bearer tokens,
 * Skylight tokens, JSON-RPC params and tool results must never be logged.
 */
export function createLogger(
  level: string = "info",
  sink: (line: string) => void = (line) => console.log(line)
): Logger {
  const threshold = LEVEL_WEIGHTS[normalizeLevel(level)];

  const emit = (logLevel: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVEL_WEIGHTS[logLevel] < threshold) {
      return;
    }

    sink(
      JSON.stringify({
        level: logLevel,
        event,
        ...fields
      })
    );
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields)
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

function normalizeLevel(level: string): LogLevel {
  return level in LEVEL_WEIGHTS ? (level as LogLevel) : "info";
}
