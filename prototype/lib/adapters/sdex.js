/**
 * SDEX — Stellar's protocol-native decentralized exchange.
 *
 * Two distinct position types are captured here, both via Horizon (no
 * Soroban RPC calls required — SDEX is a classic-Stellar feature):
 *
 *   1. Open offers (limit orders sitting in the order book)
 *      Endpoint: GET /accounts/{id}/offers
 *      Each open offer is a wallet's pending order to swap one asset for
 *      another at a specified price. The selling-side amount is locked
 *      until the offer fills, cancels, or expires. We surface each offer
 *      as a DeFi position of type `limit_order`, valued at the selling-side
 *      USD value (this is the asset the user has effectively put up).
 *
 *   2. Classic AMM liquidity pool shares
 *      These are the pool shares from Stellar's *protocol-level* AMM
 *      (CAP-38), not Soroban AMMs like Soroswap or SushiSwap. A wallet's
 *      `liquidity_pool_shares` balance entry on Horizon represents a
 *      pro-rata claim on the pool's reserves.
 *      Endpoint: GET /liquidity_pools/{id}
 *      Returns pool reserves and total shares; we compute the wallet's
 *      underlying claim on each side. Surfaced as DeFi position type `lp`.
 *
 * Why an adapter (not core server.js logic): grouping these alongside
 * Blend / Sushi / Solv / Aquarius / Templar makes the DeFi tab the
 * single home for "money the wallet has put to work somewhere", which is
 * the model Klint asked for. The Tokens tab stays as "free wallet
 * balances only" — pool shares are explicitly filtered out there (see
 * server.js LP filtering note added in this PR).
 *
 * No Soroban dependency. No new npm deps. Best-effort fetch — any
 * Horizon error returns an empty array so the rest of the response is
 * unaffected.
 */

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const pricingEngine = require("../pricing-engine");

// ─────────────────────────────────────────────────────────────────────────────
// Horizon fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchOffers(address) {
  try {
    // 100 is the per-page max on Horizon. Wallets with more than 100 open
    // offers are rare; we'd need cursor-paginate for those edge cases.
    const res = await fetch(`${HORIZON_URL}/accounts/${address}/offers?limit=100`);
    if (!res.ok) return [];
    const data = await res.json();
    const records = (data._embedded && data._embedded.records) || [];
    return records;
  } catch (e) {
    console.error("[SDEX] fetch offers error:", e.message);
    return [];
  }
}

async function _fetchAccountBalances(address) {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.balances || [];
  } catch (e) {
    console.error("[SDEX] fetch account error:", e.message);
    return [];
  }
}

