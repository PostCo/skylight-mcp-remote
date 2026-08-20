#!/usr/bin/env node
/**
 * Concurrent load test against a deployed mastra-skylight-mcp Worker, driven by
 * the real MCP SDK client so the traffic matches what Mastra actually sends.
 *
 * Credentials come from the environment; nothing is hard-coded and no token is
 * printed. This exercises MCP only -- it never delegates Linear cards.
 *
 *   MCP_URL=https://mastra-skylight-mcp.<subdomain>.workers.dev/mcp \
 *   MCP_BEARER_TOKEN=... \
 *   node scripts/load-test.mjs
 *
 * Optional:
 *   MCP_ROUNDS         rounds to run (default 10)
 *   MCP_CLIENTS        simultaneous clients per round (default 4)
 *   MCP_SELECT_TOOL    tool that selects the target application/component
 *   MCP_SELECT_ARGS    JSON arguments for the selection tool
 *   MCP_READ_TOOLS     comma-separated read tools to call after selection
 *   MCP_READ_ARGS      JSON arguments shared by the read tools
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = requireEnv("MCP_URL");
const bearerToken = requireEnv("MCP_BEARER_TOKEN");
const rounds = Number.parseInt(process.env.MCP_ROUNDS ?? "10", 10);
const clientsPerRound = Number.parseInt(process.env.MCP_CLIENTS ?? "4", 10);
const selectTool = process.env.MCP_SELECT_TOOL;
const selectArgs = parseJsonEnv("MCP_SELECT_ARGS");
const readTools = (process.env.MCP_READ_TOOLS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const readArgs = parseJsonEnv("MCP_READ_ARGS");

const stats = {
  calls: [],
  clientRuns: 0,
  failures: [],
  requests: []
};

async function runClient(round, index) {
  const label = `r${round}c${index}`;
  const requests = [];

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: `Bearer ${bearerToken}` }
    },
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      const startedAt = Date.now();
      const response = await fetch(input, init);

      requests.push({
        method,
        status: response.status,
        durationMs: Date.now() - startedAt
      });

      return response;
    }
  });

  const client = new Client({ name: `mastra-load-test-${label}`, version: "1.0.0" });

  try {
    // connect() performs initialize plus the initialized notification, and
    // opens the SSE listener exactly once.
    await timed(label, "initialize", () => client.connect(transport));

    const tools = await timed(label, "tools/list", () => client.listTools());

    if (selectTool) {
      await timed(label, selectTool, () =>
        client.callTool({ name: selectTool, arguments: selectArgs ?? {} })
      );

      for (const toolName of readTools) {
        await timed(label, toolName, () =>
          client.callTool({ name: toolName, arguments: readArgs ?? {} })
        );
      }
    } else if (round === 0 && index === 0) {
      console.warn(
        `[warn] MCP_SELECT_TOOL is unset; running list-only. Available tools: ${tools.tools
          .map((tool) => tool.name)
          .join(", ")}`
      );
    }

    // Explicit session termination via DELETE /mcp.
    await timed(label, "terminate", () => transport.terminateSession());
    await client.close();
  } catch (error) {
    stats.failures.push({ label, message: String(error?.message ?? error) });
  } finally {
    stats.clientRuns += 1;
    stats.requests.push({ label, requests });
  }
}

async function timed(label, operation, run) {
  const startedAt = Date.now();

  try {
    return await run();
  } finally {
    stats.calls.push({ label, operation, durationMs: Date.now() - startedAt });
  }
}

for (let round = 0; round < rounds; round += 1) {
  await Promise.all(
    Array.from({ length: clientsPerRound }, (_unused, index) =>
      runClient(round, index)
    )
  );
  console.log(`round ${round + 1}/${rounds} complete`);
}

report();

function report() {
  const allRequests = stats.requests.flatMap((entry) => entry.requests);
  const getRequests = allRequests.filter((request) => request.method === "GET");
  const badGets = getRequests.filter((request) => request.status !== 405);
  const perClientGets = stats.requests.map((entry) => ({
    label: entry.label,
    gets: entry.requests.filter((request) => request.method === "GET").length
  }));
  const repeatedGets = perClientGets.filter((entry) => entry.gets > 1);
  const serverErrors = allRequests.filter((request) => request.status === 502);
  const timeouts = allRequests.filter((request) => request.status === 504);
  const durations = stats.calls
    .map((call) => call.durationMs)
    .sort((left, right) => left - right);

  console.log("\n--- load test summary ---");
  console.log(`client runs:        ${stats.clientRuns}`);
  console.log(`http requests:      ${allRequests.length}`);
  console.log(`GET requests:       ${getRequests.length} (all should be 405)`);
  console.log(`clients with >1 GET:${repeatedGets.length}`);
  console.log(`502 responses:      ${serverErrors.length}`);
  console.log(`504 responses:      ${timeouts.length}`);
  console.log(`failures:           ${stats.failures.length}`);
  console.log(
    `call duration p50:  ${percentile(durations, 0.5)}ms  p95: ${percentile(
      durations,
      0.95
    )}ms  max: ${durations.at(-1) ?? 0}ms`
  );

  for (const failure of stats.failures.slice(0, 10)) {
    console.log(`  failure ${failure.label}: ${failure.message}`);
  }

  const violations = [];

  if (badGets.length > 0) {
    violations.push(`${badGets.length} GET responses were not 405`);
  }

  if (repeatedGets.length > 0) {
    violations.push(`${repeatedGets.length} clients issued more than one GET`);
  }

  if (serverErrors.length > 0) {
    violations.push(`${serverErrors.length} responses were 502`);
  }

  if (stats.failures.length > 0) {
    violations.push(`${stats.failures.length} client runs failed`);
  }

  if (violations.length > 0) {
    console.error(`\nFAILED: ${violations.join("; ")}`);
    process.exit(1);
  }

  console.log("\nPASSED: acceptance criteria met.");
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }

  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

function parseJsonEnv(name) {
  const raw = process.env[name];

  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(2);
  }

  return value;
}
