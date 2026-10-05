import assert from "node:assert/strict";
import test from "node:test";

import { buildSelectedLineup, LeagueContextError, LeagueContextService } from "../src/league-context.js";
import type { LeagueGateway, PlayerCatalogInfo, SleeperMatchup, SleeperNflState, SleeperRoster, SleeperTransaction } from "../src/sleeper-types.js";
import { FixtureSleeperGateway, NOW } from "./fixtures.js";

// The service deliberately returns JSON envelopes, so tests inspect JSON rather than internal types.
type Json = Record<string, any>;

class LeagueFixture extends FixtureSleeperGateway implements LeagueGateway {
  state: SleeperNflState = { season: "2026", season_type: "regular", week: 5, display_week: 6 };
  catalogInfo: PlayerCatalogInfo = {
    fetched_at: new Date(NOW - 3_600_000).toISOString(),
    expires_at: new Date(NOW + 82_800_000).toISOString(), stale: false,
  };
  catalogFails = false;
  stateFails = false;
  userFails = false;
  usersFail = false;
  rosterFailures = new Set<string>();
  transactionFailures = new Set<number>();
  rosterReads: string[] = [];
  matchupReads: number[] = [];
  transactionReads: number[] = [];
  leagueRequests: Array<{ userId: string; season: string }> = [];
  otherRosters: SleeperRoster[] = [{ roster_id: 11, owner_id: "owner-11", players: ["p3"], starters: ["p3"] }];
  matchups: SleeperMatchup[] = [
    { roster_id: 1, matchup_id: 1, points: 0, custom_points: 0, starters: ["p2", "0", "p3", "p1"], players: ["p1", "p2", "p3"], players_points: { p1: 0 } },
    { roster_id: 2, matchup_id: 1, points: 87.5, starters: ["p5"] },
    { roster_id: 3, matchup_id: null, points: null, starters: [] },
  ];
  transactions = new Map<number, SleeperTransaction[]>();

  constructor() {
    super();
    this.league.status = "in_season";
    this.league.season_type = "regular";
    this.league.previous_league_id = "league-2025";
    this.league.settings = { num_teams: 3, waiver_budget: 100, waiver_type: 2, custom_budget_rule: 7 };
    this.league.scoring_settings = { rec: 0, pass_td: 4 };
    this.league.roster_positions = ["QB", "FLEX", "BN", "FLEX", "WR", "IR", "TAXI"];
    this.rosters.splice(0, this.rosters.length,
      { roster_id: 1, owner_id: "user-1", co_owners: ["co-1"], players: ["p1", "p2", "p3", "bench", "ir", "taxi"], starters: ["p1", "p2", "0", "p3"], reserve: ["ir"], taxi: ["taxi"], settings: { wins: 0, losses: 2, ties: 0, fpts: 102, fpts_decimal: 34, waiver_budget_used: 0, waiver_budget: 175 } },
      { roster_id: 2, owner_id: null, co_owners: ["co-2"], players: ["p4"], starters: ["p4", "0", "0", "0"], reserve: ["orphan-ir"], taxi: ["orphan-taxi"] },
      { roster_id: 3, owner_id: "owner-3", players: [], starters: [] });
    for (const id of ["bench", "ir", "taxi", "orphan-ir", "orphan-taxi"]) {
      this.players[id] = { player_id: id, full_name: `Player ${id}`, position: "WR", active: true };
    }
  }
  override async getUser(user?: string) {
    if (this.userFails) throw new Error("User unavailable");
    if (user?.startsWith("co-")) return { user_id: user, display_name: "Co-owner" };
    return this.user;
  }
  override async getLeagueRosters(leagueId = "league-1") {
    this.rosterReads.push(leagueId);
    if (this.rosterFailures.has(leagueId)) throw new Error("Rosters unavailable");
    return leagueId === "league-2" ? this.otherRosters : this.rosters;
  }
  override async getLeagueUsers() {
    if (this.usersFail) throw new Error("Users unavailable");
    return this.users;
  }
  override async getPlayers() {
    if (this.catalogFails) throw new Error("Catalog unavailable");
    return this.players;
  }
  getPlayerCatalogInfo() { return this.catalogInfo; }
  async getNflState() {
    if (this.stateFails) throw new Error("State unavailable");
    return this.state;
  }
  async getUserLeagues(userId: string, season: string) {
    this.leagueRequests.push({ userId, season });
    return [this.league];
  }
  async getLeagueMatchups(_leagueId: string, week: number) {
    this.matchupReads.push(week);
    return this.matchups;
  }
  async getLeagueTransactions(_leagueId: string, week: number) {
    this.transactionReads.push(week);
    if (this.transactionFailures.has(week)) throw new Error("Transactions unavailable");
    return this.transactions.get(week) ?? [];
  }
}