async function _fetchPool(poolId) {
  try {
    const res = await fetch(`${HORIZON_URL}/liquidity_pools/${poolId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("[SDEX] fetch pool error:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset description helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stellar Horizon represents assets in offers as { asset_type, asset_code?, asset_issuer? }.
 * For pool reserves the format is "CODE:ISSUER" or "native".
 * Normalize to { code, issuer } where issuer is null for XLM.
 */
function _parseHorizonAsset(asset) {
  if (!asset) return { code: "?", issuer: null };
  if (typeof asset === "string") {
    if (asset === "native") return { code: "XLM", issuer: null };
    const [code, issuer] = asset.split(":");
    return { code, issuer: issuer || null };
  }
  if (asset.asset_type === "native") return { code: "XLM", issuer: null };
  return { code: asset.asset_code || "?", issuer: asset.asset_issuer || null };
}

/**
 * Look up a USD price for a classic asset via the pricing engine. Same path
 * used by server.js for token balances, so prices stay consistent.
 */
async function _priceAsset(code, issuer, xlmPrice) {
  if (code === "XLM" && !issuer) {
    return xlmPrice ? { usd: xlmPrice } : null;
  }
  try {
    // Note: priceClassicAsset's first argument is a providers object. We
    // pass {} since pricing-engine's SDEX path requires getAssetPriceViaSDEX
    // which lives in server.js and isn't shared. The classic-asset path
    // falls back to CoinGecko-style lookups for well-known assets, which
    // is sufficient for USDC/EURC/etc. that account for the vast majority
    // of SDEX volume.
    const price = await pricingEngine.priceClassicAsset({}, code, issuer);
    return price;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Position builders
// ─────────────────────────────────────────────────────────────────────────────

async function _buildOfferPosition(offer, xlmPrice) {
  const selling = _parseHorizonAsset(offer.selling);
  const buying = _parseHorizonAsset(offer.buying);
  const amount = parseFloat(offer.amount);
  const price = parseFloat(offer.price);

  // Value of this offer = selling amount × selling-side USD price.
  // (This is what the wallet has locked up.)
  let valueUSD = 0;
  let sellingPriceUSD = null;
  try {
    const sellPrice = await _priceAsset(selling.code, selling.issuer, xlmPrice);
    if (sellPrice && Number.isFinite(sellPrice.usd)) {
      sellingPriceUSD = sellPrice.usd;
      valueUSD = amount * sellPrice.usd;
    }
  } catch (_) {}

  return {
    protocol: "sdex",
    type: "limit_order",
    subtype: "open_offer",
    offerId: offer.id,
    sellingAsset: selling.code,
    sellingIssuer: selling.issuer,
    sellingAmount: amount,
    buyingAsset: buying.code,
    buyingIssuer: buying.issuer,
    price,                          // human-readable price (sell/buy ratio)
    valueUSD,
    sellingPriceUSD,
    poolName: `${selling.code} → ${buying.code}`,  // for the card header
  };
}

async function _buildLpPosition(poolBalance, xlmPrice) {
  const poolId = poolBalance.liquidity_pool_id;
  const shares = parseFloat(poolBalance.balance);
  if (!poolId || !Number.isFinite(shares) || shares <= 0) return null;

  const pool = await _fetchPool(poolId);
  if (!pool) {
    // Pool fetch failed — still emit a minimal position so the wallet's
    // share isn't completely invisible. valueUSD=0 in this case.
    return {
      protocol: "sdex",
      type: "lp",
      subtype: "amm_pool",
      poolId,
      shares,
      reserves: [],
      valueUSD: 0,
      poolName: "Stellar AMM pool",
      shareOfPool: 0,
      note: "Pool details unavailable",
    };
  }

  const totalShares = parseFloat(pool.total_shares) || 0;
  const shareFraction = totalShares > 0 ? shares / totalShares : 0;

  const reserves = pool.reserves || [];
  const enrichedReserves = [];
  let totalUSD = 0;

  for (const r of reserves) {
    const { code, issuer } = _parseHorizonAsset(r.asset);
    const reserveAmount = parseFloat(r.amount) || 0;
    const userShare = reserveAmount * shareFraction;
    const price = await _priceAsset(code, issuer, xlmPrice);
    const priceUsd = price?.usd || 0;
    const valueUSD = userShare * priceUsd;
    totalUSD += valueUSD;
    enrichedReserves.push({
      code,
      issuer,
      reserveTotal: reserveAmount,
      userShare,
      priceUsd,
      valueUSD,
    });
  }

  // Build a pool name from the two reserve codes
  const codes = enrichedReserves.map((r) => r.code);
  const poolName = codes.length === 2 ? `${codes[0]} / ${codes[1]}` : `Pool ${poolId.slice(0, 8)}…`;

  return {
    protocol: "sdex",
    type: "lp",
    subtype: "amm_pool",
    poolId,
    shares,
    totalShares,
    shareOfPool: shareFraction,
    reserves: enrichedReserves,
    valueUSD: totalUSD,
    poolName,
    feeBp: pool.fee_bp || 30,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional second argument: { xlmPrice } so we don't refetch XLM price.
 * If not provided, asset pricing for XLM is best-effort via the pricing
 * engine's classic-asset path (which may not have a fallback for native XLM).
 */
async function getPositions(address, { xlmPrice = null } = {}) {
  const [offers, balances] = await Promise.all([
    _fetchOffers(address),
    _fetchAccountBalances(address),
  ]);

  const positions = [];

  // Open offers
  for (const offer of offers) {
    try {
      const pos = await _buildOfferPosition(offer, xlmPrice);
      if (pos) positions.push(pos);
    } catch (e) {
      console.error("[SDEX] offer build error:", e.message);
    }
  }

  // Classic AMM pool shares
  const poolShares = balances.filter((b) => b.asset_type === "liquidity_pool_shares");
  for (const pb of poolShares) {
    try {
      const pos = await _buildLpPosition(pb, xlmPrice);
      if (pos) positions.push(pos);
    } catch (e) {
      console.error("[SDEX] pool build error:", e.message);
    }
  }

  return positions;
}

function isConfigured() {
  // SDEX is always available on mainnet — no contract IDs to configure.
  return true;
}

const SdexAdapter = {
  name: "SDEX",
  protocol: "sdex",
  protocolId: "sdex",
  isConfigured,
  getPositions,
};

module.exports = SdexAdapter;
