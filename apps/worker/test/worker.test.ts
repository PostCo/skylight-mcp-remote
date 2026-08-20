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
      "POST, HEAD, OPTIONS"
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization,content-type,mcp-session-id,mcp-protocol-version,mcp-method"
    );
    expect(bridge.fetch).not.toHaveBeenCalled();
  });
});

describe("MCP SSE listener is disabled", () => {
  const authorizedGet = () =>
    new Request("https://example.com/mcp", {
      method: "GET",
      headers: {
        authorization: "Bearer shared-secret",
        accept: "text/event-stream"
      }
    });

  it("answers an authenticated GET /mcp with 405 without touching the container", async () => {
    const bridge = { fetch: vi.fn() };
    const handler = createWorkerHandler();

    const response = await handler(authorizedGet(), {
      MCP_SHARED_BEARER_TOKEN: "shared-secret",
      SKYLIGHT_BRIDGE: bridge
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, HEAD, OPTIONS");
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("still requires authentication before reporting 405", async () => {
    const bridge = { fetch: vi.fn() };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", { method: "GET" }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.status).toBe(401);
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("does not advertise GET as an allowed CORS method", async () => {
    const bridge = { fetch: vi.fn() };
    const handler = createWorkerHandler();

    const response = await handler(
      new Request("https://example.com/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://linear.app" }
      }),
      {
        MCP_SHARED_BEARER_TOKEN: "shared-secret",
        SKYLIGHT_BRIDGE: bridge
      }
    );

    expect(response.headers.get("access-control-allow-methods")).toBe(
      "POST, HEAD, OPTIONS"
    );
  });

  it("cannot be pushed into a GET reconnect loop", async () => {
    const bridge = { fetch: vi.fn() };
    const handler = createWorkerHandler();
    const env = {
      MCP_SHARED_BEARER_TOKEN: "shared-secret",
      SKYLIGHT_BRIDGE: bridge
    };

    // Mirrors how an MCP Streamable HTTP client drives its SSE listener: it keeps
    // reopening the stream while the server keeps accepting GET, and gives up
    // permanently once the server answers with a terminal 405.
    let getAttempts = 0;
    let listening = true;

    while (listening && getAttempts < 10) {
      getAttempts += 1;
      const response = await handler(authorizedGet(), env);

      if (response.status === 405) {
        listening = false;
      }
    }

    expect(getAttempts).toBe(1);
    expect(listening).toBe(false);
    expect(bridge.fetch).not.toHaveBeenCalled();
  });
});
