require("dotenv").config();
const express = require("express");
const cors = require("cors");
const StellarSdk = require("@stellar/stellar-sdk");
const path = require("path");

// Soroban integration modules
const historyDb = require("./lib/history-db");
const { resolveSorobanTokens, resolveCustomToken, getRegistry } = require("./lib/token-resolver");
const { discoverSorobanTokens } = require("./lib/contract-discovery");
const SushiSwapV3Adapter = require("./lib/adapters/sushiswap-v3");
const SolvProtocolAdapter = require("./lib/adapters/solv-protocol");
const BlendAdapter = require("./lib/adapters/blend");
const AquariusAdapter = require("./lib/adapters/aquarius");
const TemplarAdapter = require("./lib/adapters/templar");
const snapshotScheduler = require("./lib/snapshot-scheduler");
const { resolveNfts } = require("./lib/nft-resolver");
const { resolveSorobanCollectibles } = require("./lib/collectibles-resolver");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Mainnet only — read-only portfolio tracker
const HORIZON_URL = "https://horizon.stellar.org";

function getHorizon() {
  return new StellarSdk.Horizon.Server(HORIZON_URL);
}

const horizon = getHorizon();

// Protocol adapter registry — add new adapters here
const PROTOCOL_ADAPTERS = [
  BlendAdapter,
  AquariusAdapter,
  TemplarAdapter,
  SushiSwapV3Adapter,
  SolvProtocolAdapter,
];

// ── Price Engine ──────────────────────────────────────────────────────────────

const priceCache = new Map();
const PRICE_TTL = 60_000; // 60 seconds

async function getXLMPrice() {
  const cached = priceCache.get("XLM");
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd&include_24hr_change=true"
    );
    const data = await res.json();
    const price = {
      usd: data.stellar.usd,
      change24h: data.stellar.usd_24h_change || 0,
    };
    priceCache.set("XLM", { price, ts: Date.now() });
    return price;
  } catch (e) {
    console.error("Failed to fetch XLM price:", e.message);
    return { usd: 0, change24h: 0 };
  }
}

