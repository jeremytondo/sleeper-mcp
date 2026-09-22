import assert from "node:assert/strict";
import test from "node:test";

import { DraftContextService } from "../src/draft-context.js";
import { FixtureSleeperGateway, NOW } from "./fixtures.js";

const contextOptions = { draftId: "draft-1", user: "user-1", availableLimitPerPosition: 30 };

function inSeasonGateway() {
  const gateway = new FixtureSleeperGateway();
  gateway.draft.status = "complete";
  gateway.league.status = "in_season";
  gateway.rosters[0]!.players = ["p1"];
  gateway.rosters[1]!.players = ["p2"];
  return gateway;
}

function availablePlayers(snapshot: Record<string, unknown>) {
  return Object.values(snapshot.available_players_by_position as Record<
    string, Array<Record<string, unknown>>
  >).flat();
}

function availableIds(snapshot: Record<string, unknown>) {
  return new Set(availablePlayers(snapshot).map((player) => player.player_id));
}

function assertNoRosterOverlap(snapshot: Record<string, unknown>, gateway: FixtureSleeperGateway) {
  const available = availableIds(snapshot);
  for (const roster of gateway.rosters) {
    for (const id of [...(roster.players ?? []), ...(roster.reserve ?? []), ...(roster.taxi ?? [])]) {
      assert.equal(available.has(id), false, `${id} is both rostered and available`);
    }
  }
  const userTeam = snapshot.user_team as Record<string, unknown>;
  for (const player of userTeam.players as Array<Record<string, unknown>>) {
    assert.equal(available.has(player.player_id), false, `${player.player_id} is in both output lists`);
  }
}

test("a player drafted by Team A is unavailable while still on its roster", async () => {
  const gateway = inSeasonGateway();
  const snapshot = await new DraftContextService(gateway).getLiveDraftContext(contextOptions);

  assert.equal(availableIds(snapshot).has("p1"), false);
  assert.deepEqual(snapshot.availability, {
    basis: "current_rosters", waiver_status: "unknown", lock_status: "unknown",
  });
  assertNoRosterOverlap(snapshot, gateway);
});

test("a drafted player dropped by Team A becomes available without reappearing on its team", async () => {
  const gateway = inSeasonGateway();
  const service = new DraftContextService(gateway);
  assert.equal(availableIds(await service.getLiveDraftContext(contextOptions)).has("p1"), false);

  gateway.rosters[0]!.players = [];
  const snapshot = await service.getLiveDraftContext(contextOptions);

  assert.equal(availableIds(snapshot).has("p1"), true);
  const team = snapshot.user_team as Record<string, unknown>;
  assert.equal(team.rostered_count, 0);
  assert.deepEqual(team.players, []);
  assert.equal(team.drafted_count, 1);
  assert.equal((snapshot.draft_history as Array<Record<string, unknown>>)[0]!.player_id, "p1");
  assertNoRosterOverlap(snapshot, gateway);
});

test("Kirk Cousins added by Team B after the draft disappears on the next refresh", async () => {
  const gateway = inSeasonGateway();
  gateway.players.cousins = {
    player_id: "cousins", full_name: "Kirk Cousins", position: "QB",
    fantasy_positions: ["QB"], active: true, search_rank: 1,
  };
  const service = new DraftContextService(gateway);
  const before = await service.getLiveDraftContext(contextOptions);
  assert.equal(availableIds(before).has("cousins"), true);

  gateway.rosters[1]!.players!.push("cousins");
  const after = await service.getLiveDraftContext(contextOptions);
  assert.equal(availableIds(after).has("cousins"), false);
  assert.equal(availablePlayers(after).some((player) => player.name === "Kirk Cousins"), false);
  assertNoRosterOverlap(after, gateway);
});

test("a guillotine chop releases players only after Sleeper clears the roster", async () => {
  const gateway = inSeasonGateway();
  gateway.rosters[1]!.players = ["p2", "p3", "p4"];
  gateway.rosters[1]!.reserve = ["p3"];
  gateway.rosters[1]!.taxi = ["p4"];
  const service = new DraftContextService(gateway);

  // Losing an owner alone does not release a team's players.
  gateway.rosters[1]!.owner_id = null;
  const before = await service.getLiveDraftContext(contextOptions);
  for (const id of ["p2", "p3", "p4"]) assert.equal(availableIds(before).has(id), false);

  // Sleeper's chop releases the entire roster, including reserves.
  gateway.rosters[1]!.players = null;
  gateway.rosters[1]!.reserve = null;
  gateway.rosters[1]!.taxi = null;
  const after = await service.getLiveDraftContext(contextOptions);
  for (const id of ["p2", "p3", "p4"]) assert.equal(availableIds(after).has(id), true);
  assert.equal((after.other_teams as Array<Record<string, unknown>>)[0]!.rostered_count, 0);
  assertNoRosterOverlap(after, gateway);
});

