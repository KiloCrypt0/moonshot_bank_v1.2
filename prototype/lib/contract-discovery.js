/**
 * Contract Discovery
 *
 * Auto-discovers Soroban SEP-41 token holdings for any address WITHOUT
 * requiring pre-registration in the static registry.
 *
 * Algorithm:
 *   1. Walk the address's invoke_host_function operation history on Horizon
 *   2. Extract the contract ID from each call's first parameter
 *   3. For each unique contract, probe SEP-41 metadata (name/symbol/decimals).
 *      A contract that responds to all three is a token. Anything else
 *      (AMMs, governance, custom protocols) is skipped.
 *   4. Query balance(address) on each token contract. Drop zero balances.
 *   5. Return entries shaped identically to those produced by
 *      token-resolver.resolveSorobanTokens(), so the existing
 *      /api/v1/account/:address response and the frontend renderer
 *      (which already handles type === "soroban_token") need no changes.
 *
 * Known limitations:
 *   - Tokens this wallet RECEIVED via a transfer signed by someone else
 *     will not appear in /accounts/:id/operations. To catch those, a
 *     follow-up pass using Soroban RPC's getEvents (filtered by topic =
 *     this address) would be required. Out of scope for v1.
 *   - The operation history window is bounded; very old interactions
 *     beyond MAX_OPS_TO_SCAN won't be discovered.
 *   - Discovery results are cached per address for DISCOVERY_TTL_MS.
 *     Refreshes within the TTL window return cached data.
 */
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative, xdr } = StellarSdk;
const {
  getTokenBalance,
  getTokenMetadata,
  formatTokenAmount,
} = require("./soroban-rpc");
const { SOROBAN_TOKEN_REGISTRY } = require("./token-resolver");

// ── Tunables ─────────────────────────────────────────────────────────────────

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const MAX_OPS_TO_SCAN = parseInt(process.env.DISCOVERY_MAX_OPS || "1000", 10);
const HORIZON_PAGE_SIZE = 200; // Horizon's max
const DISCOVERY_TTL_MS = parseInt(process.env.DISCOVERY_TTL_MS || "300000", 10); // 5 min
const PER_CONTRACT_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PROBES = 5;

// ── Cache ────────────────────────────────────────────────────────────────────

const discoveryCache = new Map(); // address -> { ts, tokens }

function getCached(address) {
  const hit = discoveryCache.get(address);
  if (!hit) return null;
  if (Date.now() - hit.ts > DISCOVERY_TTL_MS) {
    discoveryCache.delete(address);
    return null;
  }
  return hit.tokens;
}

function setCached(address, tokens) {
  discoveryCache.set(address, { ts: Date.now(), tokens });
}

// ── Step 1: paginate operations and collect contract IDs ─────────────────────

