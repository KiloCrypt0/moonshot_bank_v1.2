# Stellar Scope — Architecture

What this repo actually contains, as of September 2026.

> The previous version of this file described a React Native front end, a
> PostgreSQL database, Redis and BullMQ. None of those exist, and never did.
> Anyone joining the project was being pointed at a system that wasn't there,
> so it has been replaced with a description of the real one.

## Shape

A single Node process serves both the API and the front end. There is no build
step for application code, no framework, and no separate worker.

```
                        ┌──────────────────────────────┐
  Browser               │  Express 5 (prototype/       │       Upstreams
  ┌───────────────┐     │            server.js)        │     ┌────────────────┐
  │ public/       │◀───▶│                              │────▶│ Horizon        │
  │  index.html   │     │  routes  ·  9 DeFi adapters  │────▶│ Soroban RPC    │
  │  (one file)   │     │  pricing ·  snapshot sched.  │────▶│ CoinGecko      │
  └───────────────┘     │                              │────▶│ stellar.expert │
                        └──────────────┬───────────────┘     └────────────────┘
                                       │
                              ┌────────▼─────────┐
                              │ SQLite (WAL)     │
                              │ better-sqlite3   │
                              └──────────────────┘
```

Every upstream call is made **server-side**. The browser only ever talks to this
origin (`API_BASE = window.location.origin`) plus a handful of image hosts.

## Backend — `prototype/`

- **`server.js`** (~1,900 lines) — Express app, all HTTP routes, the protocol
  adapter fan-out, and the process lifecycle. Exports `{ app, __setTestDeps }`;
  `app.listen` and all background work are behind `require.main === module`, so
  requiring it from a test is side-effect free.
- **`lib/`** — 30 modules. The ones worth knowing:
  - `history-db.js` — SQLite schema, prepared statements, snapshot read/write,
    retention. Owns `runMigrations()` and `runBackfills()`; the latter are plain
    exported functions so tests can run them against a scratch database.
  - `public-profiles.js` — the `public_profiles` / `profile_wallets` tables.
    Every profile has an `owner_address`.
  - `profile-auth.js` — the signature-challenge flow (below).
  - `public-api-routes.js` — the open `/api/v1/public/*` API, the profile
    routes, `/p/:slug`, and `/api/docs`.
  - `sanitize.js` — write-time filtering for all user-supplied text.
  - `security-headers.js` — helmet plus a hand-written CSP.
  - `pricing-engine.js`, `token-price-map.js`, `token-universe.js`,
    `soroban-rpc.js` — asset resolution and pricing.
  - `snapshot-scheduler.js` — hourly-to-5-minute portfolio snapshots by tier.
  - `defi-explorer.js`, `rwa-yield-fetcher.js`, `fx-efficiency.js` — background
    refreshers behind in-memory caches.
- **`lib/adapters/`** — nine DeFi adapters (Blend, K2, Aquarius, Templar,
  Upshift, Sentora, Solv, plus two LP discoverers). They run in parallel under
  `Promise.allSettled` with a per-adapter timeout and a last-known-good cache,
  so one broken protocol degrades a single card instead of the whole portfolio.
  Every adapter exposes `{ name, protocolId, isConfigured, getPositions }`; a
  boot assertion fails the process if `protocolId` is missing.

## Frontend — `prototype/public/index.html`

One 7,400-line file: vanilla JS, no framework, no bundler. Four inline
`<script>` blocks — three small ones plus the ~4,200-line application. Wallet
connection is a `<script type="module">` importing the **self-hosted** Stellar
Wallets Kit from `/vendor/`, built by `npm run build:vendor` from the version
pinned in `package.json`.

Splitting this file is the obvious next refactor; the shared pieces (router,
state, `api()`, the escaper) are the ones to extract first.

## Storage

SQLite via `better-sqlite3` in WAL mode. `foreign_keys` is on (better-sqlite3
enables it by default), which matters: `token_snapshots` references
`portfolio_snapshots` with no `ON DELETE CASCADE`, so anything deleting
snapshots must delete child rows first.

Tables: `tracked_wallets`, `portfolio_snapshots`, `token_snapshots`,
`discovered_balances`, `public_profiles`, `profile_wallets`, `schema_meta`.

**`HISTORY_DB_PATH` must point at a mounted volume in production.** On the
container filesystem the database — and therefore every user-created profile —
is discarded on each deploy. The resolved path is logged at boot.

Wallet **lists** are not server state. They live in each browser's
`localStorage` (`stellarscope.walletList`). The server keeps `tracked_wallets`
only so the scheduler can keep accumulating history, and it does not return
wallet labels to callers.

## Profile ownership auth

The only place the app accepts a mutation tied to an identity.

1. Client asks `POST /api/v1/auth/challenge` for `(address, action, slug, target)`.
2. Server returns a single-use token and a message naming the domain, the
   action, the address, the profile, the target wallet where applicable, the
   token, and an expiry — then holds it for five minutes.
3. The wallet signs that message; the client submits the signature with the
   mutation.
4. Server verifies the ed25519 signature (raw or SEP-53 framing only — never
   over a digest), checks action, slug and target all match, and consumes the
   token.

Who may do what: any wallet **on** a profile can edit it; only the
`owner_address` can delete it or approve a new wallet joining; adding a wallet
takes two signatures (owner consent naming the exact address, plus the new
wallet proving control); removing one takes the owner's or that wallet's own
signature.

## Hosting

Railway (`server: railway-hikari`), Node 22, `node prototype/server.js` from the
root `package.json`. No Dockerfile — Railway auto-detects. Live at
`stellarscope.xyz`, also reachable at `stellarscope-production.up.railway.app`.

## Tests

`npm test` in `prototype/` runs `node --test` — no test framework dependency.
CI runs the suite plus `npm audit --audit-level=high` on every PR.

Coverage is deliberately concentrated on what breaks quietly: profile-auth
signature verification, the profile routes' authorization, the write-path
guards, input filtering, security headers, and source-level guardrails over
`index.html` (no interpolated inline handlers, one escaper, every interpolated
URL through `safeUrl`).
