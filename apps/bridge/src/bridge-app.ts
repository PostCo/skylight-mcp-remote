import { randomUUID } from "node:crypto";

import type { JsonRpcMessage } from "./process-session-manager.js";

export type BridgeSessionManager = {
  destroyAll: () => Promise<void>;
  destroySession: (sessionId: string) => Promise<void>;
  hasSession: (sessionId: string) => boolean;
  sendNotification: (
    sessionId: string,
    message: JsonRpcMessage
  ) => Promise<void>;
  sendRequest: (
    sessionId: string,
    message: JsonRpcMessage
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

      if (request.method === "GET") {
        return new Response(": skylight-mcp bridge ready\n\n", {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/event-stream"
          }
        });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
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

      try {
        const needsBootstrap =
          !isInitialize && !options.sessionManager.hasSession(sessionId);

        if (isEphemeralRequest || needsBootstrap) {
          await bootstrapEphemeralSession(request, sessionId, options, message);
        }

        if (isNotification) {
          await options.sessionManager.sendNotification(sessionId, message);

          return new Response(null, {
            status: 202
          });
        }

        const responseMessage = normalizeInitializeResponse(
          message,
          await options.sessionManager.sendRequest(
            sessionId,
            message
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
        return new Response(
          error instanceof Error ? error.message : "Upstream bridge failure.",
          { status: 502 }
        );
      } finally {
        if (isEphemeralRequest) {
          await options.sessionManager.destroySession(sessionId);
        }
      }
    }
  };
}

async function bootstrapEphemeralSession(
  request: Request,
  sessionId: string,
  options: BridgeAppOptions,
  message: JsonRpcMessage
): Promise<void> {
  await options.sessionManager.sendRequest(sessionId, {
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
  });
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
