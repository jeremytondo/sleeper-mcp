import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperGateway,
  SleeperLeague,
  SleeperPlayers,
  SleeperRoster,
  SleeperTradedPick,
  SleeperUser,
} from "../src/sleeper-types.js";

export const NOW = Date.parse("2026-08-25T22:00:00.000Z");

export class FixtureSleeperGateway implements SleeperGateway {
  readonly user: SleeperUser = {
    user_id: "user-1",
    username: "jeremy",
    display_name: "Jeremy",
    metadata: { team_name: "Clock Beaters" },
  };

  readonly draft: SleeperDraft = {
    draft_id: "draft-1",
    league_id: "league-1",
    status: "drafting",
    type: "snake",
    sport: "nfl",
    season: "2026",
    last_picked: NOW - 10_000,
    settings: { teams: 2, rounds: 3, pick_timer: 60 },
    slot_to_roster_id: { "1": 1, "2": 2 },
  };

  readonly picks: SleeperDraftPick[] = [
    {
      draft_id: "draft-1",
      player_id: "p1",
      picked_by: "user-1",
      roster_id: 1,
      round: 1,
      draft_slot: 1,
      pick_no: 1,
      metadata: { position: "QB" },
    },
    {
      draft_id: "draft-1",
      player_id: "p2",
      picked_by: "user-2",
      roster_id: 2,
      round: 1,
      draft_slot: 2,
      pick_no: 2,
      metadata: { position: "RB" },
    },
  ];

  readonly league: SleeperLeague = {
    league_id: "league-1",
    name: "Prototype League",
    season: "2026",
    sport: "nfl",
    status: "drafting",
    roster_positions: ["QB", "RB", "WR", "FLEX", "BN"],
    scoring_settings: { rec: 1, pass_td: 4 },
    settings: { num_teams: 2 },
  };

  readonly rosters: SleeperRoster[] = [
    { roster_id: 1, owner_id: "user-1" },
    { roster_id: 2, owner_id: "user-2" },
  ];

  readonly users: SleeperUser[] = [
    this.user,
    {
      user_id: "user-2",
      username: "opponent",
      display_name: "Opponent",
      metadata: { team_name: "Other Team" },
    },
  ];

  readonly tradedPicks: SleeperTradedPick[] = [
    { round: 2, roster_id: 2, previous_owner_id: 2, owner_id: 1 },
  ];

  readonly players: SleeperPlayers = {
    p1: {
      player_id: "p1",
      full_name: "Drafted Quarterback",
      position: "QB",
      fantasy_positions: ["QB"],
      team: "KC",
      active: true,
      search_rank: 1,
    },
    p2: {
      player_id: "p2",
      full_name: "Drafted Running Back",
      position: "RB",
      fantasy_positions: ["RB"],
      team: "DET",
      active: true,
      search_rank: 2,
    },
    p3: {
      player_id: "p3",
      full_name: "Available Receiver",
      position: "WR",
      fantasy_positions: ["WR"],
      team: "MIN",
      active: true,
      search_rank: 3,
    },
    p4: {
      player_id: "p4",
      full_name: "Available Running Back",
      position: "RB",
      fantasy_positions: ["RB"],
      team: "GB",
      active: true,
      search_rank: 4,
    },
    p5: {
      player_id: "p5",
      full_name: "Available Quarterback",
      position: "QB",
      fantasy_positions: ["QB"],
      team: "BUF",
      active: true,
      search_rank: 5,
    },
  };

  async getUser(): Promise<SleeperUser> {
    return this.user;
  }

  async getDraft(): Promise<SleeperDraft> {
    return this.draft;
  }

  async getDraftPicks(): Promise<SleeperDraftPick[]> {
    return this.picks;
  }

  async getTradedPicks(): Promise<SleeperTradedPick[]> {
    return this.tradedPicks;
  }

  async getLeague(): Promise<SleeperLeague> {
    return this.league;
  }

  async getLeagueRosters(): Promise<SleeperRoster[]> {
    return this.rosters;
  }

  async getLeagueUsers(): Promise<SleeperUser[]> {
    return this.users;
  }

  async getPlayers(): Promise<SleeperPlayers> {
    return this.players;
  }
}
