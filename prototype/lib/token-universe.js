/**
 * Token Universe
 *
 * Maintains the canonical list of "known Soroban SEP-41 token contracts on
 * Stellar mainnet" — the candidate set we probe for ANY wallet to find its
 * actual holdings, regardless of operation history.
 *
 * Sources (deduplicated, in priority order):
 *   1. token-price-map seed + dynamic refresh   — CoinGecko-listed Stellar tokens
 *   2. Soroswap official token list             — curated by Soroswap (~43 entries)
 *   3. stellar.expert contract index            — top contracts by activity
 *
 * Each entry: { contractId, symbol?, decimals?, name?, source }
 *
 * The universe is loaded once at module import (with the price-map's seed),
 * refreshed asynchronously shortly after startup, and refreshed periodically.
 * Lookups never block on a refresh; they always read from the current
 * in-memory set.
 *
 * Rationale: PR #1's operation-history-based discovery is fragile because a
 * wallet's contract interactions age out of the recent-200-ops window after
 * enough subsequent activity (typical pattern: hold a token, receive dust
 * payments, lose discovery). The probe-against-universe approach is
 * resilient: if a balance exists, it's found, no matter when the wallet
 * last interacted with the contract.
 */

const priceMap = require("./token-price-map");

const REFRESH_INTERVAL_MS = parseInt(process.env.UNIVERSE_REFRESH_MS || "21600000", 10); // 6h
const SOROSWAP_TOKEN_LIST_URL =
  process.env.SOROSWAP_TOKEN_LIST_URL ||
  "https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json";

// Whether to pull the stellar.expert contract index. This is a wider net than
// the curated sources but takes longer to fetch. On by default.
const INCLUDE_STELLAR_EXPERT = process.env.UNIVERSE_INCLUDE_STELLAR_EXPERT !== "false";
const STELLAR_EXPERT_API =
  process.env.STELLAR_EXPERT_API || "https://api.stellar.expert/explorer/public";

// Hard cap on universe size to keep probe latency bounded. Curated lists +
// stellar.expert top contracts shouldn't approach this in practice, but a
// safety valve in case stellar.expert returns thousands of low-quality hits.
const MAX_UNIVERSE_SIZE = parseInt(process.env.UNIVERSE_MAX_SIZE || "500", 10);

// ── In-memory universe ───────────────────────────────────────────────────────

// contractId → { contractId, symbol?, decimals?, name?, sources: Set<string> }
const universe = new Map();
let lastRefreshTs = 0;
let refreshInFlight = null;

function _add(entry) {
  if (!entry || !entry.contractId) return;
  if (typeof entry.contractId !== "string") return;
  if (!entry.contractId.startsWith("C") || entry.contractId.length < 56) return;

  const existing = universe.get(entry.contractId);
  if (existing) {
    existing.sources.add(entry.source || "unknown");
    // Fill in missing fields from new source
    if (!existing.symbol && entry.symbol) existing.symbol = entry.symbol;
    if (existing.decimals == null && entry.decimals != null) existing.decimals = entry.decimals;
    if (!existing.name && entry.name) existing.name = entry.name;
  } else {
    if (universe.size >= MAX_UNIVERSE_SIZE) return; // safety cap
    universe.set(entry.contractId, {
      contractId: entry.contractId,
      symbol: entry.symbol || null,
      decimals: entry.decimals != null ? entry.decimals : null,
      name: entry.name || null,
      sources: new Set([entry.source || "unknown"]),
    });
  }
}

// ── Source 1: token-price-map (already has the CoinGecko-seeded set) ─────────

