import { randomUUID } from "node:crypto";

import {
  BridgeAbortedError,
  BridgeTimeoutError,
  type JsonRpcMessage,
  type SendOptions
} from "./process-session-manager.js";

export type BridgeSessionManager = {
  destroyAll: () => Promise<void>;
  destroySession: (sessionId: string, reason?: string) => Promise<void>;
  hasSession: (sessionId: string) => boolean;
  sendNotification: (
    sessionId: string,
    message: JsonRpcMessage,
    options?: SendOptions
  ) => Promise<void>;
  sendRequest: (
    sessionId: string,
    message: JsonRpcMessage,
    options?: SendOptions
  ) => Promise<JsonRpcMessage>;
};

export type BridgeAppOptions = {
  sessionManager: BridgeSessionManager;
};

export function createBridgeApp(options: BridgeAppOptions) {
  return {
    async handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      if (request.method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      // Explicit session termination: drop the Ruby child immediately instead
      // of waiting for the idle sweep.
      if (request.method === "DELETE") {
        const sessionId = request.headers.get("mcp-session-id");

        if (!sessionId) {
          return new Response("Missing MCP-Session-Id header.", {
            status: 400
          });
        }

        await options.sessionManager.destroySession(sessionId, "client_delete");

        return new Response(null, { status: 204 });
      }

      // Defense in depth: the Worker already answers GET with 405, but the
      // bridge must never open an SSE stream it cannot feed from a stdio child.
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "POST, DELETE, HEAD" }
        });
      }

      let message: JsonRpcMessage;

      try {
        message = (await request.json()) as JsonRpcMessage;
      } catch (error) {
        return new Response(
          `Invalid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { status: 400 }
        );
      }

      const existingSessionId = request.headers.get("mcp-session-id");
      const isInitialize = message.method === "initialize";
      const isNotification = message.id === undefined;
      const isEphemeralRequest = !existingSessionId && !isInitialize;
      const sessionId =
        existingSessionId ??
        `session-${randomUUID()}`;

      const sendOptions: SendOptions = { signal: request.signal };

      try {
        const needsBootstrap =
          !isInitialize && !options.sessionManager.hasSession(sessionId);

        if (isEphemeralRequest || needsBootstrap) {
          await bootstrapEphemeralSession(
            request,
            sessionId,
            options,
            message,
            sendOptions
          );
        }

        if (isNotification) {
          await options.sessionManager.sendNotification(
            sessionId,
            message,
            sendOptions
          );

          return new Response(null, {
            status: 202
          });
        }

        const responseMessage = normalizeInitializeResponse(
          message,
          await options.sessionManager.sendRequest(
            sessionId,
            message,
            sendOptions
          )
        );
        const headers = new Headers({
          "content-type": "application/json"
        });

        if (!isEphemeralRequest || isInitialize) {
          headers.set("mcp-session-id", sessionId);
        }

        return new Response(JSON.stringify(responseMessage), {
          status: 200,
          headers
        });
      } catch (error) {
        return toErrorResponse(error);
      } finally {
        if (isEphemeralRequest) {
          await options.sessionManager.destroySession(
            sessionId,
            "ephemeral_complete"
          );
        }
      }
    }
  };
}

/**
 * Maps failures onto statuses the caller can act on: 504 means the Ruby child
 * was too slow and its session has already been reset, 502 means the child
 * itself failed, and 499 means the caller hung up first.
 */
function toErrorResponse(error: unknown): Response {
  if (error instanceof BridgeTimeoutError) {
    return new Response(error.message, { status: 504 });
  }

  if (error instanceof BridgeAbortedError) {
    return new Response(error.message, { status: 499 });
  }

  return new Response(
    error instanceof Error ? error.message : "Upstream bridge failure.",
    { status: 502 }
  );
}

async function bootstrapEphemeralSession(
  request: Request,
  sessionId: string,
  options: BridgeAppOptions,
  message: JsonRpcMessage,
  sendOptions: SendOptions
): Promise<void> {
  await options.sessionManager.sendRequest(
    sessionId,
    {
      jsonrpc: "2.0",
      id: `bootstrap-${randomUUID()}`,
      method: "initialize",
      params: {
        protocolVersion: getBootstrapProtocolVersion(request, message),
        capabilities: {},
        clientInfo: {
          name: "skylight-mcp-remote-bridge",
          version: "0.1.0"
        }
      }
    },
    sendOptions
  );
}

function getBootstrapProtocolVersion(
  request: Request,
  message: JsonRpcMessage
): string {
  const headerProtocolVersion = request.headers.get("mcp-protocol-version");

  if (headerProtocolVersion) {
    return headerProtocolVersion;
  }

  const requestedProtocolVersion = getRequestedProtocolVersion(message);
  return requestedProtocolVersion ?? "2025-11-25";
}

function normalizeInitializeResponse(
  requestMessage: JsonRpcMessage,
  responseMessage: JsonRpcMessage
): JsonRpcMessage {
  if (requestMessage.method !== "initialize") {
    return responseMessage;
  }

  const requestedProtocolVersion = getRequestedProtocolVersion(requestMessage);
  const result = responseMessage.result;

  if (!requestedProtocolVersion || !isObject(result)) {
    return responseMessage;
  }

  return {
    ...responseMessage,
    result: {
      ...result,
      protocolVersion: requestedProtocolVersion
    }
  };
}

function getRequestedProtocolVersion(
  requestMessage: JsonRpcMessage
): string | null {
  if (!isObject(requestMessage.params)) {
    return null;
  }

  const protocolVersion = requestMessage.params.protocolVersion;
  return typeof protocolVersion === "string" ? protocolVersion : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