function setup() {
  const gateway = new LeagueFixture();
  return { gateway, service: new LeagueContextService(gateway, { now: () => NOW }) };
}
function rows(snapshot: Json, key = "players"): Json[] { return snapshot[key] as Json[]; }

test("listLeagues uses the live NFL season, not calendar or create season, and retains raw rules/history", async () => {
  const { gateway, service } = setup();
  gateway.state.season = "2025"; // January rollover can still be the preceding NFL season.
  gateway.state.league_create_season = "2026";
  const snapshot = await service.listLeagues({ user: "jeremy" }) as Json;
  assert.deepEqual(gateway.leagueRequests, [{ userId: "user-1", season: "2025" }]);
  assert.equal(snapshot.season_basis, "live_nfl_state");
  assert.equal(snapshot.leagues[0].previous_league_id, "league-2025");
  assert.equal(snapshot.leagues[0].scoring_summary.points_per_reception, 0);
  assert.equal(snapshot.leagues[0].league_settings.custom_budget_rule, 7);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.sources["state/nfl"].fetched_at, new Date(NOW).toISOString());
});

test("explicit discovery season works when NFL state is down", async () => {
  const { gateway, service } = setup();
  gateway.stateFails = true;
  const snapshot = await service.listLeagues({ user: "user-1", season: "2024" }) as Json;
  assert.equal(snapshot.season, "2024");
  assert.equal(snapshot.season_basis, "explicit");
  assert.equal(snapshot.partial, false);
  await assert.rejects(service.listLeagues({ user: "user-1" }), /State unavailable/);
});

test("selected lineup preserves order, repeated FLEX slots, literal zero and missing selections", () => {
  const lineup = buildSelectedLineup(["QB", "FLEX", "BN", "FLEX", "WR", "IR"], ["not-a-QB", "0", "receiver"]);
  assert.deepEqual(lineup.map((slot) => [slot.starter_index, slot.roster_position_index, slot.slot, slot.selected_player_id, slot.selection_state]), [
    [0, 0, "QB", "not-a-QB", "selected"],
    [1, 1, "FLEX", "0", "empty"],
    [2, 3, "FLEX", "receiver", "selected"],
    [3, 4, "WR", null, "missing"],
  ]);
  assert.equal(lineup[0]!.player!.metadata_available, false);
  assert.equal(lineup[0]!.player!.name, null);
});

test("rosters separate actual bench/reserve/taxi and retain ownerless/co-owned players", async () => {
  const { service } = setup();
  const snapshot = await service.getLeagueRosters({ leagueId: "league-1" }) as Json;
  const [team, orphan] = rows(snapshot, "rosters");
  assert.deepEqual(team!.selected_lineup.map((slot: Json) => slot.selected_player_id), ["p1", "p2", "0", "p3"]);
  assert.deepEqual(team!.bench.map((p: Json) => p.player_id), ["bench"]);
  assert.deepEqual(team!.reserve.map((p: Json) => p.player_id), ["ir"]);
  assert.deepEqual(team!.taxi.map((p: Json) => p.player_id), ["taxi"]);
  assert.equal(orphan!.owner_user_id, null);
  assert.deepEqual(orphan!.co_owner_user_ids, ["co-2"]);
  assert.deepEqual(orphan!.all_player_ids, ["p4", "orphan-ir", "orphan-taxi"]);
  assert.equal(orphan!.elimination_status, "unknown");
});

