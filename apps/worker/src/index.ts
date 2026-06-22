import { Container, getContainer } from "@cloudflare/containers";

import { createWorkerHandler, type WorkerEnv } from "./worker-app.js";

type RuntimeEnv = Omit<WorkerEnv, "SKYLIGHT_BRIDGE"> & {
  BRIDGE_REQUEST_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
  PORT?: string;
  SKYLIGHT_BRIDGE: DurableObjectNamespace<SkylightBridgeContainer>;
  SKYLIGHT_MCP_TOKEN: string;
};

export class SkylightBridgeContainer extends Container {
  defaultPort = 8080;
  pingEndpoint = "localhost/healthz";
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);

    this.entrypoint = ["node", "/app/apps/bridge/dist/index.js"];
    this.envVars = {
      BRIDGE_REQUEST_TIMEOUT_MS: env.BRIDGE_REQUEST_TIMEOUT_MS ?? "30000",
      LOG_LEVEL: env.LOG_LEVEL ?? "info",
      PORT: env.PORT ?? "8080",
      SKYLIGHT_MCP_TOKEN: env.SKYLIGHT_MCP_TOKEN
    };
  }
}

const handleRequest = createWorkerHandler();

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    return handleRequest(request, {
      MCP_SHARED_BEARER_TOKEN: env.MCP_SHARED_BEARER_TOKEN,
      SKYLIGHT_BRIDGE: getContainer(env.SKYLIGHT_BRIDGE)
    });
  }
};
