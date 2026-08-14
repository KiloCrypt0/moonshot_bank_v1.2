// K2 Lend (Kinetic) position adapter — Aave-V3-style lending on Soroban.
// Docs: https://docs.k2lend.com  Contracts: https://docs.k2lend.com/contracts
//
// Model: each reserve has an aToken (supply receipt) and a variable-debt
// ledger. Wallet balances on those tokens are *scaled*; multiply by the
// reserve's liquidity_index / variable_borrow_index (RAY = 1e27) to get
// underlying units. current_liquidity_rate / current_variable_borrow_rate are
// RAY-scaled rates — verified empirically 2026-08-14: the SolvBTC reserve
// returned 0.10228, matching the 10.23% APY shown on app.k2lend.com.
const { simulateContractCall } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative } = StellarSdk;
const { priceSorobanToken } = require("../pricing-engine");

const K2_ROUTER =
  process.env.K2_ROUTER_CONTRACT ||
  "CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7";

const RAY = 1e27;

let reserveListCache = null;          // asset contract ids (never change)
const reserveMetaCache = new Map();   // asset -> { symbol, decimals, aToken, debtToken }

async function view(contractId, method, args = []) {
  const r = await simulateContractCall(contractId, method, args);
  return r == null ? null : scValToNative(r);
}

async function getReservesList() {
  if (reserveListCache) return reserveListCache;
  const list = await view(K2_ROUTER, "get_reserves_list");
  if (Array.isArray(list) && list.length) reserveListCache = list;
  return list || [];
}

async function getReserveData(asset) {
  return view(K2_ROUTER, "get_reserve_data", [new Address(asset).toScVal()]);
}

async function getReserveMeta(asset, data) {
  if (reserveMetaCache.has(asset)) return reserveMetaCache.get(asset);
  let symbol = null, decimals = 7;
  try { symbol = await view(asset, "symbol"); } catch (_) {}
  try { decimals = Number(await view(asset, "decimals")); } catch (_) {}
  const meta = {
    asset,
    symbol: typeof symbol === "string" ? symbol.replace(/\0+$/, "") : asset.slice(0, 4),
    decimals: Number.isFinite(decimals) ? decimals : 7,
    aToken: data.a_token_address,
    debtToken: data.debt_token_address,
  };
  reserveMetaCache.set(asset, meta);
  return meta;
}

async function tokenBalance(tokenId, userScVal) {
  try {
    const b = await view(tokenId, "balance", [userScVal]);
    return b == null ? 0n : BigInt(b);
  } catch (_) {
    return 0n;
  }
}

/**
 * Returns the flat positions array (server sums valueUSD; borrows negative)
 * with a __blendPoolGroups property attached for the profile table renderer.
 * Each group carries protocol:"k2" which overrides the server's default
 * `{ protocol: "blend", ...group }` spread.
 */
async function getPositions(userAddress) {
  const userScVal = new Address(userAddress).toScVal();
  const reserves = await getReservesList();
  if (!reserves.length) return [];

  const rows = [];
  let totalSuppliedUSD = 0;
  let totalBorrowedUSD = 0;

  for (const asset of reserves) {
    let data;
    try { data = await getReserveData(asset); } catch (_) { continue; }
    if (!data) continue;
    const meta = await getReserveMeta(asset, data);
    const [scaledSupply, scaledDebt] = await Promise.all([
      tokenBalance(meta.aToken, userScVal),
      tokenBalance(meta.debtToken, userScVal),
    ]);
    if (scaledSupply === 0n && scaledDebt === 0n) continue;

    const liquidityIndex = Number(data.liquidity_index) / RAY;
    const borrowIndex = Number(data.variable_borrow_index) / RAY;
    const supplyApy = Number(data.current_liquidity_rate) / RAY;
    const borrowApy = Number(data.current_variable_borrow_rate) / RAY;
    const denom = 10 ** meta.decimals;
    const supplied = (Number(scaledSupply) / denom) * liquidityIndex;
    const borrowed = (Number(scaledDebt) / denom) * borrowIndex;

    let price = null;
    try { price = await priceSorobanToken(asset, meta.symbol); } catch (_) {}
    const usd = price && price.usd != null ? price.usd : null;
    const suppliedUSD = usd != null ? supplied * usd : 0;
    const borrowedUSD = usd != null ? borrowed * usd : 0;
    totalSuppliedUSD += suppliedUSD;
    totalBorrowedUSD += borrowedUSD;

    rows.push({
      asset: meta.symbol,
      assetAddress: asset,
      decimals: meta.decimals,
      supplied,
      suppliedUSD,
      supplyApy,
      borrowed,
      borrowedUSD,
      borrowApy,
      netUSD: suppliedUSD - borrowedUSD,
      price: usd != null ? { usd, source: price.source || "pricing-engine" } : null,
      utilization: null,
    });
  }

  if (!rows.length) return [];

  const group = {
    protocol: "k2",
    protocolLabel: "K2 Lend",
    poolContractId: K2_ROUTER,
    poolName: "Primary Market",
    rows,
    totalSuppliedUSD,
    totalBorrowedUSD,
    netUSD: totalSuppliedUSD - totalBorrowedUSD,
    debtRatio: totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0,
  };

  const flat = [];
  for (const r of rows) {
    if (r.suppliedUSD !== 0) {
      flat.push({
        protocol: "k2", type: "lending", subtype: "collateral",
        poolContractId: K2_ROUTER, poolName: group.poolName,
        asset: r.asset, assetAddress: r.assetAddress, decimals: r.decimals,
        underlyingAmount: r.supplied, valueUSD: r.suppliedUSD,
        apy: r.supplyApy, price: r.price,
      });
    }
    if (r.borrowedUSD !== 0) {
      flat.push({
        protocol: "k2", type: "borrowing", subtype: "liability",
        poolContractId: K2_ROUTER, poolName: group.poolName,
        asset: r.asset, assetAddress: r.assetAddress, decimals: r.decimals,
        underlyingAmount: r.borrowed, valueUSD: -r.borrowedUSD,
        apy: r.borrowApy, price: r.price,
      });
    }
  }
  flat.__blendPoolGroups = [group];
  return flat;
}

function isConfigured() {
  return Boolean(K2_ROUTER);
}

module.exports = {
  name: "K2 Lend",
  protocolId: "k2",
  isConfigured,
  getPositions,
};
