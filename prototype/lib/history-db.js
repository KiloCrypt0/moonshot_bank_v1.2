/**
 * Historical Portfolio Tracking — SQLite
 *
 * Stores periodic snapshots of portfolio values for any tracked address.
 * Designed to be lightweight: ~100 bytes per snapshot, so tracking 100 wallets
 * hourly for a year is only ~88MB.
 *
 * Premium feature: charge a fee to enable historical tracking for an address.
 */
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.HISTORY_DB_PATH || path.join(__dirname, "..", "data", "history.db");

// Ensure data directory exists
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_wallets (
    address TEXT PRIMARY KEY,
    network TEXT NOT NULL DEFAULT 'mainnet',
    label TEXT,
    tier TEXT NOT NULL DEFAULT 'free',
    tracking_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_snapshot_at TEXT
  );

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'mainnet',
    total_value_usd REAL NOT NULL,
    xlm_balance REAL,
    xlm_price_usd REAL,
    token_count INTEGER,
    defi_position_count INTEGER,
    snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (address) REFERENCES tracked_wallets(address)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_address_time
    ON portfolio_snapshots(address, snapshot_at);

  CREATE TABLE IF NOT EXISTS token_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    asset_issuer TEXT,
    contract_id TEXT,
    balance REAL NOT NULL,
    value_usd REAL,
    price_usd REAL,
    FOREIGN KEY (snapshot_id) REFERENCES portfolio_snapshots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_token_snapshots_id
    ON token_snapshots(snapshot_id);

  -- Discovery cache: which wallets are known to hold which Soroban contracts.
  -- Once any non-zero balance is observed, the row persists so subsequent
  -- discovery runs always re-probe that wallet/contract pair, even if the
  -- contract leaves the active token-universe candidate set.
  CREATE TABLE IF NOT EXISTS discovered_balances (
    wallet_address TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    balance_raw TEXT,         -- raw balance as string (Soroban i128 may exceed JS Number precision)
    decimals INTEGER,
    symbol TEXT,
    last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_nonzero_at TEXT,
    PRIMARY KEY (wallet_address, contract_id)
  );

  CREATE INDEX IF NOT EXISTS idx_discovered_balances_wallet
    ON discovered_balances(wallet_address);

  CREATE INDEX IF NOT EXISTS idx_discovered_balances_nonzero
    ON discovered_balances(wallet_address, last_nonzero_at)
    WHERE last_nonzero_at IS NOT NULL;
