# skylight-mcp-remote

Remote MCP deployment scaffold for [`skylight-mcp`](https://rubygems.org/gems/skylight-mcp), built on Cloudflare Workers plus Cloudflare Containers.

This repo is for people who want to expose the Ruby `skylight-mcp` server through a hosted HTTP endpoint instead of running it locally over stdio.

## What It Does

- Terminates HTTP requests at a Cloudflare Worker.
- Protects `/mcp` with a shared bearer token.
- Forwards authenticated traffic to a containerized Node bridge.
- Runs `gem exec skylight-mcp --token "$SKYLIGHT_MCP_TOKEN"` inside the container.
- Adapts hosted MCP traffic into the stdio-based Ruby server.

## MCP Behavior

The bridge is intentionally tolerant of real hosted-client behavior:

- `OPTIONS /mcp` returns `204` for browser preflight requests.
- `HEAD /mcp` returns `200` for authenticated reachability checks.
- `POST /mcp` supports standard JSON-RPC requests such as `initialize`, `tools/list`, and `tools/call`.
- `notifications/initialized` is accepted as a notification and returns `202`.
- If a client sends follow-up traffic without a local in-memory session, the bridge bootstraps a replacement session before forwarding the request.

## Architecture

- `apps/worker`: Cloudflare Worker request handling, auth, and CORS.
- `apps/bridge`: HTTP-to-stdio bridge service that manages `skylight-mcp` child processes.
- `Dockerfile`: minimal container image for the bridge.
- `wrangler.jsonc`: Worker + container deployment config.

Request flow:

1. Client sends `POST /mcp` with `Authorization: Bearer <MCP_SHARED_BEARER_TOKEN>`.
2. Worker validates auth and forwards the request to the Cloudflare Container binding.
3. Bridge creates or resumes a session, then proxies JSON-RPC over stdio to `skylight-mcp`.
4. Bridge returns JSON-RPC responses, `mcp-session-id` headers when relevant, and browser-friendly CORS headers.

## Prerequisites

- Node 22+
- npm
- Docker with `buildx`
- Ruby is only required if you want to run the bridge outside the container image
- A Cloudflare account with Workers and Containers enabled
- A valid Skylight MCP token

## Configuration

Required secrets:

- `MCP_SHARED_BEARER_TOKEN`
- `SKYLIGHT_MCP_TOKEN`

Optional environment variables:

- `PORT` default `8080`
- `LOG_LEVEL` default `info`
- `BRIDGE_REQUEST_TIMEOUT_MS` default `30000`

`.env.example` contains the expected variable names for local development.

## Local Development

Install dependencies and run tests:

```bash
npm install
npm test
npm run build
```

Run the bridge directly:

```bash
export SKYLIGHT_MCP_TOKEN=your-skylight-token
export PORT=8080
npm run dev:bridge
```

Quick checks:

```bash
curl -i http://127.0.0.1:8080/healthz

curl -i \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"local-test","version":"1.0"}}}' \
  http://127.0.0.1:8080/mcp
```

## Deploying To Cloudflare

1. Authenticate Wrangler.
2. Build the workspace artifacts copied into the bridge image:

```bash
npm run build
```

3. Set Worker secrets:

```bash
npx wrangler secret put MCP_SHARED_BEARER_TOKEN
npx wrangler secret put SKYLIGHT_MCP_TOKEN
```

4. Build and push the bridge image:

```bash
docker buildx build --platform linux/amd64 --load -t skylight-mcp-remote:amd64 .
npx wrangler containers push skylight-mcp-remote:amd64
```

5. Update `wrangler.jsonc` with your pushed image digest.

6. Review the account-specific values in `wrangler.jsonc` before deploy:

- Worker `name`
- container `name`
- registry image reference under `containers[].image`

7. Deploy:

```bash
npx wrangler deploy
```

## Smoke Test

Set helpers:

```bash
export BASE_URL="https://<your-worker-subdomain>.workers.dev"
export MCP_SHARED_BEARER_TOKEN="<your-shared-bearer-token>"
```

Health check:

```bash
curl -i "$BASE_URL/healthz"
```

Initialize:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'Mcp-Method: initialize' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}' \
  "$BASE_URL/mcp"
```

Follow with `notifications/initialized`:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'Mcp-Method: notifications/initialized' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$BASE_URL/mcp"
```

List tools:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'Mcp-Method: tools/list' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$BASE_URL/mcp"
```

## Limitations

- The repo is a deployment scaffold, not a published npm package.
- `wrangler.jsonc` is intentionally operational and must be edited for your own Cloudflare account.
- Session state is in-memory inside the bridge container. The Worker smooths over some hosted-client edge cases, but the architecture is still fundamentally a stateful bridge around a stdio server.

## License

MIT. See [LICENSE](./LICENSE).
