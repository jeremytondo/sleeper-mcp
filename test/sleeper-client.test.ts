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

test("catalog freshness is unknown until fetched and expires after the default 24 hours", async () => {
  let now = Date.UTC(2026, 9, 5);
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return Response.json({ p1: { player_id: "p1", full_name: `Version ${requests}` } });
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => now });

  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: null,
    expires_at: null,
    stale: true,
  });
  assert.equal(requests, 0);

  const first = await client.getPlayers();
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "2026-10-05T00:00:00.000Z",
    expires_at: "2026-10-06T00:00:00.000Z",
    stale: false,
  });

  now += 24 * 60 * 60 * 1_000 - 1;
  assert.equal(await client.getPlayers(), first);
  assert.equal(requests, 1);
  assert.equal(client.getPlayerCatalogInfo().stale, false);

  now += 1;
  assert.equal(client.getPlayerCatalogInfo().stale, true);
  assert.equal((await client.getPlayers()).p1!.full_name, "Version 2");
  assert.equal(requests, 2);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "2026-10-06T00:00:00.000Z",
    expires_at: "2026-10-07T00:00:00.000Z",
    stale: false,
  });
});

test("concurrent catalog requests share one fetch and TTL starts after successful completion", async () => {
  let now = 1_000;
  let requests = 0;
  let finish!: (response: Response) => void;
  const fetcher: typeof fetch = () => {
    requests += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => now, playerCacheTtlMs: 100 });
  const first = client.getPlayers();
  const second = client.getPlayers();
  const third = client.getPlayers();
  assert.equal(requests, 1);
  assert.equal(client.getPlayerCatalogInfo().fetched_at, null);

  now = 2_000;
  finish(Response.json({ p1: { player_id: "p1" } }));
  const catalogs = await Promise.all([first, second, third]);
  assert.equal(catalogs[0], catalogs[1]);
  assert.equal(catalogs[1], catalogs[2]);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "1970-01-01T00:00:02.000Z",
    expires_at: "1970-01-01T00:00:02.100Z",
    stale: false,
  });

  now = 2_099;
  assert.equal(await client.getPlayers(), catalogs[0]);
  assert.equal(requests, 1);

  now = 2_100;
  const refresh = client.getPlayers();
  const sharedRefresh = client.getPlayers();
  assert.equal(requests, 2);
  finish(Response.json({ p2: { player_id: "p2" } }));
  assert.equal(await refresh, await sharedRefresh);
});

test("failed catalog refresh rejects instead of returning stale data or extending freshness", async () => {
  let now = 1_000;
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    if (requests === 2) return new Response("upstream failure", { status: 503 });
    return Response.json({ p1: { player_id: "p1", full_name: `Version ${requests}` } });
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => now, playerCacheTtlMs: 100 });
  await client.getPlayers();
  now = 1_100;

  await assert.rejects(client.getPlayers(), SleeperApiError);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "1970-01-01T00:00:01.000Z",
    expires_at: "1970-01-01T00:00:01.100Z",
    stale: true,
  });

  now = 1_200;
  assert.equal((await client.getPlayers()).p1!.full_name, "Version 3");
  assert.equal(requests, 3);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "1970-01-01T00:00:01.200Z",
    expires_at: "1970-01-01T00:00:01.300Z",
    stale: false,
  });
});

test("concurrent failed catalog requests share the failure and can be retried", async () => {
  let requests = 0;
  let fail!: (error: Error) => void;
  const fetcher: typeof fetch = () => {
    requests += 1;
    if (requests > 1) return Promise.resolve(Response.json({}));
    return new Promise<Response>((_resolve, reject) => { fail = reject; });
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => 1_000 });
  const first = assert.rejects(client.getPlayers(), /Sleeper request failed: offline/);
  const second = assert.rejects(client.getPlayers(), /Sleeper request failed: offline/);
  assert.equal(requests, 1);
  fail(new Error("offline"));
  await Promise.all([first, second]);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: null,
    expires_at: null,
    stale: true,
  });

  assert.deepEqual(await client.getPlayers(), {});
  assert.equal(requests, 2);
  assert.equal(client.getPlayerCatalogInfo().stale, false);
});

test("invalid catalog JSON does not refresh cache timestamps", async () => {
  let now = 1_000;
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return requests === 1 ? Response.json({}) : new Response("{invalid");
  };
  const client = new SleeperClient({ fetch: fetcher, now: () => now, playerCacheTtlMs: 100 });
  await client.getPlayers();
  now = 1_100;
  await assert.rejects(client.getPlayers(), /Sleeper returned invalid JSON/);
  assert.deepEqual(client.getPlayerCatalogInfo(), {
    fetched_at: "1970-01-01T00:00:01.000Z",
    expires_at: "1970-01-01T00:00:01.100Z",
    stale: true,
  });
});