test("missing lineup cannot fabricate a bench; known empty and missing selected slots differ", async () => {
  const { gateway, service } = setup();
  delete gateway.rosters[0]!.starters;
  const snapshot = await service.getLeagueRosters({ leagueId: "league-1" }) as Json;
  assert.equal(snapshot.rosters[0].lineup_available, false);
  assert.equal(snapshot.rosters[0].bench, null);
  assert.equal(snapshot.rosters[0].selected_lineup[0].selection_state, "missing");
  assert.equal(snapshot.rosters[1].selected_lineup[1].selection_state, "empty");
});

test("raw budgets and records distinguish missing from zero and do not invent remaining FAAB", async () => {
  const { service } = setup();
  const snapshot = await service.getLeagueRosters({ leagueId: "league-1" }) as Json;
  const [team, orphan] = rows(snapshot, "rosters");
  assert.equal(team!.record.wins, 0);
  assert.equal(orphan!.record.wins, null);
  assert.equal(team!.points_for, 102.34);
  assert.equal(team!.waiver_budget.roster_budget_used, 0);
  assert.equal(orphan!.waiver_budget.roster_budget_used, null);
  assert.equal(team!.waiver_budget.remaining, null);
  assert.equal(team!.settings.waiver_budget, 175);
  assert.equal(snapshot.league.waiver_budget, 100);
});

test("context recognizes coownership, returns all weekly scores and keeps historical lineup separate", async () => {
  const { gateway, service } = setup();
  const snapshot = await service.getLeagueContext({ leagueId: "league-1", user: "co-1" }) as Json;
  assert.deepEqual(gateway.matchupReads, [5]); // display_week was 6.
  assert.equal(snapshot.weekly.basis, "live_nfl_state");
  assert.equal(snapshot.weekly.lineup_basis, "requested_week_matchups_not_current_rosters");
  assert.deepEqual(snapshot.identity.roster_ids, [1]);
  assert.equal(snapshot.user_membership, "roster_owner_or_coowner");
  assert.equal(snapshot.current_user_rosters[0].selected_lineup[0].selected_player_id, "p1");
  assert.equal(snapshot.weekly.scores[0].selected_lineup[0].selected_player_id, "p2");
  assert.equal(snapshot.weekly.scores.length, 3);
  assert.equal(snapshot.weekly.scores[0].points, 0);
  assert.equal(snapshot.weekly.scores[0].custom_points, 0);
  assert.equal(snapshot.weekly.scores[2].points, null);
  assert.deepEqual(snapshot.weekly.scores[0].matchup_peer_roster_ids, [2]);
  assert.deepEqual(snapshot.weekly.scores[2].matchup_peer_roster_ids, []);
});

test("past seasons never reuse the new season's live week and explicit week remains usable", async () => {
  const { gateway, service } = setup();
  gateway.league.season = "2025";
  const missing = await service.getLeagueContext({ leagueId: "league-1" }) as Json;
  assert.equal(missing.weekly.week, null);
  assert.equal(missing.weekly.scores, null);
  assert.equal(missing.partial, true);
  assert.deepEqual(gateway.matchupReads, []);
  assert.match(missing.weekly.reason, /provide week/);
  gateway.stateFails = true;
  const explicit = await service.getLeagueContext({ leagueId: "league-1", week: 17 }) as Json;
  assert.equal(explicit.weekly.week, 17);
  assert.equal(explicit.weekly.basis, "explicit");
  assert.equal(explicit.partial, false);
  assert.deepEqual(gateway.matchupReads, [17]);
});

