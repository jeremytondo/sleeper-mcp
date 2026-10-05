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
  season_type?: string | null;
  sport: string;
  status: string;
  previous_league_id?: string | null;
  draft_id?: string | null;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
  metadata?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface SleeperNflState {
  season: string;
  season_type: string;
  week: number;
  display_week?: number | null;
  leg?: number | null;
  season_start_date?: string | null;
  previous_season?: string | null;
  league_season?: string | null;
  league_create_season?: string | null;
  [key: string]: unknown;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  custom_points?: number | null;
  starters?: string[] | null;
  players?: string[] | null;
  starters_points?: number[] | null;
  players_points?: Record<string, number> | null;
  [key: string]: unknown;
}

export interface SleeperTransactionDraftPick extends SleeperTradedPick {
  season: string;
  [key: string]: unknown;
}

export interface SleeperWaiverBudgetTransfer {
  sender: number;
  receiver: number;
  amount: number;
  [key: string]: unknown;
}

export interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  created?: number | null;
  status_updated?: number | null;
  creator?: string | null;
  leg?: number | null;
  roster_ids?: number[] | null;
  consenter_ids?: number[] | null;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  settings?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  waiver_budget?: SleeperWaiverBudgetTransfer[] | null;
  draft_picks?: SleeperTransactionDraftPick[] | null;
  [key: string]: unknown;
}

/** Timestamps describe the last successful catalog fetch, never a failed refresh. */
export interface PlayerCatalogInfo {
  fetched_at: string | null;
  expires_at: string | null;
  stale: boolean;
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
  getPlayerCatalogInfo?(): PlayerCatalogInfo;
}

/** League tools need these endpoints; existing draft-only gateways remain valid. */
export interface LeagueGateway extends SleeperGateway {
  getNflState(signal?: AbortSignal): Promise<SleeperNflState>;
  getUserLeagues(userId: string, season: string, signal?: AbortSignal): Promise<SleeperLeague[]>;
  getLeagueMatchups(leagueId: string, week: number, signal?: AbortSignal): Promise<SleeperMatchup[]>;
  getLeagueTransactions(leagueId: string, week: number, signal?: AbortSignal): Promise<SleeperTransaction[]>;
  getPlayerCatalogInfo(): PlayerCatalogInfo;
}
