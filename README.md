# Sleeper League Toolkit MCP

A read-only prototype that gives ChatGPT a fresh, league-aware Sleeper snapshot during the draft and season.

The server exposes six read-only Streamable HTTP MCP tools. League discovery, current rosters, selected lineups, player ownership, weekly scores and public transaction history are available without a draft ID.

## Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `list_leagues` | `user` (or configured default), optional `season` | NFL league IDs, rules/scoring and previous-season league links |
| `get_league_context` | `league_id`, optional `user`, `week` | Current roster/selected lineup, rules, budget fields and the requested week’s league-wide scores/lineups |
| `get_league_rosters` | `league_id` | Every team’s current full ownership, selected starters, bench, reserve, taxi and raw roster settings |
| `search_players` | Optional `query`, `positions`, `player_ids`, `league_ids`, `available_only`, `limit`, `offset` | Catalog matches and current ownership across the supplied leagues |
| `get_league_activity` | `league_id`, optional `weeks`, `types`, `roster_ids`, `player_ids`, `limit`, `offset` | Public adds/drops/waivers/trades, exposed completed bids and pick/budget transfers |
| `get_live_draft_context` | Existing `draft_id`, `user`, `available_limit_per_position` | Backwards-compatible live draft snapshot |

All tools return structured data under `snapshot`. The new league tools share `schema_version`, `refreshed_at`, `source`, `partial`, `issues` and `sources`; check these before treating empty or incomplete results as authoritative. Source timestamps mean retrieval time, not an upstream last-modified time. Calls combine independently fetched resources, not an atomic Sleeper snapshot. Catalog metadata includes the last successful fetch, expiration and stale flag. A catalog refresh failure is marked unavailable rather than silently served as fresh.

### League and player queries

- Omit `season` to resolve it from live NFL state, rather than the calendar year. This matters in January.
- Omit `week`/`weeks` only for a matching regular season. Historical or non-regular seasons need explicit week input; unresolved context is marked partial. Requested-week matchup lineups are separate from the current roster and current selected starters.
- Selected lineups preserve the order of `roster.starters` against starter positions, including repeated FLEX slots, empty `"0"` slots and missing entries. Bench coverage never fills a selected empty slot.
- Ownership includes reserve, taxi, starters and ownerless rosters. Removing an owner is not a release. Neither low weekly scores nor ownerless teams establish documented elimination status.
- Budget fields are returned raw. A missing field is not zero. League budget minus reported usage is not guaranteed remaining FAAB because trades or commissioner adjustments can change it.
- Search uses the whole catalog, not the draft tool’s top-30-per-position candidates. Explicit IDs can identify catalog-missing players; name and position filtering depend on available catalog metadata. Search does not silently exclude inactive players.
- `available_only: true` requires `league_ids` and means known unrostered in every supplied league. Ownership failures are flagged partial and never counted as available. Waiver clearance, lock status and claim eligibility remain unknown.
- Search/activity pagination defaults to 50 items, maximum 100. Use `offset` and the returned pagination metadata to continue; pages across calls can change as live data changes. Search accepts up to 10 league IDs and 100 player IDs.
- Activity defaults to the current and previous regular-season weeks and accepts up to 22 distinct requested weeks (1–22), with optional types `waiver`, `free_agent`, `trade`. Duplicate transactions are deduplicated before paging. Failed weeks are listed as partial, not mistaken for no activity. Public transaction statuses are preserved, including failed/pending records if returned. Only completed public waiver bids are summarized; waiver_bid is omitted from settings/raw data for other statuses. Private pending bids are unavailable.
- News and projections are explicitly unavailable. There is no external provider, new credential, lineup write, waiver claim, scheduler or strategy engine.

For example, use `list_leagues` to find the league ID, then call `get_league_context` for a lineup question, `search_players` with specific `player_ids` and several `league_ids` for cross-league ownership, or `get_league_activity` with `weeks: [4, 5]` and `types: ["waiver"]` for recent waiver activity.

## Draft compatibility

`get_live_draft_context` keeps its original input and response fields. Every call refreshes the draft, picks, traded picks, league, rosters, and league users. It returns:

- the manager's current players (supplemented with picks during the draft), position counts, potential starter coverage and bench capacity;
- `selected_lineup`, `selected_starters_raw`, current bench/reserve/taxi IDs and raw roster settings as additive fields;
- the current selection, manager on the clock, and picks until the user's next selection;
- league scoring, roster, and draft settings;
- the full draft history and compact positional summaries for every other roster;
- available player candidates by league position, with player IDs, names, fantasy positions, NFL teams, injuries, status, and search rank.

`lineup_slots`, `open_starter_slots` and `bench` retain their draft coverage meanings; they are not selected starter assignments. Use `selected_lineup` for actual current selections.