test("preseason, postseason and zero week do not silently become fantasy regular weeks", async () => {
  for (const [phase, week] of [["pre", 3], ["post", 1], ["off", 0], ["regular", 0]] as const) {
    const { gateway, service } = setup();
    gateway.state.season_type = phase;
    gateway.state.week = week;
    const snapshot = await service.getLeagueContext({ leagueId: "league-1" }) as Json;
    assert.equal(snapshot.weekly.week, null);
    assert.equal(snapshot.partial, true);
    assert.deepEqual(gateway.matchupReads, []);
  }
});

test("user or roster source failures are partial rather than empty ownership claims", async () => {
  const { gateway, service } = setup();
  gateway.rosterFailures.add("league-1");
  gateway.usersFail = true;
  const snapshot = await service.getLeagueContext({ leagueId: "league-1", user: "user-1", week: 5 }) as Json;
  assert.equal(snapshot.current_user_rosters, null);
  assert.equal(snapshot.roster_summaries, null);
  assert.equal(snapshot.user_membership, "unknown");
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.weekly.scores.length, 3);
  assert.equal(snapshot.sources["league/league-1/rosters"].status, "unavailable");
});

test("search scans beyond top 30, supports name/position and paginates deterministically", async () => {
  const { gateway, service } = setup();
  for (let i = 0; i < 80; i++) gateway.players[`deep-${i}`] = {
    player_id: `deep-${i}`, full_name: `Deep Receiver ${i}`, position: "WR", search_rank: 1000 + i,
  };
  const byName = await service.searchPlayers({ query: "Deep Receiver 79", positions: ["wr"] }) as Json;
  assert.deepEqual(rows(byName).map((p) => p.player_id), ["deep-79"]);
  const byId = await service.searchPlayers({ playerIds: ["deep-79"] }) as Json;
  assert.equal(byId.players[0].player_id, "deep-79");
  assert.equal(byId.players[0].sleeper_search_rank, 1079);
  assert.equal(byId.ownership_basis, "current_rosters");
  const first = await service.searchPlayers({ query: "Deep Receiver", limit: 30 }) as Json;
  const second = await service.searchPlayers({ query: "Deep Receiver", limit: 30, offset: 30 }) as Json;
  assert.equal(first.pagination.total_matches, 80);
  assert.equal(first.pagination.next_offset, 30);
  assert.equal(first.pagination.truncated, true);
  assert.equal(first.source_data_complete, true);
  assert.equal(second.players[0].player_id, "deep-30");
  assert.equal(new Set([...rows(first), ...rows(second)].map((p) => p.player_id)).size, 60);
});

test("cross-league search refreshes all ownership each call, including reserve/taxi and ownerless rosters", async () => {
  const { gateway, service } = setup();
  const before = await service.searchPlayers({ leagueIds: ["league-1", "league-2"], playerIds: ["p4", "p5", "orphan-ir", "orphan-taxi"] }) as Json;
  for (const id of ["p4", "orphan-ir", "orphan-taxi"]) {
    const player = rows(before).find((p) => p.player_id === id)!;
    assert.equal(player.ownership[0].status, "rostered");
    assert.equal(player.ownership[0].rosters[0].owner_user_id, null);
  }
  assert.equal(rows(before).find((p) => p.player_id === "p5")!.ownership[1].status, "unrostered");
  gateway.otherRosters[0]!.players!.push("p5");
  const after = await service.searchPlayers({ leagueIds: ["league-1", "league-2"], playerIds: ["p5"] }) as Json;
  assert.equal(after.players[0].ownership[1].status, "rostered");
  assert.deepEqual(gateway.rosterReads, ["league-1", "league-2", "league-1", "league-2"]);
  assert.equal(after.players[0].ownership[1].waiver_status, "unknown");
  assert.equal(after.players[0].ownership[1].lock_status, "unknown");
});

test("availability requires all selected leagues and follows real drops, not ownership disappearance", async () => {
  const { gateway, service } = setup();
  const options = { leagueIds: ["league-1", "league-2"], playerIds: ["p3", "p4", "p5"], availableOnly: true };
  assert.deepEqual(rows(await service.searchPlayers(options)).map((p) => p.player_id), ["p5"]);
  gateway.rosters[1]!.players = null;
  gateway.rosters[1]!.starters = null;
  gateway.rosters[1]!.reserve = null;
  gateway.rosters[1]!.taxi = null;
  assert.deepEqual(rows(await service.searchPlayers(options)).map((p) => p.player_id), ["p4", "p5"]);
});

