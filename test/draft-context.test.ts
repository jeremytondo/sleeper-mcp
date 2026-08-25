import assert from "node:assert/strict";
import test from "node:test";

import { DraftContextService } from "../src/draft-context.js";
import { FixtureSleeperGateway, NOW } from "./fixtures.js";

test("builds a fresh, league-aware snake draft snapshot", async () => {
  const service = new DraftContextService(new FixtureSleeperGateway(), { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({
    draftId: "draft-1",
    user: "jeremy",
    availableLimitPerPosition: 5,
  });

  assert.equal(snapshot.refreshed_at, "2026-08-25T22:00:00.000Z");
  assert.equal(snapshot.refresh_latency_ms, 0);

  const currentPick = snapshot.current_pick as Record<string, unknown>;
  assert.equal(currentPick.pick_no, 3);
  assert.equal(currentPick.round, 2);
  assert.equal(currentPick.draft_slot, 2);
  assert.equal(currentPick.user_is_on_clock, true);
  assert.equal(currentPick.picks_until_user_selection, 0);
  assert.equal(currentPick.clock_seconds_remaining, 50);

  const userTeam = snapshot.user_team as Record<string, unknown>;
  assert.equal(userTeam.drafted_count, 1);
  assert.deepEqual(userTeam.open_starter_slots, [
    { slot: "RB", open: 1 },
    { slot: "WR", open: 1 },
    { slot: "FLEX", open: 1 },
  ]);
  assert.deepEqual(userTeam.bench, { capacity: 1, filled: 0, open: 1 });

  const available = snapshot.available_players_by_position as Record<
    string,
    Array<Record<string, unknown>>
  >;
  assert.deepEqual(available.QB?.map((player) => player.player_id), ["p5"]);
  assert.deepEqual(available.RB?.map((player) => player.player_id), ["p4"]);
  assert.deepEqual(available.WR?.map((player) => player.player_id), ["p3"]);
  assert.equal(available.QB?.some((player) => player.player_id === "p1"), false);
});

test("reports auction nomination order as unsupported", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.draft.type = "auction";
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({
    draftId: "draft-1",
    user: "user-1",
  });

  const currentPick = snapshot.current_pick as Record<string, unknown>;
  assert.equal(currentPick.pick_no, null);
  assert.match(String(currentPick.note), /auction/i);
});

test("supports third-round reversal draft order", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.draft.settings.rounds = 4;
  gateway.draft.settings.reversal_round = 3;
  gateway.picks.push(
    {
      ...gateway.picks[0]!,
      player_id: "p3",
      round: 2,
      draft_slot: 2,
      pick_no: 3,
      roster_id: 2,
    },
    {
      ...gateway.picks[1]!,
      player_id: "p4",
      round: 2,
      draft_slot: 1,
      pick_no: 4,
      roster_id: 1,
    },
  );
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({
    draftId: "draft-1",
    user: "user-1",
  });

  const currentPick = snapshot.current_pick as Record<string, unknown>;
  assert.equal(currentPick.pick_no, 5);
  assert.equal(currentPick.round, 3);
  assert.equal(currentPick.draft_slot, 2);
  assert.equal(currentPick.user_is_on_clock, false);
});

test("future keeper tiles do not jump the live pick frontier", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.picks.push({
    ...gateway.picks[0]!,
    player_id: "p5",
    round: 3,
    draft_slot: 2,
    pick_no: 6,
    roster_id: 2,
    is_keeper: true,
  });
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const currentPick = snapshot.current_pick as Record<string, unknown>;
  const draft = snapshot.draft as Record<string, unknown>;

  assert.equal(currentPick.pick_no, 3);
  assert.equal(draft.filled_picks, 3);
  assert.equal(draft.live_picks_made, 2);
});