test("invalid catalog top-level payloads are rejected without recording successful freshness", async () => {
  for (const payload of [null, [], "invalid", 42]) {
    const fetcher: typeof fetch = async () => Response.json(payload);
    const client = new SleeperClient({ fetch: fetcher, now: () => 1_000 });
    await assert.rejects(client.getPlayers(), /Sleeper returned invalid player catalog/);
    assert.deepEqual(client.getPlayerCatalogInfo(), {
      fetched_at: null,
      expires_at: null,
      stale: true,
    });
  }
});

test("league endpoints encode identifiers, preserve raw payloads, and fetch fresh on every request", async () => {
  const state = { season: "2026", season_type: "regular", week: 5, display_week: 5, leg: 5, extra: true };
  const leagues = [{ league_id: "league/one", previous_league_id: "last-year", draft_id: "draft-one", season_type: "regular", extra: true }];
  const matchups = [{ roster_id: 1, matchup_id: 2, points: 101.5, custom_points: 105, starters: ["p1"], players: ["p1", "p2"], starters_points: [25], players_points: { p1: 25, p2: 10 }, extra: true }];
  const transactions = [{ transaction_id: "tx1", type: "trade", status: "complete", adds: { p1: 1 }, drops: { p1: 2 }, settings: { waiver_bid: 5 }, metadata: { note: "raw note", other: 1 }, waiver_budget: [{ sender: 1, receiver: 2, amount: 5 }], draft_picks: [{ season: "2027", round: 2, roster_id: 1, previous_owner_id: 1, owner_id: 2 }], extra: { preserved: true } }];
  const responses = new Map<string, unknown>([
    ["/state/nfl", state],
    ["/user/user%2Fone/leagues/nfl/2026%3Fx%3Dy", leagues],
    ["/league/league%2Fone/matchups/5", matchups],
    ["/league/league%2Fone/transactions/5", transactions],
  ]);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url).replace("https://example.test/v1", "");
    assert.ok(responses.has(path), `Unexpected endpoint: ${path}`);
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    calls.push(path);
    return Response.json(responses.get(path));
  };
  const client = new SleeperClient({ fetch: fetcher, baseUrl: "https://example.test/v1/" });

  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(await client.getNflState(), state);
    assert.deepEqual(await client.getUserLeagues("user/one", "2026?x=y"), leagues);
    assert.deepEqual(await client.getLeagueMatchups("league/one", 5), matchups);
    assert.deepEqual(await client.getLeagueTransactions("league/one", 5), transactions);
  }
  assert.equal(calls.length, 8);
  for (const path of responses.keys()) assert.equal(calls.filter((call) => call === path).length, 2);
});

test("league endpoints propagate caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  controller.abort(reason);
  let requests = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    requests += 1;
    assert.equal(init?.signal?.aborted, true);
    assert.equal(init?.signal?.reason, reason);
    throw init?.signal?.reason;
  };
  const client = new SleeperClient({ fetch: fetcher });

  await assert.rejects(client.getNflState(controller.signal), /cancelled by caller/);
  await assert.rejects(client.getUserLeagues("user", "2026", controller.signal), /cancelled by caller/);
  await assert.rejects(client.getLeagueMatchups("league", 5, controller.signal), /cancelled by caller/);
  await assert.rejects(client.getLeagueTransactions("league", 5, controller.signal), /cancelled by caller/);
  assert.equal(requests, 4);
});

test("fetches league rosters every time while retaining cached player metadata", async () => {
  let rosterRequests = 0;
  let catalogRequests = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/league/league-1/rosters")) {
      rosterRequests += 1;
      return Response.json([{ roster_id: 1, players: rosterRequests === 1 ? [] : ["p1"] }]);
    }
    assert.ok(String(url).endsWith("/players/nfl"));
    catalogRequests += 1;
    return Response.json({ p1: { player_id: "p1" } });
  };
  const client = new SleeperClient({ fetch: fetcher });

  assert.deepEqual((await client.getLeagueRosters("league-1"))[0]!.players, []);
  await client.getPlayers();
  assert.deepEqual((await client.getLeagueRosters("league-1"))[0]!.players, ["p1"]);
  await client.getPlayers();
  assert.equal(rosterRequests, 2);
  assert.equal(catalogRequests, 1);
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