function _seedFromPriceMap() {
  // The price-map's internal sorobanMap is keyed by contractId → coingeckoId.
  // We can re-derive symbols/decimals from the SEED, but lookups are fine with
  // just the contractId for probing purposes — metadata gets populated on
  // first balance probe via getTokenMetadata.
  const stats = priceMap.stats();
  // Best-effort: iterate via the stats interface. If we need actual entries,
  // we add a quick accessor. (See token-price-map.js: this works because
  // _maybeRefresh and lookupSoroban access the same internal map.)
  // For seeding we just enumerate what we know.
  // To avoid coupling, we iterate the known contractIds we have:
  if (typeof priceMap.knownSorobanContracts === "function") {
    for (const contractId of priceMap.knownSorobanContracts()) {
      _add({ contractId, source: "price-map" });
    }
  }
  // Static seed of known Soroban contracts with their decimals and symbols.
  // Critical: Soroban RPC metadata calls can fail (rate-limit, transient errors).
  // When they do, contract-discovery falls back to defaults — and the wrong
  // default for an 8-decimals token (like SolvBTC) produces a 10x balance
  // misreport. Encoding decimals here guarantees correct balance formatting
  // even when metadata fetch fails.
  //
  // Decimals values: Bitcoin-derived tokens (SolvBTC, SolvBTC.BBN) use 8;
  // Stellar-native and stablecoin SACs use 7 (the Stellar default).
  const STATIC_SEED = [
    { contractId: "CB44W727WSLHPXJ47A6DHF5D34RKWSOZAMEDXO3CF5TEEEQ2ZX4V3VRI", symbol: "EURAU",    decimals: 7 },
    { contractId: "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF", symbol: "EUTBL",    decimals: 7 },
    { contractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2", symbol: "PYUSD",    decimals: 7 },
    { contractId: "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX", symbol: "SAFO",     decimals: 7 },
    { contractId: "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH", symbol: "EURCV",    decimals: 7 },
    { contractId: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN", symbol: "SOLVBTC",  decimals: 8 },
    { contractId: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J", symbol: "XSOLVBTC", decimals: 8 },
    { contractId: "CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4", symbol: "CHFSAFO",  decimals: 7 },
    { contractId: "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP", symbol: "EURSAFO",  decimals: 7 },
    { contractId: "CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP", symbol: "GBPSAFO",  decimals: 7 },
    { contractId: "CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR", symbol: "UKTBL",    decimals: 7 },
    { contractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",      decimals: 7 },
    { contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC",     decimals: 7 },
    { contractId: "CAC743NYRBMS76L2DCPAXZTOEF6EJPKPVEC5OX2SXY7HOWNXISSLUE2C", symbol: "USDM1",    decimals: 7 },
  ];
  for (const e of STATIC_SEED) _add({ ...e, source: "static-seed" });
}

// ── Source 2: Soroswap official token list ───────────────────────────────────

async function _fetchSoroswapList() {
  try {
    const res = await fetch(SOROSWAP_TOKEN_LIST_URL);
    if (!res.ok) {
      console.error(`[token-universe] Soroswap list HTTP ${res.status}`);
      return 0;
    }
    const data = await res.json();
    const assets = data.assets || [];
    let added = 0;
    for (const a of assets) {
      if (a.contract && typeof a.contract === "string") {
        const before = universe.has(a.contract);
        _add({
          contractId: a.contract,
          symbol: a.code,
          decimals: a.decimals,
          name: a.name,
          source: "soroswap",
        });
        if (!before && universe.has(a.contract)) added++;
      }
    }
    return added;
  } catch (e) {
    console.error("[token-universe] Soroswap fetch error:", e.message);
    return 0;
  }
}

// ── Source 3: stellar.expert contract index ──────────────────────────────────

async function _fetchStellarExpertContracts() {
  if (!INCLUDE_STELLAR_EXPERT) return 0;
  try {
    // Order by number of trustlines descending — this surfaces SEP-41 tokens
    // (which accumulate trustlines/holders) over other contract types.
    const url = `${STELLAR_EXPERT_API}/contract?sort=trustlines&order=desc&limit=200`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[token-universe] stellar.expert HTTP ${res.status}`);
      return 0;
    }
    const data = await res.json();
    const records = (data._embedded && data._embedded.records) || (Array.isArray(data) ? data : []);
    let added = 0;
    for (const r of records) {
      if (r.contract && typeof r.contract === "string") {
        const before = universe.has(r.contract);
        _add({
          contractId: r.contract,
          source: "stellar.expert",
        });
        if (!before && universe.has(r.contract)) added++;
      }
    }
    return added;
  } catch (e) {
    console.error("[token-universe] stellar.expert fetch error:", e.message);
    return 0;
  }
}

// ── Refresh orchestration ────────────────────────────────────────────────────

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const t0 = Date.now();
    const sizeBefore = universe.size;
    const soroswapAdded = await _fetchSoroswapList();
    const stellarExpertAdded = await _fetchStellarExpertContracts();
    lastRefreshTs = Date.now();
    console.log(
      `[token-universe] refreshed in ${Date.now() - t0}ms: +${soroswapAdded} from soroswap, ` +
        `+${stellarExpertAdded} from stellar.expert (total: ${universe.size}, was: ${sizeBefore})`
    );
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function _maybeRefresh() {
  if (Date.now() - lastRefreshTs > REFRESH_INTERVAL_MS) {
    refresh().catch(() => {});
  }
}

// ── Initialization ───────────────────────────────────────────────────────────

_seedFromPriceMap();

// Kick off remote refresh shortly after startup (don't block startup)
setTimeout(() => refresh().catch(() => {}), 5000).unref?.();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current universe as an array of entries.
 * Each entry: { contractId, symbol?, decimals?, name?, sources: Set<string> }
 */
function getAll() {
  _maybeRefresh();
  return Array.from(universe.values());
}

/**
 * Get just the contract IDs (for fast iteration).
 */
function getContractIds() {
  _maybeRefresh();
  return Array.from(universe.keys());
}

/**
 * Look up a single entry by contract ID.
 */
function get(contractId) {
  return universe.get(contractId) || null;
}

/**
 * Manually register a contract ID (e.g., when contract-discovery finds a
 * balance for a contract not yet in the universe, we add it for future
 * discovery to be even faster).
 */
function add(contractId, fields = {}) {
  _add({ contractId, ...fields, source: fields.source || "runtime" });
}

function stats() {
  return {
    size: universe.size,
    lastRefreshTs,
    lastRefreshAgoMs: lastRefreshTs ? Date.now() - lastRefreshTs : null,
    sourcesBreakdown: (() => {
      const counts = {};
      for (const e of universe.values()) {
        for (const s of e.sources) {
          counts[s] = (counts[s] || 0) + 1;
        }
      }
      return counts;
    })(),
  };
}

module.exports = {
  getAll,
  getContractIds,
  get,
  add,
  refresh,
  stats,
};