test("keeper tiles are excluded from picks until the user's next live selection", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.tradedPicks.length = 0;
  gateway.picks.push({
    ...gateway.picks[0]!,
    player_id: "p5",
    round: 2,
    draft_slot: 1,
    pick_no: 4,
    roster_id: 1,
    is_keeper: true,
  });
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const currentPick = snapshot.current_pick as Record<string, unknown>;

  assert.equal(currentPick.pick_no, 3);
  assert.equal(currentPick.user_next_pick_no, 5);
  assert.equal(currentPick.picks_until_user_selection, 1);
});

test("existing dynasty players count toward roster needs without duplicating new picks", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.rosters[0]!.players = ["p1", "p3"];
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const userTeam = snapshot.user_team as Record<string, unknown>;

  assert.equal(userTeam.drafted_count, 1);
  assert.equal(userTeam.rostered_count, 2);
  assert.deepEqual(userTeam.open_starter_slots, [
    { slot: "RB", open: 1 },
    { slot: "FLEX", open: 1 },
  ]);
  assert.equal((userTeam.players as unknown[]).length, 2);
});

test("finds a maximum assignment across overlapping flex slots", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.league.roster_positions = ["REC_FLEX", "WR_RB"];
  gateway.players.p6 = {
    player_id: "p6",
    full_name: "Existing Tight End",
    position: "TE",
    fantasy_positions: ["TE"],
    active: true,
    search_rank: 6,
  };
  gateway.rosters[0]!.players = ["p3", "p6"];
  gateway.picks.length = 0;
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const userTeam = snapshot.user_team as Record<string, unknown>;

  assert.deepEqual(userTeam.open_starter_slots, []);
});

test("uses draft start time for the first pick clock", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.picks.length = 0;
  gateway.draft.last_picked = null;
  gateway.draft.start_time = NOW - 5_000;
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const currentPick = snapshot.current_pick as Record<string, unknown>;

  assert.equal(currentPick.pick_no, 1);
  assert.equal(currentPick.clock_seconds_remaining, 55);
});

test("returns candidates for direct IDP slots", async () => {
  const gateway = new FixtureSleeperGateway();
  gateway.league.roster_positions = ["DE", "BN"];
  gateway.players.p6 = {
    player_id: "p6",
    full_name: "Available Edge",
    position: "DE",
    fantasy_positions: ["DE"],
    active: true,
    search_rank: 6,
  };
  const service = new DraftContextService(gateway, { now: () => NOW });

  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const available = snapshot.available_players_by_position as Record<string, unknown[]>;

  assert.equal((available.DE?.[0] as Record<string, unknown>).player_id, "p6");
});

test("retries once when a pick lands while the snapshot is loading", async () => {
  class RacingGateway extends FixtureSleeperGateway {
    draftReads = 0;

    override async getDraft() {
      this.draftReads += 1;
      return {
        ...this.draft,
        last_picked: this.draftReads === 1 ? NOW - 10_000 : NOW - 9_000,
      };
    }
  }

  const gateway = new RacingGateway();
  const service = new DraftContextService(gateway, { now: () => NOW });
  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });
  const currentPick = snapshot.current_pick as Record<string, unknown>;

  assert.equal(gateway.draftReads, 4);
  assert.equal(currentPick.clock_seconds_remaining, 51);
});

test("returns live draft state when the player catalog is temporarily unavailable", async () => {
  class CatalogFailureGateway extends FixtureSleeperGateway {
    override async getPlayers(): Promise<never> {
      throw new Error("catalog unavailable");
    }
  }

  const service = new DraftContextService(new CatalogFailureGateway(), { now: () => NOW });
  const snapshot = await service.getLiveDraftContext({ draftId: "draft-1", user: "user-1" });

  assert.equal((snapshot.current_pick as Record<string, unknown>).pick_no, 3);
  assert.deepEqual(snapshot.available_players_by_position, { QB: [], RB: [], TE: [], WR: [] });
  assert.match((snapshot.interpretation_notes as string[]).at(-1) ?? "", /unavailable/i);
});
