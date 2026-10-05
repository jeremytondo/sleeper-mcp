import type {
  LeagueGateway,
  PlayerCatalogInfo,
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperNflState,
  SleeperPlayers,
  SleeperRoster,
  SleeperTradedPick,
  SleeperTransaction,
  SleeperUser,
} from "./sleeper-types.js";

const DEFAULT_BASE_URL = "https://api.sleeper.app/v1";

export class SleeperApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = "SleeperApiError";
  }
}

interface SleeperClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  playerCacheTtlMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class SleeperClient implements LeagueGateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly playerCacheTtlMs: number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private playerCache?: { value: SleeperPlayers; fetchedAt: number; expiresAt: number };
  private playerRequest?: Promise<SleeperPlayers>;

  constructor(options: SleeperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.playerCacheTtlMs = options.playerCacheTtlMs ?? 24 * 60 * 60 * 1_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getUser(user: string, signal?: AbortSignal): Promise<SleeperUser> {
    const result = await this.get<SleeperUser | null>(`/user/${encodeURIComponent(user)}`, signal);
    if (!result) {
      throw new SleeperApiError(`Sleeper user not found: ${user}`, 404);
    }
    return result;
  }

  getDraft(draftId: string, signal?: AbortSignal): Promise<SleeperDraft> {
    return this.get(`/draft/${encodeURIComponent(draftId)}`, signal);
  }

  getDraftPicks(draftId: string, signal?: AbortSignal): Promise<SleeperDraftPick[]> {
    return this.get(`/draft/${encodeURIComponent(draftId)}/picks`, signal);
  }

  getTradedPicks(draftId: string, signal?: AbortSignal): Promise<SleeperTradedPick[]> {
    return this.get(`/draft/${encodeURIComponent(draftId)}/traded_picks`, signal);
  }

  getLeague(leagueId: string, signal?: AbortSignal): Promise<SleeperLeague> {
    return this.get(`/league/${encodeURIComponent(leagueId)}`, signal);
  }

  getLeagueRosters(leagueId: string, signal?: AbortSignal): Promise<SleeperRoster[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/rosters`, signal);
  }

  getLeagueUsers(leagueId: string, signal?: AbortSignal): Promise<SleeperUser[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/users`, signal);
  }

  getNflState(signal?: AbortSignal): Promise<SleeperNflState> {
    return this.get("/state/nfl", signal);
  }

  getUserLeagues(userId: string, season: string, signal?: AbortSignal): Promise<SleeperLeague[]> {
    return this.get(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`, signal);
  }

  getLeagueMatchups(leagueId: string, week: number, signal?: AbortSignal): Promise<SleeperMatchup[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/matchups/${encodeURIComponent(week)}`, signal);
  }

  getLeagueTransactions(leagueId: string, week: number, signal?: AbortSignal): Promise<SleeperTransaction[]> {
    return this.get(`/league/${encodeURIComponent(leagueId)}/transactions/${encodeURIComponent(week)}`, signal);
  }

  getPlayerCatalogInfo(): PlayerCatalogInfo {
    return {
      fetched_at: this.playerCache ? new Date(this.playerCache.fetchedAt).toISOString() : null,
      expires_at: this.playerCache ? new Date(this.playerCache.expiresAt).toISOString() : null,
      stale: !this.playerCache || this.playerCache.expiresAt <= this.now(),
    };
  }

  async getPlayers(): Promise<SleeperPlayers> {
    const now = this.now();
    if (this.playerCache && this.playerCache.expiresAt > now) {
      return this.playerCache.value;
    }

    if (!this.playerRequest) {
      this.playerRequest = this.get<SleeperPlayers>("/players/nfl")
        .then((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new SleeperApiError("Sleeper returned invalid player catalog", 200, `${this.baseUrl}/players/nfl`);
          }
          const fetchedAt = this.now();
          this.playerCache = {
            value,
            fetchedAt,
            expiresAt: fetchedAt + this.playerCacheTtlMs,
          };
          return value;
        })
        .finally(() => {
          this.playerRequest = undefined;
        });
    }

    return this.playerRequest;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const endpoint = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await this.fetcher(endpoint, {
        headers: { accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SleeperApiError(`Sleeper request failed: ${detail}`, undefined, endpoint);
    }

    if (!response.ok) {
      throw new SleeperApiError(
        `Sleeper returned HTTP ${response.status}`,
        response.status,
        endpoint,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new SleeperApiError("Sleeper returned invalid JSON", response.status, endpoint);
    }
  }
}
