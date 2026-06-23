/**
 * RWA Yield Fetcher
 *
 * Periodically pulls live yield values from each issuer's API and exposes a
 * lookup keyed by the same slug shape used in rwa-yields.json
 * (lowercased {code}-{first6charsOfIssuerOrContract}).
 *
 * Design:
 *   - One fetcher function per issuer. Each may return values for multiple
 *     slugs in a single network call (e.g. Centrifuge returns JAAA + JTRSY +
 *     their deFi-wrapped variants in one GraphQL query).
 *   - Hourly background refresh. Per-slug 24h grace window keeps stale
 *     fetched values alive across short outages; beyond that, server.js falls
 *     back to the curated values in rwa-yields.json.
 *   - Pure in-memory cache — no disk writes. The curated JSON remains the
 *     human-edited source of truth and the durable fallback.
 *
 * Adding an issuer:
 *   1. Write an async function returning { "<slug>": { yield7d, asOf, source } }
 *      (or {} on failure — never throw past the boundary).
 *   2. Add it to ISSUER_FETCHERS.
 */

const REFRESH_INTERVAL = 60 * 60_000; // 1 hour
const STALE_GRACE = 24 * 60 * 60_000; // serve fetched values up to 24h old if a refresh fails

let cache = new Map(); // slug -> { ts, value: { yield7d, asOf, source } }
let lastRefreshTs = 0;
let lastRefreshSummary = null;

// ── Centrifuge ──────────────────────────────────────────────────────────────
// Public read-only GraphQL endpoint (https://api.centrifuge.io). Token ids are
// chain-prefixed but the yield data is fund-wide, so a single query covers
// every chain's wrapper of a given fund.
//
// yield7d365 is a fixed-point integer scaled by 1e27 (DeFi "ray" precision).
// Divide by 1e27 to get the fractional annualized yield, multiply by 100 for %.

const CENTRIFUGE_API = "https://api.centrifuge.io/";
const CENTRIFUGE_YIELD_SCALE = 1e27;

// Map Centrifuge token symbols → slugs that match rwa-yields.json. JAAA/JTRSY
// have allowlist-gated and DeFi-wrapped variants on Stellar; both share the
// underlying fund's APY.
const CENTRIFUGE_TOKENS = {
  JAAA:  ["jaaa-cdv6u7", "dejaaa-cc64wb"],
  JTRSY: ["jtrsy-cbhoek", "dejtrsy-cbi7uc"],
};

async function fetchCentrifuge() {
  const query = `{
    tokens(where: { symbol_in: ${JSON.stringify(Object.keys(CENTRIFUGE_TOKENS))} }) {
      items { symbol id }
    }
  }`;
  const tokens = await centrifugeQuery(query).then(d => d?.tokens?.items || []);
  if (tokens.length === 0) return {};

  const out = {};
  await Promise.all(tokens.map(async (t) => {
    const slugs = CENTRIFUGE_TOKENS[t.symbol];
    if (!slugs) return;
    const snap = await fetchLatestSnapshot(t.id);
    if (!snap) return;
    const value = formatCentrifugeYield(snap);
    if (!value) return;
    for (const slug of slugs) out[slug] = value;
  }));
  return out;
}

async function fetchLatestSnapshot(tokenId) {
  const q = `{
    tokenSnapshots(
      where: { id: "${tokenId}" },
      orderBy: "timestamp",
      orderDirection: "desc",
      limit: 1
    ) { items { timestamp yield7d365 } }
  }`;
  const items = await centrifugeQuery(q).then(d => d?.tokenSnapshots?.items || []);
  return items[0] || null;
}

function formatCentrifugeYield(snap) {
  const raw = snap?.yield7d365;
  if (raw == null) return null;
  // BigInt because the integer is well past 2^53. Convert to percent as Number.
  let pct;
  try {
    pct = Number(BigInt(raw)) / CENTRIFUGE_YIELD_SCALE * 100;
  } catch {
    return null;
  }
  if (!Number.isFinite(pct)) return null;
  const ts = parseInt(snap.timestamp, 10);
  const asOf = Number.isFinite(ts)
    ? new Date(ts).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return {
    yield7d: `${pct.toFixed(2)}%`,
    asOf,
    source: "Centrifuge (fund APY, 7d annualized)",
  };
}

async function centrifugeQuery(query) {
  const res = await fetch(CENTRIFUGE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Centrifuge HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Centrifuge GraphQL: ${json.errors[0]?.message}`);
  return json.data;
}

// ── Spiko ───────────────────────────────────────────────────────────────────
// Public REST API, no auth. Per-share-class yield endpoint returns
// daily/weekly/monthly yields as fractional decimals (e.g. "0.0313" = 3.13%).
// "weeklyYield" matches our "yield7d annualized" semantic.

const SPIKO_API = "https://public-api.spiko.io/v0";

const SPIKO_SYMBOLS = {
  USTBL: "ustbl-caruux",
  EUTBL: "eutbl-cbgv2q",
  UKTBL: "uktbl-cdt3ku",
  SAFO:  "safo-cdgsc6",
};

async function fetchSpiko() {
  const out = {};
  await Promise.all(Object.entries(SPIKO_SYMBOLS).map(async ([symbol, slug]) => {
    try {
      const res = await fetch(`${SPIKO_API}/share-classes/${symbol}/yield`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const wy = parseFloat(data?.weeklyYield);
      if (!Number.isFinite(wy)) return;
      const pct = wy * 100;
      const asOf = data?.updatedAt
        ? data.updatedAt.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      out[slug] = {
        yield7d: `${pct.toFixed(2)}%`,
        asOf,
        source: "Spiko (7d annualized yield)",
      };
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Spiko ${symbol} failed: ${e.message}`);
    }
  }));
  return out;
}

