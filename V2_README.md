# Lemonade Stand V2 (development branch)

This is an independent development branch in a personal fork of [jimmcq/Lemonade-Stand-MCP-Server](https://github.com/jimmcq/Lemonade-Stand-MCP-Server).
The upstream `main` version is preserved, including `server.js` and its MIT license.

**Status:** development. Not deployed to Lighthouse. This code has automated tests; public tunnel / official ChatGPT acceptance has not been tested yet.

## Architecture

- `src/game.js`: pure deterministic game rules; validation, 14-day state machine, recipe accounting
- `src/store.js`: SQLite durable game state, archive history, atomic writes and request idempotency
- `server-v2.js`: MCP Streamable HTTP endpoint, using low-level SDK v1 server interface
- `src/*.test.js`: pure engine, storage/restart, and HTTP MCP integration tests

Existing `server.js` is the unchanged original STDIO entrypoint.

## Requirements

- Node.js 22.13 or newer (Node 22 still labels built-in `node:sqlite` experimental; the Lighthouse Node 22.23.x release supports it)
- npm
- Persistent writable directory for SQLite data

## Local development only

```bash
npm install
npm test
npm run start:v2
```

The server defaults to `http://127.0.0.1:8044/mcp`, with local health check at `/health`. Data is saved at `./data/lemonade.sqlite`.

Environment variables:
- `PORT`: HTTP port (default 8044)
- `HOST`: bind address (default `127.0.0.1`; do **not** set to `0.0.0.0` for public exposure)
- `MCP_PATH`: request path (default `/mcp`)
- `LEMONADE_DB_PATH`: full SQLite database path

MCP tools: `start_game`, `get_game_state`, `resume_game`, `new_game`, `buy_supplies`, `set_price`, `sell_lemonade`, `next_day`.

Write tools require a stable `operationId` provided by the client, so retries can return the original result without repeating a charge or sale. `new_game` additionally requires `confirm: true` and archives the existing active save rather than deleting it.

## Rules differing from the upstream sample

- States are enforced: buying/pricing → selling → reporting → next day → gameOver.
- Purchase inputs must be valid nonnegative integers, without extra fields.
- Price must be a finite positive amount with at most two decimal places.
- A partial 10-cup pitcher still consumes one whole pitcher's ingredients when any cups sell.
- The previous ice melts at daily close; unused cups, lemons and sugar remain.
- A daily settlement cannot be repeated, and the game cannot skip unplayed days.
- Cash records actual purchasing expenses and sales receipts; daily cost/profit is a separate standardized accounting estimate.
- The original README mentions `get_game_state` but the upstream `server.js` does not register it. V2 registers a real tool.

## Security and deployment warning

**Do not publish this service on an unrestricted Internet tunnel.**

The V2 runtime rejects requests that include an unapproved HTTP `Origin` header (DNS rebinding defense). It also checks tool arguments server-side instead of trusting the advertised JSON schema. These controls reduce accidental/browser-origin abuse but **do not authenticate a user**.

`MCP_ALLOWED_ORIGINS` is an optional comma-separated exact origin allowlist for trusted browser clients. Leave it empty for server-to-server ChatGPT clients (which usually omit `Origin`). Do not add `*`. An absent `Origin` must never be treated as proof of identity.

### Preferred private connection

If the account has access, prefer **OpenAI Secure MCP Tunnel** instead of exposing a public Cloudflare hostname. It routes requests through an OpenAI-managed private tunnel to the HTTP MCP listener on Lighthouse. This needs a Platform tunnel ID, a restricted tunnel runtime key, the `tunnel-client` process on Lighthouse, and the correct ChatGPT workspace linkage. First verify account/workspace eligibility; do not assume it is already configured. See [Secure MCP Tunnel official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### If reusing Cloudflare Tunnel

Use OAuth 2.1 (with ChatGPT-supported authorization discovery) or another **actually tested and compatible** identity-aware policy at the public edge; do not rely on an obscure URL, a static bearer token that ChatGPT cannot send, or a dashboard setting of "No authentication" alone. See [ChatGPT plugin authentication](https://developers.openai.com/plugins/build/auth). Confirm the exact auth flow and test unauthorized access before any real game save is exposed.

This first V2 draft has no authentication layer or player identity. It is designed for one private game owner, not multiple untrusted users. A Cloudflare hostname routed to it without an effective access policy would expose game contents and modification tools to any visitor who discovers the URL.

Before exposing via Lighthouse Tunnel:
1. Verify the selected ChatGPT connector authentication option and compatible gateway/Access controls.
2. Add an authentication method that actually works end-to-end, or keep access strictly private.
3. Set rate limits where possible. Do not treat an obscure URL alone as authentication.
4. Keep the service bound to `127.0.0.1`, and do not mix it with server-admin powers.

For a proposed systemd unit see `deploy/lemonade-stand-mcp.service.example`. It is a template, not an installed service.

## SQLite backups

The database uses WAL. For a consistent snapshot, stop the service before copying its database, or use SQLite's online backup operation; copying only a live `.sqlite` file while its WAL is active can lose recent commits.

Keep backups outside Git, test restoring one, and don't accidentally commit game databases or secrets.

## CI

`npm test` uses Node's built-in test runner. GitHub Actions executes on Node 22 and 24; the HTTP integration test starts the real MCP server, calls tools, restarts the process, and confirms the SQLite save survives.

## Rollback

The V2 service is independent from the original STDIO entrypoint. If an eventual deployment fails, stop the V2 systemd service, remove only its dedicated Cloudflare Tunnel route, and retain the SQLite file for investigation and restoration. Do not touch other Lighthouse services.

## Attribution

Original game: Jim McQuillan, 2025, MIT. Preserve the `LICENSE` file and upstream attribution in redistributed copies.
