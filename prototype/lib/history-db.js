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
const { cleanLabel } = require("./sanitize");

const DB_PATH = process.env.HISTORY_DB_PATH || path.join(__dirname, "..", "data", "history.db");

// Ensure data directory exists
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");

// ── Schema ────────────────────────────────────────────────────────────────────
//
// Exported as plain functions so tests can run them against a scratch database
// and assert they are idempotent. Re-requiring this module to re-run them is not
// an option: `require` is cached, and busting the cache opens a second
// better-sqlite3 connection to the same file while the first is still live.

function runMigrations(database = db) {
  database.exec(`
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
    database.prepare("SELECT tier FROM tracked_wallets LIMIT 1").get();
  } catch (e) {
    database.exec("ALTER TABLE tracked_wallets ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
    console.log("[history-db] Migrated: added tier column to tracked_wallets");
  }

  // Bookkeeping for one-shot data migrations — see runBackfills().
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function _backfillHasRun(database, key) {
  return !!database.prepare("SELECT 1 FROM schema_meta WHERE key = ?").get(key);
}

function _markBackfillRun(database, key, value = "1") {
  database
    .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)")
    .run(key, String(value));
}

/**
 * One-shot data migrations. Each is gated on a schema_meta row so it runs once
 * per database, not on every boot. Idempotent: safe to call repeatedly.
 */
function runBackfills(database = db) {
  // Labels stored before write-time filtering existed. See the note in
  // public-profiles' runBackfills: this only rewrites genuinely unsafe or
  // over-long values, and logs each change with its previous value.
  if (!_backfillHasRun(database, "tracked_wallet_labels_filtered")) {
    const rows = database.prepare(
      "SELECT address, label FROM tracked_wallets WHERE label IS NOT NULL"
    ).all();
    const update = database.prepare("UPDATE tracked_wallets SET label = ? WHERE address = ?");
    let changed = 0;
    for (const row of rows) {
      const cleaned = cleanLabel(row.label);
      if (cleaned !== row.label) {
        console.log(`[history-db] Backfill: tracked_wallets.label ${row.address.slice(0, 8)}… ${JSON.stringify(row.label)} -> ${JSON.stringify(cleaned)}`);
        update.run(cleaned, row.address);
        changed++;
      }
    }
    if (changed) console.log(`[history-db] Backfill: filtered ${changed} tracked wallet label(s)`);
    _markBackfillRun(database, "tracked_wallet_labels_filtered");
  }

  // Correction to the hardening review, which said foreign_keys "is never
  // turned on so the FK constraints are decorative": better-sqlite3 enables the
  // pragma by DEFAULT, so they have always been enforced (verified against
  // 72d69b4: `db.pragma("foreign_keys")` reads 1). This sweep is therefore a
  // cheap no-op safety net rather than a prerequisite — kept because an orphan
  // would break the retention delete, and it costs one query per database.
  if (!_backfillHasRun(database, "orphan_snapshots_cleaned")) {
    const orphanSnapshots = database.prepare(`
      DELETE FROM portfolio_snapshots
      WHERE address NOT IN (SELECT address FROM tracked_wallets)
    `).run();
    const orphanTokens = database.prepare(`
      DELETE FROM token_snapshots
      WHERE snapshot_id NOT IN (SELECT id FROM portfolio_snapshots)
    `).run();
    if (orphanSnapshots.changes || orphanTokens.changes) {
      console.log(
        `[history-db] Backfill: removed ${orphanSnapshots.changes} orphaned snapshot(s) ` +
        `and ${orphanTokens.changes} orphaned token row(s) before enabling foreign_keys`
      );
    }
    _markBackfillRun(database, "orphan_snapshots_cleaned");
  }
}

runMigrations();
runBackfills();

// ── Prepared Statements ───────────────────────────────────────────────────────

const stmts = {
  // NOTE: this deliberately does NOT set tracking_enabled = 1 on conflict.
  // It used to, which meant any request that touched a wallet row silently
  // undid a user's untrackWallet() — including an anonymous POST /portfolio.
  // trackWallet() re-enables tracking explicitly when that is the intent.
  upsertWallet: db.prepare(`
    INSERT INTO tracked_wallets (address, network, label, tier, tracking_enabled)
    VALUES (@address, @network, @label, @tier, 1)
    ON CONFLICT(address) DO UPDATE SET
      network = @network,
      label = COALESCE(@label, tracked_wallets.label),
      tier = COALESCE(@tier, tracked_wallets.tier)
  `),

  enableTracking: db.prepare(`
    UPDATE tracked_wallets SET tracking_enabled = 1 WHERE address = ?
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

  // token_snapshots.snapshot_id references portfolio_snapshots(id) with NO
  // "ON DELETE CASCADE", and better-sqlite3 enables foreign_keys by default, so
  // deleting a parent snapshot that still has token rows raises
  // SQLITE_CONSTRAINT_FOREIGNKEY. Children first, always.
  deleteOldTokenSnapshots: db.prepare(`
    DELETE FROM token_snapshots
    WHERE snapshot_id IN (
      SELECT id FROM portfolio_snapshots
       WHERE address = ? AND snapshot_at < datetime('now', ?)
    )
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

const VALID_TIERS = ["free", "basic", "pro", "premium"];
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Start tracking a wallet address.
 *
 * Validation lives here rather than only at the route boundary: three separate
 * routes reached this function, none of them validated the tier, and two wrote
 * an arbitrary label onto an arbitrary address. Guarding the data layer means a
 * future route cannot reintroduce that.
 */
function trackWallet(address, network = "mainnet", label = null, tier = "free") {
  if (!ADDRESS_RE.test(String(address || ""))) {
    throw new Error("Invalid Stellar address");
  }
  const cleanTier = tier == null ? "free" : String(tier);
  if (!VALID_TIERS.includes(cleanTier)) {
    throw new Error(`Invalid tier: ${cleanTier}. Use: ${VALID_TIERS.join(", ")}`);
  }
  stmts.upsertWallet.run({ address, network, label: cleanLabel(label), tier: cleanTier });
  stmts.enableTracking.run(address);
}

/**
 * Upgrade a wallet's tracking tier.
 * Tiers: "free" (1h), "basic" (30m), "pro" (15m), "premium" (5m)
 */
function setTier(address, tier) {
  if (!VALID_TIERS.includes(tier)) throw new Error(`Invalid tier: ${tier}. Use: ${VALID_TIERS.join(", ")}`);
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
 *
 * `autoTrack` defaults to FALSE. It used to be unconditional, which meant every
 * anonymous POST /api/v1/portfolio permanently enrolled whatever addresses it
 * was given into the hourly snapshot scheduler — an unauthenticated write that
 * altered data about someone else's wallet. Callers that legitimately own the
 * enrolment decision (the scheduler, an explicit add-wallet) opt in.
 */
function recordSnapshot(portfolioData, network = "mainnet", { autoTrack = false } = {}) {
  const address = portfolioData.address;
  if (!ADDRESS_RE.test(String(address || ""))) {
    throw new Error("Invalid Stellar address");
  }

  if (autoTrack) trackWallet(address, network);

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
  const window = `-${Math.max(1, Number(retentionDays) || 365)} days`;
  const run = db.transaction(() => {
    stmts.deleteOldTokenSnapshots.run(address, window);
    stmts.deleteOldSnapshots.run(address, window);
  });
  run();
}

/**
 * Downsample old snapshots to keep DB size bounded.
 * - Keep full resolution for the last `fullResDays` days (default: 30)
 * - Keep only one snapshot per day for data older than that
 * - Delete everything older than `maxDays` (default: 365)
 *
 * Call this periodically (e.g., daily) to prune storage.
 */
function downsample(address, options = {}) {
  // These bounds are load-bearing, not defensive style. This function was
  // reachable through an unauthenticated POST /api/v1/history/downsample, and
  // {fullResDays:0, maxDays:0} made step 1 delete every snapshot older than
  // "now" — i.e. all of them — for every tracked wallet. The route is gone; the
  // clamp means re-adding a caller can never turn it back into a wipe.
  //
  // Both bounds need a floor. Clamping only fullResDays leaves
  // {fullResDays:-1, maxDays:1} deleting everything older than 24 hours.
  const fullResDays = Math.min(365, Math.max(7, Number(options.fullResDays) || 30));
  const maxDays = Math.max(fullResDays + 1, Math.max(30, Number(options.maxDays) || 365));

  // Step 1: Delete ancient data — token rows first (see deleteOldTokenSnapshots).
  stmts.deleteOldTokenSnapshots.run(address, `-${maxDays} days`);
  stmts.deleteOldSnapshots.run(address, `-${maxDays} days`);

  // Step 2: For data between fullResDays and maxDays, keep only one snapshot per day
  // (keep the one closest to midnight UTC for each day)
  const selectDownsampled = `
    SELECT id FROM portfolio_snapshots
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
  `;

  const params = [
    address,
    `-${fullResDays} days`,
    `-${maxDays} days`,
    address,
    `-${fullResDays} days`,
    `-${maxDays} days`,
  ];

  // Same child-before-parent ordering, in one transaction so a failure can't
  // leave token rows pointing at snapshots that are already gone.
  const deleteTokens = db.prepare(
    `DELETE FROM token_snapshots WHERE snapshot_id IN (${selectDownsampled})`
  );
  const deleteSnapshots = db.prepare(
    `DELETE FROM portfolio_snapshots WHERE id IN (${selectDownsampled})`
  );
  const run = db.transaction(() => {
    deleteTokens.run(...params);
    return deleteSnapshots.run(...params).changes;
  });
  const deletedRows = run();

  // Belt and braces: sweep any token row whose parent is already gone. This
  // used to be the ONLY cleanup, and it ran after the parent delete — too late
  // to prevent the constraint failure it was presumably meant to avoid.
  db.prepare(`
    DELETE FROM token_snapshots
    WHERE snapshot_id NOT IN (SELECT id FROM portfolio_snapshots)
  `).run();

  return { deletedRows };
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
/**
 * DB stats for /api/health and /api/v1/history/stats.
 *
 * dbPath is deliberately NOT included. It used to be, and BOTH of those routes
 * are unauthenticated, so the container's filesystem layout was public. The
 * resolved path is logged once at boot instead, where the deploy logs can show
 * it — which is also where you check that a Railway volume mount actually took
 * effect.
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
  };
}

module.exports = {
  DB_PATH,
  runMigrations,
  runBackfills,
  _backfillHasRun,
  _markBackfillRun,
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
