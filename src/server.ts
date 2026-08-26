import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";
import { z } from "zod";

import { DraftContextService } from "./draft-context.js";

const snapshotOutputSchema = z.object({
  schema_version: z.string(),
  refreshed_at: z.string(),
  refresh_latency_ms: z.number(),
  source: z.string(),
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
): McpServer {
  const server = new McpServer(
    { name: "sleeper-draft-assistant", version: "0.1.0" },
    {
      instructions:
        "Call get_live_draft_context immediately before every Sleeper draft recommendation, even if it was called earlier in the chat. Treat its available-player ordering as Sleeper search metadata, not an expert ranking. This server is read-only and never makes draft selections.",
    },
  );

  server.registerTool(
    "get_live_draft_context",
    {
      title: "Get live Sleeper draft context",
      description:
        "Refresh the current Sleeper draft and return the user's team, open roster slots, current pick, picks until their next selection, complete draft history, other teams' needs, and available players. Call this immediately before answering any draft recommendation, comparison, availability, roster-priority, or on-the-clock question.",
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

  return server;
}

export function createApp(
  draftContext: DraftContextService,
  options: ServerOptions = {},
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
    const server = createMcpServer(draftContext, options);
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
