import { describe, expect, it, vi } from "vitest";

import { createWorkerHandler } from "../src/worker-app.js";

describe("createWorkerHandler", () => {
  it("rejects unauthenticated MCP requests", async () => {
    const bridge = {
      fetch: vi.fn()
    };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          origin: "https://linear.app",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {}
        })
      }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://linear.app"
    );
    expect(await response.text()).toContain("Unauthorized");
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("proxies authenticated MCP requests to the bridge and strips the shared auth header", async () => {
    const bridge = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("mcp-session-id")).toBe("session-123");
        expect(await request.json()).toEqual({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        });

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: []
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-123"
            }
          }
        );
      })
    };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-type": "application/json",
          "mcp-session-id": "session-123",
          origin: "https://linear.app"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        })
      }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-123");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://linear.app"
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "MCP-Session-Id"
    );
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: []
      }
    });
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });

  it("proxies health checks without requiring client auth", async () => {
    const bridge = {
      fetch: vi.fn(async () => {
        return Response.json({
          ok: true
        });
      })
    };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/healthz"),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true
    });
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });

  it("answers authenticated HEAD requests without proxying to the bridge", async () => {
    const bridge = {
      fetch: vi.fn()
    };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", {
        method: "HEAD",
        headers: {
          authorization: "Bearer shared-secret",
          origin: "https://linear.app"
        }
      }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://linear.app"
    );
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("responds to MCP preflight requests without requiring auth", async () => {
    const bridge = {
      fetch: vi.fn()
    };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", {
        method: "OPTIONS",
        headers: {
          origin: "https://linear.app",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,mcp-session-id,mcp-protocol-version,mcp-method"
        }
      }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://linear.app"
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, POST, OPTIONS"
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization,content-type,mcp-session-id,mcp-protocol-version,mcp-method"
    );
    expect(bridge.fetch).not.toHaveBeenCalled();
  });
});
