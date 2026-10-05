import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";
import { z } from "zod";

import { DraftContextService } from "./draft-context.js";
import { LeagueContextService } from "./league-context.js";

const snapshotOutputSchema = z.object({
  schema_version: z.string(),
  refreshed_at: z.string(),
  refresh_latency_ms: z.number(),
  source: z.string(),
  partial: z.boolean(),
  sources: z.record(z.string(), z.unknown()),
  identity: z.object({
    user_id: z.string(),
    username: z.string().nullable(),
    display_name: z.string().nullable(),
    roster_id: z.number(),
  }),
  league: z.record(z.string(), z.unknown()),
  draft: z.record(z.string(), z.unknown()),
  current_pick: z.record(z.string(), z.unknown()),
  user_team: z.record(z.string(), z.unknown()),
  other_teams: z.array(z.record(z.string(), z.unknown())),
  draft_history: z.array(z.record(z.string(), z.unknown())),
  availability: z.object({
    basis: z.enum(["current_rosters", "current_rosters_and_draft_picks"]),
    waiver_status: z.literal("unknown"),
    lock_status: z.literal("unknown"),
  }),
  available_players_by_position: z.record(
    z.string(),
    z.array(z.record(z.string(), z.unknown())),
  ),
  interpretation_notes: z.array(z.string()),
});

export interface ServerOptions {
  defaultUser?: string;
  bearerToken?: string;
  allowedOrigins?: string[];
  maxConcurrentRequests?: number;
  maxRequestsPerMinute?: number;
}

export function createMcpServer(
  draftContext: DraftContextService,
  options: ServerOptions = {},
  leagueContext?: LeagueContextService,
): McpServer {
  const server = new McpServer(
    { name: "sleeper-draft-assistant", version: "0.1.0" },
    {
      instructions:
        "Use list_leagues to discover league IDs, get_league_context for current selected lineups and weekly scores, get_league_rosters for full ownership, search_players for targeted player lookup across leagues, and get_league_activity for public transaction history. Refresh the relevant tools immediately before recommendations. Use get_live_draft_context for draft questions; its legacy lineup_slots describe potential roster coverage, not selected starters. Current rosters and historical weekly lineups are distinct. Unrostered does not guarantee add eligibility: waiver and lock status are unknown. Sleeper search_rank is discovery metadata, not an expert ranking. News, projections, private pending bids and documented elimination status are unavailable. All tools are read-only.",
    },
  );

  server.registerTool(
    "get_live_draft_context",
    {
      title: "Get live Sleeper draft context",
      description:
        "Refresh the Sleeper draft and league rosters and return the user's team, open roster slots, current pick, picks until their next selection, complete draft history, other teams' needs, and available players. After the draft, availability excludes current league rosters instead of historical picks, including for chopped leagues. Per-player waiver and lock status are unknown. Call this immediately before answering any draft recommendation, comparison, availability, roster-priority, or on-the-clock question.",
      inputSchema: {
        draft_id: z
          .string()
          .min(1)
          .max(64)
          .describe("Sleeper draft ID from the draft URL or Sleeper API."),
        user: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "Sleeper username or user ID. Omit when SLEEPER_USER_ID is configured on the server.",
          ),
        available_limit_per_position: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(12)
          .describe("Maximum available players returned for each rostered position."),
      },
      outputSchema: {
        snapshot: snapshotOutputSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ draft_id, user, available_limit_per_position }, extra) => {
      const resolvedUser = user ?? options.defaultUser;
      if (!resolvedUser) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "A Sleeper username or user ID is required. Pass user or configure SLEEPER_USER_ID on the server.",
            },
          ],
        };
      }

      try {
        const snapshot = await draftContext.getLiveDraftContext({
          draftId: draft_id,
          user: resolvedUser,
          availableLimitPerPosition: available_limit_per_position,
          signal: extra.signal,
        });
        return {
          structuredContent: { snapshot },
          content: [
            {
              type: "text",
              text: `Refreshed Sleeper draft ${draft_id}. Use the structured snapshot for the recommendation; available-player order is not an expert ranking.`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Sleeper error";
        return {
          isError: true,
          content: [{ type: "text", text: `Unable to refresh the draft: ${message}` }],
        };
      }
    },
  );

  if (leagueContext) registerLeagueTools(server, leagueContext, options);

  return server;
}