test("failed or omitted roster lists never label a player unrostered", async () => {
  const { gateway, service } = setup();
  gateway.rosterFailures.add("league-2");
  let snapshot = await service.searchPlayers({ leagueIds: ["league-1", "league-2"], playerIds: ["p5"] }) as Json;
  assert.equal(snapshot.players[0].ownership[1].status, "unknown");
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.ownership_complete, false);
  snapshot = await service.searchPlayers({ leagueIds: ["league-1", "league-2"], availableOnly: true }) as Json;
  assert.deepEqual(snapshot.players, []);
  assert.equal(snapshot.source_data_complete, false);
  gateway.rosterFailures.clear();
  delete gateway.otherRosters[0]!.players;
  snapshot = await service.searchPlayers({ leagueIds: ["league-2"], playerIds: ["p5"] }) as Json;
  assert.equal(snapshot.players[0].ownership[0].status, "unknown");
  assert.equal(snapshot.partial, true);
});

test("catalog failure preserves explicit IDs and live ownership but cannot claim complete catalog search", async () => {
  const { gateway, service } = setup();
  gateway.catalogFails = true;
  gateway.catalogInfo.stale = true;
  const explicit = await service.searchPlayers({ leagueIds: ["league-1"], playerIds: ["p1", "unknown-id"] }) as Json;
  assert.equal(explicit.players.length, 2);
  assert.equal(explicit.partial, true);
  assert.equal(explicit.catalog_available, false);
  assert.equal(explicit.source_data_complete, false);
  assert.equal(rows(explicit).find((p) => p.player_id === "p1")!.ownership[0].status, "rostered");
  assert.equal(explicit.players[0].name, null);
  assert.equal(explicit.sources["players/nfl"].fetched_at, gateway.catalogInfo.fetched_at);
  assert.equal(explicit.sources["players/nfl"].stale, true);
  const catalog = await service.searchPlayers({ query: "Receiver" }) as Json;
  assert.deepEqual(catalog.players, []);
  assert.equal(catalog.pagination.total_matches, null);
  assert.equal(catalog.pagination.has_more, null);
  assert.equal(catalog.source_data_complete, false);
});

test("catalog freshness stays separate from live request time and external enrichment is unavailable", async () => {
  const { gateway, service } = setup();
  const snapshot = await service.getLeagueRosters({ leagueId: "league-1" }) as Json;
  assert.equal(snapshot.refreshed_at, new Date(NOW).toISOString());
  assert.equal(snapshot.sources["players/nfl"].fetched_at, gateway.catalogInfo.fetched_at);
  assert.equal(snapshot.sources["players/nfl"].expires_at, gateway.catalogInfo.expires_at);
  assert.equal(snapshot.sources["league/league-1/rosters"].fetched_at, snapshot.refreshed_at);
  assert.equal(snapshot.limitations.player_projections, "unavailable");
  assert.equal(snapshot.limitations.comprehensive_player_news, "unavailable");
});

function transactions(): SleeperTransaction[] {
  return [
    { transaction_id: "zero-bid", type: "waiver", status: "complete", created: 10, status_updated: 20, roster_ids: [1], adds: { p5: 1 }, drops: { p1: 1 }, settings: { waiver_bid: 0 } },
    { transaction_id: "trade", type: "trade", status: "complete", created: 30, roster_ids: [2, 3], adds: { p4: 3 }, drops: { p4: 2 }, draft_picks: [{ season: "2027", round: 1, roster_id: 1, previous_owner_id: 2, owner_id: 3 }], waiver_budget: [{ sender: 3, receiver: 2, amount: 25 }] },
    { transaction_id: "pending", type: "waiver", status: "pending", created: 40, roster_ids: [1], settings: { waiver_bid: 55, another_setting: 1 } },
    { transaction_id: "free-agent", type: "free_agent", status: "complete", created: 50, adds: { p3: 1 } },
    { transaction_id: "missing-bid", type: "waiver", status: "complete", created: 60, roster_ids: [3], adds: { p2: 3 } },
  ];
}

