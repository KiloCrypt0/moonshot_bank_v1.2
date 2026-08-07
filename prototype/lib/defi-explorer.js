/**
 * DeFi Explorer — protocol & pool directory for the top-level "DeFi" tab.
 *
 * Answers "what DeFi exists on Stellar, how big is it, and what does it pay?"
 * for a newcomer. This is a DIRECTORY (protocol → pools ≥ TVL threshold),
 * not a portfolio tracker — no user addresses involved.
 *
 * Architecture mirrors rwa-yield-fetcher.js (the proven pattern in this repo):
 *   - One fetcher per protocol. Each returns a full protocol entry
 *     { ...meta, pools: [...] } or null on failure — never throws past
 *     its boundary.
 *   - Background refresh loop keeps a cache warm; the HTTP endpoint serves
 *     the cache instantly and never triggers network calls on the request
 *     path. Stale-grace: a failed refresh keeps the previous value up to
 *     24h so transient API outages don't blank the page.
 *   - Per-protocol refresh intervals reflect data-source cost:
 *       Aquarius / Upshift  (one HTTP call)      → every cycle (60s min gap)
 *       Blend               (~30 RPC calls)      → 5 min
 *       Sentora             (1 RPC call)         → 5 min
 *       SushiSwap           (universe 1h, data 5 min)
 *       Soroswap            (universe 1h, TVL 15 min — 214 pairs is heavy)
 *       Templar             (static card, refreshed daily for custody TVL)
 *
 * Data-source notes (validated live 2026-08-07, see PR description):
 *   - Aquarius API returns USD values in 7-DECIMAL FIXED POINT — divide by 1e7.
 *   - Sushi/Soroswap publish no APY on-chain (fee APR needs volume history
 *     behind gated APIs) → pools carry apy: null, UI renders "—".
 *   - Upshift API `tvl` field is USD (verified: on-chain vault buffer ≈ 5% of
 *     tvl, matching their reserve_target of 0.05).
 *   - Templar's lending logic lives on NEAR; Stellar custody ≈ $65K (below
 *     threshold) → card only, no pool rows.
 */

const { simulateContractCall, getTokenBalance, getTokenMetadata } = require("./soroban-rpc");
const pricingEngine = require("./pricing-engine");
const BlendAdapter = require("./adapters/blend");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative } = StellarSdk;

// ── Config ──────────────────────────────────────────────────────────────────

const MIN_POOL_TVL_USD = Number(process.env.DEFI_EXPLORER_MIN_TVL_USD || 250_000);
const REFRESH_INTERVAL = 60_000;            // main loop tick
const STALE_GRACE = 24 * 60 * 60_000;       // serve stale values up to 24h on failure

const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

// ── Protocol metadata (hand-written blurbs; pool notes are auto-generated) ──

const PROTOCOL_META = {
  blend: {
    id: "blend",
    name: "Blend",
    category: "Lending",
    url: "https://mainnet.blend.capital",
    blurb:
      "Stellar's main lending protocol. Supply assets to earn interest, or borrow against " +
      "your collateral. Each pool is isolated — problems in one pool can't spread to " +
      "others — and a shared \"backstop\" insurance layer absorbs bad debt first.",
  },
  aquarius: {
    id: "aquarius",
    name: "Aquarius",
    category: "AMM / DEX",
    url: "https://aqua.network",
    blurb:
      "Stellar's largest automated market maker (AMM). Deposit two tokens into a pool " +
      "and earn a share of every swap fee, plus AQUA token rewards on incentivized " +
      "pools. Pools come in three flavors: standard, stable (for pegged pairs), and " +
      "concentrated (higher capital efficiency, more active management).",
  },
  soroswap: {
    id: "soroswap",
    name: "Soroswap",
    category: "AMM / DEX",
    url: "https://soroswap.finance",
    blurb:
      "The first AMM built on Soroban, Stellar's smart contract platform. Classic " +
      "constant-product pools (like Uniswap V2): deposit a 50/50 pair, earn swap fees. " +
      "Also aggregates routes across other Stellar DEXes for best-price swaps.",
  },
  sushiswap: {
    id: "sushiswap",
    name: "SushiSwap V3",
    category: "AMM / DEX",
    url: "https://www.sushi.com/stellar/explore/pools",
    blurb:
      "The multichain DEX veteran, live on Stellar since early 2026 with V3 " +
      "concentrated liquidity: liquidity providers choose a price range for their " +
      "capital, earning more fees when trades happen inside it. More efficient than " +
      "classic pools, but needs more active management.",
  },
  upshift: {
    id: "upshift",
    name: "Upshift",
    category: "Yield Vaults",
    url: "https://app.upshift.finance",
    blurb:
      "Tokenized yield vaults. Deposit a single asset (USDC or XLM) and receive a " +
      "vault share token that grows in value as the vault's strategy earns yield. " +
      "The Gami vaults on Stellar route deposits to institutional strategies — " +
      "no pair management or lending decisions needed.",
  },
  sentora: {
    id: "sentora",
    name: "Sentora",
    category: "Yield Vaults",
    url: "https://defi.stellar.org",
    blurb:
      "Institutional DeFi infrastructure (part of the Stellar DeFi Hub initiative). " +
      "Its XLM vault takes native XLM deposits under a principal-escrow design; " +
      "yield is distributed off-chain, so no live APY is published on-chain.",
  },
  templar: {
    id: "templar",
    name: "Templar Finance",
    category: "Lending",
    url: "https://templarfi.org",
    blurb:
      "Cross-chain lending: post Stellar assets (XLM, SolvBTC, RWAs like deJAAA and " +
      "CETES) as collateral and borrow stablecoins. The lending engine runs on NEAR " +
      "via chain signatures, with Stellar-side custody accounts holding collateral. " +
      "Stellar-side deposits are currently below this page's TVL threshold, so no " +
      "individual markets are listed yet.",
  },
};