const idSchema = z.string().trim().min(1).max(64);
const userSchema = idSchema.optional().describe("Sleeper username or user ID; defaults to SLEEPER_USER_ID when configured.");
const weekSchema = z.number().int().min(1).max(22);
const pageSchema = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
};
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const leagueOutputSchema = {
  snapshot: z.object({
    schema_version: z.string(),
    refreshed_at: z.string(),
    refresh_latency_ms: z.number(),
    source: z.string(),
    partial: z.boolean(),
    issues: z.array(z.object({ source: z.string(), message: z.string() })),
    sources: z.record(z.string(), z.unknown()),
  }).passthrough(),
};

async function leagueResult(operation: () => Promise<Record<string, unknown>>) {
  try {
    const snapshot = await operation();
    return {
      structuredContent: { snapshot },
      content: [{ type: "text" as const, text: "Use the structured Sleeper snapshot. Check partial, issues, sources and pagination before interpreting the results." }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unable to refresh Sleeper data: ${error instanceof Error ? error.message : "Unknown Sleeper error"}` }],
    };
  }
}

function registerLeagueTools(server: McpServer, service: LeagueContextService, options: ServerOptions) {
  server.registerTool("list_leagues", {
    title: "List Sleeper leagues",
    description: "Find a user's NFL leagues and IDs for a season, including scoring/settings and previous-season league links. If season is omitted, resolve it from live NFL state rather than the calendar year.",
    inputSchema: { user: userSchema, season: z.string().regex(/^\d{4}$/).optional() },
    outputSchema: leagueOutputSchema,
    annotations: readOnlyAnnotations,
  }, async ({ user, season }, extra) => leagueResult(async () => {
    const resolvedUser = user ?? options.defaultUser;
    if (!resolvedUser) throw new Error("Pass user or configure SLEEPER_USER_ID on the server.");
    return service.listLeagues({ user: resolvedUser, season, signal: extra.signal });
  }));

  server.registerTool("get_league_context", {
    title: "Get Sleeper league context",
    description: "Refresh rules, current selected starter slots (including empty/repeated slots), bench/IR/taxi, raw budget fields, and league-wide weekly scores. Optional user selects a manager's roster. Requested-week lineups are separate from current rosters. Historical or non-regular seasons need an explicit week. Does not infer chopped elimination status.",
    inputSchema: { league_id: idSchema, user: userSchema, week: weekSchema.optional() },
    outputSchema: leagueOutputSchema,
    annotations: readOnlyAnnotations,
  }, async ({ league_id, user, week }, extra) => leagueResult(() => service.getLeagueContext({
    leagueId: league_id, user: user ?? options.defaultUser, week, signal: extra.signal,
  })));

  server.registerTool("get_league_rosters", {
    title: "Get all Sleeper league rosters",
    description: "Refresh every team's full current player ownership, selected starters, bench/reserve/taxi and raw roster/budget settings. Includes co-owned and ownerless rosters. No eliminated-team inference or exact remaining-FAAB guarantee.",
    inputSchema: { league_id: idSchema },
    outputSchema: leagueOutputSchema,
    annotations: readOnlyAnnotations,
  }, async ({ league_id }, extra) => leagueResult(() => service.getLeagueRosters({ leagueId: league_id, signal: extra.signal })));

  server.registerTool("search_players", {
    title: "Search Sleeper players and ownership",
    description: "Search the full daily-cached NFL catalog by name, position or explicit IDs, independent of draft candidate limits. Refresh ownership across up to 10 supplied leagues. available_only means known unrostered in ALL supplied leagues, never guaranteed add/waiver eligibility. Explicit IDs can return unknown catalog entries. Results are paginated; search_rank is not a recommendation.",
    inputSchema: {
      league_ids: z.array(idSchema).min(1).max(10).optional(),
      query: z.string().trim().min(1).max(120).optional(),
      positions: z.array(z.string().trim().min(1).max(20)).min(1).max(20).optional(),
      player_ids: z.array(idSchema).min(1).max(100).optional(),
      available_only: z.boolean().default(false),
      ...pageSchema,
    },
    outputSchema: leagueOutputSchema,
    annotations: readOnlyAnnotations,
  }, async ({ league_ids, query, positions, player_ids, available_only, limit, offset }, extra) => leagueResult(() => service.searchPlayers({
    leagueIds: league_ids, query, positions, playerIds: player_ids, availableOnly: available_only, limit, offset, signal: extra.signal,
  })));

  server.registerTool("get_league_activity", {
    title: "Get Sleeper league activity",
    description: "Read public weekly waiver, free-agent and trade transactions with adds/drops, exposed completed bids, traded picks and raw budget transfers. Filter by type, roster or player and paginate newest first. Defaults to current and previous regular-season weeks when the season matches this league; pass weeks for history. Failed weeks are flagged partial. No private pending bids, waiver-clearance inference or eliminated-team inference.",
    inputSchema: {
      league_id: idSchema,
      weeks: z.array(weekSchema).min(1).max(22).optional(),
      types: z.array(z.enum(["trade", "free_agent", "waiver"])).min(1).max(3).optional(),
      roster_ids: z.array(z.number().int().positive()).min(1).max(100).optional(),
      player_ids: z.array(idSchema).min(1).max(100).optional(),
      ...pageSchema,
    },
    outputSchema: leagueOutputSchema,
    annotations: readOnlyAnnotations,
  }, async ({ league_id, weeks, types, roster_ids, player_ids, limit, offset }, extra) => leagueResult(() => service.getLeagueActivity({
    leagueId: league_id, weeks, types, rosterIds: roster_ids, playerIds: player_ids, limit, offset, signal: extra.signal,
  })));
}

export function createApp(
  draftContext: DraftContextService,
  options: ServerOptions = {},
  leagueContext?: LeagueContextService,
): Express {
  const app = express();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 8;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 60;
  let activeRequests = 0;
  let requestWindowStartedAt = Date.now();
  let requestsInWindow = 0;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use("/mcp", (request, response, next) => {
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin not allowed" },
        id: null,
      });
      return;
    }

    if (
      options.bearerToken &&
      request.get("authorization") !== `Bearer ${options.bearerToken}`
    ) {
      response.set("WWW-Authenticate", "Bearer").status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    const now = Date.now();
    if (now - requestWindowStartedAt >= 60_000) {
      requestWindowStartedAt = now;
      requestsInWindow = 0;
    }
    if (requestsInWindow >= maxRequestsPerMinute) {
      response.set("Retry-After", "60").status(429).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Request rate limit exceeded" },
        id: null,
      });
      return;
    }
    requestsInWindow += 1;

    if (request.method === "POST") {
      if (activeRequests >= maxConcurrentRequests) {
        response.status(429).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Too many concurrent requests" },
          id: null,
        });
        return;
      }
      activeRequests += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
      };
      response.once("finish", release);
      response.once("close", release);
    }

    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "sleeper-draft-assistant", version: "0.1.0" });
  });

  app.get("/", (_request, response) => {
    response.json({
      name: "Sleeper Draft Assistant MCP",
      transport: "Streamable HTTP",
      endpoint: "/mcp",
      read_only: true,
    });
  });

  app.post("/mcp", async (request, response) => {
    const server = createMcpServer(draftContext, options, leagueContext);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.all("/mcp", (_request, response) => {
    response.set("Allow", "POST").status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed for stateless MCP endpoint" },
      id: null,
    });
  });

  return app;
}
