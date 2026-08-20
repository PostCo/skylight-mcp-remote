# skylight-mcp-remote

Remote MCP deployment scaffold for [`skylight-mcp`](https://rubygems.org/gems/skylight-mcp), built on Cloudflare Workers plus Cloudflare Containers.

Relevant upstream links:

- Skylight: [https://skylight.io/](https://skylight.io/)
- `skylight-mcp` on RubyGems: [https://rubygems.org/gems/skylight-mcp](https://rubygems.org/gems/skylight-mcp)
- `skylight-mcp` on Ruby China: [https://gems.ruby-china.com/gems/skylight-mcp/](https://gems.ruby-china.com/gems/skylight-mcp/)

This repo is for people who want to expose the Ruby `skylight-mcp` server through a hosted HTTP endpoint instead of running it locally over stdio.

## What It Does

- Terminates HTTP requests at a Cloudflare Worker.
- Protects `/mcp` with a shared bearer token.
- Forwards authenticated traffic to a containerized Node bridge.
- Runs `gem exec skylight-mcp --token "$SKYLIGHT_MCP_TOKEN"` inside the container.
- Adapts hosted MCP traffic into the stdio-based Ruby server.

If you found this repo while searching for Skylight MCP, Skylight Ruby performance tooling, or the `skylight-mcp` gem, start with [Skylight](https://skylight.io/) and the package pages on [RubyGems](https://rubygems.org/gems/skylight-mcp) or [Ruby China](https://gems.ruby-china.com/gems/skylight-mcp/).

## MCP Behavior

The bridge is intentionally tolerant of real hosted-client behavior:

- `OPTIONS /mcp` returns `204` for browser preflight requests.
- `HEAD /mcp` returns `200` for authenticated reachability checks.
- `POST /mcp` supports standard JSON-RPC requests such as `initialize`, `tools/list`, and `tools/call`.
- `notifications/initialized` is accepted as a notification and returns `202`.
- `DELETE /mcp` with an `MCP-Session-Id` header terminates the session, kills its Ruby child process, and returns `204`.
- `GET /mcp` returns `405 Method Not Allowed`. The Ruby server is stdio-only and never initiates messages, so there is no SSE stream to listen on. Clients must treat this as terminal and not reconnect.
- If a client sends follow-up traffic without a local in-memory session, the bridge bootstraps a replacement session before forwarding the request.

### Sessions, Timeouts, And Status Codes

- Calls within one MCP session are serialized, because application and component selection in `skylight-mcp` is stateful. Different sessions run concurrently, one Ruby child process each.
- A session is destroyed by `DELETE /mcp`, by idle expiry after `SESSION_IDLE_TIMEOUT_MS`, or when its child exits.
- When a request exceeds `BRIDGE_REQUEST_TIMEOUT_MS` or its HTTP connection is aborted, the bridge sends `notifications/cancelled` and terminates that session's Ruby process, so no timed-out operation keeps running. The next request for that session id starts a clean replacement.

| Status | Meaning |
| --- | --- |
| `405` | `GET /mcp`: SSE listening is not supported. |
| `499` | The caller aborted the HTTP connection; the session was reset. |
| `502` | The Ruby child process failed or exited. |
| `504` | The bridge timed out waiting for the child; the session was reset. |

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

Both are stored as Worker secrets and are never committed:

```bash
npx wrangler secret put MCP_SHARED_BEARER_TOKEN
npx wrangler secret put SKYLIGHT_MCP_TOKEN
```

Use a bearer token dedicated to this Worker. Do not reuse the token of another
MCP Worker, so either side can be rotated or revoked on its own.

Optional environment variables:

- `PORT` default `8080`
- `LOG_LEVEL` default `info`
- `BRIDGE_REQUEST_TIMEOUT_MS` default `120000`
- `SESSION_IDLE_TIMEOUT_MS` default `300000`
- `ALLOWED_ORIGINS` default empty; comma-separated list of browser origins allowed to call `/mcp`. A request carrying any other `Origin` is rejected with `403` rather than having its origin reflected. Server-to-server clients send no `Origin` header and are unaffected.

`.env.example` contains the expected variable names for local development.

### Container Sizing

`wrangler.jsonc` pins `instance_type: "standard-1"` (1/2 vCPU, 4 GiB memory, 8 GB
disk) with `max_instances: 1`. Leaving `instance_type` unset falls back to `lite`
(1/16 vCPU, 256 MiB), which cannot hold four concurrent Ruby `skylight-mcp`
children. Re-check the current sizes in the
[Cloudflare instance type documentation](https://developers.cloudflare.com/containers/platform-details/limits/)
before changing this.

The container image is built from this repository's `Dockerfile` on deploy, and
the `skylight-mcp` gem version is pinned via the `SKYLIGHT_MCP_VERSION` build arg.

### Logging

The bridge emits one JSON object per line covering session creation and
destruction, active session count, operation name, duration, timeouts, child
exits, and the cleanup reason. Bearer tokens, Skylight tokens, request payloads
and raw tool responses are never logged. Raise `LOG_LEVEL` to `debug` for
per-notification detail.

`/healthz` is deliberately cheap: it confirms only that the bridge process is
accepting HTTP requests. It does not spawn a Ruby child, does not contact
Skylight, and a `200` therefore says nothing about whether MCP calls succeed.

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

4. Review the account-specific values in `wrangler.jsonc` before deploy:

- `account_id`
- Worker `name`
- container `name`

`wrangler deploy` builds the `Dockerfile` and pushes it to your account's
Cloudflare registry, so no image digest has to be maintained by hand.

5. Verify without deploying:

```bash
npx wrangler deploy --dry-run
```

6. Deploy:

```bash
npx wrangler deploy
```

## Concurrency Load Test

`scripts/load-test.mjs` drives the deployed Worker with the real MCP SDK client:
ten rounds of four simultaneous clients, each running `initialize`, the
`initialized` notification, `tools/list`, a target selection call, representative
read calls, and an explicit `DELETE` session termination. It exercises MCP only
and never delegates Linear cards.

Credentials are read from the environment and never printed:

```bash
export MCP_URL="https://<your-worker-subdomain>.workers.dev/mcp"
export MCP_BEARER_TOKEN="<your-mastra-bearer-token>"
export MCP_SELECT_TOOL="<application selection tool>"
export MCP_SELECT_ARGS='{"app":"<app-id>"}'
export MCP_READ_TOOLS="<read tool>,<read tool>"

npm run load-test
```

`MCP_ROUNDS` and `MCP_CLIENTS` override the 10x4 default. The script exits
non-zero if any client issues more than one `GET`, if a `GET` is answered with
anything other than `405`, if any response is a `502`, or if any client run
fails.

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