Sleeper player metadata is cached for 24 hours because `/players/nfl` is a large, slow-changing catalog. Every call fetches fresh league rosters and excludes all rostered players, including reserve and taxi players, from availability. During a pending or active draft, draft picks are excluded too. Once the draft is complete, or the league is `in_season` or `complete`, only current rosters determine ownership; historical picks do not keep dropped players out of the pool or add them back to team summaries. Failed roster requests fail the call instead of returning stale availability.

In guillotine/chopped leagues, players enter the pool when Sleeper releases them from the roster. Removing an owner alone does not release players. When a surviving team claims a player, that player disappears on the next refresh.

The response's `availability.basis` identifies the ownership source. The documented public API does not expose per-player waiver or transaction lock state, so `availability.waiver_status` and `availability.lock_status` are `unknown`. League settings are included, but the tool cannot guarantee immediate adds, claim eligibility, or exact parity with every lock shown in **Players → Available**. It reports unrostered candidates for league positions and does not infer waiver clearance from transaction history.

The returned `sleeper_search_rank` is discovery metadata and should be combined with a separate rankings or research source. Results are capped by `available_limit_per_position` (default 12, maximum 30); they are not an exhaustive pool. Players without a finite positive rank sort last and return a null rank.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Optionally set `SLEEPER_USER_ID` to a Sleeper username or user ID. If it is unset, `list_leagues` and `get_live_draft_context` require `user`; `get_league_context` can still return league-wide context without selecting a manager’s roster. Other tools need no user input.

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

Point MCP Inspector at `http://localhost:3000/mcp`, list all six tools, then call `list_leagues` with a real `user` or `get_league_context` with a `league_id`. The existing draft tool still accepts a real `draft_id` and `user`. The integration suite uses a loopback HTTP server and fixtures; it does not contact live Sleeper or require credentials. No lint script is configured.

The included `Dockerfile` builds a production image for any HTTPS-capable container host:

```bash
docker build -t sleeper-mcp .
docker run --rm -p 3000:3000 -e SLEEPER_USER_ID=your-user sleeper-mcp
```

For ChatGPT, expose the endpoint through public HTTPS or a supported secure tunnel. Then enable Developer mode under **Settings → Security and login**, add an MCP server from **ChatGPT Plugins**, and enter the HTTPS URL including `/mcp`. Start a new chat, add the connection from the tools menu, and ask a draft question from the mobile app.

Keep the default localhost binding when using a secure tunnel. If you deliberately expose the server, set `HOST=0.0.0.0`, configure `MCP_BEARER_TOKEN` when the client can send a bearer credential, and place TLS at the hosting edge. Browser-originated requests are rejected unless their exact origins appear in `MCP_ALLOWED_ORIGINS`; server-to-server MCP requests normally omit `Origin`.

## Private deployment through OpenAI Secure MCP Tunnel

`compose.tunnel.yml` runs two services on a private Docker network: `sleeper-mcp` and OpenAI's `tunnel-client`. The client forwards requests to `http://sleeper-mcp:3000/mcp` over an outbound connection to OpenAI. Neither service publishes a host port.

The deployment host supplies `SLEEPER_USER_ID`, `CONTROL_PLANE_API_KEY`, and `CONTROL_PLANE_TUNNEL_ID` through its environment or an untracked `.env` file. Keep the existing tunnel ID and credentials when updating the server so the existing ChatGPT connection can continue using that tunnel.

To update an existing deployment, put the updated source in its original deployment directory, retain its `.env`, and run these commands there (using the original Compose project name or `--env-file` option if the deployment used one):

```bash
docker compose -f compose.tunnel.yml build sleeper-mcp
docker compose -f compose.tunnel.yml up -d --no-deps sleeper-mcp
docker compose -f compose.tunnel.yml ps
docker compose -f compose.tunnel.yml exec -T sleeper-mcp node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })"
```

This rebuilds and replaces the server while preserving the existing tunnel client. Confirm both services are running, then call `get_live_draft_context` through the existing ChatGPT connection. The legacy draft schema remains `"2026-09-22"` with additive selected-lineup/freshness fields, and an in-season response uses `availability.basis: "current_rosters"`. Confirm that tool discovery also lists the five new league tools.

See the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for tunnel setup and connection troubleshooting.

## Prototype boundaries

- Read-only: there is no code path that makes a Sleeper selection or modifies a league.
- No ranking engine: external rankings, projections, injury research, and news remain separate.
- Snake/linear drafts: current and future pick math supports these formats, including traded picks. Auction nomination order is reported as unsupported.
- Public Sleeper data: the optional bearer token protects the endpoint, but it is not per-user authorization. Use a secure tunnel for the personal proof and add OAuth before operating this as a shared service.
- Availability depends on the cached Sleeper player catalog, including its position and active flags. The legacy draft candidate list omits players marked `active: false` and positions outside the league's eligible slots. The full-catalog search exposes inactive players instead of silently hiding them. Injury status and an absent NFL team do not by themselves exclude a player. Metadata can lag by up to the configured cache lifetime.

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
