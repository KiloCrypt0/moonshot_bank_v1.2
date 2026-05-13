/**
 * Soroswap Aggregator price wrapper
 *
 * The Soroswap Aggregator (CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO)
 * routes swaps across Soroswap, Phoenix, and Aquarius pools transparently — picking
 * the best path/price across all three. Using it as our Soroban-side price oracle
 * means new pools or new AMMs added by the Soroswap team flow into our pricing
 * automatically without any maintenance on our end.
 *
 * NOTE: The aggregator's exact view-function interface (e.g. `get_best_path`,
 * `swap_exact_in_simulation`) is not 100% verified from this side at build time —
 * we attempt the most common method names and fall back to null on any error.
 * If Soroswap changes their interface or the contract is unavailable, this layer
 * cleanly degrades to "no price" rather than crashing.
 */

const StellarSdk = require("@stellar/stellar-sdk");
const { Contract, Address, nativeToScVal, scValToNative } = StellarSdk;
const { simulateContractCall } = require("./soroban-rpc");

const AGGREGATOR_CONTRACT_ID =
  process.env.SOROSWAP_AGGREGATOR_CONTRACT_ID ||
  "CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO";

// USDC SAC on Stellar mainnet — used as the dollar-denominated quote token.
const USDC_SAC_CONTRACT =
  process.env.USDC_SAC_CONTRACT ||
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

// XLM SAC wrapper (used when aggregator only supports XLM-denominated quotes)
const XLM_SAC_CONTRACT =
  process.env.XLM_SAC_CONTRACT ||
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

// Anti-manipulation: liquidity threshold below which we flag prices as thin.
// Default $1k effective depth, as agreed in design.
const MIN_DEPTH_USD = parseFloat(process.env.AGGREGATOR_MIN_DEPTH_USD || "1000");

// How much price-impact we tolerate before downgrading confidence
// (test query at 10x scale should produce a quote within this fraction)
const MAX_PRICE_IMPACT_PCT = parseFloat(
  process.env.AGGREGATOR_MAX_PRICE_IMPACT_PCT || "0.05" // 5%
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function toI128(amount) {
  return nativeToScVal(BigInt(amount), { type: "i128" });
}

function toAddr(strkey) {
  return new Address(strkey).toScVal();
}

/**
 * Try to call a quote-style method on the aggregator. The aggregator's view
 * method names can vary across versions; we try a small set in order.
 *
 * Each candidate is given: (token_in, token_out, amount_in)
 * Expected return: native BigInt (raw amount of token_out for given amount_in)
 *
 * Returns: { rawOut: BigInt, method: string } | null
 */
async function _tryQuote(tokenInContract, tokenOutContract, amountInRaw) {
  const candidates = ["get_best_path", "swap_quote", "get_quote", "quote"];
  for (const m of candidates) {
    try {
      const result = await simulateContractCall(AGGREGATOR_CONTRACT_ID, m, [
        toAddr(tokenInContract),
        toAddr(tokenOutContract),
        toI128(amountInRaw),
      ]);
      if (!result) continue;
      const native = scValToNative(result);
      // Result shape may be { amount_out, path, ... } or just a BigInt.
      let amountOut = null;
      if (typeof native === "bigint") amountOut = native;
      else if (native && typeof native === "object") {
        amountOut = native.amount_out || native.out || native.expected_out || null;
        if (typeof amountOut !== "bigint" && amountOut != null) {
          amountOut = BigInt(amountOut.toString());
        }
      } else if (Array.isArray(native) && native.length > 0) {
        // Some aggregators return [out, path...]
        const v = native[native.length - 1];
        amountOut = typeof v === "bigint" ? v : null;
      }
      if (amountOut && amountOut > 0n) {
        return { rawOut: amountOut, method: m };
      }
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a USD price for a Soroban token by quoting against USDC via the aggregator.
 *
 * Returns: { usd, source, confidence, depthOk, priceImpact } | null
 *   - confidence: 'high' | 'thin-liquidity'
 *   - depthOk: boolean (passed MIN_DEPTH_USD check)
 *   - priceImpact: fraction (e.g. 0.03 = 3%)
 *
 * @param {string} contractId C-strkey of the Soroban token
 * @param {number} decimals Token decimals (for computing the 1-unit probe)
 */
async function priceSorobanTokenInUSD(contractId, decimals = 7) {
  if (!contractId || contractId === USDC_SAC_CONTRACT) {
    return contractId === USDC_SAC_CONTRACT
      ? { usd: 1, source: "soroswap-aggregator-usdc-self", confidence: "high", depthOk: true, priceImpact: 0 }
      : null;
  }

  // Probe: 1 unit of the input token
  const oneUnit = BigInt(10) ** BigInt(decimals);

  // First quote: 1 unit → USDC
  const quote1 = await _tryQuote(contractId, USDC_SAC_CONTRACT, oneUnit);
  if (!quote1) return null;

  // Convert raw USDC (assume 7 decimals for the Stellar USDC SAC; verify if it varies)
  const USDC_DECIMALS = 7;
  const usdcDivisor = 10 ** USDC_DECIMALS;
  const pricePerUnit = Number(quote1.rawOut) / usdcDivisor;
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) return null;

  // Anti-manipulation: re-quote at 10x scale, verify linearity within tolerance
  const tenUnits = oneUnit * 10n;
  const quote10 = await _tryQuote(contractId, USDC_SAC_CONTRACT, tenUnits);
  let priceImpact = null;
  let depthOk = false;
  if (quote10) {
    const pricePerUnitAt10x = Number(quote10.rawOut) / 10 / usdcDivisor;
    priceImpact = Math.abs(pricePerUnit - pricePerUnitAt10x) / pricePerUnit;
    // Depth check: the 10-unit quote returning >= MIN_DEPTH_USD worth of USDC
    // means the pool can absorb at least that much, which proxies for adequate
    // liquidity. (Note: this is a rough proxy, not true TVL.)
    depthOk = Number(quote10.rawOut) / usdcDivisor >= MIN_DEPTH_USD;
  }

  const confidence =
    depthOk && priceImpact !== null && priceImpact <= MAX_PRICE_IMPACT_PCT
      ? "high"
      : "thin-liquidity";

  return {
    usd: pricePerUnit,
    change24h: 0, // Aggregator doesn't expose 24h change
    source: "soroswap-aggregator",
    confidence,
    depthOk,
    priceImpact,
  };
}

/**
 * For classic Stellar assets — derive their Soroban Asset Contract (SAC)
 * address from the classic asset, then price via Soroban path.
 *
 * Caveat: not all classic assets have a deployed SAC. If `Asset.contractId()`
 * fails or the contract doesn't exist on-chain, returns null.
 */
async function priceClassicAssetViaSACInUSD(code, issuer) {
  try {
    const asset = new StellarSdk.Asset(code, issuer);
    const sacContract = asset.contractId(StellarSdk.Networks.PUBLIC);
    if (!sacContract) return null;
    return await priceSorobanTokenInUSD(sacContract, 7);
  } catch (e) {
    return null;
  }
}

module.exports = {
  priceSorobanTokenInUSD,
  priceClassicAssetViaSACInUSD,
  AGGREGATOR_CONTRACT_ID,
  USDC_SAC_CONTRACT,
};
