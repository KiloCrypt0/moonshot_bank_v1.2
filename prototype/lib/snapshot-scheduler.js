/**
 * Background Snapshot Scheduler
 *
 * Periodically polls all tracked wallets and records portfolio snapshots.
 * This is the engine behind historical portfolio tracking — it runs even
 * when no one is viewing the dashboard.
 *
 * Tier-aware: premium wallets get more frequent snapshots.
 */
const historyDb = require("./history-db");

// Horizon + pricing functions are injected from server.js to avoid circular deps
let _fetchPortfolio = null;

/**
 * Initialize the scheduler with a portfolio-fetching function.
 * @param {Function} fetchPortfolioFn - async (address, network) => portfolioData
 */
function init(fetchPortfolioFn) {
  _fetchPortfolio = fetchPortfolioFn;
}

// ── Tier-based intervals ────────────────────────────────────────────────────

const TIER_INTERVALS = {
  free:    60 * 60 * 1000,   // 1 hour
  basic:   30 * 60 * 1000,   // 30 minutes
  pro:     15 * 60 * 1000,   // 15 minutes
  premium:  5 * 60 * 1000,   //  5 minutes
};

const DEFAULT_TICK_INTERVAL = 60 * 1000; // Check every 60 seconds which wallets need a snapshot

// ── Scheduler state ─────────────────────────────────────────────────────────

let _interval = null;
let _running = false;
let _stats = {
  lastTick: null,
  totalSnapshotsTaken: 0,
  errors: 0,
  lastError: null,
  walletsProcessedLastTick: 0,
};

/**
 * Determine if a wallet is due for a snapshot based on its tier.
 */
function isDue(wallet) {
  if (!wallet.tracking_enabled) return false;

  const tier = wallet.tier || "free";
  const interval = TIER_INTERVALS[tier] || TIER_INTERVALS.free;
  const lastSnapshot = wallet.last_snapshot_at
    ? new Date(wallet.last_snapshot_at + "Z").getTime()
    : 0;

  return Date.now() - lastSnapshot >= interval;
}

/**
 * Run one tick of the scheduler: check all tracked wallets and snapshot any that are due.
 */
async function tick() {
  if (!_fetchPortfolio) {
    console.warn("[Scheduler] Not initialized — call init() first");
    return;
  }

  if (_running) {
    console.log("[Scheduler] Previous tick still running, skipping");
    return;
  }

  _running = true;
  _stats.lastTick = new Date().toISOString();
  let processed = 0;

  try {
    const wallets = historyDb.getTrackedWallets();

    for (const wallet of wallets) {
      if (!isDue(wallet)) continue;

      try {
        console.log(`[Scheduler] Snapshotting ${wallet.address} (${wallet.network}, tier: ${wallet.tier || "free"})`);
        const portfolioData = await _fetchPortfolio(wallet.address, wallet.network || "mainnet");

        if (portfolioData) {
          historyDb.recordSnapshot(portfolioData, wallet.network || "mainnet");
          _stats.totalSnapshotsTaken++;
          processed++;
        }
      } catch (e) {
        console.error(`[Scheduler] Error snapshotting ${wallet.address}:`, e.message);
        _stats.errors++;
        _stats.lastError = { address: wallet.address, message: e.message, at: new Date().toISOString() };
      }

      // Small delay between wallets to avoid hammering Horizon
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    _running = false;
    _stats.walletsProcessedLastTick = processed;
  }

  if (processed > 0) {
    console.log(`[Scheduler] Tick complete: ${processed} wallet(s) snapshotted`);
  }
}

/**
 * Start the background scheduler.
 * @param {number} tickIntervalMs - How often to check for due wallets (default: 60s)
 */
function start(tickIntervalMs = DEFAULT_TICK_INTERVAL) {
  if (_interval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting background snapshot scheduler (tick every ${tickIntervalMs / 1000}s)`);
  console.log(`[Scheduler] Tier intervals — free: 1h, basic: 30m, pro: 15m, premium: 5m`);

  // Run first tick after a short delay (let server finish starting)
  setTimeout(() => tick(), 10_000);

  _interval = setInterval(() => tick(), tickIntervalMs);
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[Scheduler] Stopped");
  }
}

/**
 * Get scheduler stats.
 */
function getStats() {
  return {
    running: !!_interval,
    ..._stats,
    tierIntervals: Object.fromEntries(
      Object.entries(TIER_INTERVALS).map(([k, v]) => [k, `${v / 60000} min`])
    ),
  };
}

module.exports = { init, start, stop, tick, getStats, TIER_INTERVALS };
