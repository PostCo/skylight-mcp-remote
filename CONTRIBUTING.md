# Contributing

Thanks for contributing.

## Development Setup

Requirements:

- Node 22+
- npm
- Docker if you want to exercise the container build locally

Install dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Build all workspaces:

```bash
npm run build
```

Run the bridge locally:

```bash
export SKYLIGHT_MCP_TOKEN=your-skylight-token
npm run dev:bridge
```

## Contribution Guidelines

- Keep changes focused and small when possible.
- Update documentation when behavior changes.
- Add or update tests for transport, auth, or session-management changes.
- Do not commit real tokens, worker URLs with private meaning, or local `.env` files.

## Pull Requests

Before opening a pull request, make sure:

- `npm test` passes
- `npm run build` passes
- the README still matches the shipped behavior