test("a chopped player claimed by a surviving team is unavailable on the next refresh", async () => {
  const gateway = inSeasonGateway();
  gateway.rosters[1]!.players = [];
  const service = new DraftContextService(gateway);
  assert.equal(availableIds(await service.getLiveDraftContext(contextOptions)).has("p2"), true);

  gateway.rosters[0]!.players!.push("p2");
  const snapshot = await service.getLiveDraftContext(contextOptions);
  assert.equal(availableIds(snapshot).has("p2"), false);
  const team = snapshot.user_team as Record<string, unknown>;
  assert.deepEqual((team.players as Array<Record<string, unknown>>).map((p) => p.player_id), ["p1", "p2"]);
  assertNoRosterOverlap(snapshot, gateway);
});

test("roster/availability disjointness holds across refreshes, owners, reserve, taxi and positions", async () => {
  const gateway = inSeasonGateway();
  gateway.players.p3!.fantasy_positions = ["WR", "RB"];
  let rosterReads = 0;
  gateway.getLeagueRosters = async () => {
    rosterReads += 1;
    return structuredClone(gateway.rosters);
  };
  const service = new DraftContextService(gateway, { now: () => NOW });

  for (const id of Object.keys(gateway.players)) {
    for (const roster of gateway.rosters) {
      for (const field of ["players", "reserve", "taxi"] as const) {
        for (const team of gateway.rosters) {
          team.players = [];
          team.reserve = [];
          team.taxi = [];
        }
        roster[field] = [id];
        const snapshot = await service.getLiveDraftContext(contextOptions);
        assert.equal(availableIds(snapshot).size, Object.keys(gateway.players).length - 1);
        assertNoRosterOverlap(snapshot, gateway);
      }
    }
  }
  assert.equal(rosterReads, Object.keys(gateway.players).length * gateway.rosters.length * 3);
});

test("in-season league status overrides a stale active draft, and completed drafts ignore historical ownership", async () => {
  for (const [leagueStatus, draftStatus] of [
    ["in_season", "drafting"], ["complete", "drafting"], ["pre_draft", "complete"],
  ]) {
    const gateway = inSeasonGateway();
    gateway.league.status = leagueStatus!;
    gateway.draft.status = draftStatus!;
    gateway.rosters[0]!.players = [];
    const snapshot = await new DraftContextService(gateway).getLiveDraftContext(contextOptions);
    assert.equal(availableIds(snapshot).has("p1"), true);
    assertNoRosterOverlap(snapshot, gateway);
  }
});

test("active drafts exclude existing dynasty rosters as well as picks not yet on rosters", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.rosters[1]!.players = ["p3"];
  gateway.rosters[1]!.reserve = ["p4"];
  gateway.rosters[1]!.taxi = ["p5"];
  const snapshot = await new DraftContextService(gateway).getLiveDraftContext(contextOptions);
  assert.equal(availableIds(snapshot).size, 0);
  assertNoRosterOverlap(snapshot, gateway);
});

test("availability respects league positions, preserves injury metadata and includes unranked players last", async () => {
  const gateway = inSeasonGateway();
  gateway.league.roster_positions = ["SUPER_FLEX", "BN"];
  gateway.players.p3!.injury_status = "IR";
  gateway.players.p3!.status = "Injured Reserve";
  gateway.players.p5!.team = null;
  for (const [id, rank] of Object.entries({ unranked: undefined, zero: 0, invalid: NaN })) {
    gateway.players[id] = {
      player_id: id, full_name: id, position: "QB", fantasy_positions: ["QB"],
      active: true, search_rank: rank,
    };
  }
  gateway.players.inactive = { ...gateway.players.p5!, player_id: "inactive", active: false };
  gateway.players.kicker = { player_id: "kicker", position: "K", active: true, search_rank: 1 };
  const service = new DraftContextService(gateway);
  const snapshot = await service.getLiveDraftContext(contextOptions);
  const available = availableIds(snapshot);
  assert.equal(available.has("inactive"), false);
  assert.equal(available.has("kicker"), false);
  assert.equal(available.has("p5"), true);
  const receiver = availablePlayers(snapshot).find((player) => player.player_id === "p3")!;
  assert.equal(receiver.name, "Available Receiver");
  assert.equal(receiver.position, "WR");
  assert.deepEqual(receiver.fantasy_positions, ["WR"]);
  assert.equal(receiver.nfl_team, "MIN");
  assert.equal(receiver.injury_status, "IR");
  assert.equal(receiver.status, "Injured Reserve");
  assert.equal(receiver.sleeper_search_rank, 3);
  const qbs = (snapshot.available_players_by_position as Record<string, Array<Record<string, unknown>>>).QB!;
  assert.deepEqual(qbs.map((p) => p.player_id), ["p5", "invalid", "unranked", "zero"]);
  assert.deepEqual(qbs.map((p) => p.sleeper_search_rank), [5, null, null, null]);
  const limited = await service.getLiveDraftContext({ ...contextOptions, availableLimitPerPosition: 1 });
  assert.equal(availablePlayers(limited).filter((p) => p.position === "QB").length, 1);
});

test("a failed roster refresh fails the call instead of serving stale availability", async () => {
  const gateway = inSeasonGateway();
  const service = new DraftContextService(gateway);
  await service.getLiveDraftContext(contextOptions);
  gateway.getLeagueRosters = async () => { throw new Error("rosters unavailable"); };
  await assert.rejects(service.getLiveDraftContext(contextOptions), /rosters unavailable/);
});
