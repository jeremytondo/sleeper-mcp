# Sleeper Draft Assistant MCP

A read-only prototype that gives ChatGPT a fresh, league-aware Sleeper snapshot during the draft and season.

The server exposes one focused Streamable HTTP MCP tool, `get_live_draft_context`. Every call refreshes the draft, picks, traded picks, league, rosters, and league users. It returns:

- the manager's current players (supplemented with picks during the draft), position counts, filled/open starter slots, and bench space;
- the current selection, manager on the clock, and picks until the user's next selection;
- league scoring, roster, and draft settings;
- the full draft history and compact positional summaries for every other roster;
- available player candidates by league position, with player IDs, names, fantasy positions, NFL teams, injuries, status, and search rank.

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

This rebuilds and replaces the server while preserving the existing tunnel client. Confirm both services are running, then call `get_live_draft_context` through the existing ChatGPT connection. For the availability fix, an in-season response should have `schema_version: "2026-09-22"` and `availability.basis: "current_rosters"`.

See the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for tunnel setup and connection troubleshooting.

## Prototype boundaries

- Read-only: there is no code path that makes a Sleeper selection or modifies a league.
- No ranking engine: external rankings, projections, injury research, and news remain separate.
- Snake/linear drafts: current and future pick math supports these formats, including traded picks. Auction nomination order is reported as unsupported.
- Public Sleeper data: the optional bearer token protects the endpoint, but it is not per-user authorization. Use a secure tunnel for the personal proof and add OAuth before operating this as a shared service.
- Availability depends on the cached Sleeper player catalog, including its position and active flags. Players marked `active: false` and positions outside the league's eligible slots are omitted. Injury status and an absent NFL team do not by themselves exclude a player. Metadata can lag by up to the configured cache lifetime.

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
