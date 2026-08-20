import { Container, getContainer } from "@cloudflare/containers";

import { createWorkerHandler, type WorkerEnv } from "./worker-app.js";

type RuntimeEnv = Omit<WorkerEnv, "SKYLIGHT_BRIDGE"> & {
  BRIDGE_REQUEST_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
  PORT?: string;
  SESSION_IDLE_TIMEOUT_MS?: string;
  SKYLIGHT_BRIDGE: DurableObjectNamespace<SkylightBridgeContainer>;
  SKYLIGHT_MCP_TOKEN: string;
};

export class SkylightBridgeContainer extends Container {
  defaultPort = 8080;
  pingEndpoint = "localhost/healthz";
  // Must outlive the in-bridge idle session TTL so the container is not put to
  // sleep with sessions the bridge still considers live.
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);

    this.entrypoint = ["node", "/app/apps/bridge/dist/index.js"];
    this.envVars = {
      BRIDGE_REQUEST_TIMEOUT_MS: env.BRIDGE_REQUEST_TIMEOUT_MS ?? "120000",
      LOG_LEVEL: env.LOG_LEVEL ?? "info",
      PORT: env.PORT ?? "8080",
      SESSION_IDLE_TIMEOUT_MS: env.SESSION_IDLE_TIMEOUT_MS ?? "300000",
      SKYLIGHT_MCP_TOKEN: env.SKYLIGHT_MCP_TOKEN
    };
  }
}

const handleRequest = createWorkerHandler();

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    return handleRequest(request, {
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      MCP_SHARED_BEARER_TOKEN: env.MCP_SHARED_BEARER_TOKEN,
      SKYLIGHT_BRIDGE: getContainer(env.SKYLIGHT_BRIDGE)
    });
  }
};
