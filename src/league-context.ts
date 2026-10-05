import type {
  LeagueGateway,
  SleeperLeague,
  SleeperMatchup,
  SleeperNflState,
  SleeperPlayers,
  SleeperRoster,
  SleeperTransaction,
  SleeperUser,
} from "./sleeper-types.js";

const NON_STARTER_SLOTS = new Set(["BN", "BENCH", "IR", "RESERVE", "TAXI"]);
const TRANSACTION_TYPES = new Set(["trade", "free_agent", "waiver"]);
const SCHEMA_VERSION = "2026-10-05";

interface RequestOptions { signal?: AbortSignal }
export interface ListLeaguesOptions extends RequestOptions { user: string; season?: string }
export interface LeagueRostersOptions extends RequestOptions { leagueId: string }
export interface LeagueContextOptions extends LeagueRostersOptions { user?: string; week?: number }
export interface SearchPlayersOptions extends RequestOptions {
  leagueIds?: string[];
  query?: string;
  positions?: string[];
  playerIds?: string[];
  availableOnly?: boolean;
  limit?: number;
  offset?: number;
}
export interface LeagueActivityOptions extends LeagueRostersOptions {
  weeks?: number[];
  types?: string[];
  rosterIds?: number[];
  playerIds?: string[];
  limit?: number;
  offset?: number;
}

export class LeagueContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueContextError";
  }
}

type SourceResult = {
  status: "ok" | "unavailable";
  fetched_at: string | null;
  checked_at: string;
  expires_at?: string | null;
  stale?: boolean;
  error?: string;
};

/** A scope belongs to one call, so concurrent calls never share freshness/partial state. */
class SnapshotScope {
  readonly startedAt: number;
  readonly sources: Record<string, SourceResult> = {};
  readonly issues: Array<{ source: string; message: string }> = [];

  constructor(readonly now: () => number, readonly signal?: AbortSignal) {
    this.startedAt = now();
    this.checkAbort();
  }

  checkAbort() { this.signal?.throwIfAborted(); }

  issue(source: string, message: string) { this.issues.push({ source, message }); }

  async read<T>(source: string, read: () => Promise<T>): Promise<T | null> {
    this.checkAbort();
    try {
      const value = await read();
      this.checkAbort();
      if (value === null || value === undefined) throw new Error("Sleeper returned no data.");
      const timestamp = new Date(this.now()).toISOString();
      this.sources[source] = { status: "ok", fetched_at: timestamp, checked_at: timestamp };
      return value;
    } catch (error) {
      this.checkAbort();
      const message = error instanceof Error ? error.message : String(error);
      this.sources[source] = {
        status: "unavailable", fetched_at: null,
        checked_at: new Date(this.now()).toISOString(), error: message,
      };
      this.issue(source, message);
      return null;
    }
  }

  async required<T>(source: string, read: () => Promise<T>): Promise<T> {
    const value = await this.read(source, read);
    if (value === null) {
      throw new LeagueContextError(`Unable to read ${source}: ${this.sources[source]?.error}`);
    }
    return value;
  }

  async catalog(gateway: LeagueGateway): Promise<SleeperPlayers | null> {
    const players = await this.read("players/nfl", () => gateway.getPlayers());
    const source = this.sources["players/nfl"]!;
    // Request time is not catalog fetch time: a successful request may use the daily cache.
    const info = gateway.getPlayerCatalogInfo();
    source.fetched_at = info.fetched_at;
    source.expires_at = info.expires_at;
    source.stale = info.stale;
    return players;
  }

  finish(payload: Record<string, unknown>): Record<string, unknown> {
    this.checkAbort();
    return {
      schema_version: SCHEMA_VERSION,
      source: "Sleeper read-only API",
      refreshed_at: new Date(this.now()).toISOString(),
      refresh_latency_ms: Math.max(0, this.now() - this.startedAt),
      partial: this.issues.length > 0,
      issues: this.issues,
      sources: this.sources,
      ...payload,
    };
  }
}