test("activity deduplicates weeks, filters before pagination, returns adds/drops and actual trade participants", async () => {
  const { gateway, service } = setup();
  const txs = transactions();
  gateway.transactions.set(5, txs);
  gateway.transactions.set(4, [{ ...txs[0]!, status: "pending", status_updated: 15 }, txs[1]!]);
  const all = await service.getLeagueActivity({ leagueId: "league-1", weeks: [5, 4, 5] }) as Json;
  assert.deepEqual(gateway.transactionReads, [5, 4]);
  assert.equal(all.pagination.total_matches, 5);
  assert.deepEqual(rows(all, "transactions").find((t) => t.transaction_id === "zero-bid")!.source_weeks, [4, 5]);
  assert.equal(rows(all, "transactions").find((t) => t.transaction_id === "zero-bid")!.status, "complete");
  const filtered = await service.getLeagueActivity({ leagueId: "league-1", weeks: [4, 5], types: ["waiver"], rosterIds: [1], limit: 1, offset: 1 }) as Json;
  assert.equal(filtered.pagination.total_matches, 2);
  assert.equal(filtered.transactions[0].transaction_id, "zero-bid");
  assert.equal(filtered.transactions[0].adds[0].player_id, "p5");
  assert.equal(filtered.transactions[0].drops[0].player_id, "p1");
  const playerFiltered = await service.getLeagueActivity({ leagueId: "league-1", weeks: [5], playerIds: ["p4"] }) as Json;
  assert.equal(playerFiltered.transactions.length, 1);
  assert.equal(playerFiltered.transactions[0].transaction_id, "trade");
  assert.deepEqual(playerFiltered.transactions[0].involved_roster_ids.sort(), [2, 3]);
  assert.equal(playerFiltered.transactions[0].draft_picks[0].roster_id, 1);
  assert.equal(playerFiltered.transactions[0].waiver_budget_transfers[0].amount, 25);
  const originalPickOwner = await service.getLeagueActivity({ leagueId: "league-1", weeks: [5], rosterIds: [1], types: ["trade"] }) as Json;
  assert.deepEqual(originalPickOwner.transactions, []);
});

test("completed waiver bids preserve zero, missing is null and pending bids are redacted even from raw", async () => {
  const { gateway, service } = setup();
  gateway.transactions.set(5, transactions());
  const snapshot = await service.getLeagueActivity({ leagueId: "league-1", weeks: [5] }) as Json;
  const zero = rows(snapshot, "transactions").find((t) => t.transaction_id === "zero-bid")!;
  const pending = rows(snapshot, "transactions").find((t) => t.transaction_id === "pending")!;
  const missing = rows(snapshot, "transactions").find((t) => t.transaction_id === "missing-bid")!;
  assert.equal(zero.completed_waiver_bid, 0);
  assert.equal(zero.settings.waiver_bid, 0);
  assert.equal(missing.completed_waiver_bid, null);
  assert.equal(pending.completed_waiver_bid, null);
  assert.equal(pending.settings.waiver_bid, undefined);
  assert.equal(pending.raw.settings.waiver_bid, undefined);
  assert.equal(pending.settings.another_setting, 1);
  assert.equal(gateway.transactions.get(5)![2]!.settings!.waiver_bid, 55, "Output redaction must not mutate the gateway response");
});