// ── Etherfuse ───────────────────────────────────────────────────────────────
// Public REST API, no auth. Per-bond endpoint returns `current_basis_points`,
// which is the displayed APY × 100 (so 321 bps = 3.21% APY).

const ETHERFUSE_API = "https://api.etherfuse.com";

const ETHERFUSE_SYMBOLS = {
  USTRY: "ustry-gcryug",
  CETES: "cetes-gcryug",
};

async function fetchEtherfuse() {
  const out = {};
  await Promise.all(Object.entries(ETHERFUSE_SYMBOLS).map(async ([symbol, slug]) => {
    try {
      const res = await fetch(`${ETHERFUSE_API}/lookup/bonds/cost/${symbol}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const bps = Number(data?.current_basis_points);
      if (!Number.isFinite(bps)) return;
      const pct = bps / 100;
      const asOf = data?.current_time
        ? data.current_time.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      out[slug] = {
        yield7d: `${pct.toFixed(2)}%`,
        asOf,
        source: "Etherfuse (current bond APY)",
      };
    } catch (e) {
      console.warn(`[rwa-yield-fetcher] Etherfuse ${symbol} failed: ${e.message}`);
    }
  }));
  return out;
}

// ── Ondo ────────────────────────────────────────────────────────────────────
// Ondo's authenticated API (api.gm.ondo.finance) requires an API key we don't
// have. The public marketing page ondo.finance/usdy embeds a JSON blob with
// the live APY. Anchoring the regex on the unique product name keeps this
// fragile-but-acceptable until Ondo opens a public yield endpoint.

const ONDO_USDY_URL = "https://ondo.finance/usdy";

async function fetchOndo() {
  try {
    const res = await fetch(ONDO_USDY_URL, {
      headers: { "User-Agent": "stellar-scope-rwa-fetcher/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let html = await res.text();
    // Ondo's page embeds asset data as a JSON string inside another JSON
    // payload, so quotes arrive double-escaped. Collapse `\"` → `"` once
    // so the regex below works on either escape level.
    html = html.replace(/\\"/g, '"');
    // Anchor on the unique product name so we don't capture an APY from some
    // other asset block on the page.
    const m = html.match(/"name":"Ondo US Dollar Yield"[^}]{0,200}?"apy":\s*([\d.]+)/);
    if (!m) throw new Error("apy field not found in HTML");
    const pct = parseFloat(m[1]);
    if (!Number.isFinite(pct)) throw new Error("apy not numeric");
    return {
      "usdy-gajmpx": {
        yield7d: `${pct.toFixed(2)}%`,
        asOf: new Date().toISOString().slice(0, 10),
        source: "Ondo USDY (live APY from ondo.finance)",
      },
    };
  } catch (e) {
    console.warn(`[rwa-yield-fetcher] Ondo failed: ${e.message}`);
    return {};
  }
}

// ── Registry ────────────────────────────────────────────────────────────────
// Each fetcher returns a slug-keyed object of fresh values, or {} on failure.
// Add new issuers here. Slug coverage gaps fall back to curated rwa-yields.json.

const ISSUER_FETCHERS = [
  { name: "centrifuge", fn: fetchCentrifuge },  // JAAA, deJAAA, JTRSY, deJTRSY
  { name: "spiko",      fn: fetchSpiko },        // USTBL, EUTBL, UKTBL, SAFO
  { name: "etherfuse",  fn: fetchEtherfuse },    // USTRY, CETES
  { name: "ondo",       fn: fetchOndo },         // USDY
  // Still manual (no public yield API found): BENJI (Franklin), MGUSD
  // (MoneyGram — stable, no yield), USDM1 (M1X), YLDS (computed from
  // SOFR in server.js), XAUM (non-yielding gold).
];

// ── Refresh loop ────────────────────────────────────────────────────────────

async function refreshAll() {
  const next = new Map();
  const summary = { ok: 0, failed: 0, byIssuer: {} };

  await Promise.all(ISSUER_FETCHERS.map(async ({ name, fn }) => {
    try {
      const values = await fn();
      const count = Object.keys(values).length;
      summary.byIssuer[name] = { count, error: null };
      for (const [slug, value] of Object.entries(values)) {
        next.set(slug, { ts: Date.now(), value });
      }
      summary.ok += count;
    } catch (e) {
      summary.byIssuer[name] = { count: 0, error: e.message };
      summary.failed += 1;
      console.warn(`[rwa-yield-fetcher] ${name} failed: ${e.message}`);
    }
  }));

  // Preserve stale-but-still-recent entries for slugs this round didn't refresh.
  for (const [slug, entry] of cache.entries()) {
    if (!next.has(slug) && Date.now() - entry.ts < STALE_GRACE) {
      next.set(slug, entry);
    }
  }

  cache = next;
  lastRefreshTs = Date.now();
  lastRefreshSummary = summary;
  console.log(`[rwa-yield-fetcher] refreshed ${summary.ok} slug(s); failures: ${summary.failed}`);
}

let _interval = null;
function start() {
  if (_interval) return;
  refreshAll().catch(e => console.warn("[rwa-yield-fetcher] initial refresh failed:", e.message));
  _interval = setInterval(
    () => refreshAll().catch(e => console.warn("[rwa-yield-fetcher] refresh failed:", e.message)),
    REFRESH_INTERVAL,
  );
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

function getFreshYield(slug) {
  const entry = cache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.ts > STALE_GRACE) return null;
  return entry.value;
}

function getStatus() {
  return {
    lastRefreshAt: lastRefreshTs ? new Date(lastRefreshTs).toISOString() : null,
    cachedSlugs: cache.size,
    summary: lastRefreshSummary,
  };
}

module.exports = { start, stop, refreshAll, getFreshYield, getStatus };
