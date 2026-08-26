import assert from "node:assert/strict";
import test from "node:test";

import { SleeperApiError, SleeperClient } from "../src/sleeper-client.js";

test("caches the large player catalog", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return Response.json({ p1: { player_id: "p1", full_name: "Player One" } });
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => 1_000 });

  const first = await client.getPlayers();
  const second = await client.getPlayers();

  assert.equal(requests, 1);
  assert.equal(first, second);
});

test("surfaces upstream HTTP failures without response bodies", async () => {
  const fetcher: typeof fetch = async () => new Response("sensitive upstream body", { status: 503 });
  const client = new SleeperClient({ fetch: fetcher });

  await assert.rejects(
    client.getDraft("draft-1"),
    (error: unknown) => {
      assert.ok(error instanceof SleeperApiError);
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /sensitive upstream body/);
      return true;
    },
  );
});

test("turns Sleeper's 200 null unknown-user response into a stable not-found error", async () => {
  const fetcher: typeof fetch = async () => Response.json(null);
  const client = new SleeperClient({ fetch: fetcher });

  await assert.rejects(
    client.getUser("missing-user"),
    (error: unknown) => {
      assert.ok(error instanceof SleeperApiError);
      assert.equal(error.status, 404);
      assert.match(error.message, /not found/i);
      return true;
    },
  );
});
