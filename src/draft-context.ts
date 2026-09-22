import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperGateway,
  SleeperLeague,
  SleeperPlayer,
  SleeperPlayers,
  SleeperRoster,
  SleeperTradedPick,
  SleeperUser,
} from "./sleeper-types.js";

const NON_DRAFT_SLOTS = new Set(["BN", "BENCH", "IR", "RESERVE", "TAXI"]);

const FLEX_POSITIONS: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRT: ["RB", "WR", "TE"],
  RB_WR_TE: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WR_TE: ["WR", "TE"],
  WR_RB: ["WR", "RB"],
  RB_WR: ["RB", "WR"],
  WRRB_FLEX: ["WR", "RB"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB", "DE", "DT", "CB", "S"],
  DL: ["DL", "DE", "DT"],
  DB: ["DB", "CB", "S"],
};

export interface DraftContextOptions {
  draftId: string;
  user: string;
  availableLimitPerPosition?: number;
  signal?: AbortSignal;
}

export interface DraftContextServiceOptions {
  now?: () => number;
}

export class DraftContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftContextError";
  }
}

export class DraftContextService {
  private readonly now: () => number;

  constructor(
    private readonly sleeper: SleeperGateway,
    options: DraftContextServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async getLiveDraftContext(options: DraftContextOptions): Promise<Record<string, unknown>> {
    return this.loadLiveDraftContext(options, this.now(), 0);
  }

  private async loadLiveDraftContext(
    options: DraftContextOptions,
    startedAt: number,
    attempt: number,
  ): Promise<Record<string, unknown>> {
    const limit = options.availableLimitPerPosition ?? 12;

    const [draft, picks, user] = await Promise.all([
      this.sleeper.getDraft(options.draftId, options.signal),
      this.sleeper.getDraftPicks(options.draftId, options.signal),
      this.sleeper.getUser(options.user, options.signal),
    ]);

    if (!draft.league_id) {
      throw new DraftContextError(`Draft ${options.draftId} is not attached to a league.`);
    }

    const [league, rosters, users, tradedPicks, players] = await Promise.all([
      this.sleeper.getLeague(draft.league_id, options.signal),
      this.sleeper.getLeagueRosters(draft.league_id, options.signal),
      this.sleeper.getLeagueUsers(draft.league_id, options.signal),
      this.sleeper.getTradedPicks(options.draftId, options.signal),
      this.sleeper.getPlayers().catch(() => ({} as SleeperPlayers)),
    ]);

    const [finalDraft, finalPicks] = await Promise.all([
      this.sleeper.getDraft(options.draftId, options.signal),
      this.sleeper.getDraftPicks(options.draftId, options.signal),
    ]);
    const stateChanged =
      finalDraft.last_picked !== draft.last_picked ||
      finalDraft.status !== draft.status ||
      pickSignature(finalPicks) !== pickSignature(picks);
    if (attempt === 0 && stateChanged) {
      return this.loadLiveDraftContext(options, startedAt, attempt + 1);
    }
    const snapshotPicks = stateChanged ? finalPicks : picks;

    const userRoster = rosters.find(
      (roster) =>
        roster.owner_id === user.user_id || roster.co_owners?.includes(user.user_id) === true,
    );

    if (!userRoster) {
      throw new DraftContextError(
        `${user.display_name ?? user.username ?? user.user_id} does not own a roster in league ${league.name}.`,
      );
    }

    const sortedPicks = [...snapshotPicks].sort((a, b) => a.pick_no - b.pick_no);
    // Picks supplement rosters while drafting, but are only history after the draft.
    const includeDraftPicks =
      league.status !== "in_season" &&
      league.status !== "complete" &&
      finalDraft.status !== "complete";
    const unavailableIds = new Set(
      rosters.flatMap((roster) => [
        ...(roster.players ?? []),
        ...(roster.reserve ?? []),
        ...(roster.taxi ?? []),
      ]),
    );
    if (includeDraftPicks) {
      for (const pick of sortedPicks) unavailableIds.add(pick.player_id);
    }
    const userPicks = sortedPicks.filter(
      (pick) => numericRosterId(pick.roster_id) === userRoster.roster_id,
    );
    const playerIndex = normalizePlayers(players);
    const currentPick = buildCurrentPick(
      finalDraft,
      sortedPicks,
      userRoster.roster_id,
      tradedPicks,
      rosters,
      users,
      this.now(),
    );

    const context = {
      schema_version: "2026-09-22",
      refreshed_at: new Date(this.now()).toISOString(),
      refresh_latency_ms: Math.max(0, this.now() - startedAt),
      source: "Sleeper read-only API",
      identity: {
        user_id: user.user_id,
        username: user.username ?? null,
        display_name: user.display_name ?? null,
        roster_id: userRoster.roster_id,
      },
      league: {
        league_id: league.league_id,
        name: league.name,
        season: league.season,
        sport: league.sport,
        status: league.status,
        roster_positions: league.roster_positions,
        scoring_settings: league.scoring_settings,
        league_settings: league.settings,
      },
      draft: {
        draft_id: finalDraft.draft_id,
        status: finalDraft.status,
        type: finalDraft.type,
        season: finalDraft.season,
        teams: finalDraft.settings.teams ?? rosters.length,
        rounds: finalDraft.settings.rounds ?? league.roster_positions.length,
        pick_timer_seconds: finalDraft.settings.pick_timer ?? null,
        filled_picks: sortedPicks.length,
        live_picks_made: sortedPicks.filter((pick) => pick.is_keeper !== true).length,
        total_picks:
          (finalDraft.settings.teams ?? rosters.length) *
          (finalDraft.settings.rounds ?? league.roster_positions.length),
      },
      current_pick: currentPick,
      user_team: buildTeamContext(
        userRoster, user, userPicks, league, playerIndex, true, includeDraftPicks,
      ),
      other_teams: rosters
        .filter((roster) => roster.roster_id !== userRoster.roster_id)
        .map((roster) => {
          const owner = ownerForRoster(roster, users);
          const rosterPicks = sortedPicks.filter(
            (pick) => numericRosterId(pick.roster_id) === roster.roster_id,
          );
          return buildTeamContext(
            roster, owner, rosterPicks, league, playerIndex, false, includeDraftPicks,
          );
        }),
      draft_history: sortedPicks.map((pick) => enrichPick(pick, playerIndex)),
      availability: {
        basis: includeDraftPicks ? "current_rosters_and_draft_picks" : "current_rosters",
        waiver_status: "unknown",
        lock_status: "unknown",
      },
      available_players_by_position: buildAvailablePlayers(
        playerIndex,
        unavailableIds,
        league.roster_positions,
        limit,
      ),
      interpretation_notes: [
        "This snapshot is live Sleeper context, not a recommendation.",
        includeDraftPicks
          ? "Availability excludes all current league rosters (including reserve and taxi) and draft picks while the draft is pending or active."
          : "Availability is recomputed from all current league rosters (including reserve and taxi); draft history does not determine ownership. Chopped players enter the pool only when Sleeper removes them from rosters.",
        "Available players are limited per position and ordered by Sleeper search_rank, with unranked players last; combine them with a separate rankings or research source before advising.",
        "The documented public Sleeper API does not expose per-player waiver or transaction lock state. These are unrostered candidates for league positions, not a guarantee of an immediate add or successful claim; waiver_status and lock_status are unknown. League waiver settings are returned in league.league_settings.",
        "Player metadata is cached daily, while draft, picks, rosters, users, league settings, and traded picks are refreshed on every call.",
        ...(playerIndex.size === 0
          ? ["The Sleeper player catalog was unavailable, so player enrichment and available-player lists may be empty; live draft state is still current."]
          : []),
      ],
    };

    return context;
  }
}

function numericRosterId(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickSignature(picks: SleeperDraftPick[]): string {
  return picks
    .map((pick) => `${pick.pick_no}:${pick.player_id}:${pick.roster_id ?? ""}:${pick.is_keeper === true}`)
    .sort()
    .join("|");
}

function normalizePlayers(players: SleeperPlayers): Map<string, SleeperPlayer> {
  return new Map(
    Object.entries(players).map(([id, player]) => [
      id,
      { ...player, player_id: player.player_id || id },
    ]),
  );
}

function playerPositions(player: SleeperPlayer | undefined, pick?: SleeperDraftPick): string[] {
  const positions = new Set<string>();
  if (player?.position) positions.add(player.position);
  for (const position of player?.fantasy_positions ?? []) positions.add(position);
  const pickPosition = pick?.metadata?.position;
  if (pickPosition) positions.add(pickPosition);
  return [...positions];
}

function playerName(player: SleeperPlayer | undefined, pick?: SleeperDraftPick): string {
  if (player?.full_name) return player.full_name;
  const fromPlayer = [player?.first_name, player?.last_name].filter(Boolean).join(" ");
  if (fromPlayer) return fromPlayer;
  const fromPick = [pick?.metadata?.first_name, pick?.metadata?.last_name]
    .filter(Boolean)
    .join(" ");
  return fromPick || pick?.player_id || "Unknown player";
}

function enrichPick(pick: SleeperDraftPick, players: Map<string, SleeperPlayer>) {
  const player = players.get(pick.player_id);
  return {
    pick_no: pick.pick_no,
    round: pick.round,
    draft_slot: pick.draft_slot,
    roster_id: numericRosterId(pick.roster_id) ?? null,
    picked_by_user_id: pick.picked_by || null,
    player_id: pick.player_id,
    player_name: playerName(player, pick),
    positions: playerPositions(player, pick),
    nfl_team: player?.team ?? pick.metadata?.team ?? null,
    injury_status: player?.injury_status ?? pick.metadata?.injury_status ?? null,
    is_keeper: pick.is_keeper ?? false,
  };
}

interface TeamPlayer {
  playerId: string;
  pick?: SleeperDraftPick;
}

function enrichTeamPlayer(teamPlayer: TeamPlayer, players: Map<string, SleeperPlayer>) {
  if (teamPlayer.pick) {
    return { ...enrichPick(teamPlayer.pick, players), source: "draft" };
  }
  const player = players.get(teamPlayer.playerId);
  return {
    player_id: teamPlayer.playerId,
    player_name: playerName(player),
    positions: playerPositions(player),
    nfl_team: player?.team ?? null,
    injury_status: player?.injury_status ?? null,
    source: "existing_roster",
  };
}

function buildTeamContext(
  roster: SleeperRoster,
  owner: SleeperUser,
  picks: SleeperDraftPick[],
  league: SleeperLeague,
  players: Map<string, SleeperPlayer>,
  includePlayers: boolean,
  includeDraftPicks: boolean,
) {
  const inactiveIds = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
  const rosterPicks = includeDraftPicks ? picks : [];
  const pickByPlayerId = new Map(rosterPicks.map((pick) => [pick.player_id, pick]));
  const activePlayerIds = [
    ...(roster.players ?? []),
    ...rosterPicks.map((pick) => pick.player_id),
  ].filter((playerId, index, all) =>
    !inactiveIds.has(playerId) && all.indexOf(playerId) === index
  );
  const teamPlayers = activePlayerIds.map((playerId) => ({
    playerId,
    pick: pickByPlayerId.get(playerId),
  }));
  const positionCounts: Record<string, number> = {};
  for (const teamPlayer of teamPlayers) {
    const primary = playerPositions(
      players.get(teamPlayer.playerId),
      teamPlayer.pick,
    )[0] ?? "UNKNOWN";
    positionCounts[primary] = (positionCounts[primary] ?? 0) + 1;
  }

  const result: Record<string, unknown> = {
    roster_id: roster.roster_id,
    owner_user_id: owner.user_id,
    owner_name: owner.display_name ?? owner.username ?? owner.user_id,
    team_name: owner.metadata?.team_name ?? null,
    drafted_count: picks.length,
    rostered_count: teamPlayers.length,
    reserve_count: roster.reserve?.length ?? 0,
    taxi_count: roster.taxi?.length ?? 0,
    position_counts: positionCounts,
  };

  if (includePlayers) {
    const assignments = assignLineupSlots(league.roster_positions, teamPlayers, players);
    result.lineup_slots = assignments.lineupSlots;
    result.open_starter_slots = assignments.openStarterSlots;
    result.bench = assignments.bench;
    result.players = teamPlayers.map((teamPlayer) => enrichTeamPlayer(teamPlayer, players));
  }

  return result;
}

function assignLineupSlots(
  rosterPositions: string[],
  teamPlayers: TeamPlayer[],
  players: Map<string, SleeperPlayer>,
) {
  const starterSlots = rosterPositions.filter((slot) => !NON_DRAFT_SLOTS.has(slot));
  const candidates = teamPlayers.map((teamPlayer) => ({
    teamPlayer,
    positions: playerPositions(players.get(teamPlayer.playerId), teamPlayer.pick),
  }));
  const candidateBySlot = new Map<number, number>();

  function assignCandidate(candidateIndex: number, visitedSlots: Set<number>): boolean {
    const candidate = candidates[candidateIndex];
    if (!candidate) return false;

    for (let slotIndex = 0; slotIndex < starterSlots.length; slotIndex += 1) {
      const slot = starterSlots[slotIndex];
      if (
        !slot ||
        visitedSlots.has(slotIndex) ||
        !candidate.positions.some((position) => eligiblePositions(slot).includes(position))
      ) {
        continue;
      }

      visitedSlots.add(slotIndex);
      const assignedCandidate = candidateBySlot.get(slotIndex);
      if (
        assignedCandidate === undefined ||
        assignCandidate(assignedCandidate, visitedSlots)
      ) {
        candidateBySlot.set(slotIndex, candidateIndex);
        return true;
      }
    }
    return false;
  }

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    assignCandidate(candidateIndex, new Set());
  }

  const grouped = new Map<string, { slot: string; filled: number; open: number }>();
  starterSlots.forEach((slot, index) => {
    const value = grouped.get(slot) ?? { slot, filled: 0, open: 0 };
    if (candidateBySlot.has(index)) value.filled += 1;
    else value.open += 1;
    grouped.set(slot, value);
  });

  const benchCapacity = rosterPositions.filter((slot) =>
    slot === "BN" || slot === "BENCH"
  ).length;
  const assignedCandidates = new Set(candidateBySlot.values());
  const unassignedCount = candidates.length - assignedCandidates.size;

  return {
    lineupSlots: [...grouped.values()],
    openStarterSlots: [...grouped.values()]
      .filter((slot) => slot.open > 0)
      .map(({ slot, open }) => ({ slot, open })),
    bench: {
      capacity: benchCapacity,
      filled: Math.min(benchCapacity, unassignedCount),
      open: Math.max(0, benchCapacity - unassignedCount),
    },
  };
}

function eligiblePositions(slot: string): string[] {
  return FLEX_POSITIONS[slot] ?? [slot];
}

function ownerForRoster(roster: SleeperRoster, users: SleeperUser[]): SleeperUser {
  return (
    users.find((user) => user.user_id === roster.owner_id) ?? {
      user_id: roster.owner_id ?? `roster-${roster.roster_id}`,
      display_name: `Roster ${roster.roster_id}`,
    }
  );
}

function buildAvailablePlayers(
  players: Map<string, SleeperPlayer>,
  unavailableIds: Set<string>,
  rosterPositions: string[],
  limit: number,
) {
  const usedPositions = new Set(
    rosterPositions
      .filter((slot) => !NON_DRAFT_SLOTS.has(slot))
      .flatMap((slot) => eligiblePositions(slot)),
  );
  const positions = [...usedPositions].sort();
  const result: Record<string, unknown[]> = {};

  for (const position of positions) {
    result[position] = [...players.values()]
      .filter((player) => {
        return (
          !unavailableIds.has(player.player_id) &&
          player.active !== false &&
          playerPositions(player).includes(position)
        );
      })
      .sort((a, b) => {
        const rankDifference = (playerSearchRank(a) ?? Number.MAX_SAFE_INTEGER) -
          (playerSearchRank(b) ?? Number.MAX_SAFE_INTEGER);
        return rankDifference || playerName(a).localeCompare(playerName(b));
      })
      .slice(0, limit)
      .map((player) => ({
        player_id: player.player_id,
        name: playerName(player),
        position: player.position ?? position,
        fantasy_positions: player.fantasy_positions ?? [position],
        nfl_team: player.team ?? null,
        injury_status: player.injury_status ?? null,
        status: player.status ?? null,
        age: player.age ?? null,
        years_experience: player.years_exp ?? null,
        sleeper_search_rank: playerSearchRank(player),
      }));
  }

  return result;
}

function playerSearchRank(player: SleeperPlayer): number | null {
  const rank = player.search_rank;
  return typeof rank === "number" && Number.isFinite(rank) && rank > 0 ? rank : null;
}

function buildCurrentPick(
  draft: SleeperDraft,
  picks: SleeperDraftPick[],
  userRosterId: number,
  tradedPicks: SleeperTradedPick[],
  rosters: SleeperRoster[],
  users: SleeperUser[],
  now: number,
) {
  const teams = draft.settings.teams ?? rosters.length;
  const rounds = draft.settings.rounds ?? 0;
  const totalPicks = teams * rounds;
  const occupiedPicks = new Set(
    picks
      .map((pick) => pick.pick_no)
      .filter((pickNo) => pickNo >= 1 && pickNo <= totalPicks),
  );
  let nextPickNo = 1;
  while (nextPickNo <= totalPicks && occupiedPicks.has(nextPickNo)) nextPickNo += 1;

  if (draft.status !== "drafting" || nextPickNo > totalPicks || draft.type === "auction") {
    return {
      status: draft.status,
      pick_no: null,
      user_is_on_clock: false,
      picks_until_user_selection: null,
      note: draft.type === "auction"
        ? "Nomination order is not calculated for auction drafts in this prototype."
        : "There is no active selection.",
    };
  }

  const selection = selectionAt(nextPickNo, teams, draft, tradedPicks);
  const currentRoster = rosters.find((roster) => roster.roster_id === selection.ownerRosterId);
  const currentOwner = currentRoster ? ownerForRoster(currentRoster, users) : undefined;
  let nextUserPick: ReturnType<typeof selectionAt> | undefined;

  for (let pickNo = nextPickNo; pickNo <= totalPicks; pickNo += 1) {
    if (occupiedPicks.has(pickNo)) continue;
    const candidate = selectionAt(pickNo, teams, draft, tradedPicks);
    if (candidate.ownerRosterId === userRosterId) {
      nextUserPick = candidate;
      break;
    }
  }

  const timerSeconds = draft.settings.pick_timer;
  const clockStartedAt = draft.last_picked ?? (nextPickNo === 1 ? draft.start_time : null);
  const deadline = timerSeconds && clockStartedAt
    ? clockStartedAt + timerSeconds * 1_000
    : undefined;

  return {
    status: draft.status,
    pick_no: selection.pickNo,
    round: selection.round,
    pick_in_round: selection.pickInRound,
    draft_slot: selection.draftSlot,
    roster_id_on_clock: selection.ownerRosterId ?? null,
    manager_on_clock: currentOwner?.display_name ?? currentOwner?.username ?? null,
    user_is_on_clock: selection.ownerRosterId === userRosterId,
    picks_until_user_selection: nextUserPick
      ? countOpenPicksBefore(selection.pickNo, nextUserPick.pickNo, occupiedPicks)
      : null,
    user_next_pick_no: nextUserPick?.pickNo ?? null,
    clock_deadline: deadline ? new Date(deadline).toISOString() : null,
    clock_seconds_remaining: deadline
      ? Math.max(0, Math.ceil((deadline - now) / 1_000))
      : null,
  };
}

function countOpenPicksBefore(
  currentPickNo: number,
  targetPickNo: number,
  occupiedPicks: Set<number>,
): number {
  let count = 0;
  for (let pickNo = currentPickNo; pickNo < targetPickNo; pickNo += 1) {
    if (!occupiedPicks.has(pickNo)) count += 1;
  }
  return count;
}

function selectionAt(
  pickNo: number,
  teams: number,
  draft: SleeperDraft,
  tradedPicks: SleeperTradedPick[],
) {
  const round = Math.ceil(pickNo / teams);
  const pickInRound = ((pickNo - 1) % teams) + 1;
  const reversalRound = typeof draft.settings.reversal_round === "number"
    ? draft.settings.reversal_round
    : 0;
  const normallyReversed = round % 2 === 0;
  const isReversed = draft.type === "snake" && (
    reversalRound > 0 && round >= reversalRound
      ? !normallyReversed
      : normallyReversed
  );
  const draftSlot = isReversed
    ? teams - pickInRound + 1
    : pickInRound;
  const originalRosterId = draft.slot_to_roster_id?.[String(draftSlot)];
  const trade = tradedPicks.reduce<SleeperTradedPick | undefined>(
    (latest, pick) =>
      pick.round === round && pick.roster_id === originalRosterId ? pick : latest,
    undefined,
  );

  return {
    pickNo,
    round,
    pickInRound,
    draftSlot,
    ownerRosterId: trade?.owner_id ?? originalRosterId,
  };
}
