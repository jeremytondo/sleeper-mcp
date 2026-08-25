# Sleeper Draft Assistant MCP

A read-only prototype that gives ChatGPT a fresh, league-aware Sleeper draft snapshot while a pick clock is running.

The server exposes one focused Streamable HTTP MCP tool, `get_live_draft_context`. Every call refreshes the draft, picks, traded picks, league, rosters, and league users. It returns:

- the manager's drafted players, position counts, filled/open starter slots, and bench space;
- the current selection, manager on the clock, and picks until the user's next selection;
- league scoring, roster, and draft settings;
- the full draft history and compact positional summaries for every other roster;
- currently undrafted players by rostered position.

Sleeper player metadata is cached for 24 hours because `/players/nfl` is a large, slow-changing catalog. Availability is still calculated from freshly fetched picks on every call. The returned `sleeper_search_rank` is discovery metadata—not draft advice—and should be combined with a separate rankings or research source.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Optionally set `SLEEPER_USER_ID` to a Sleeper username or user ID. If it is unset, the MCP call must provide `user`.

The endpoints are:

- `POST /mcp` — stateless Streamable HTTP MCP
- `GET /health` — process health
- `GET /` — service metadata

## Verify the prototype

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
npx @modelcontextprotocol/inspector@latest
```

Point MCP Inspector at `http://localhost:3000/mcp`, list the tools, and call `get_live_draft_context` with a real `draft_id` and `user`.

The included `Dockerfile` builds a production image for any HTTPS-capable container host:

```bash
docker build -t sleeper-mcp .
docker run --rm -p 3000:3000 -e SLEEPER_USER_ID=your-user sleeper-mcp
```

For ChatGPT, expose the endpoint through public HTTPS or a supported secure tunnel. Then enable Developer mode under **Settings → Security and login**, add an MCP server from **ChatGPT Plugins**, and enter the HTTPS URL including `/mcp`. Start a new chat, add the connection from the tools menu, and ask a draft question from the mobile app.

Keep the default localhost binding when using a secure tunnel. If you deliberately expose the server, set `HOST=0.0.0.0`, configure `MCP_BEARER_TOKEN` when the client can send a bearer credential, and place TLS at the hosting edge. Browser-originated requests are rejected unless their exact origins appear in `MCP_ALLOWED_ORIGINS`; server-to-server MCP requests normally omit `Origin`.

## Prototype boundaries

- Read-only: there is no code path that makes a Sleeper selection or modifies a league.
- No ranking engine: external rankings, projections, injury research, and news remain separate.
- Snake/linear drafts: current and future pick math supports these formats, including traded picks. Auction nomination order is reported as unsupported.
- Public Sleeper data: the optional bearer token protects the endpoint, but it is not per-user authorization. Use a secure tunnel for the personal proof and add OAuth before operating this as a shared service.
- Availability depends on the Sleeper player catalog. Players without a finite positive `search_rank` are omitted from the compact candidate lists but remain visible in draft history when selected.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP bind address (`0.0.0.0` inside the image) |
| `SLEEPER_USER_ID` | unset | Default Sleeper username or user ID |
| `MCP_BEARER_TOKEN` | unset | Optional bearer credential required by `/mcp` |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated browser origins allowed to call `/mcp` |
| `MCP_MAX_CONCURRENT_REQUESTS` | `8` | In-flight MCP request cap |
| `MCP_MAX_REQUESTS_PER_MINUTE` | `60` | Per-process MCP request limit |
| `SLEEPER_API_BASE_URL` | `https://api.sleeper.app/v1` | Sleeper API base URL |
| `SLEEPER_REQUEST_TIMEOUT_MS` | `5000` | Per-request timeout |
| `SLEEPER_PLAYER_CACHE_TTL_MS` | `86400000` | Player catalog cache lifetime |

## Source references

- [Sleeper's API documentation](https://docs.sleeper.com/) describes its unauthenticated, read-only endpoints and usage limits.
- [OpenAI's MCP server guide](https://developers.openai.com/plugins/build/mcp-server) covers tool schemas, annotations, results, and the TypeScript SDK.
- [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) covers public HTTPS or secure tunnels, MCP Inspector, Developer mode, and adding the `/mcp` endpoint to ChatGPT.
