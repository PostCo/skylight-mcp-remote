export type ContainerBinding = {
  fetch: (request: Request) => Promise<Response>;
};

export type WorkerEnv = {
  MCP_SHARED_BEARER_TOKEN: string;
  SKYLIGHT_BRIDGE: ContainerBinding;
};

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

    const proxiedRequest = stripSharedAuthHeader(request);

    return withCorsHeaders(request, await env.SKYLIGHT_BRIDGE.fetch(proxiedRequest));
  };
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
  headers.set("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  headers.set("access-control-allow-headers", requestedHeaders);
  headers.set("access-control-expose-headers", "MCP-Session-Id");
  headers.append("vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