// ── Shared helpers ──────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _parallelMap(items, worker, concurrency = 5) {
  const out = new Array(items.length);
  let i = 0;
  async function pump() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        if (/429|rate/i.test(e?.message || "")) {
          await _sleep(300 + Math.random() * 400);
          try { out[idx] = await worker(items[idx], idx); }
          catch { out[idx] = null; }
        } else { out[idx] = null; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pump));
  return out;
}

async function _priceToken(contractId) {
  try {
    const p = await pricingEngine.priceSorobanToken(contractId);
    return p && Number.isFinite(p.usd) ? p.usd : null;
  } catch { return null; }
}

async function _tokenSymbol(contractId) {
  try {
    if (contractId === XLM_SAC) return "XLM";
    const meta = await getTokenMetadata(contractId);
    return meta?.symbol || contractId.slice(0, 6) + "…";
  } catch { return contractId.slice(0, 6) + "…"; }
}

// Parse Aquarius "tokens_str" entries: "native" or "CODE:ISSUER".
function _aquaTokenCode(s) {
  if (!s || s === "native") return "XLM";
  return String(s).split(":")[0];
}

// ── Aquarius ────────────────────────────────────────────────────────────────

const AQUA_SCALE = 1e7; // ALL USD values in the Aquarius API are 7-dec fixed point

async function fetchAquarius() {
  const pools = [];
  let total = Infinity;
  let page = 1;
  let totalTvl = 0;
  let allCount = 0;

  while (pools.length + 0 < total && page <= 6) {
    const res = await fetch(`https://amm-api.aqua.network/pools/?page=${page}&size=100`, {
      headers: { "User-Agent": "StellarScope/1.0" },
    });
    if (!res.ok) throw new Error(`Aquarius HTTP ${res.status}`);
    const data = await res.json();
    total = data.total ?? 0;
    allCount = total;
    for (const p of data.items || []) {
      const tvl = Number(p.liquidity_usd || 0) / AQUA_SCALE;
      totalTvl += tvl;
      if (tvl < MIN_POOL_TVL_USD) continue;
      const codes = (p.tokens_str || []).map(_aquaTokenCode);
      const baseApy = Number(p.apy || 0);
      const rewardsApy = Number(p.rewards_apy || 0) + Number(p.incentive_apy || 0);
      const typeLabel = p.pool_type === "stable" ? "stable"
        : p.pool_type === "concentrated" ? "concentrated" : "standard";
      pools.push({
        assets: codes,
        name: codes.join(" / "),
        tvlUSD: tvl,
        apy: baseApy,                 // fraction (0.05 = 5%)
        rewardApy: rewardsApy || 0,   // fraction
        feePct: Number(p.fee || 0) * 100,
        poolType: typeLabel,
        address: p.address,
        url: `https://aqua.network/pools/${p.address}`,
        note: `${typeLabel === "stable" ? "Stable-pair" : typeLabel === "concentrated" ? "Concentrated-liquidity" : "Standard"} pool — ` +
          `provide ${codes.join(" + ")}, earn ${ (Number(p.fee || 0) * 100).toFixed(2) }% of each swap` +
          (rewardsApy > 0 ? " plus AQUA rewards." : "."),
      });
    }
    if ((data.items || []).length < 100) break;
    page += 1;
  }

  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.aquarius,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: allCount,
    hasApyData: true,
    pools,
  };
}

