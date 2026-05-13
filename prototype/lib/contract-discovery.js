/**
 * Soroban Token Auto-Discovery
 *
 * Discovers SEP-41 Soroban tokens a wallet has interacted with by scanning
 * its operation history for invoke_host_function operations.
 *
 * Strategy:
 *   1. Pull recent operations from Horizon
 *   2. Filter to invoke_host_function ops (Soroban contract calls)
 *   3. For each unique contract called, check if it's an SEP-41 token
 *      (has `balance`, `symbol`, `decimals` view functions)
 *   4. Query the wallet's balance on each
 *   5. Return non-zero balances
 *
 * This is best-effort — it depends on the user having actually interacted
 * with the token contract (e.g. transferred, claimed, swapped). Pure
 * passive holdings (received but never touched) won't be discovered via
 * operation history alone; a future enhancement could scan Soroban events
 * (`SAC` mint/transfer events) for completeness.
 */

const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative, xdr } = StellarSdk;
const {
  getTokenBalance,
  getTokenMetadata,
  formatTokenAmount,
} = require("./soroban-rpc");
const { SOROBAN_TOKEN_REGISTRY } = require("./token-resolver");
const { enrichSorobanTokenWithPrice } = require("./pricing-engine");

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";

// Max operations to scan per wallet. Stellar accounts can have thousands of
// operations; we cap at a reasonable recent window to keep latency bounded.
const MAX_OPS_TO_SCAN = parseInt(process.env.DISCOVERY_MAX_OPS || "200", 10);

// Cap on distinct contracts to probe per wallet (defense in depth — a wallet
// that interacted with hundreds of contracts shouldn't fan out into hundreds
// of metadata queries).
const MAX_CONTRACTS_TO_PROBE = parseInt(
  process.env.DISCOVERY_MAX_CONTRACTS || "30",
  10
);

// Contracts already known via the static registry — skip these to avoid
// double-resolution (token-resolver.js handles them).
function _isAlreadyKnown(contractId) {
  return SOROBAN_TOKEN_REGISTRY.some(
    (t) => t.contractId === contractId
  );
}

/**
 * Pull recent invoke_host_function operations for a wallet and extract the
 * distinct contract addresses called.
 *
 * @param {string} accountId G-strkey of the wallet
 * @returns {Promise<string[]>} array of unique contract IDs (C-strkeys)
 */
async function _findCalledContracts(accountId) {
  const url = `${HORIZON_URL}/accounts/${accountId}/operations?order=desc&limit=200&include_failed=false`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[contract-discovery] Horizon ${res.status} for ${accountId}`);
    return [];
  }
  const data = await res.json();
  const ops = (data._embedded && data._embedded.records) || [];

  const seen = new Set();
  for (const op of ops.slice(0, MAX_OPS_TO_SCAN)) {
    if (op.type !== "invoke_host_function") continue;
    // The host_function payload encodes which contract was invoked.
    // Horizon decodes this into op.function = "HostFunctionTypeHostFunctionTypeInvokeContract"
    // and op.parameters[0] = the contract address.
    if (
      op.parameters &&
      Array.isArray(op.parameters) &&
      op.parameters.length > 0
    ) {
      const firstParam = op.parameters[0];
      // The contract address is in different fields depending on Horizon version
      const candidate =
        firstParam.value || firstParam.address || firstParam.contractId;
      if (
        candidate &&
        typeof candidate === "string" &&
        candidate.startsWith("C") &&
        candidate.length >= 56
      ) {
        seen.add(candidate);
      }
    }
  }
  return Array.from(seen).slice(0, MAX_CONTRACTS_TO_PROBE);
}

/**
 * Resolve a single discovered contract into a SEP-41 token result, or null
 * if it isn't a token / wallet has no balance / probe failed.
 */
async function resolveDiscoveredToken(contractId, accountId) {
  // Try to get metadata first. If the contract doesn't expose `symbol`/`decimals`,
  // it's not a SEP-41 token and we skip it.
  let meta;
  try {
    meta = await getTokenMetadata(contractId);
  } catch (e) {
    return null;
  }
  if (!meta || !meta.symbol || meta.decimals == null) return null;

  // Then query balance.
  let rawBalance;
  try {
    rawBalance = await getTokenBalance(contractId, accountId);
  } catch (e) {
    return null;
  }
  if (!rawBalance || rawBalance === 0n) return null;

  const balance = formatTokenAmount(rawBalance, meta.decimals);

  // Match the exact shape resolveSorobanTokens() returns so the existing
  // frontend handles this without any change.
  const token = {
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
    valueUSD: 0,
    price: null,
    source: "soroban_discovery",
  };

  // Enrich with price from the pricing engine (CoinGecko → Aggregator → unpriced).
  // Failures here leave the token visible but unpriced — never block.
  try {
    await enrichSorobanTokenWithPrice(token);
  } catch (e) {
    // swallow — token stays unpriced
  }
  return token;
}

/**
 * Main entry point. Discover all SEP-41 Soroban tokens a wallet has any
 * non-zero balance in.
 *
 * @param {string} accountId G-strkey of the wallet
 * @returns {Promise<object[]>} array of token results
 */
async function discoverSorobanTokens(accountId) {
  if (!accountId || typeof accountId !== "string" || !accountId.startsWith("G")) {
    return [];
  }

  let contracts;
  try {
    contracts = await _findCalledContracts(accountId);
  } catch (e) {
    console.error(`[contract-discovery] failed for ${accountId}:`, e.message);
    return [];
  }

  // Filter out already-known tokens from the static registry
  contracts = contracts.filter((c) => !_isAlreadyKnown(c));

  if (contracts.length === 0) return [];

  // Probe each in parallel with a reasonable concurrency cap (Promise.all is fine
  // here since MAX_CONTRACTS_TO_PROBE caps the fan-out at 30).
  const results = await Promise.all(
    contracts.map((c) =>
      resolveDiscoveredToken(c, accountId).catch((e) => {
        console.error(
          `[contract-discovery] resolveDiscoveredToken(${c}) failed:`,
          e.message
        );
        return null;
      })
    )
  );

  return results.filter((r) => r !== null);
}

module.exports = {
  discoverSorobanTokens,
};
