export type ContainerBinding = {
  fetch: (request: Request) => Promise<Response>;
};

export type WorkerEnv = {
  MCP_SHARED_BEARER_TOKEN: string;
  SKYLIGHT_BRIDGE: ContainerBinding;
};

const ALLOWED_MCP_METHODS = "POST, HEAD, OPTIONS";

export function createWorkerHandler() {
  return async function handleRequest(
    request: Request,
    env: WorkerEnv
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return env.SKYLIGHT_BRIDGE.fetch(request);
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return withCorsHeaders(request, new Response(null, { status: 204 }));
    }

    if (request.method === "HEAD" && isAuthorized(request, env.MCP_SHARED_BEARER_TOKEN)) {
      return withCorsHeaders(request, new Response(null, { status: 200 }));
    }

    if (!isAuthorized(request, env.MCP_SHARED_BEARER_TOKEN)) {
      return withCorsHeaders(request, new Response("Unauthorized", { status: 401 }));
    }

    // The Ruby skylight-mcp server is stdio-only, so there is no server-initiated
    // SSE stream to listen on. Answer GET at the edge with a terminal 405 so MCP
    // clients disable the listener instead of entering a reconnect loop, and so
    // the request never reaches the container.
    if (request.method === "GET") {
      return withCorsHeaders(request, methodNotAllowed());
    }

    const proxiedRequest = stripSharedAuthHeader(request);

    return withCorsHeaders(request, await env.SKYLIGHT_BRIDGE.fetch(proxiedRequest));
  };
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: ALLOWED_MCP_METHODS
    }
  });
}

function isAuthorized(request: Request, expectedToken: string): boolean {
  const authorizationHeader = request.headers.get("authorization");

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return false;
  }

  return authorizationHeader.slice("Bearer ".length) === expectedToken;
}

function stripSharedAuthHeader(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");

  return new Request(request, {
    headers
  });
}

function withCorsHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin") ?? "*";
  const requestedHeaders =
    request.headers.get("access-control-request-headers") ??
    "Authorization, Content-Type, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method";

  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", ALLOWED_MCP_METHODS);
  headers.set("access-control-allow-headers", requestedHeaders);
  headers.set("access-control-expose-headers", "MCP-Session-Id");
  headers.append("vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