// ── Blend (delegates to the adapter's pool-overview export) ─────────────────

async function fetchBlend() {
  const overview = await BlendAdapter.getPoolsOverview();
  // overview: [{ name, contractId, reserves: [{symbol, suppliedUSD, borrowedUSD, supplyApy, borrowApy, utilization}] }]
  const pools = [];
  let totalTvl = 0;
  for (const p of overview) {
    const suppliedUSD = p.reserves.reduce((s, r) => s + (r.suppliedUSD || 0), 0);
    totalTvl += suppliedUSD;
    if (suppliedUSD < MIN_POOL_TVL_USD) continue;
    const assets = p.reserves.map((r) => r.symbol);
    pools.push({
      assets,
      name: p.name,
      tvlUSD: suppliedUSD,
      // A lending pool has per-reserve APYs, not one number; surface the range.
      apy: null,
      rewardApy: 0,
      reserves: p.reserves.map((r) => ({
        symbol: r.symbol,
        suppliedUSD: r.suppliedUSD,
        borrowedUSD: r.borrowedUSD,
        supplyApy: r.supplyApy,
        borrowApy: r.borrowApy,
        utilization: r.utilization,
      })),
      address: p.contractId,
      url: `https://mainnet.blend.capital/dashboard/?poolId=${p.contractId}`,
      note: `Lending market with ${assets.join(", ")} — supply any of these to earn ` +
        `interest, or borrow against your deposits. Rates float with utilization.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.blend,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: overview.length,
    hasApyData: true,
    apyStyle: "perReserve",
    pools,
  };
}

// ── SushiSwap V3 ────────────────────────────────────────────────────────────

const SUSHI_FACTORY = "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF";
// Token set from Sushi's own frontend bundle (validated live). Pools with
// tokens outside this set won't be discovered — acceptable v1 limitation,
// documented in the PR.
const SUSHI_TOKENS = {
  XLM: XLM_SAC,
  USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  EURC: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  CETES: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV",
  USDY: "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP",
  USTRY: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  SolvBTC: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN",
  xSolvBTC: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J",
  PYUSD: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
};
const SUSHI_FEE_TIERS = [100, 500, 3000, 10000];
const SUSHI_UNIVERSE_TTL = 60 * 60_000; // pool set changes rarely

let _sushiUniverse = { pools: [], ts: 0 };

async function _sushiPoolUniverse() {
  const now = Date.now();
  if (_sushiUniverse.pools.length > 0 && now - _sushiUniverse.ts < SUSHI_UNIVERSE_TTL) {
    return _sushiUniverse.pools;
  }
  const names = Object.keys(SUSHI_TOKENS);
  const combos = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      for (const fee of SUSHI_FEE_TIERS) {
        combos.push({ a: names[i], b: names[j], fee });
      }
    }
  }
  const found = [];
  // Sequential with a small delay — 144 read-only simulations; keep RPC happy.
  for (const c of combos) {
    try {
      const raw = await simulateContractCall(SUSHI_FACTORY, "get_pool", [
        new Address(SUSHI_TOKENS[c.a]).toScVal(),
        new Address(SUSHI_TOKENS[c.b]).toScVal(),
        nativeToScVal(c.fee, { type: "u32" }),
      ]);
      const addr = scValToNative(raw);
      if (addr && String(addr).startsWith("C")) {
        found.push({ pair: [c.a, c.b], fee: c.fee, address: addr });
      }
    } catch { /* no pool at this combo */ }
    await _sleep(50);
  }
  if (found.length > 0) _sushiUniverse = { pools: found, ts: now };
  return _sushiUniverse.pools;
}

async function fetchSushi() {
  const universe = await _sushiPoolUniverse();
  const pools = [];
  let totalTvl = 0;

  const rows = await _parallelMap(universe, async (u) => {
    const [symA, symB] = u.pair;
    const [balARaw, balBRaw] = await Promise.all([
      getTokenBalance(SUSHI_TOKENS[symA], u.address),
      getTokenBalance(SUSHI_TOKENS[symB], u.address),
    ]);
    const [priceA, priceB] = await Promise.all([
      _priceToken(SUSHI_TOKENS[symA]),
      _priceToken(SUSHI_TOKENS[symB]),
    ]);
    // All Sushi-bundled tokens are 7-dec SACs except Solv (8) — read decimals
    // properly via metadata to stay correct.
    const [metaA, metaB] = await Promise.all([
      getTokenMetadata(SUSHI_TOKENS[symA]).catch(() => null),
      getTokenMetadata(SUSHI_TOKENS[symB]).catch(() => null),
    ]);
    const decA = metaA?.decimals ?? 7;
    const decB = metaB?.decimals ?? 7;
    const amtA = Number(balARaw || 0n) / 10 ** decA;
    const amtB = Number(balBRaw || 0n) / 10 ** decB;
    const tvl = (priceA ? amtA * priceA : 0) + (priceB ? amtB * priceB : 0);
    return { ...u, symA, symB, tvl };
  });

  for (const r of rows) {
    if (!r) continue;
    totalTvl += r.tvl;
    if (r.tvl < MIN_POOL_TVL_USD) continue;
    const feePct = r.fee / 10000;
    pools.push({
      assets: [r.symA, r.symB],
      name: `${r.symA} / ${r.symB} (${feePct}%)`,
      tvlUSD: r.tvl,
      apy: null, // fee APR needs volume history — not available on-chain
      rewardApy: 0,
      feePct,
      address: r.address,
      url: "https://www.sushi.com/stellar/explore/pools",
      note: `Concentrated-liquidity pool — provide ${r.symA} + ${r.symB} in a price ` +
        `range you choose; earn ${feePct}% of swaps that execute in range.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.sushiswap,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: universe.length,
    hasApyData: false,
    apyNote: "Fee APY requires trade-volume data SushiSwap doesn't publish on-chain.",
    pools,
  };
}

// ── Soroswap ────────────────────────────────────────────────────────────────

const SOROSWAP_FACTORY = "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2";
const SOROSWAP_UNIVERSE_TTL = 60 * 60_000;

let _soroswapUniverse = { pairs: [], ts: 0 };

async function _soroswapPairUniverse() {
  const now = Date.now();
  if (_soroswapUniverse.pairs.length > 0 && now - _soroswapUniverse.ts < SOROSWAP_UNIVERSE_TTL) {
    return _soroswapUniverse.pairs;
  }
  const lenRaw = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs_length");
  const total = Number(scValToNative(lenRaw));
  if (!Number.isFinite(total) || total <= 0) return _soroswapUniverse.pairs;

  const idxs = Array.from({ length: total }, (_, i) => i);
  const addrs = await _parallelMap(idxs, async (i) => {
    const r = await simulateContractCall(SOROSWAP_FACTORY, "all_pairs", [
      nativeToScVal(i, { type: "u32" }),
    ]);
    return scValToNative(r);
  });

  // Resolve token ids per pair (cache these with the universe — they never change)
  const pairs = await _parallelMap(addrs.filter(Boolean), async (addr) => {
    const [t0raw, t1raw] = await Promise.all([
      simulateContractCall(addr, "token_0"),
      simulateContractCall(addr, "token_1"),
    ]);
    return { address: addr, token0: scValToNative(t0raw), token1: scValToNative(t1raw) };
  });

  const clean = pairs.filter(Boolean);
  if (clean.length > 0) _soroswapUniverse = { pairs: clean, ts: now };
  return _soroswapUniverse.pairs;
}

async function fetchSoroswap() {
  const universe = await _soroswapPairUniverse();
  const pools = [];
  let totalTvl = 0;

  const rows = await _parallelMap(universe, async (p) => {
    // Price first — most Soroswap pairs hold unpriceable junk tokens; skip
    // reserve reads for those to save RPC budget.
    const [price0, price1] = await Promise.all([
      _priceToken(p.token0),
      _priceToken(p.token1),
    ]);
    if (price0 == null && price1 == null) return null;

    const resRaw = await simulateContractCall(p.address, "get_reserves");
    const reserves = scValToNative(resRaw);
    const [meta0, meta1] = await Promise.all([
      getTokenMetadata(p.token0).catch(() => null),
      getTokenMetadata(p.token1).catch(() => null),
    ]);
    const dec0 = meta0?.decimals ?? 7;
    const dec1 = meta1?.decimals ?? 7;
    const amt0 = Number(reserves?.[0] ?? 0n) / 10 ** dec0;
    const amt1 = Number(reserves?.[1] ?? 0n) / 10 ** dec1;

    // If only one side has a price, double it (balanced constant-product pool)
    let tvl;
    if (price0 != null && price1 != null) tvl = amt0 * price0 + amt1 * price1;
    else if (price0 != null) tvl = amt0 * price0 * 2;
    else tvl = amt1 * price1 * 2;

    const normSym = (meta, tok) => {
      const s = meta?.symbol;
      if (!s || s === "native") return tok === XLM_SAC ? "XLM" : (s || tok.slice(0, 6) + "…");
      return s;
    };
    const sym0 = normSym(meta0, p.token0);
    const sym1 = normSym(meta1, p.token1);
    return { ...p, sym0, sym1, tvl };
  }, 4);

  for (const r of rows) {
    if (!r) continue;
    totalTvl += r.tvl;
    if (r.tvl < MIN_POOL_TVL_USD) continue;
    pools.push({
      assets: [r.sym0, r.sym1],
      name: `${r.sym0} / ${r.sym1}`,
      tvlUSD: r.tvl,
      apy: null, // volume-based fee APR not available on-chain
      rewardApy: 0,
      feePct: 0.3, // Soroswap standard pair fee
      address: r.address,
      url: "https://soroswap.finance",
      note: `Classic 50/50 pool — provide equal values of ${r.sym0} + ${r.sym1}, ` +
        `earn 0.3% of every swap.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.soroswap,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: universe.length,
    hasApyData: false,
    apyNote: "Fee APY requires trade-volume data Soroswap serves only via a gated API.",
    pools,
  };
}

// ── Upshift ─────────────────────────────────────────────────────────────────

async function fetchUpshift() {
  const res = await fetch("https://api.upshift.finance/v1/tokenized_vaults", {
    headers: { "User-Agent": "StellarScope/1.0" },
  });
  if (!res.ok) throw new Error(`Upshift HTTP ${res.status}`);
  const all = await res.json();
  const vaults = (Array.isArray(all) ? all : []).filter(
    (v) => v.chain_type === "stellar" && v.is_visible
  );
  const pools = [];
  let totalTvl = 0;
  for (const v of vaults) {
    const tvl = Number(v.tvl || v.latest_reported_tvl || 0); // USD (verified)
    totalTvl += tvl;
    if (tvl < MIN_POOL_TVL_USD) continue;
    const apy = Number(v.reported_apy?.apy ?? 0) || null;
    const meta = v.stellar_vault_metadata || {};
    const depositSym = meta.deposit_token_symbol || "?";
    pools.push({
      assets: [depositSym],
      name: v.vault_name,
      tvlUSD: tvl,
      apy,
      rewardApy: 0,
      address: v.address,
      url: "https://app.upshift.finance",
      note: `Single-asset vault — deposit ${depositSym}, receive shares that grow ` +
        `as the strategy earns. No pair management needed.`,
    });
  }
  pools.sort((a, b) => b.tvlUSD - a.tvlUSD);
  return {
    ...PROTOCOL_META.upshift,
    totalTvlUSD: totalTvl,
    poolsShown: pools.length,
    poolsTotal: vaults.length,
    hasApyData: true,
    pools,
  };
}

// ── Sentora ─────────────────────────────────────────────────────────────────

const SENTORA_VAULT = "CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO";

async function fetchSentora() {
  const balRaw = await getTokenBalance(XLM_SAC, SENTORA_VAULT);
  const xlm = Number(balRaw || 0n) / 1e7;
  const xlmPrice = (await _priceToken(XLM_SAC)) || 0;
  const tvl = xlm * xlmPrice;
  const pools = [];
  if (tvl >= MIN_POOL_TVL_USD) {
    pools.push({
      assets: ["XLM"],
      name: "Sentora XLM Vault",
      tvlUSD: tvl,
      apy: null, // yield distributed off-chain; no on-chain APY
      rewardApy: 0,
      address: SENTORA_VAULT,
      url: "https://defi.stellar.org",
      note: "Deposit native XLM under a principal-escrow design. Yield accrues " +
        "off-chain, so no live APY is published here.",
    });
  }
  return {
    ...PROTOCOL_META.sentora,
    totalTvlUSD: tvl,
    poolsShown: pools.length,
    poolsTotal: 1,
    hasApyData: false,
    apyNote: "Yield is distributed off-chain; the vault contract tracks principal only.",
    pools,
  };
}

// ── Templar (card only) ─────────────────────────────────────────────────────

const TEMPLAR_G = "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK";

async function fetchTemplar() {
  // Best-effort custody TVL for the protocol card; no pool rows (below threshold).
  let tvl = 0;
  try {
    const res = await fetch(`https://horizon.stellar.org/accounts/${TEMPLAR_G}`, {
      headers: { "User-Agent": "StellarScope/1.0" },
    });
    if (res.ok) {
      const acct = await res.json();
      const xlmPrice = (await _priceToken(XLM_SAC)) || 0;
      for (const b of acct.balances || []) {
        const amt = Number(b.balance || 0);
        if (b.asset_type === "native") tvl += amt * xlmPrice;
        else if ((b.asset_code || "").startsWith("USD")) tvl += amt; // USDC ≈ $1
      }
    }
  } catch { /* card renders with tvl 0 */ }
  return {
    ...PROTOCOL_META.templar,
    totalTvlUSD: tvl,
    poolsShown: 0,
    poolsTotal: 0,
    hasApyData: false,
    pools: [],
  };
}

// ── Refresh orchestration ───────────────────────────────────────────────────

// protocolId -> { ts, value, error, lastAttempt }
const cache = new Map();

const FETCHERS = [
  { id: "blend", fn: fetchBlend, interval: 5 * 60_000 },
  { id: "aquarius", fn: fetchAquarius, interval: 60_000 },
  { id: "soroswap", fn: fetchSoroswap, interval: 15 * 60_000 },
  { id: "sushiswap", fn: fetchSushi, interval: 5 * 60_000 },
  { id: "upshift", fn: fetchUpshift, interval: 60_000 },
  { id: "sentora", fn: fetchSentora, interval: 5 * 60_000 },
  { id: "templar", fn: fetchTemplar, interval: 24 * 60 * 60_000 },
];

let _refreshing = false;

async function refreshOnce() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    for (const f of FETCHERS) {
      const entry = cache.get(f.id);
      const due = !entry || Date.now() - (entry.lastAttempt || 0) >= f.interval;
      if (!due) continue;
      const prev = entry || {};
      cache.set(f.id, { ...prev, lastAttempt: Date.now() });
      try {
        const value = await f.fn();
        cache.set(f.id, { ts: Date.now(), value, error: null, lastAttempt: Date.now() });
      } catch (e) {
        const stale = prev.value && Date.now() - (prev.ts || 0) < STALE_GRACE;
        cache.set(f.id, {
          ts: prev.ts || 0,
          value: stale ? prev.value : null,
          error: e.message?.slice(0, 200) || "fetch failed",
          lastAttempt: Date.now(),
        });
        console.warn(`[defi-explorer] ${f.id} refresh failed: ${e.message?.slice(0, 120)}`);
      }
    }
  } finally {
    _refreshing = false;
  }
}

function start() {
  refreshOnce().catch(() => {});
  setInterval(() => refreshOnce().catch(() => {}), REFRESH_INTERVAL);
}

// ── Public read API (request path — cache only, never fetches) ──────────────

function getSnapshot() {
  const protocols = [];
  for (const f of FETCHERS) {
    const entry = cache.get(f.id);
    if (entry?.value) {
      protocols.push({
        ...entry.value,
        lastUpdated: entry.ts ? new Date(entry.ts).toISOString() : null,
        stale: entry.error != null,
      });
    } else {
      // Not yet loaded (first boot) or hard-failed past grace — surface the
      // card with meta so the page structure is complete.
      protocols.push({
        ...PROTOCOL_META[f.id],
        totalTvlUSD: null,
        poolsShown: 0,
        poolsTotal: null,
        pools: [],
        loading: entry?.error == null,
        error: entry?.error || null,
        lastUpdated: null,
      });
    }
  }
  // Highest-TVL protocols first (nulls last)
  protocols.sort((a, b) => (b.totalTvlUSD || -1) - (a.totalTvlUSD || -1));
  return {
    thresholdUSD: MIN_POOL_TVL_USD,
    protocols,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { start, getSnapshot, refreshOnce, MIN_POOL_TVL_USD };
