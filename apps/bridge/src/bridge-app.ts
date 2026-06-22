import { randomUUID } from "node:crypto";

import type { JsonRpcMessage } from "./process-session-manager.js";

export type BridgeSessionManager = {
  destroyAll: () => Promise<void>;
  destroySession: (sessionId: string) => Promise<void>;
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
      const sessionId =
        existingSessionId ??
        (message.method === "initialize"
          ? `session-${randomUUID()}`
          : null);

      if (!sessionId) {
        return new Response("Missing mcp-session-id header.", { status: 400 });
      }

      try {
        const responseMessage = await options.sessionManager.sendRequest(
          sessionId,
          message
        );

        return new Response(JSON.stringify(responseMessage), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": sessionId
          }
        });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Upstream bridge failure.",
          { status: 502 }
        );
      }
    }
  };
}