async function getAssetPriceViaSDEX(assetCode, assetIssuer) {
  const cacheKey = `${assetCode}:${assetIssuer}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  try {
    const asset = new StellarSdk.Asset(assetCode, assetIssuer);
    const xlmAsset = StellarSdk.Asset.native();

    // Get orderbook: asset vs XLM
    const orderbook = await horizon.orderbook(asset, xlmAsset).call();

    if (orderbook.bids.length === 0 && orderbook.asks.length === 0) {
      return null; // No market
    }

    let priceInXLM = null;

    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestAsk = parseFloat(orderbook.asks[0].price);
      const spread = (bestAsk - bestBid) / bestBid;

      if (spread < 0.1) {
        // Use mid-price if spread < 10%
        priceInXLM = (bestBid + bestAsk) / 2;
      } else {
        priceInXLM = bestBid; // Conservative: use bid
      }
    } else if (orderbook.bids.length > 0) {
      priceInXLM = parseFloat(orderbook.bids[0].price);
    } else {
      priceInXLM = parseFloat(orderbook.asks[0].price);
    }

    const xlmPrice = await getXLMPrice();
    const priceUSD = priceInXLM * xlmPrice.usd;

    const price = { usd: priceUSD, xlm: priceInXLM, change24h: 0 };
    priceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch (e) {
    console.error(`Failed to price ${assetCode}:`, e.message);
    return null;
  }
}

// ── Known stablecoins (shortcut pricing) ─────────────────────────────────────

const STABLECOINS = {
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": 1.0,
  "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP": 1.0,
  "yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6FDFDZQI3D2URRQMHI4BSFS7SN2F": 1.0,
};

function isStablecoin(code, issuer) {
  return STABLECOINS[`${code}:${issuer}`] !== undefined;
}

// ── API Routes ────────────────────────────────────────────────────────────────

// Full portfolio summary
app.get("/api/v1/account/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();

    // Validate Stellar address
    if (!address.startsWith("G") || address.length !== 56) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const account = await h.loadAccount(address);
    const xlmPrice = await getXLMPrice();

    // Process balances
    const balances = [];
    let totalValueUSD = 0;

    for (const bal of account.balances) {
      const amount = parseFloat(bal.balance);

      if (bal.asset_type === "native") {
        const reserved =
          (2 + account.subentry_count * 0.5 + account.num_sponsoring * 0.5 - account.num_sponsored * 0.5);
        const available = Math.max(0, amount - reserved);
        const valueUSD = amount * xlmPrice.usd;
        totalValueUSD += valueUSD;

        balances.push({
          type: "native",
          asset: { code: "XLM", issuer: null, domain: "stellar.org", logo: null },
          balance: bal.balance,
          available: available.toFixed(7),
          reserved: reserved.toFixed(7),
          valueUSD: valueUSD,
          price: xlmPrice,
        });
      } else if (bal.asset_type === "liquidity_pool_shares") {
        // LP position — we'll resolve this separately
        balances.push({
          type: "lp_share",
          poolId: bal.liquidity_pool_id,
          shares: bal.balance,
          valueUSD: 0, // Will be enriched
        });
      } else {
        // Standard trustline token
        const code = bal.asset_code;
        const issuer = bal.asset_issuer;
        let price = null;
        let valueUSD = 0;

        if (isStablecoin(code, issuer)) {
          price = { usd: STABLECOINS[`${code}:${issuer}`], change24h: 0 };
          valueUSD = amount * price.usd;
        } else if (amount > 0) {
          price = await getAssetPriceViaSDEX(code, issuer);
          if (price) valueUSD = amount * price.usd;
        }

        totalValueUSD += valueUSD;

        balances.push({
          type: "token",
          asset: {
            code,
            issuer,
            domain: null,
            logo: null,
          },
          balance: bal.balance,
          valueUSD,
          price,
          trustline: {
            limit: bal.limit,
            authorized: bal.is_authorized,
          },
        });
      }
    }

    // ── Soroban token balances (SolvBTC, etc.) ──────────────────────────────
    let sorobanTokens = [];
    try {
      sorobanTokens = await resolveSorobanTokens(address);
      for (const st of sorobanTokens) {
        totalValueUSD += st.valueUSD || 0;
        balances.push(st);
      }
    } catch (e) {
      console.error("Soroban token resolution error:", e.message);
    }

    // ── Auto-discovered Soroban tokens (not in the static registry) ─────────
    // Scans the wallet's invoke_host_function history for SEP-41 token
    // contracts and queries balances. Cached per address (5 min default).
    let discoveredTokens = [];
    try {
      discoveredTokens = await discoverSorobanTokens(address);
      for (const dt of discoveredTokens) {
        totalValueUSD += dt.valueUSD || 0;
        balances.push(dt);
      }
    } catch (e) {
      console.error("Soroban token discovery error:", e.message);
    }

    // ── DeFi positions (SushiSwap V3, Solv vaults, etc.) ─────────────────
    const defiPositions = [];
    for (const adapter of PROTOCOL_ADAPTERS) {
      if (!adapter.isConfigured()) continue;
      try {
        const positions = await adapter.getPositions(address);
        for (const pos of positions) {
          totalValueUSD += pos.valueUSD || 0;
          defiPositions.push(pos);
        }
      } catch (e) {
        console.error(`${adapter.name} adapter error:`, e.message);
      }
    }

    // Sort by value descending
    balances.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    const responseData = {
      address,
      network: "mainnet",
      totalValueUSD,
      xlmPrice,
      balanceCount: balances.length,
      balances,
      defiPositions,
      defiProtocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => ({
        id: a.protocolId,
        name: a.name,
        type: a.type,
      })),
      sorobanTokenCount: sorobanTokens.length + discoveredTokens.length,
      subentryCount: account.subentry_count,
      lastModifiedLedger: account.last_modified_ledger,
      lastUpdated: new Date().toISOString(),
    };

    res.json(responseData);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return res.status(404).json({ error: "Account not found on Stellar network" });
    }
    console.error("Account fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch account data" });
  }
});

// Transaction history
app.get("/api/v1/account/:address/history", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const cursor = req.query.cursor || undefined;

    let query = h.operations().forAccount(address).order("desc").limit(limit);
    if (cursor) query = query.cursor(cursor);

    const operations = await query.call();

    const history = operations.records.map((op) => ({
      id: op.id,
      type: op.type,
      createdAt: op.created_at,
      transactionHash: op.transaction_hash,
      ...(op.type === "payment" && {
        from: op.from,
        to: op.to,
        amount: op.amount,
        assetCode: op.asset_code || "XLM",
        assetIssuer: op.asset_issuer || null,
      }),
      ...(op.type === "path_payment_strict_receive" && {
        from: op.from,
        to: op.to,
        amount: op.amount,
        sourceAmount: op.source_amount,
        assetCode: op.asset_code || "XLM",
        sourceAssetCode: op.source_asset_code || "XLM",
      }),
      ...(op.type === "manage_sell_offer" && {
        offerId: op.offer_id,
        amount: op.amount,
        price: op.price,
        buyingAsset: op.buying_asset_code || "XLM",
        sellingAsset: op.selling_asset_code || "XLM",
      }),
      ...(op.type === "create_account" && {
        account: op.account,
        startingBalance: op.starting_balance,
        funder: op.funder,
      }),
      ...(op.type === "change_trust" && {
        assetCode: op.asset_code,
        assetIssuer: op.asset_issuer,
        limit: op.limit,
      }),
    }));

    res.json({
      address,
      count: history.length,
      cursor: operations.records.length > 0
        ? operations.records[operations.records.length - 1].paging_token
        : null,
      history,
    });
  } catch (e) {
    console.error("History fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch transaction history" });
  }
});

// Claimable balances
app.get("/api/v1/account/:address/claimable", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const claimable = await h.claimableBalances().claimant(address).limit(50).call();

    const balances = claimable.records.map((cb) => ({
      id: cb.id,
      amount: cb.amount,
      asset: cb.asset === "native"
        ? { code: "XLM", issuer: null }
        : {
            code: cb.asset.split(":")[0],
            issuer: cb.asset.split(":")[1],
          },
      sponsor: cb.sponsor,
      claimants: cb.claimants.map((c) => ({
        destination: c.destination,
        predicate: c.predicate,
      })),
      lastModifiedLedger: cb.last_modified_ledger,
    }));

    res.json({ address, count: balances.length, claimableBalances: balances });
  } catch (e) {
    console.error("Claimable balance error:", e.message);
    res.status(500).json({ error: "Failed to fetch claimable balances" });
  }
});

// NFT holdings — classic Stellar assets that look like NFTs, with SEP-1/SEP-39
// metadata resolved from the issuer's stellar.toml where available.
app.get("/api/v1/account/:address/nfts", async (req, res) => {
  try {
    const { address } = req.params;
    const h = getHorizon();
    const account = await h.loadAccount(address);

    const nfts = await resolveNfts(h, account.balances);
    res.json({
      address,
      count: nfts.length,
      nfts,
      // Surface the threshold so a future UI toggle can show "maybe" entries
      confidenceCutoff: 0.35,
    });
  } catch (e) {
    console.error("NFT fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// Soroban contract NFTs (SEP-50, including Meridian Pay collections).
// Proxies SDF's official Freighter backend rather than reimplementing Soroban
// RPC token enumeration. See lib/collectibles-resolver.js for the full
// rationale and source-code references.
app.get("/api/v1/account/:address/collectibles", async (req, res) => {
  try {
    const { address } = req.params;
    const result = await resolveSorobanCollectibles(address);
    res.json({ address, ...result });
  } catch (e) {
    console.error("Collectibles fetch error:", e.message);
    res.status(502).json({ error: "Failed to fetch collectibles", detail: e.message });
  }
});

// Liquidity pool details
app.get("/api/v1/pool/:poolId", async (req, res) => {
  try {
    const pool = await horizon.liquidityPools().liquidityPoolId(req.params.poolId).call();
    const xlmPrice = await getXLMPrice();

    const reserves = pool.reserves.map((r) => ({
      asset: r.asset === "native"
        ? { code: "XLM", issuer: null }
        : { code: r.asset.split(":")[0], issuer: r.asset.split(":")[1] },
      amount: r.amount,
    }));

    res.json({
      id: pool.id,
      fee: pool.fee_bp,
      totalShares: pool.total_shares,
      totalTrustlines: pool.total_trustlines,
      reserves,
    });
  } catch (e) {
    console.error("Pool fetch error:", e.message);
    res.status(500).json({ error: "Failed to fetch pool data" });
  }
});

// Asset search
app.get("/api/v1/assets/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Query parameter 'q' is required" });

    const assets = await horizon.assets().forCode(q).limit(20).call();

    const results = assets.records.map((a) => ({
      code: a.asset_code,
      issuer: a.asset_issuer,
      type: a.asset_type,
      accounts: a.accounts,
      balances: a.balances,
      flags: a.flags,
    }));

    res.json({ query: q, count: results.length, assets: results });
  } catch (e) {
    console.error("Asset search error:", e.message);
    res.status(500).json({ error: "Failed to search assets" });
  }
});

// DeFi positions (dedicated endpoint)
app.get("/api/v1/account/:address/defi", async (req, res) => {
  try {
    const { address } = req.params;
    const allPositions = [];

    for (const adapter of PROTOCOL_ADAPTERS) {
      if (!adapter.isConfigured()) continue;
      try {
        const positions = await adapter.getPositions(address);
        allPositions.push(...positions);
      } catch (e) {
        console.error(`${adapter.name} error:`, e.message);
      }
    }

    res.json({
      address,
      count: allPositions.length,
      protocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => ({
        id: a.protocolId,
        name: a.name,
        type: a.type,
      })),
      positions: allPositions,
    });
  } catch (e) {
    console.error("DeFi positions error:", e.message);
    res.status(500).json({ error: "Failed to fetch DeFi positions" });
  }
});

// Soroban token balance for a specific contract
app.get("/api/v1/account/:address/soroban/:contractId", async (req, res) => {
  try {
    const { address, contractId } = req.params;
    const token = await resolveCustomToken(contractId, address);
    if (!token) {
      return res.json({ address, contractId, balance: "0", found: false });
    }
    res.json({ address, contractId, found: true, ...token });
  } catch (e) {
    console.error("Soroban token error:", e.message);
    res.status(500).json({ error: "Failed to query Soroban token" });
  }
});

// Soroban token registry
app.get("/api/v1/soroban/registry", (req, res) => {
  res.json({
    tokens: getRegistry(),
    protocols: PROTOCOL_ADAPTERS.map((a) => ({
      id: a.protocolId,
      name: a.name,
      type: a.type,
      configured: a.isConfigured(),
    })),
  });
});

// ── Portfolio History API ─────────────────────────────────────────────────────

// Get portfolio value history (chart data)
app.get("/api/v1/account/:address/portfolio-history", (req, res) => {
  try {
    const { address } = req.params;
    const range = req.query.range || "30d";

    const validRanges = ["24h", "7d", "30d", "90d", "1y", "all"];
    if (!validRanges.includes(range)) {
      return res.status(400).json({ error: `Invalid range. Use: ${validRanges.join(", ")}` });
    }

    const snapshots = historyDb.getHistory(address, "mainnet", range);
    const latest = historyDb.getLatestSnapshot(address, "mainnet");

    // Calculate change stats
    let changeUSD = 0;
    let changePercent = 0;
    if (snapshots.length >= 2) {
      const first = snapshots[0].total_value_usd;
      const last = snapshots[snapshots.length - 1].total_value_usd;
      changeUSD = last - first;
      changePercent = first > 0 ? ((last - first) / first) * 100 : 0;
    }

    res.json({
      address,
      network: "mainnet",
      range,
      dataPoints: snapshots.length,
      change: {
        usd: changeUSD,
        percent: changePercent,
      },
      latest: latest || null,
      snapshots: snapshots.map((s) => ({
        timestamp: s.snapshot_at,
        totalValueUSD: s.total_value_usd,
        xlmBalance: s.xlm_balance,
        xlmPriceUSD: s.xlm_price_usd,
        tokenCount: s.token_count,
        defiPositionCount: s.defi_position_count,
      })),
    });
  } catch (e) {
    console.error("Portfolio history error:", e.message);
    res.status(500).json({ error: "Failed to fetch portfolio history" });
  }
});

// Get token-specific price/balance history
app.get("/api/v1/account/:address/token-history/:assetCode", (req, res) => {
  try {
    const { address, assetCode } = req.params;
    const range = req.query.range || "30d";

    const history = historyDb.getTokenHistory(address, "mainnet", assetCode, range);

    res.json({
      address,
      network: "mainnet",
      assetCode,
      range,
      dataPoints: history.length,
      history: history.map((h) => ({
        timestamp: h.snapshot_at,
        balance: h.balance,
        valueUSD: h.value_usd,
        priceUSD: h.price_usd,
      })),
    });
  } catch (e) {
    console.error("Token history error:", e.message);
    res.status(500).json({ error: "Failed to fetch token history" });
  }
});

// Get snapshot closest to a specific date/time
app.get("/api/v1/account/:address/snapshot-at", (req, res) => {
  try {
    const { address } = req.params;
    const { date } = req.query; // ISO string, e.g. "2026-05-10T14:00:00"

    if (!date) {
      return res.status(400).json({ error: "Missing ?date= parameter (ISO timestamp)" });
    }

    const snapshot = historyDb.getSnapshotAtDate(address, date, "mainnet");

    if (!snapshot) {
      return res.json({
        address,
        requestedDate: date,
        found: false,
        message: "No snapshots found for this wallet. Snapshots are recorded after you add the wallet.",
      });
    }

    res.json({
      address,
      requestedDate: date,
      found: true,
      snapshotDate: snapshot.snapshot_at,
      totalValueUSD: snapshot.total_value_usd,
      xlmBalance: snapshot.xlm_balance,
      xlmPriceUSD: snapshot.xlm_price_usd,
      tokenCount: snapshot.token_count,
      defiPositionCount: snapshot.defi_position_count,
      tokens: snapshot.tokens.map((t) => ({
        asset: t.asset_code,
        issuer: t.asset_issuer,
        contractId: t.contract_id,
        balance: t.balance,
        valueUSD: t.value_usd,
        priceUSD: t.price_usd,
      })),
    });
  } catch (e) {
    console.error("Snapshot-at error:", e.message);
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

// Enable/disable tracking for a wallet
app.post("/api/v1/account/:address/track", (req, res) => {
  try {
    const { address } = req.params;
    const { label, tier } = req.body || {};
    historyDb.trackWallet(address, "mainnet", label || null, tier || "free");
    res.json({ success: true, address, tracked: true, tier: tier || "free" });
  } catch (e) {
    console.error("Track wallet error:", e.message);
    res.status(500).json({ error: "Failed to enable tracking" });
  }
});

app.delete("/api/v1/account/:address/track", (req, res) => {
  try {
    const { address } = req.params;
    historyDb.untrackWallet(address);
    res.json({ success: true, address, tracked: false });
  } catch (e) {
    console.error("Untrack wallet error:", e.message);
    res.status(500).json({ error: "Failed to disable tracking" });
  }
});

// History DB stats
app.get("/api/v1/history/stats", (req, res) => {
  try {
    const stats = historyDb.getStats();
    res.json(stats);
  } catch (e) {
    console.error("History stats error:", e.message);
    res.status(500).json({ error: "Failed to fetch history stats" });
  }
});

// ── Multi-Wallet Portfolio API ───────────────────────────────────────────────

// List all tracked wallets
app.get("/api/v1/wallets", (req, res) => {
  try {
    const wallets = historyDb.getTrackedWallets();
    res.json({ count: wallets.length, wallets });
  } catch (e) {
    console.error("List wallets error:", e.message);
    res.status(500).json({ error: "Failed to list wallets" });
  }
});

// Add a wallet to the portfolio
app.post("/api/v1/wallets", (req, res) => {
  try {
    const { address, label, tier } = req.body || {};
    if (!address || !address.startsWith("G") || address.length !== 56) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    historyDb.trackWallet(address, "mainnet", label || null, tier || "free");
    const wallets = historyDb.getTrackedWallets();
    res.json({ success: true, address, wallets });
  } catch (e) {
    console.error("Add wallet error:", e.message);
    res.status(500).json({ error: "Failed to add wallet" });
  }
});

// Update a wallet label
app.patch("/api/v1/wallets/:address", (req, res) => {
  try {
    const { address } = req.params;
    const { label } = req.body || {};
    historyDb.db.prepare("UPDATE tracked_wallets SET label = ? WHERE address = ?").run(label, address);
    res.json({ success: true, address, label });
  } catch (e) {
    console.error("Update wallet error:", e.message);
    res.status(500).json({ error: "Failed to update wallet" });
  }
});

// Remove a wallet from the portfolio
app.delete("/api/v1/wallets/:address", (req, res) => {
  try {
    const { address } = req.params;
    historyDb.untrackWallet(address);
    const wallets = historyDb.getTrackedWallets();
    res.json({ success: true, address, wallets });
  } catch (e) {
    console.error("Remove wallet error:", e.message);
    res.status(500).json({ error: "Failed to remove wallet" });
  }
});

// Aggregated multi-wallet portfolio
app.post("/api/v1/portfolio", async (req, res) => {
  try {
    const { addresses } = req.body || {};

    // If no addresses provided, use all tracked wallets
    let walletAddresses = addresses;
    if (!walletAddresses || walletAddresses.length === 0) {
      const tracked = historyDb.getTrackedWallets();
      walletAddresses = tracked.map((w) => w.address);
    }

    if (walletAddresses.length === 0) {
      return res.json({
        network: "mainnet",
        walletCount: 0,
        totalValueUSD: 0,
        wallets: [],
        aggregatedBalances: [],
      });
    }

    const h = getHorizon();
    const xlmPrice = await getXLMPrice();
    const walletResults = [];
    let grandTotalUSD = 0;

    // Aggregate balances across wallets by asset key
    const assetAgg = new Map(); // key → { code, issuer, totalBalance, totalValueUSD, price }

    for (const address of walletAddresses) {
      try {
        const account = await h.loadAccount(address);
        const balances = [];
        let walletTotalUSD = 0;

        for (const bal of account.balances) {
          const amount = parseFloat(bal.balance);

          if (bal.asset_type === "native") {
            const valueUSD = amount * xlmPrice.usd;
            walletTotalUSD += valueUSD;
            balances.push({
              type: "native",
              asset: { code: "XLM", issuer: null },
              balance: bal.balance,
              valueUSD,
              price: xlmPrice,
            });

            const key = "XLM:native";
            const existing = assetAgg.get(key) || { code: "XLM", issuer: null, totalBalance: 0, totalValueUSD: 0, price: xlmPrice, wallets: [] };
            existing.totalBalance += amount;
            existing.totalValueUSD += valueUSD;
            existing.wallets.push({ address, balance: amount, valueUSD });
            assetAgg.set(key, existing);
          } else if (bal.asset_type !== "liquidity_pool_shares") {
            const code = bal.asset_code;
            const issuer = bal.asset_issuer;
            let price = null;
            let valueUSD = 0;

            if (isStablecoin(code, issuer)) {
              price = { usd: STABLECOINS[`${code}:${issuer}`], change24h: 0 };
              valueUSD = amount * price.usd;
            } else if (amount > 0) {
              price = await getAssetPriceViaSDEX(code, issuer);
              if (price) valueUSD = amount * price.usd;
            }

            walletTotalUSD += valueUSD;
            balances.push({
              type: "token",
              asset: { code, issuer },
              balance: bal.balance,
              valueUSD,
              price,
            });

            const key = `${code}:${issuer}`;
            const existing = assetAgg.get(key) || { code, issuer, totalBalance: 0, totalValueUSD: 0, price, wallets: [] };
            existing.totalBalance += amount;
            existing.totalValueUSD += valueUSD;
            if (price) existing.price = price;
            existing.wallets.push({ address, balance: amount, valueUSD });
            assetAgg.set(key, existing);
          }
        }

        // DeFi positions
        const defiPositions = [];
        for (const adapter of PROTOCOL_ADAPTERS) {
          if (!adapter.isConfigured()) continue;
          try {
            const positions = await adapter.getPositions(address);
            for (const pos of positions) {
              walletTotalUSD += pos.valueUSD || 0;
              defiPositions.push(pos);
            }
          } catch (e) {}
        }

        grandTotalUSD += walletTotalUSD;

        // Get label from DB
        const tracked = historyDb.db
          .prepare("SELECT label FROM tracked_wallets WHERE address = ?")
          .get(address);

        walletResults.push({
          address,
          label: tracked?.label || null,
          totalValueUSD: walletTotalUSD,
          balanceCount: balances.length,
          balances,
          defiPositions,
        });

        // Auto-snapshot
        try {
          const latest = historyDb.getLatestSnapshot(address, "mainnet");
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          if (!latest || latest.snapshot_at < fiveMinAgo) {
            historyDb.recordSnapshot({
              address,
              network: "mainnet",
              totalValueUSD: walletTotalUSD,
              xlmPrice,
              balanceCount: balances.length,
              balances,
              defiPositions,
            }, "mainnet");
          }
        } catch (e) {}
      } catch (e) {
        walletResults.push({
          address,
          error: e.response?.status === 404 ? "Account not found" : e.message,
          totalValueUSD: 0,
          balances: [],
          defiPositions: [],
        });
      }
    }

    // Sort aggregated balances by value
    const aggregatedBalances = Array.from(assetAgg.values())
      .sort((a, b) => b.totalValueUSD - a.totalValueUSD);

    res.json({
      network: "mainnet",
      walletCount: walletResults.length,
      totalValueUSD: grandTotalUSD,
      xlmPrice,
      wallets: walletResults.sort((a, b) => b.totalValueUSD - a.totalValueUSD),
      aggregatedBalances,
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Portfolio aggregation error:", e.message);
    res.status(500).json({ error: "Failed to aggregate portfolio" });
  }
});

// Aggregated portfolio history across all wallets
app.post("/api/v1/portfolio/history", (req, res) => {
  try {
    const { addresses } = req.body || {};
    const range = req.query.range || "30d";

    let walletAddresses = addresses;
    if (!walletAddresses || walletAddresses.length === 0) {
      const tracked = historyDb.getTrackedWallets();
      walletAddresses = tracked.map((w) => w.address);
    }

    // Get history for each wallet and merge by timestamp
    const timeMap = new Map(); // timestamp → { totalValueUSD, perWallet }

    for (const address of walletAddresses) {
      const snapshots = historyDb.getHistory(address, "mainnet", range);
      for (const snap of snapshots) {
        const ts = snap.snapshot_at;
        const existing = timeMap.get(ts) || { totalValueUSD: 0, walletCount: 0 };
        existing.totalValueUSD += snap.total_value_usd;
        existing.walletCount++;
        timeMap.set(ts, existing);
      }
    }

    // Sort by time and return
    const snapshots = Array.from(timeMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, data]) => ({
        timestamp: ts,
        totalValueUSD: data.totalValueUSD,
        walletCount: data.walletCount,
      }));

    let changeUSD = 0;
    let changePercent = 0;
    if (snapshots.length >= 2) {
      const first = snapshots[0].totalValueUSD;
      const last = snapshots[snapshots.length - 1].totalValueUSD;
      changeUSD = last - first;
      changePercent = first > 0 ? ((last - first) / first) * 100 : 0;
    }

    res.json({
      network: "mainnet",
      range,
      walletCount: walletAddresses.length,
      dataPoints: snapshots.length,
      change: { usd: changeUSD, percent: changePercent },
      snapshots,
    });
  } catch (e) {
    console.error("Portfolio history error:", e.message);
    res.status(500).json({ error: "Failed to fetch portfolio history" });
  }
});

// Set tracking tier (premium feature hook)
app.post("/api/v1/account/:address/tier", (req, res) => {
  try {
    const { address } = req.params;
    const { tier } = req.body || {};
    if (!tier) return res.status(400).json({ error: "tier is required (free, basic, pro, premium)" });
    historyDb.setTier(address, tier);
    res.json({ success: true, address, tier });
  } catch (e) {
    console.error("Set tier error:", e.message);
    res.status(400).json({ error: e.message });
  }
});

// Scheduler stats
app.get("/api/v1/scheduler/stats", (req, res) => {
  res.json(snapshotScheduler.getStats());
});

// Manual downsample trigger (admin)
app.post("/api/v1/history/downsample", (req, res) => {
  try {
    const result = historyDb.downsampleAll(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    console.error("Downsample error:", e.message);
    res.status(500).json({ error: "Failed to downsample" });
  }
});

// Top XLM whales leaderboard
const EXCLUDED_WHALES = new Set([
  "GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO", // burned
  // SDF mandate addresses
  "GB6NVEN5HSUBKMYCE5ZOWSK5K23TBWRUQLZY3KNMXUZ3AQ2ESC4MY4AQ",
  "GATL3ETTZ3XDGFXX2ELPIKCZL7S5D2HY3VK4T7LRPD6DW5JOLAEZSZBA",
  "GAKGC35HMNB7A3Q2V5SQU6VJC2JFTZB6I7ZW77SJSMRCOX2ZFBGJOCHH",
  "GAPV2C4BTHXPL2IVYDXJ5PUU7Q3LAXU7OAQDP7KVYHLCNM2JTAJNOQQI",
  "GCVJDBALC2RQFLD2HYGQGWNFZBCOD2CPOTN3LE7FWRZ44H2WRAVZLFCU",
  "GC3ITNZSVVPOWZ5BU7S64XKNI5VPTRSBEXXLS67V4K6LEUETWBMTE7IH",
  "GBEVKAYIPWC5AQT6D4N7FC3XGKRRBMPCAMTO3QZWMHHACLHTMAHAM2TP",
  "GDUY7J7A33TQWOSOQGDO776GGLM3UQERL4J3SPT56F6YS4ID7MLDERI4",
  "GCPWKVQNLDPD4RNP5CAXME4BEDTKSSYRR4MMEL4KG65NEGCOGNJW7QI2",
  "GDKIJJIKXLOM2NRMPNQZUUYK24ZPVFC6426GZAEP3KUK6KEJLACCWNMX",
  "GDWXQOTIIDO2EUK4DIGIBLEHLME2IAJRNU6JDFS5B2ZTND65P7J36WQZ",
  "GAMGGUQKKJ637ILVDOSCT5X7HYSZDUPGXSUW67B2UKMG2HEN5TPWN3LQ",
  "GANII5Y2LABEBK74NWNKS4NREX2T52YTBGQDRVKVBFRIIF5VE4ORYOVY",
  "GBFZPAHO24P7ZVZCMI5SXZR53UYD325OWSSWWHHVLBNN56LU5YZJJFNP",
]);

app.get("/api/v1/whales", async (req, res) => {
  try {
    // Fetch extra to have enough after filtering
    const response = await fetch("https://api.stellar.expert/explorer/public/asset/XLM/holders?order=desc&limit=40");
    const data = await response.json();
    const records = data._embedded?.records || [];

    const filtered = records
      .filter(a => !EXCLUDED_WHALES.has(a.address))
      .slice(0, 10);

    const h = getHorizon();
    const whales = await Promise.all(filtered.map(async (a) => {
      const xlmBalance = Math.round(parseInt(a.balance) / 10_000_000);
      let assetCount = null;
      try {
        const account = await h.loadAccount(a.address);
        assetCount = account.balances.length; // includes native XLM + all trustlines
      } catch (e) { /* leave null if account can't be loaded */ }
      return { address: a.address, balance: xlmBalance, assetCount };
    }));

    res.json({ whales });
  } catch (e) {
    console.error("Whales error:", e.message);
    res.status(500).json({ error: "Failed to fetch whales" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    network: "mainnet",
    sorobanRpc: require("./lib/soroban-rpc").SOROBAN_RPC_URL,
    configuredProtocols: PROTOCOL_ADAPTERS.filter((a) => a.isConfigured()).map((a) => a.protocolId),
    registeredSorobanTokens: getRegistry().filter((t) => t.enabled).length,
    historyDb: historyDb.getStats(),
    scheduler: snapshotScheduler.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Background Snapshot Scheduler ────────────────────────────────────────────

/**
 * Fetch a full portfolio for a given address/network.
 * Used by the scheduler to take snapshots without an HTTP request.
 */
async function fetchPortfolioForScheduler(address) {
  const h = getHorizon();
  const account = await h.loadAccount(address);
  const xlmPrice = await getXLMPrice();

  const balances = [];
  let totalValueUSD = 0;

  for (const bal of account.balances) {
    const amount = parseFloat(bal.balance);

    if (bal.asset_type === "native") {
      const reserved =
        (2 + account.subentry_count * 0.5 + account.num_sponsoring * 0.5 - account.num_sponsored * 0.5);
      const valueUSD = amount * xlmPrice.usd;
      totalValueUSD += valueUSD;
      balances.push({
        type: "native",
        asset: { code: "XLM", issuer: null },
        balance: bal.balance,
        valueUSD,
        price: xlmPrice,
      });
    } else if (bal.asset_type === "liquidity_pool_shares") {
      balances.push({ type: "lp_share", poolId: bal.liquidity_pool_id, shares: bal.balance, valueUSD: 0 });
    } else {
      const code = bal.asset_code;
      const issuer = bal.asset_issuer;
      let price = null;
      let valueUSD = 0;

      if (isStablecoin(code, issuer)) {
        price = { usd: STABLECOINS[`${code}:${issuer}`], change24h: 0 };
        valueUSD = amount * price.usd;
      } else if (amount > 0) {
        price = await getAssetPriceViaSDEX(code, issuer);
        if (price) valueUSD = amount * price.usd;
      }

      totalValueUSD += valueUSD;
      balances.push({
        type: "token",
        asset: { code, issuer },
        balance: bal.balance,
        valueUSD,
        price,
      });
    }
  }

  // Soroban tokens
  try {
    const sorobanTokens = await resolveSorobanTokens(address);
    for (const st of sorobanTokens) {
      totalValueUSD += st.valueUSD || 0;
      balances.push(st);
    }
  } catch (e) { /* ignore for scheduler */ }

  // Auto-discovered Soroban tokens (cached, so usually a no-op in the scheduler loop)
  try {
    const discoveredTokens = await discoverSorobanTokens(address);
    for (const dt of discoveredTokens) {
      totalValueUSD += dt.valueUSD || 0;
      balances.push(dt);
    }
  } catch (e) { /* ignore for scheduler */ }

  // DeFi positions
  const defiPositions = [];
  for (const adapter of PROTOCOL_ADAPTERS) {
    if (!adapter.isConfigured()) continue;
    try {
      const positions = await adapter.getPositions(address);
      for (const pos of positions) {
        totalValueUSD += pos.valueUSD || 0;
        defiPositions.push(pos);
      }
    } catch (e) { /* ignore for scheduler */ }
  }

  return {
    address,
    network: "mainnet",
    totalValueUSD,
    xlmPrice,
    balanceCount: balances.length,
    balances,
    defiPositions,
  };
}

// Initialize scheduler with the portfolio fetch function
snapshotScheduler.init(fetchPortfolioForScheduler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Stellar Moonshot Bank API running on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  // Start background snapshot scheduler
  snapshotScheduler.start();

  // Run daily downsampling at startup (and it could be scheduled via cron too)
  setTimeout(() => {
    try {
      const result = historyDb.downsampleAll();
      if (result.totalDeletedRows > 0) {
        console.log(`[Cleanup] Downsampled ${result.totalDeletedRows} old snapshots across ${result.walletsProcessed} wallets`);
      }
    } catch (e) {
      console.error("[Cleanup] Downsample error:", e.message);
    }
  }, 30_000);
});