`);

// Migration: add tier column if upgrading from an older schema
try {
  db.prepare("SELECT tier FROM tracked_wallets LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE tracked_wallets ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
  console.log("[history-db] Migrated: added tier column to tracked_wallets");
}

// ── Prepared Statements ───────────────────────────────────────────────────────

const stmts = {
  upsertWallet: db.prepare(`
    INSERT INTO tracked_wallets (address, network, label, tier)
    VALUES (@address, @network, @label, @tier)
    ON CONFLICT(address) DO UPDATE SET
      network = @network,
      label = COALESCE(@label, tracked_wallets.label),
      tier = COALESCE(@tier, tracked_wallets.tier),
      tracking_enabled = 1
  `),

  disableTracking: db.prepare(`
    UPDATE tracked_wallets SET tracking_enabled = 0 WHERE address = ?
  `),

  getTrackedWallets: db.prepare(`
    SELECT * FROM tracked_wallets WHERE tracking_enabled = 1
  `),

  isTracked: db.prepare(`
    SELECT 1 FROM tracked_wallets WHERE address = ? AND tracking_enabled = 1
  `),

  insertSnapshot: db.prepare(`
    INSERT INTO portfolio_snapshots
      (address, network, total_value_usd, xlm_balance, xlm_price_usd, token_count, defi_position_count, snapshot_at)
    VALUES
      (@address, @network, @totalValueUSD, @xlmBalance, @xlmPriceUSD, @tokenCount, @defiPositionCount, datetime('now'))
  `),

  insertTokenSnapshot: db.prepare(`
    INSERT INTO token_snapshots
      (snapshot_id, asset_code, asset_issuer, contract_id, balance, value_usd, price_usd)
    VALUES
      (@snapshotId, @assetCode, @assetIssuer, @contractId, @balance, @valueUSD, @priceUSD)
  `),

  updateLastSnapshot: db.prepare(`
    UPDATE tracked_wallets SET last_snapshot_at = datetime('now') WHERE address = ?
  `),

  getHistory: db.prepare(`
    SELECT
      id, total_value_usd, xlm_balance, xlm_price_usd,
      token_count, defi_position_count, snapshot_at
    FROM portfolio_snapshots
    WHERE address = ? AND network = ?
      AND snapshot_at >= datetime('now', ?)
    ORDER BY snapshot_at ASC
  `),

  getHistoryAll: db.prepare(`
    SELECT
      id, total_value_usd, xlm_balance, xlm_price_usd,
      token_count, defi_position_count, snapshot_at
    FROM portfolio_snapshots
    WHERE address = ? AND network = ?
    ORDER BY snapshot_at ASC
  `),

  getTokenHistory: db.prepare(`
    SELECT
      ts.asset_code, ts.balance, ts.value_usd, ts.price_usd, ps.snapshot_at
    FROM token_snapshots ts
    JOIN portfolio_snapshots ps ON ts.snapshot_id = ps.id
    WHERE ps.address = ? AND ps.network = ? AND ts.asset_code = ?
      AND ps.snapshot_at >= datetime('now', ?)
    ORDER BY ps.snapshot_at ASC
  `),

  getLatestSnapshot: db.prepare(`
    SELECT * FROM portfolio_snapshots
    WHERE address = ? AND network = ?
    ORDER BY snapshot_at DESC LIMIT 1
  `),

  getSnapshotCount: db.prepare(`
    SELECT COUNT(*) as count FROM portfolio_snapshots WHERE address = ?
  `),

  deleteOldSnapshots: db.prepare(`
    DELETE FROM portfolio_snapshots
    WHERE address = ? AND snapshot_at < datetime('now', ?)
  `),

  // ── Discovery cache ─────────────────────────────────────────────────────────

  upsertDiscoveredBalance: db.prepare(`
    INSERT INTO discovered_balances
      (wallet_address, contract_id, balance_raw, decimals, symbol, last_checked_at, last_nonzero_at)
    VALUES
      (@walletAddress, @contractId, @balanceRaw, @decimals, @symbol,
       datetime('now'),
       CASE WHEN @balanceRaw != '0' AND @balanceRaw IS NOT NULL THEN datetime('now') ELSE NULL END)
    ON CONFLICT(wallet_address, contract_id) DO UPDATE SET
      balance_raw = @balanceRaw,
      decimals = COALESCE(@decimals, decimals),
      symbol = COALESCE(@symbol, symbol),
      last_checked_at = datetime('now'),
      last_nonzero_at = CASE
        WHEN @balanceRaw != '0' AND @balanceRaw IS NOT NULL THEN datetime('now')
        ELSE last_nonzero_at
      END
  `),

  getHistoricalContractsForWallet: db.prepare(`
    SELECT contract_id, balance_raw, decimals, symbol, last_checked_at, last_nonzero_at
    FROM discovered_balances
    WHERE wallet_address = ? AND last_nonzero_at IS NOT NULL
  `),

  getDiscoveredBalance: db.prepare(`
    SELECT balance_raw, decimals, symbol, last_checked_at, last_nonzero_at
    FROM discovered_balances
    WHERE wallet_address = ? AND contract_id = ?
  `),

  getDiscoveryStats: db.prepare(`
    SELECT
      COUNT(*) as total_entries,
      COUNT(DISTINCT wallet_address) as wallets,
      COUNT(DISTINCT contract_id) as contracts,
      SUM(CASE WHEN last_nonzero_at IS NOT NULL THEN 1 ELSE 0 END) as nonzero_entries
    FROM discovered_balances
  `),
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start tracking a wallet address.
 */
function trackWallet(address, network = "mainnet", label = null, tier = "free") {
  stmts.upsertWallet.run({ address, network, label, tier });
}

/**
 * Upgrade a wallet's tracking tier.
 * Tiers: "free" (1h), "basic" (30m), "pro" (15m), "premium" (5m)
 */
function setTier(address, tier) {
  const validTiers = ["free", "basic", "pro", "premium"];
  if (!validTiers.includes(tier)) throw new Error(`Invalid tier: ${tier}. Use: ${validTiers.join(", ")}`);
  db.prepare("UPDATE tracked_wallets SET tier = ? WHERE address = ?").run(tier, address);
}

/**
 * Stop tracking a wallet.
 */
function untrackWallet(address) {
  stmts.disableTracking.run(address);
}

/**
 * Check if a wallet is being tracked.
 */
function isTracked(address) {
  return !!stmts.isTracked.get(address);
}

/**
 * Get all tracked wallets.
 */
function getTrackedWallets() {
  return stmts.getTrackedWallets.all();
}

/**
 * Record a portfolio snapshot.
 * Call this with the same data structure returned by the /api/v1/account endpoint.
 */
function recordSnapshot(portfolioData, network = "mainnet") {
  const address = portfolioData.address;

  // Ensure wallet is tracked
  trackWallet(address, network);

  // Find XLM balance
  const xlmBal = portfolioData.balances?.find((b) => b.type === "native");

  const snapshotData = {
    address,
    network,
    totalValueUSD: portfolioData.totalValueUSD || 0,
    xlmBalance: xlmBal ? parseFloat(xlmBal.balance) : 0,
    xlmPriceUSD: portfolioData.xlmPrice?.usd || 0,
    tokenCount: portfolioData.balanceCount || 0,
    defiPositionCount: portfolioData.defiPositions?.length || 0,
  };

  const result = stmts.insertSnapshot.run(snapshotData);
  const snapshotId = result.lastInsertRowid;

  // Record individual token balances
  if (portfolioData.balances) {
    const insertToken = db.transaction((balances) => {
      for (const bal of balances) {
        if (bal.type === "lp_share") continue; // Skip LP shares for now
        stmts.insertTokenSnapshot.run({
          snapshotId: Number(snapshotId),
          assetCode: bal.asset?.code || "XLM",
          assetIssuer: bal.asset?.issuer || null,
          contractId: bal.asset?.contractId || null,
          balance: parseFloat(bal.balance) || 0,
          valueUSD: bal.valueUSD || 0,
          priceUSD: bal.price?.usd || 0,
        });
      }
    });
    insertToken(portfolioData.balances);
  }

  stmts.updateLastSnapshot.run(address);
  return snapshotId;
}

/**
 * Get portfolio history for an address.
 * @param {string} range - "24h", "7d", "30d", "90d", "1y", or "all"
 */
function getHistory(address, network = "mainnet", range = "30d") {
  const rangeMap = {
    "24h": "-1 day",
    "7d": "-7 days",
    "30d": "-30 days",
    "90d": "-90 days",
    "1y": "-365 days",
  };

  if (range === "all") {
    return stmts.getHistoryAll.all(address, network);
  }

  const sqlRange = rangeMap[range] || "-30 days";
  return stmts.getHistory.all(address, network, sqlRange);
}

/**
 * Get price history for a specific token.
 */
function getTokenHistory(address, network, assetCode, range = "30d") {
  const rangeMap = {
    "24h": "-1 day",
    "7d": "-7 days",
    "30d": "-30 days",
    "90d": "-90 days",
    "1y": "-365 days",
  };
  const sqlRange = rangeMap[range] || "-30 days";
  return stmts.getTokenHistory.all(address, network, assetCode, sqlRange);
}

/**
 * Get the snapshot closest to a given ISO timestamp.
 * Returns the snapshot + its token breakdown.
 */
function getSnapshotAtDate(address, isoDate, network = "mainnet") {
  // Find the single snapshot closest to the requested timestamp
  const snap = db.prepare(`
    SELECT *, ABS(strftime('%s', snapshot_at) - strftime('%s', ?)) AS dist
    FROM portfolio_snapshots
    WHERE address = ? AND network = ?
    ORDER BY dist ASC
    LIMIT 1
  `).get(isoDate, address, network);

  if (!snap) return null;

  // Get the token breakdown for that snapshot
  const tokens = db.prepare(`
    SELECT asset_code, asset_issuer, contract_id, balance, value_usd, price_usd
    FROM token_snapshots
    WHERE snapshot_id = ?
  `).all(snap.id);

  return { ...snap, tokens };
}

/**
 * Get the latest snapshot for an address.
 */
function getLatestSnapshot(address, network = "mainnet") {
  return stmts.getLatestSnapshot.get(address, network);
}

/**
 * Get snapshot count for an address.
 */
function getSnapshotCount(address) {
  return stmts.getSnapshotCount.get(address)?.count || 0;
}

/**
 * Clean up old snapshots beyond a retention period.
 */
function cleanupOldSnapshots(address, retentionDays = 365) {
  stmts.deleteOldSnapshots.run(address, `-${retentionDays} days`);
}

/**
 * Downsample old snapshots to keep DB size bounded.
 * - Keep full resolution for the last `fullResDays` days (default: 30)
 * - Keep only one snapshot per day for data older than that
 * - Delete everything older than `maxDays` (default: 365)
 *
 * Call this periodically (e.g., daily) to prune storage.
 */
function downsample(address, { fullResDays = 30, maxDays = 365 } = {}) {
  // Step 1: Delete ancient data
  stmts.deleteOldSnapshots.run(address, `-${maxDays} days`);

  // Step 2: For data between fullResDays and maxDays, keep only one snapshot per day
  // (keep the one closest to midnight UTC for each day)
  const downsampleStmt = db.prepare(`
    DELETE FROM portfolio_snapshots
    WHERE address = ?
      AND snapshot_at < datetime('now', ?)
      AND snapshot_at >= datetime('now', ?)
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY date(snapshot_at) ORDER BY time(snapshot_at) ASC
          ) as rn
          FROM portfolio_snapshots
          WHERE address = ?
            AND snapshot_at < datetime('now', ?)
            AND snapshot_at >= datetime('now', ?)
        ) WHERE rn = 1
      )
  `);

  const result = downsampleStmt.run(
    address,
    `-${fullResDays} days`,
    `-${maxDays} days`,
    address,
    `-${fullResDays} days`,
    `-${maxDays} days`
  );

  // Also clean up orphaned token snapshots
  db.prepare(`
    DELETE FROM token_snapshots
    WHERE snapshot_id NOT IN (SELECT id FROM portfolio_snapshots)
  `).run();

  return { deletedRows: result.changes };
}

/**
 * Run downsampling for ALL tracked wallets. Intended for a daily cron.
 */
function downsampleAll(options) {
  const wallets = stmts.getTrackedWallets.all();
  let totalDeleted = 0;
  for (const w of wallets) {
    const { deletedRows } = downsample(w.address, options);
    totalDeleted += deletedRows;
  }
  return { walletsProcessed: wallets.length, totalDeletedRows: totalDeleted };
}

/**
 * Get DB stats.
 */
function getStats() {
  const walletCount = db.prepare("SELECT COUNT(*) as c FROM tracked_wallets WHERE tracking_enabled = 1").get().c;
  const snapshotCount = db.prepare("SELECT COUNT(*) as c FROM portfolio_snapshots").get().c;
  const dbSize = fs.statSync(DB_PATH).size;
  return {
    trackedWallets: walletCount,
    totalSnapshots: snapshotCount,
    dbSizeBytes: dbSize,
    dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
    dbPath: DB_PATH,
  };
}

module.exports = {
  trackWallet,
  untrackWallet,
  setTier,
  isTracked,
  getTrackedWallets,
  recordSnapshot,
  getHistory,
  getTokenHistory,
  getLatestSnapshot,
  getSnapshotAtDate,
  getSnapshotCount,
  cleanupOldSnapshots,
  downsample,
  downsampleAll,
  getStats,
  // Discovery cache
  upsertDiscoveredBalance,
  getHistoricalContractsForWallet,
  getDiscoveredBalance,
  getDiscoveryStats,
  db, // Expose for advanced queries
};

// ── Discovery cache helpers ───────────────────────────────────────────────────

/**
 * Record (or update) a probe result for a wallet/contract pair.
 * Stores zero results too so we can avoid re-probing during short windows;
 * any non-zero result marks last_nonzero_at, making this pair "sticky" for
 * all future discovery runs even if the contract leaves the active universe.
 */
function upsertDiscoveredBalance(walletAddress, contractId, { balanceRaw, decimals, symbol } = {}) {
  stmts.upsertDiscoveredBalance.run({
    walletAddress,
    contractId,
    balanceRaw: balanceRaw != null ? String(balanceRaw) : "0",
    decimals: decimals != null ? Number(decimals) : null,
    symbol: symbol || null,
  });
}

/**
 * Return contract IDs we've historically observed this wallet holding
 * (with any non-zero balance), regardless of current universe membership.
 * The probe-based discoverer will always include these in its candidate set.
 */
function getHistoricalContractsForWallet(walletAddress) {
  return stmts.getHistoricalContractsForWallet.all(walletAddress);
}

/**
 * Look up the cached balance row for a single wallet/contract pair.
 * Returns null if we've never probed it.
 */
function getDiscoveredBalance(walletAddress, contractId) {
  return stmts.getDiscoveredBalance.get(walletAddress, contractId) || null;
}

/**
 * Aggregate stats about the discovery cache.
 */
function getDiscoveryStats() {
  return stmts.getDiscoveryStats.get() || { total_entries: 0, wallets: 0, contracts: 0, nonzero_entries: 0 };
}
