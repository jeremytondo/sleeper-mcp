import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DraftContextService } from "../src/draft-context.js";
import { createApp } from "../src/server.js";
import { FixtureSleeperGateway, NOW } from "./fixtures.js";

test(
  "lists and calls the read-only tool over Streamable HTTP",
  { skip: process.env.RUN_NETWORK_TESTS !== "1" && "set RUN_NETWORK_TESTS=1 to bind a loopback port" },
  async (t) => {
  const gateway = new FixtureSleeperGateway();
  const service = new DraftContextService(gateway, { now: () => NOW });
  const app = createApp(service, { defaultUser: "jeremy" });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  t.after(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  const { port } = httpServer.address() as AddressInfo;
  const client = new Client({ name: "prototype-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["get_live_draft_context"]);
  assert.equal(tools.tools[0]?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools[0]?.annotations?.destructiveHint, false);

  const result = await client.callTool({
    name: "get_live_draft_context",
    arguments: { draft_id: "draft-1", available_limit_per_position: 3 },
  });

  assert.notEqual(result.isError, true);
  const structured = result.structuredContent as { snapshot: Record<string, unknown> };
  assert.equal((structured.snapshot.current_pick as Record<string, unknown>).pick_no, 3);

  // The same MCP service must recompute availability on successive in-season calls.
  gateway.draft.status = "complete";
  gateway.league.status = "in_season";
  gateway.rosters[0]!.players = ["p1"];
  gateway.rosters[1]!.players = ["p2"];
  for (const claimed of [false, true]) {
    if (claimed) gateway.rosters[1]!.players!.push("p5");
    const refreshed = await client.callTool({
      name: "get_live_draft_context",
      arguments: { draft_id: "draft-1", available_limit_per_position: 3 },
    });
    assert.notEqual(refreshed.isError, true);
    const { snapshot } = refreshed.structuredContent as { snapshot: Record<string, unknown> };
    assert.deepEqual(snapshot.availability, {
      basis: "current_rosters", waiver_status: "unknown", lock_status: "unknown",
    });
    const available = snapshot.available_players_by_position as Record<string, Array<Record<string, unknown>>>;
    assert.equal(available.QB!.some((player) => player.player_id === "p5"), !claimed);
    assert.equal(available.QB!.some((player) => player.player_id === "p1"), false);
  }
  },
);

test(
  "rejects unauthorized and hostile-origin MCP requests",
  { skip: process.env.RUN_NETWORK_TESTS !== "1" && "set RUN_NETWORK_TESTS=1 to bind a loopback port" },
  async (t) => {
    const service = new DraftContextService(new FixtureSleeperGateway(), { now: () => NOW });
    const app = createApp(service, {
      bearerToken: "prototype-secret",
      allowedOrigins: ["https://chatgpt.com"],
    });
    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    t.after(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const { port } = httpServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/mcp`;

    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);

    const hostileOrigin = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer prototype-secret",
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(hostileOrigin.status, 403);
  },
);
