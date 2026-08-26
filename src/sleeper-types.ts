export interface SleeperUser {
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  metadata?: Record<string, string> | null;
}

export interface SleeperDraft {
  draft_id: string;
  league_id?: string | null;
  status: string;
  type: string;
  sport: string;
  season: string;
  last_picked?: number | null;
  start_time?: number | null;
  settings: {
    teams?: number;
    rounds?: number;
    pick_timer?: number;
    [key: string]: unknown;
  };
  metadata?: Record<string, string> | null;
  slot_to_roster_id?: Record<string, number> | null;
}

export interface SleeperDraftPick {
  player_id: string;
  picked_by?: string | null;
  roster_id?: number | string | null;
  round: number;
  draft_slot: number;
  pick_no: number;
  metadata?: Record<string, string> | null;
  is_keeper?: boolean | null;
  draft_id: string;
}

export interface SleeperTradedPick {
  round: number;
  roster_id: number;
  previous_owner_id?: number;
  owner_id: number;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  sport: string;
  status: string;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
  metadata?: Record<string, string> | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id?: string | null;
  co_owners?: string[] | null;
  players?: string[] | null;
  starters?: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  metadata?: Record<string, string> | null;
  settings?: Record<string, number> | null;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  number?: number | null;
  age?: number | null;
  years_exp?: number | null;
  status?: string | null;
  active?: boolean;
  injury_status?: string | null;
  search_rank?: number | null;
}

export type SleeperPlayers = Record<string, SleeperPlayer>;

export interface SleeperGateway {
  getUser(user: string, signal?: AbortSignal): Promise<SleeperUser>;
  getDraft(draftId: string, signal?: AbortSignal): Promise<SleeperDraft>;
  getDraftPicks(draftId: string, signal?: AbortSignal): Promise<SleeperDraftPick[]>;
  getTradedPicks(draftId: string, signal?: AbortSignal): Promise<SleeperTradedPick[]>;
  getLeague(leagueId: string, signal?: AbortSignal): Promise<SleeperLeague>;
  getLeagueRosters(leagueId: string, signal?: AbortSignal): Promise<SleeperRoster[]>;
  getLeagueUsers(leagueId: string, signal?: AbortSignal): Promise<SleeperUser[]>;
  getPlayers(): Promise<SleeperPlayers>;
}
