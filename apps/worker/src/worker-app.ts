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

    if (!isAuthorized(request, env.MCP_SHARED_BEARER_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const proxiedRequest = stripSharedAuthHeader(request);

    return env.SKYLIGHT_BRIDGE.fetch(proxiedRequest);
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