test("activity defaults to live and previous week, marks failed-week totals as lower bounds", async () => {
  const { gateway, service } = setup();
  gateway.transactions.set(5, transactions());
  gateway.transactionFailures.add(4);
  const snapshot = await service.getLeagueActivity({ leagueId: "league-1" }) as Json;
  assert.deepEqual(gateway.transactionReads, [5, 4]);
  assert.deepEqual(snapshot.weeks_read, [5]);
  assert.deepEqual(snapshot.weeks_unavailable, [4]);
  assert.equal(snapshot.coverage_complete, false);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.pagination.total_is_lower_bound, true);
  assert.equal(snapshot.transactions.length, 5);
});

test("past-season activity without explicit weeks never queries a wrong season week", async () => {
  const { gateway, service } = setup();
  gateway.league.season = "2025";
  const missing = await service.getLeagueActivity({ leagueId: "league-1" }) as Json;
  assert.equal(missing.transactions, null);
  assert.equal(missing.filters.weeks, null);
  assert.equal(missing.coverage_complete, false);
  assert.equal(missing.pagination.total_matches, null);
  assert.deepEqual(gateway.transactionReads, []);
  const explicit = await service.getLeagueActivity({ leagueId: "league-1", weeks: [17] }) as Json;
  assert.equal(explicit.coverage_complete, true);
  assert.deepEqual(explicit.transactions, []);
  assert.deepEqual(gateway.transactionReads, [17]);
});

test("all failed activity weeks are unavailable rather than a falsely empty history", async () => {
  const { gateway, service } = setup();
  gateway.transactionFailures.add(5);
  const snapshot = await service.getLeagueActivity({ leagueId: "league-1", weeks: [5] }) as Json;
  assert.equal(snapshot.transactions, null);
  assert.equal(snapshot.pagination.total_matches, null);
  assert.equal(snapshot.partial, true);
});

test("service boundary rejects invalid inputs before any endpoint requests", async () => {
  const { gateway, service } = setup();
  const invalid = [
    () => service.listLeagues({ user: " " }),
    () => service.listLeagues({ user: "user-1", season: "25" }),
    () => service.getLeagueRosters({ leagueId: "" }),
    () => service.getLeagueContext({ leagueId: "league-1", week: 0 }),
    () => service.getLeagueContext({ leagueId: "league-1", week: 23 }),
    () => service.searchPlayers({ availableOnly: true }),
    () => service.searchPlayers({ leagueIds: [] }),
    () => service.searchPlayers({ playerIds: Array(101).fill("p1") }),
    () => service.searchPlayers({ positions: Array(21).fill("WR") }),
    () => service.searchPlayers({ query: "" }),
    () => service.searchPlayers({ query: "a".repeat(121) }),
    () => service.searchPlayers({ limit: 0 }),
    () => service.searchPlayers({ limit: 101 }),
    () => service.searchPlayers({ offset: 0.5 }),
    () => service.searchPlayers({ offset: 100_001 }),
    () => service.getLeagueActivity({ leagueId: "league-1", weeks: [] }),
    () => service.getLeagueActivity({ leagueId: "league-1", weeks: [2.5] }),
    () => service.getLeagueActivity({ leagueId: "league-1", rosterIds: [0] }),
    () => service.getLeagueActivity({ leagueId: "league-1", types: ["unknown"] }),
  ];
  for (const run of invalid) await assert.rejects(run, LeagueContextError);
  assert.deepEqual(gateway.rosterReads, []);
  assert.deepEqual(gateway.transactionReads, []);
  assert.deepEqual(gateway.matchupReads, []);
  assert.deepEqual(gateway.leagueRequests, []);
});

test("caller cancellation is never swallowed into a partial success", async () => {
  const { gateway, service } = setup();
  const controller = new AbortController();
  controller.abort(new Error("Caller cancelled"));
  await assert.rejects(service.searchPlayers({ signal: controller.signal }), /Caller cancelled/);
  assert.deepEqual(gateway.rosterReads, []);
  const lateController = new AbortController();
  gateway.getPlayers = async () => {
    lateController.abort(new Error("Cancelled during catalog request"));
    return gateway.players;
  };
  await assert.rejects(service.searchPlayers({ signal: lateController.signal }), /Cancelled during catalog request/);
});