const LIMITATIONS = {
  player_projections: "unavailable",
  comprehensive_player_news: "unavailable",
  pending_private_waiver_bids: "unavailable",
  waiver_status: "unknown",
  lock_status: "unknown",
  elimination_status: "unknown",
};

export class LeagueContextService {
  private readonly now: () => number;

  constructor(private readonly sleeper: LeagueGateway, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async listLeagues(options: ListLeaguesOptions): Promise<Record<string, unknown>> {
    const userInput = identifier(options.user, "user");
    if (options.season !== undefined) validateSeason(options.season);
    const scope = new SnapshotScope(this.now, options.signal);
    const [user, state] = await Promise.all([
      scope.required(`user/${userInput}`, () => this.sleeper.getUser(userInput, options.signal)),
      options.season === undefined
        ? scope.required("state/nfl", () => this.sleeper.getNflState(options.signal))
        : Promise.resolve(null),
    ]);
    const season = options.season ?? state?.season;
    if (!season) throw new LeagueContextError("NFL state did not include a season; provide season explicitly.");
    validateSeason(season);
    const leagues = await scope.required(`user/${user.user_id}/leagues/nfl/${season}`,
      () => this.sleeper.getUserLeagues(user.user_id, season, options.signal));
    return scope.finish({
      identity: userIdentity(user),
      season,
      season_basis: options.season === undefined ? "live_nfl_state" : "explicit",
      leagues: leagues.map(leagueDetails),
      total: leagues.length,
      limitations: LIMITATIONS,
      interpretation_notes: [
        "This discovery call does not fetch rosters. Use get_league_context or get_league_rosters for fresh ownership and lineups.",
        "previous_league_id is a history link, not an instruction to silently substitute a different season.",
      ],
    });
  }

  async getLeagueRosters(options: LeagueRostersOptions): Promise<Record<string, unknown>> {
    const leagueId = identifier(options.leagueId, "leagueId");
    const scope = new SnapshotScope(this.now, options.signal);
    const [league, rosters, users, players] = await Promise.all([
      this.league(scope, leagueId), this.rosters(scope, leagueId), this.users(scope, leagueId),
      scope.catalog(this.sleeper),
    ]);
    return scope.finish({
      league: leagueDetails(league),
      roster_basis: "current_roster_snapshot",
      rosters: rosters?.map((roster) => rosterDetails(roster, league, users, players)) ?? null,
      total_rosters: rosters?.length ?? null,
      limitations: LIMITATIONS,
      interpretation_notes: rosterNotes(),
    });
  }

  async getLeagueContext(options: LeagueContextOptions): Promise<Record<string, unknown>> {
    const leagueId = identifier(options.leagueId, "leagueId");
    if (options.user !== undefined) identifier(options.user, "user");
    if (options.week !== undefined) integer(options.week, "week", 1, 22);
    const scope = new SnapshotScope(this.now, options.signal);
    const [league, rosters, users, players, user, state] = await Promise.all([
      this.league(scope, leagueId), this.rosters(scope, leagueId), this.users(scope, leagueId),
      scope.catalog(this.sleeper),
      options.user === undefined ? Promise.resolve(null)
        : scope.read(`user/${options.user}`, () => this.sleeper.getUser(options.user!, options.signal)),
      options.week === undefined
        ? scope.read("state/nfl", () => this.sleeper.getNflState(options.signal))
        : Promise.resolve(null),
    ]);
    const selection = resolveWeek(league, options.week, state);
    if (selection.week === null) scope.issue("weekly_context", selection.reason!);
    const matchups = selection.week === null ? null : await scope.read(
      `league/${leagueId}/matchups/${selection.week}`,
      () => this.sleeper.getLeagueMatchups(leagueId, selection.week!, options.signal));
    const ownedRosters = user && rosters
      ? rosters.filter((roster) => isOwner(roster, user.user_id)) : null;
    return scope.finish({
      league: leagueDetails(league),
      identity: user ? { ...userIdentity(user), roster_ids: ownedRosters?.map((r) => r.roster_id) ?? null } : null,
      user_membership: options.user === undefined ? "not_requested"
        : ownedRosters === null ? "unknown" : ownedRosters.length ? "roster_owner_or_coowner" : "no_owned_roster",
      current_user_rosters: ownedRosters?.map((r) => rosterDetails(r, league, users, players)) ?? null,
      roster_summaries: rosters?.map((r) => rosterSummary(r, league, users)) ?? null,
      weekly: {
        ...selection,
        season: league.season,
        lineup_basis: "requested_week_matchups_not_current_rosters",
        scores: matchups?.map((matchup) => weeklyScore(matchup, matchups, league, rosters, users, players)) ?? null,
        total_rosters: matchups?.length ?? null,
      },
      limitations: LIMITATIONS,
      interpretation_notes: [
        ...rosterNotes(),
        "Weekly starters and points come from that week's matchups; current roster ownership and selected starters are a separate, freshly read snapshot.",
        "All weekly scores are returned. A matchup group alone does not establish head-to-head rules, elimination, or a Chopped survivor.",
        "Live NFL week is used only for a matching season during the regular season. Supply week explicitly for other seasons or phases.",
      ],
    });
  }

  async searchPlayers(options: SearchPlayersOptions): Promise<Record<string, unknown>> {
    const leagueIds = stringList(options.leagueIds, "leagueIds", 10, 64);
    const playerIds = stringList(options.playerIds, "playerIds", 100, 64);
    const positions = stringList(options.positions, "positions", 20, 20)?.map((p) => p.toUpperCase());
    const query = options.query === undefined ? undefined : textInput(options.query, "query", 120).toLowerCase();
    if (options.availableOnly !== undefined && typeof options.availableOnly !== "boolean") {
      throw new LeagueContextError("availableOnly must be a boolean.");
    }
    if (options.availableOnly && !leagueIds?.length) {
      throw new LeagueContextError("availableOnly requires at least one leagueId.");
    }
    const page = pagination(options);
    const scope = new SnapshotScope(this.now, options.signal);
    const [players, ownership] = await Promise.all([
      scope.catalog(this.sleeper),
      Promise.all((leagueIds ?? []).map(async (leagueId) => {
        const rosters = await this.rosters(scope, leagueId);
        // Null means an explicitly empty Sleeper roster; an omitted field is not known empty.
        const complete = rosters !== null && rosters.every((r) => r.players !== undefined);
        if (rosters && !complete) scope.issue(`league/${leagueId}/ownership`, "Some roster player lists are missing; absence cannot establish availability.");
        const byPlayer = new Map<string, SleeperRoster[]>();
        for (const roster of rosters ?? []) {
          for (const id of ownedPlayerIds(roster)) byPlayer.set(id, [...(byPlayer.get(id) ?? []), roster]);
        }
        return { leagueId, byPlayer, complete };
      })),
    ]);
    const ids = playerIds ?? (players === null ? [] : Object.keys(players));
    const matches = ids.map((id) => {
      return {
        ...playerDetails(id, players),
        ownership: ownership.map(({ leagueId, byPlayer, complete }) => {
          const owners = byPlayer.get(id) ?? [];
          return {
            league_id: leagueId,
            status: owners.length ? "rostered" : complete ? "unrostered" : "unknown",
            rosters: owners.map((roster) => ({
              roster_id: roster.roster_id,
              owner_user_id: roster.owner_id ?? null,
              co_owner_user_ids: roster.co_owners ?? [],
            })),
            waiver_status: "unknown", lock_status: "unknown",
          };
        }),
      };
    }).filter((result) => {
      if (query && !`${result.player_id} ${result.name ?? ""}`.toLowerCase().includes(query)) return false;
      if (positions?.length && !positions.some((p) => result.positions.includes(p))) return false;
      if (options.availableOnly && !result.ownership.every((entry) => entry.status === "unrostered")) return false;
      return true;
    }).sort((a, b) => {
      const rank = (a.sleeper_search_rank ?? Number.MAX_SAFE_INTEGER) - (b.sleeper_search_rank ?? Number.MAX_SAFE_INTEGER);
      return rank || (a.name ?? a.player_id).localeCompare(b.name ?? b.player_id) || a.player_id.localeCompare(b.player_id);
    });
    const enumerable = players !== null || playerIds !== undefined;
    const metadataFilterIncomplete = (query !== undefined || Boolean(positions?.length)) &&
      (players === null || ids.some((id) => !players[id]));
    if (metadataFilterIncomplete) scope.issue("player_filters", "Missing player metadata may hide matches for name or position filters.");
    return scope.finish({
      filters: {
        league_ids: leagueIds ?? [], player_ids: playerIds ?? null,
        query: options.query ?? null, positions: positions ?? [],
        available_only: options.availableOnly ?? false,
        available_only_basis: "known_unrostered_in_all_requested_leagues",
      },
      players: matches.slice(page.offset, page.offset + page.limit),
      pagination: pageDetails(page, enumerable ? matches.length : null),
      catalog_available: players !== null,
      ownership_basis: "current_rosters",
      ownership_complete: ownership.every((entry) => entry.complete),
      source_data_complete: players !== null && enumerable && !metadataFilterIncomplete && ownership.every((entry) => entry.complete),
      limitations: LIMITATIONS,
      interpretation_notes: [
        "Search scans the player catalog directly, independently of any draft tool's top-player limit. Explicit IDs can be enriched even when unranked or inactive.",
        "Ordering uses Sleeper search_rank, not expert rankings or projections. Roster ownership is refreshed on every call, including reserve, taxi and ownerless teams.",
        "Search does not inspect ongoing draft picks. Use get_live_draft_context during a draft to account for selections not yet reflected on rosters.",
        "Unrostered does not guarantee an immediate add. Per-player waiver and lock states are unknown. available_only requires known unrostered status in every requested league.",
        "The player catalog is cached daily. Its own fetch and expiry timestamps appear under sources; a failed catalog cannot enumerate the entire player pool.",
      ],
    });
  }

  async getLeagueActivity(options: LeagueActivityOptions): Promise<Record<string, unknown>> {
    const leagueId = identifier(options.leagueId, "leagueId");
    const requestedWeeks = numberList(options.weeks, "weeks", 22, 1, 22);
    const rosterIds = numberList(options.rosterIds, "rosterIds", 100, 1, Number.MAX_SAFE_INTEGER);
    const playerIds = stringList(options.playerIds, "playerIds", 100, 64);
    const types = stringList(options.types, "types", 3, 32);
    if (types?.some((type) => !TRANSACTION_TYPES.has(type))) {
      throw new LeagueContextError("types must contain only trade, free_agent or waiver.");
    }
    const page = pagination(options);
    const scope = new SnapshotScope(this.now, options.signal);
    const [league, state, players] = await Promise.all([
      this.league(scope, leagueId),
      requestedWeeks === undefined ? scope.read("state/nfl", () => this.sleeper.getNflState(options.signal)) : Promise.resolve(null),
      scope.catalog(this.sleeper),
    ]);
    const selection = requestedWeeks === undefined ? resolveWeek(league, undefined, state) : null;
    const weeks = requestedWeeks ?? (selection?.week ? [selection.week, ...(selection.week > 1 ? [selection.week - 1] : [])] : null);
    if (weeks === null) scope.issue("activity_weeks", selection?.reason ?? "Provide explicit weeks.");
    const reads = await Promise.all((weeks ?? []).map(async (week) => ({
      week, transactions: await scope.read(`league/${leagueId}/transactions/${week}`,
        () => this.sleeper.getLeagueTransactions(leagueId, week, options.signal)),
    })));
    const deduped = new Map<string, { transaction: SleeperTransaction; weeks: Set<number> }>();
    for (const { week, transactions } of reads) {
      for (const transaction of transactions ?? []) {
        const previous = deduped.get(transaction.transaction_id);
        if (!previous) deduped.set(transaction.transaction_id, { transaction, weeks: new Set([week]) });
        else {
          previous.weeks.add(week);
          if (transactionTime(transaction) > transactionTime(previous.transaction)) previous.transaction = transaction;
        }
      }
    }
    const filtered = [...deduped.values()].filter(({ transaction }) => {
      if (types?.length && !types.includes(transaction.type)) return false;
      if (rosterIds?.length && !transactionRosterIds(transaction).some((id) => rosterIds.includes(id))) return false;
      if (playerIds?.length && !Object.keys({ ...transaction.adds, ...transaction.drops }).some((id) => playerIds.includes(id))) return false;
      return true;
    }).sort((a, b) => transactionTime(b.transaction) - transactionTime(a.transaction) ||
      a.transaction.transaction_id.localeCompare(b.transaction.transaction_id));
    const readableWeeks = reads.filter((read) => read.transactions !== null).map((read) => read.week);
    const coverageComplete = weeks !== null && readableWeeks.length === weeks.length;
    return scope.finish({
      league: leagueDetails(league),
      filters: { weeks, types: types ?? [], roster_ids: rosterIds ?? [], player_ids: playerIds ?? [] },
      weeks_basis: requestedWeeks === undefined ? "live_week_and_previous_week" : "explicit",
      weeks_read: readableWeeks,
      weeks_unavailable: reads.filter((read) => read.transactions === null).map((read) => read.week),
      coverage_complete: coverageComplete,
      transactions: readableWeeks.length ? filtered.slice(page.offset, page.offset + page.limit)
        .map(({ transaction, weeks: foundWeeks }) => transactionDetails(transaction, [...foundWeeks].sort((a, b) => a - b), players)) : null,
      pagination: {
        ...pageDetails(page, readableWeeks.length ? filtered.length : null),
        total_is_lower_bound: !coverageComplete,
      },
      limitations: LIMITATIONS,
      interpretation_notes: [
        "Only the requested weeks are read; the default is the live regular-season week and its preceding week for the same season.",
        "Transactions are deduplicated by transaction_id, filtered, then sorted by latest status update (or creation) before pagination. Pagination is a fresh snapshot and can shift as transactions change.",
        "completed_waiver_bid is an exposed bid on a completed waiver only. Missing bids stay null, and a zero bid remains zero. waiver_bid is omitted from settings and raw data for non-completed transactions. Private pending claims and losing bids are not inferred.",
        "Raw transaction settings, draft-pick movement and waiver-budget transfers are preserved. Transactions do not establish a team's normalized remaining FAAB balance.",
      ],
    });
  }

  private async league(scope: SnapshotScope, leagueId: string) {
    const league = await scope.required(`league/${leagueId}`, () => this.sleeper.getLeague(leagueId, scope.signal));
    if (league.sport !== "nfl") throw new LeagueContextError("These league tools support NFL leagues only.");
    return league;
  }
  private rosters(scope: SnapshotScope, leagueId: string) {
    return scope.read(`league/${leagueId}/rosters`, () => this.sleeper.getLeagueRosters(leagueId, scope.signal));
  }
  private users(scope: SnapshotScope, leagueId: string) {
    return scope.read(`league/${leagueId}/users`, () => this.sleeper.getLeagueUsers(leagueId, scope.signal));
  }
}

function identifier(value: unknown, name: string): string { return textInput(value, name, 64); }
function textInput(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new LeagueContextError(`${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LeagueContextError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
function validateSeason(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) throw new LeagueContextError("season must be a four-digit year.");
}
function stringList(value: unknown, name: string, max: number, itemMax: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new LeagueContextError(`${name} must contain 1 to ${max} values when provided.`);
  }
  return [...new Set(value.map((entry) => textInput(entry, name, itemMax)))];
}
function numberList(value: unknown, name: string, max: number, minValue: number, maxValue: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new LeagueContextError(`${name} must contain 1 to ${max} values when provided.`);
  }
  return [...new Set(value.map((entry) => integer(entry, name, minValue, maxValue)))];
}
function pagination(options: { limit?: number; offset?: number }) {
  return { limit: integer(options.limit ?? 50, "limit", 1, 100), offset: integer(options.offset ?? 0, "offset", 0, 100_000) };
}
function pageDetails(page: { limit: number; offset: number }, total: number | null) {
  const hasMore = total === null ? null : page.offset + page.limit < total;
  return {
    ...page, total_matches: total, has_more: hasMore,
    truncated: total === null ? null : page.offset > 0 || hasMore,
    next_offset: hasMore ? page.offset + page.limit : null,
  };
}

function userIdentity(user: SleeperUser) {
  return { user_id: user.user_id, username: user.username ?? null, display_name: user.display_name ?? null };
}
function leagueDetails(league: SleeperLeague) {
  return {
    league_id: league.league_id, name: league.name, season: league.season,
    sport: league.sport, status: league.status, season_type: league.season_type ?? null,
    draft_id: league.draft_id ?? null, previous_league_id: league.previous_league_id ?? null,
    roster_positions: league.roster_positions,
    scoring_settings: league.scoring_settings,
    league_settings: league.settings,
    metadata: league.metadata ?? null,
    scoring_summary: {
      points_per_reception: league.scoring_settings?.rec ?? null,
      passing_touchdown_points: league.scoring_settings?.pass_td ?? null,
      note: "A summary only; full scoring_settings are authoritative.",
    },
    waiver_budget: league.settings?.waiver_budget ?? null,
  };
}
function resolveWeek(league: SleeperLeague, explicit: number | undefined, state: SleeperNflState | null) {
  if (explicit !== undefined) return { week: explicit, basis: "explicit", reason: null };
  if (!state) return { week: null, basis: "unavailable", reason: "NFL state is unavailable; provide week (or activity weeks) explicitly." };
  if (String(state.season) !== league.season) {
    return { week: null, basis: "unavailable", reason: `League season ${league.season} differs from live NFL season ${state.season}; provide week (or activity weeks) explicitly.` };
  }
  if (state.season_type !== "regular" || (league.season_type && league.season_type !== "regular")) {
    return { week: null, basis: "unavailable", reason: "A regular-season week cannot be safely inferred in this season phase; provide week (or activity weeks) explicitly." };
  }
  if (!Number.isInteger(state.week) || state.week < 1 || state.week > 22) {
    return { week: null, basis: "unavailable", reason: "NFL state has no usable regular-season week; provide week (or activity weeks) explicitly." };
  }
  return { week: state.week, basis: "live_nfl_state", reason: null };
}
function isOwner(roster: SleeperRoster, userId: string) {
  return roster.owner_id === userId || roster.co_owners?.includes(userId) === true;
}
function validPlayerIds(ids: string[] | null | undefined): string[] {
  return (ids ?? []).filter((id) => id !== "0" && id.length > 0);
}
function ownedPlayerIds(roster: SleeperRoster): string[] {
  return [...new Set([
    ...validPlayerIds(roster.players), ...validPlayerIds(roster.starters),
    ...validPlayerIds(roster.reserve), ...validPlayerIds(roster.taxi),
  ])];
}
function playerDetails(id: string, players: SleeperPlayers | null) {
  const player = players?.[id];
  const name = player?.full_name || [player?.first_name, player?.last_name].filter(Boolean).join(" ") || null;
  const rank = player?.search_rank;
  return {
    player_id: id, name,
    positions: [...new Set([player?.position, ...(player?.fantasy_positions ?? [])].filter((p): p is string => Boolean(p)))],
    position: player?.position ?? null,
    fantasy_positions: player?.fantasy_positions ?? null,
    nfl_team: player?.team ?? null,
    status: player?.status ?? null, active: player?.active ?? null,
    injury_status: player?.injury_status ?? null,
    age: player?.age ?? null, years_experience: player?.years_exp ?? null,
    sleeper_search_rank: typeof rank === "number" && Number.isFinite(rank) && rank > 0 ? rank : null,
    metadata_available: player !== undefined,
  };
}

/** Ordered, actual selections. This deliberately does not optimize/guess player eligibility. */
export function buildSelectedLineup(rosterPositions: string[], starters: string[] | null | undefined, players: SleeperPlayers = {}) {
  let starterIndex = 0;
  return rosterPositions.flatMap((slot, rosterPositionIndex) => {
    if (NON_STARTER_SLOTS.has(slot.toUpperCase())) return [];
    const index = starterIndex++;
    const id = starters?.[index] ?? null;
    return [{
      starter_index: index,
      roster_position_index: rosterPositionIndex,
      slot,
      selected_player_id: id,
      selection_state: id === null ? "missing" : id === "0" || id === "" ? "empty" : "selected",
      player: id === null || id === "0" || id === "" ? null : playerDetails(id, players),
    }];
  });
}
function rosterSummary(roster: SleeperRoster, league: SleeperLeague, users: SleeperUser[] | null) {
  const owner = users?.find((u) => u.user_id === roster.owner_id);
  return {
    roster_id: roster.roster_id,
    owner_user_id: roster.owner_id ?? null,
    owner: owner ? userIdentity(owner) : null,
    co_owner_user_ids: roster.co_owners ?? [],
    co_owners: (roster.co_owners ?? []).map((id) => {
      const user = users?.find((u) => u.user_id === id);
      return user ? userIdentity(user) : { user_id: id, username: null, display_name: null };
    }),
    team_name: owner?.metadata?.team_name ?? roster.metadata?.team_name ?? null,
    settings: roster.settings ?? null,
    metadata: roster.metadata ?? null,
    record: { wins: roster.settings?.wins ?? null, losses: roster.settings?.losses ?? null, ties: roster.settings?.ties ?? null },
    points_for: pointsWithFraction(roster.settings, "fpts", "fpts_decimal"),
    points_against: pointsWithFraction(roster.settings, "fpts_against", "fpts_against_decimal"),
    waiver_budget: {
      league_budget: league.settings?.waiver_budget ?? null,
      roster_budget_used: roster.settings?.waiver_budget_used ?? null,
      remaining: null,
      remaining_status: "not_normalized_adjustments_or_trades_may_apply",
    },
    elimination_status: "unknown",
  };
}
function pointsWithFraction(settings: Record<string, number> | null | undefined, whole: string, fraction: string): number | null {
  if (settings?.[whole] === undefined || settings[whole] === null) return null;
  return settings[whole] + (settings[fraction] ?? 0) / 100;
}
function rosterDetails(roster: SleeperRoster, league: SleeperLeague, users: SleeperUser[] | null, players: SleeperPlayers | null) {
  const starterIds = validPlayerIds(roster.starters);
  const reserveIds = validPlayerIds(roster.reserve);
  const taxiIds = validPlayerIds(roster.taxi);
  const notBench = new Set([...starterIds, ...reserveIds, ...taxiIds]);
  const benchIds = validPlayerIds(roster.players).filter((id) => !notBench.has(id));
  const selectedLineup = buildSelectedLineup(league.roster_positions, roster.starters, players ?? {});
  return {
    ...rosterSummary(roster, league, users),
    basis: "current_roster_snapshot",
    roster_player_ids_raw: roster.players ?? null,
    selected_starter_ids_raw: roster.starters ?? null,
    all_player_ids: ownedPlayerIds(roster),
    players: ownedPlayerIds(roster).map((id) => playerDetails(id, players)),
    lineup_available: Array.isArray(roster.starters),
    selected_lineup: selectedLineup,
    bench: roster.players === undefined || selectedLineup.some((slot) => slot.selection_state === "missing")
      ? null : [...new Set(benchIds)].map((id) => playerDetails(id, players)),
    reserve: [...new Set(reserveIds)].map((id) => playerDetails(id, players)),
    taxi: [...new Set(taxiIds)].map((id) => playerDetails(id, players)),
  };
}
function weeklyScore(matchup: SleeperMatchup, matchups: SleeperMatchup[], league: SleeperLeague, rosters: SleeperRoster[] | null, users: SleeperUser[] | null, players: SleeperPlayers | null) {
  const roster = rosters?.find((r) => r.roster_id === matchup.roster_id);
  const peers = matchup.matchup_id === null || matchup.matchup_id === undefined ? []
    : matchups.filter((m) => m.matchup_id === matchup.matchup_id && m.roster_id !== matchup.roster_id).map((m) => m.roster_id);
  return {
    roster_id: matchup.roster_id,
    current_owner_user_id: roster?.owner_id ?? null,
    current_team_name: roster ? rosterSummary(roster, league, users).team_name : null,
    matchup_id: matchup.matchup_id ?? null,
    matchup_peer_roster_ids: peers,
    points: matchup.points ?? null,
    custom_points: matchup.custom_points ?? null,
    player_ids: matchup.players ?? null,
    selected_starter_ids_raw: matchup.starters ?? null,
    selected_lineup: buildSelectedLineup(league.roster_positions, matchup.starters, players ?? {}),
    starters_points: matchup.starters_points ?? null,
    players_points: matchup.players_points ?? null,
  };
}
function transactionTime(transaction: SleeperTransaction): number {
  return transaction.status_updated ?? transaction.created ?? 0;
}
function transactionRosterIds(transaction: SleeperTransaction): number[] {
  return [...new Set([
    ...(transaction.roster_ids ?? []), ...Object.values(transaction.adds ?? {}), ...Object.values(transaction.drops ?? {}),
    ...(transaction.waiver_budget ?? []).flatMap((transfer) => [transfer.sender, transfer.receiver]),
    ...(transaction.draft_picks ?? []).flatMap((pick) => [pick.owner_id, pick.previous_owner_id]),
  ].filter((id): id is number => typeof id === "number" && Number.isInteger(id)))];
}
function transactionDetails(transaction: SleeperTransaction, weeks: number[], players: SleeperPlayers | null) {
  const completedWaiver = transaction.type === "waiver" && transaction.status === "complete";
  const settings = transaction.settings ? { ...transaction.settings } : null;
  if (!completedWaiver && settings) delete settings.waiver_bid;
  const raw = transaction.settings ? { ...transaction, settings } : transaction;
  return {
    transaction_id: transaction.transaction_id,
    type: transaction.type, status: transaction.status,
    source_weeks: weeks,
    roster_ids: transaction.roster_ids ?? null,
    involved_roster_ids: transactionRosterIds(transaction),
    consenter_ids: transaction.consenter_ids ?? null,
    created: transaction.created ?? null, status_updated: transaction.status_updated ?? null,
    adds: Object.entries(transaction.adds ?? {}).map(([id, rosterId]) => ({ ...playerDetails(id, players), roster_id: rosterId })),
    drops: Object.entries(transaction.drops ?? {}).map(([id, rosterId]) => ({ ...playerDetails(id, players), roster_id: rosterId })),
    completed_waiver_bid: completedWaiver
      ? transaction.settings?.waiver_bid ?? null : null,
    draft_picks: transaction.draft_picks ?? null,
    waiver_budget_transfers: transaction.waiver_budget ?? null,
    settings,
    metadata: transaction.metadata ?? null,
    raw,
  };
}
function rosterNotes(): string[] {
  return [
    "Selected starters retain their order against starting roster positions, including repeated FLEX slots and empty '0' entries. These are actual selections, not inferred positional fits.",
    "Bench excludes selected starters, reserve and taxi. Current player lists and raw settings are preserved; missing numeric data is null, not zero.",
    "Ownerless rosters still hold their players. No elimination status is inferred from ownership or a low score.",
    "League budget and roster waiver_budget_used are raw fields. Remaining FAAB is not normalized because budget trades or commissioner adjustments may apply.",
    "Player enrichment uses the daily catalog and may reflect today's metadata even for a historical lineup. Projections and comprehensive news require a separate source.",
  ];
}
