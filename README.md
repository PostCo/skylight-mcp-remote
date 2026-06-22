# skylight-mcp-remote

Cloudflare-hosted MCP bridge for `skylight-mcp`, built as a thin Worker plus a containerized bridge process.

## Architecture

- `POST /mcp`: authenticated MCP JSON-RPC requests.
- `GET /mcp`: bridge event-stream endpoint placeholder for remote MCP transports.
- `GET /healthz`: readiness and deployment check.
- The Worker validates `Authorization: Bearer <MCP_SHARED_BEARER_TOKEN>`.
- The Worker forwards only authenticated `/mcp` traffic to a Cloudflare Container.
- The Container runs a Node bridge that spawns `gem exec skylight-mcp --token $SKYLIGHT_MCP_TOKEN` and proxies JSON-RPC over stdio.

## Repo Layout

- `apps/worker`: Cloudflare Worker and container binding.
- `apps/bridge`: HTTP-to-stdio bridge service.
- `wrangler.jsonc`: Worker plus container deployment config.
- `Dockerfile`: bridge container image.

## Required Secrets

Set these in Cloudflare with `wrangler secret put`:

- `MCP_SHARED_BEARER_TOKEN`
- `SKYLIGHT_MCP_TOKEN`

Keep local development secrets in an untracked `.env.local` file if needed.

## Local Development

Use Node 22 for install and local scripts. This machine already has it through `mise`.

```bash
mise exec node@22 -- npm install
mise exec node@22 -- npm test
mise exec node@22 -- npm run build
```

Run the bridge locally:

```bash
export SKYLIGHT_MCP_TOKEN=your-skylight-token
export PORT=8080
mise exec node@22 -- npm run dev:bridge
```

Quick local checks:

```bash
curl -i http://127.0.0.1:8080/healthz

curl -i \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}' \
  http://127.0.0.1:8080/mcp
```

## Cloudflare Setup

1. Ensure Cloudflare Containers is enabled for the target account.
2. Authenticate Wrangler.
3. Build the workspace artifacts that the bridge image copies in:

```bash
npm run build
```

3. Set secrets:

```bash
npx wrangler@4.103.0 secret put MCP_SHARED_BEARER_TOKEN
npx wrangler@4.103.0 secret put SKYLIGHT_MCP_TOKEN
```

4. Build and push an amd64 bridge image to Cloudflare's registry:

```bash
docker pull --platform linux/amd64 public.ecr.aws/docker/library/ruby:3.3-slim
docker buildx build --platform linux/amd64 --load -t skylight-mcp-remote:amd64 .
npx wrangler@4.103.0 containers push skylight-mcp-remote:amd64
```

5. Update `wrangler.jsonc` to the pushed image digest if it changed.

6. Deploy:

```bash
npx wrangler@4.103.0 deploy
```

## Post-Deploy Smoke Test

Set helpers:

```bash
export BASE_URL="https://skylight-mcp-remote.postco.workers.dev"
export MCP_SHARED_BEARER_TOKEN="<your-shared-bearer-token>"
```

Health check:

```bash
curl -i "$BASE_URL/healthz"
```

Unauthorized request should return `401`:

```bash
curl -i \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}' \
  "$BASE_URL/mcp"
```

Initialize and capture the returned session id:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}' \
  "$BASE_URL/mcp"
```

List tools with the session id from the initialize response header:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$BASE_URL/mcp"
```

Call a real Skylight-backed tool after identifying one from `tools/list`:

```bash
curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<tool-name>","arguments":{}}}' \
  "$BASE_URL/mcp"
```

Success criteria:

- `/healthz` returns `200`.
- Unauthenticated `/mcp` returns `401`.
- Authenticated `initialize` returns `200` and an `mcp-session-id` header.
- Authenticated `tools/list` returns a non-error JSON-RPC result.
- At least one real `tools/call` returns a non-error JSON-RPC result backed by Skylight.

## Verified 2026-06-22

The deployment verified in this repo used:

- Worker URL: `https://skylight-mcp-remote.postco.workers.dev`
- Worker version: `2d8f2798-617e-4225-bc6b-c235922a2528`
- Container image: `registry.cloudflare.com/6413bfbe023fbf879350a20fe7a2245b/skylight-mcp-remote@sha256:fa32552b0fd0292bcb92c95e1bce95f983588f0dfd2c70439cabd077b3693861`

Verified commands:

```bash
curl -i "$BASE_URL/healthz"

curl -i \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}' \
  "$BASE_URL/mcp"

curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}' \
  "$BASE_URL/mcp"

curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$BASE_URL/mcp"

curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"select_app","arguments":{"app":"Project Tapir"}}}' \
  "$BASE_URL/mcp"

curl -i \
  -H "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_components","arguments":{}}}' \
  "$BASE_URL/mcp"
```
