/**
 * Price ticker resolver — fetches live prices for the marquee banner.
 *
 * Source: SDF's Freighter backend /token-prices endpoint. It accepts a batch
 * of token identifiers (either "XLM" or "CODE:ISSUER" for classic assets) and
 * returns current price + 24h percentage change in a single call. We use it
 * for all four ticker tokens because they're all Stellar-native classic
 * assets with active liquidity that Freighter prices accurately.
 *
 * Caching:
 *   30-second in-memory cache. The marquee polls every 30s so this avoids any
 *   chance of hammering the upstream even if multiple browser tabs are open.
 *
 * Sanity check:
 *   We've seen the upstream return absurd 24h-change values (e.g. +666%) when
 *   its yesterday-price baseline is missing. Any change outside ±200% gets
 *   replaced with null so the UI just hides the percentage rather than
 *   showing a wrong number.
 */

const FREIGHTER_PRICES = "https://freighter-backend-prd.stellar.org/api/v1/token-prices";

const CHANGE_SANITY_BOUND = 200; // |24h change %| above this is treated as bad data
const CACHE_TTL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let cache = { ts: 0, data: null };

// Tokens shown in the marquee. Order is the display order.
const TOKENS = [
  {
    symbol: "XLM",
    name: "Stellar Lumens",
    freighterKey: "XLM",
  },
  {
    symbol: "AQUA",
    name: "Aquarius",
    freighterKey: "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
  },
  {
    symbol: "BLND",
    name: "Blend",
    freighterKey: "BLND:GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
  },
  {
    symbol: "EURC",
    name: "Euro Coin",
    freighterKey: "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
  },
];

async function fetchWithTimeout(url, ms, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function sanityCheckChange(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  if (Math.abs(pct) > CHANGE_SANITY_BOUND) return null;
  return pct;
}

async function fetchPricesUncached() {
  const tokenKeys = TOKENS.map((t) => t.freighterKey);
  let response;
  try {
    response = await fetchWithTimeout(FREIGHTER_PRICES, FETCH_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: tokenKeys }),
    });
  } catch (e) {
    throw new Error(`Freighter prices endpoint unreachable: ${e.message}`);
  }
  if (!response.ok) {
    throw new Error(`Freighter prices returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const priceMap = body && body.data ? body.data : {};

  // Map back to our token list, preserving order. Tokens that came back
  // empty or with NaN prices are still included in the output but with
  // price: null — the frontend can choose to skip them or show a placeholder.
  return TOKENS.map((t) => {
    const v = priceMap[t.freighterKey];
    if (!v) return { symbol: t.symbol, name: t.name, price: null, change24h: null };
    const price = parseFloat(v.currentPrice);
    const change = sanityCheckChange(parseFloat(v.percentagePriceChange24h));
    return {
      symbol: t.symbol,
      name: t.name,
      price: Number.isFinite(price) ? price : null,
      change24h: change,
    };
  });
}

/**
 * Public entry point. Returns:
 *   {
 *     tokens: [
 *       { symbol, name, price, change24h },
 *       ...
 *     ],
 *     updatedAt: <epoch ms>,
 *     cached: <bool>,
 *   }
 */
async function getTickerPrices() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }
  const tokens = await fetchPricesUncached();
  const fresh = { tokens, updatedAt: now };
  cache = { ts: now, data: fresh };
  return { ...fresh, cached: false };
}

module.exports = { getTickerPrices };