async function fetchInvokeHostFunctionOps(address) {
  const seen = new Set();
  let cursor = null;
  let fetched = 0;

  while (fetched < MAX_OPS_TO_SCAN) {
    const url = new URL(`${HORIZON_URL}/accounts/${address}/operations`);
    url.searchParams.set("order", "desc");
    url.searchParams.set("limit", String(HORIZON_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    let res;
    try {
      res = await fetch(url.toString(), {
        headers: { Accept: "application/hal+json" },
      });
    } catch (e) {
      console.error("Horizon ops fetch error:", e.message);
      break;
    }
    if (!res.ok) {
      if (res.status === 404) break; // account not found
      console.error(`Horizon ops returned ${res.status}`);
      break;
    }
    const body = await res.json();
    const records = body?._embedded?.records || [];
    if (records.length === 0) break;

    for (const op of records) {
      fetched++;
      if (op.type !== "invoke_host_function") continue;
      const contractId = extractContractIdFromOp(op);
      if (contractId) seen.add(contractId);
    }

    if (records.length < HORIZON_PAGE_SIZE) break; // end of history
    cursor = records[records.length - 1].paging_token;
  }

  return Array.from(seen);
}

/**
 * Every invoke_host_function op's first ScVal parameter is the contract being
 * called. Decode it from base64 XDR back to a C-strkey.
 */
function extractContractIdFromOp(op) {
  const params = op.parameters;
  if (!params || params.length === 0) return null;
  try {
    const scval = xdr.ScVal.fromXDR(params[0].value, "base64");
    if (scval.switch().name !== "scvAddress") return null;
    const addr = Address.fromScAddress(scval.address());
    const str = addr.toString();
    return str.startsWith("C") ? str : null;
  } catch (e) {
    return null;
  }
}

// ── Step 2: probe each contract for SEP-41 token metadata ───────────────────

/**
 * A contract is treated as a token if name/symbol/decimals all resolve to
 * non-default values. getTokenMetadata returns "Unknown"/"???"/7 on failure,
 * so we reject those sentinels.
 */
async function probeIsToken(contractId) {
  const meta = await withTimeout(
    getTokenMetadata(contractId),
    PER_CONTRACT_TIMEOUT_MS,
    null,
  );
  if (!meta) return null;
  // Reject the failure sentinels from getTokenMetadata
  if (meta.symbol === "???" || meta.name === "Unknown") return null;
  // Sanity: symbol should be a short string, decimals 0..36
  if (typeof meta.symbol !== "string" || meta.symbol.length > 32) return null;
  if (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36) return null;
  return meta;
}

// ── Step 3+4: resolve balances and shape results ────────────────────────────

async function resolveDiscoveredToken(contractId, userAddress) {
  const meta = await probeIsToken(contractId);
  if (!meta) return null;

  const rawBalance = await withTimeout(
    getTokenBalance(contractId, userAddress),
    PER_CONTRACT_TIMEOUT_MS,
    "0",
  );
  if (BigInt(rawBalance) === 0n) return null;

  const balance = formatTokenAmount(rawBalance, meta.decimals);

  // Match the exact shape resolveSorobanTokens() returns so the existing
  // frontend handles this without any change.
  return {
    type: "soroban_token",
    asset: {
      code: meta.symbol,
      issuer: null,
      contractId,
      domain: null,
      logo: null,
      category: "discovered",
    },
    balance,
    rawBalance,
    decimals: meta.decimals,
    valueUSD: 0, // No automatic pricing for discovered tokens; matches resolveCustomToken
    price: null,
    source: "soroban_discovery",
  };
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      ()  => { clearTimeout(t); resolve(fallback); },
    );
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-discover SEP-41 token holdings for an address.
 * Returns an array of soroban_token entries (same shape as resolveSorobanTokens).
 * Excludes contracts already in the static registry to avoid double-counting.
 */
async function discoverSorobanTokens(address, { force = false } = {}) {
  if (!force) {
    const cached = getCached(address);
    if (cached) return cached;
  }

  // Step 1: discover contracts from op history
  const allContracts = await fetchInvokeHostFunctionOps(address);

  // Step 1b: filter out anything already covered by the static registry
  const registeredIds = new Set(
    SOROBAN_TOKEN_REGISTRY.filter((t) => t.enabled).map((t) => t.contractId),
  );
  const candidates = allContracts.filter((c) => !registeredIds.has(c));

  if (candidates.length === 0) {
    setCached(address, []);
    return [];
  }

  // Steps 2-4: probe and resolve each candidate concurrently
  const resolved = await mapWithConcurrency(
    candidates,
    MAX_CONCURRENT_PROBES,
    (contractId) => resolveDiscoveredToken(contractId, address),
  );

  const tokens = resolved.filter((t) => t !== null);
  setCached(address, tokens);
  return tokens;
}

function clearCache(address) {
  if (address) discoveryCache.delete(address);
  else discoveryCache.clear();
}

module.exports = {
  discoverSorobanTokens,
  clearCache,
  // exported for tests
  _internal: { extractContractIdFromOp, probeIsToken },
};
