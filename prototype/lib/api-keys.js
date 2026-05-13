/**
 * API Key Management — SQLite
 *
 * Handles generation, validation, and rate limiting of public API keys.
 * Each key has a tier (free/basic/pro) that controls rate limits.
 *
 * Usage:
 *   const apiKeys = require("./api-keys");
 *   const key = apiKeys.createKey("keb@stellar.org", "My App");
 *   const valid = apiKeys.validateKey("mk_abc123...");
 */
const crypto = require("crypto");
const historyDb = require("./history-db");
const db = historyDb.db;

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    owner_email TEXT NOT NULL,
    label TEXT,
    tier TEXT NOT NULL DEFAULT 'free',
    enabled INTEGER NOT NULL DEFAULT 1,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_request_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
`);

// ── Rate Limits (requests per minute) ───────────────────────────────────────

const RATE_LIMITS = {
  free: 30,
  basic: 120,
  pro: 600,
};

// In-memory sliding window for rate limiting
const requestWindows = new Map();

// ── Key Generation ──────────────────────────────────────────────────────────

function generateKey() {
  const bytes = crypto.randomBytes(24);
  return "mk_" + bytes.toString("base64url");
}

// ── Public API ──────────────────────────────────────────────────────────────

function createKey(ownerEmail, label = null, tier = "free") {
  const validTiers = Object.keys(RATE_LIMITS);
  if (!validTiers.includes(tier)) {
    throw new Error(`Invalid tier: ${tier}. Use: ${validTiers.join(", ")}`);
  }

  const key = generateKey();

  db.prepare(`
    INSERT INTO api_keys (key, owner_email, label, tier)
    VALUES (?, ?, ?, ?)
  `).run(key, ownerEmail, label, tier);

  return {
    key,
    ownerEmail,
    label,
    tier,
    rateLimit: RATE_LIMITS[tier],
  };
}

function validateKey(key) {
  if (!key) return null;

  const row = db.prepare(`
    SELECT * FROM api_keys WHERE key = ? AND enabled = 1
  `).get(key);

  if (!row) return null;

  // Update usage stats
  db.prepare(`
    UPDATE api_keys
    SET request_count = request_count + 1, last_request_at = datetime('now')
    WHERE id = ?
  `).run(row.id);

  return {
    id: row.id,
    ownerEmail: row.owner_email,
    label: row.label,
    tier: row.tier,
    rateLimit: RATE_LIMITS[row.tier],
  };
}

function checkRateLimit(key) {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  if (!requestWindows.has(key)) {
    requestWindows.set(key, []);
  }

  const window = requestWindows.get(key);

  // Remove old entries outside the window
  while (window.length > 0 && window[0] < now - windowMs) {
    window.shift();
  }

  // Get the key's tier limit
  const row = db.prepare("SELECT tier FROM api_keys WHERE key = ?").get(key);
  const limit = row ? RATE_LIMITS[row.tier] : RATE_LIMITS.free;

  if (window.length >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetMs: window[0] + windowMs - now,
    };
  }

  window.push(now);

  return {
    allowed: true,
    limit,
    remaining: limit - window.length,
    resetMs: windowMs,
  };
}

function revokeKey(key) {
  db.prepare("UPDATE api_keys SET enabled = 0 WHERE key = ?").run(key);
}

function listKeys(ownerEmail) {
  return db.prepare(`
    SELECT key, label, tier, enabled, request_count, last_request_at, created_at
    FROM api_keys
    WHERE owner_email = ?
    ORDER BY created_at DESC
  `).all(ownerEmail);
}

function getKeyStats() {
  const total = db.prepare("SELECT COUNT(*) as c FROM api_keys").get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE enabled = 1").get().c;
  const totalRequests = db.prepare("SELECT SUM(request_count) as c FROM api_keys").get().c || 0;
  return { totalKeys: total, activeKeys: active, totalRequests };
}

// ── Express Middleware ───────────────────────────────────────────────────────

function apiKeyAuth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;

  if (!key) {
    return res.status(401).json({
      error: "Missing API key",
      hint: "Include your key as X-Api-Key header or ?api_key= query param",
      docs: "/api/docs",
    });
  }

  const keyData = validateKey(key);
  if (!keyData) {
    return res.status(403).json({
      error: "Invalid or disabled API key",
      docs: "/api/docs",
    });
  }

  // Rate limit check
  const rateCheck = checkRateLimit(key);
  res.set("X-RateLimit-Limit", rateCheck.limit);
  res.set("X-RateLimit-Remaining", rateCheck.remaining);

  if (!rateCheck.allowed) {
    res.set("Retry-After", Math.ceil(rateCheck.resetMs / 1000));
    return res.status(429).json({
      error: "Rate limit exceeded",
      limit: rateCheck.limit,
      retryAfterSeconds: Math.ceil(rateCheck.resetMs / 1000),
    });
  }

  req.apiKey = keyData;
  next();
}

module.exports = {
  createKey,
  validateKey,
  checkRateLimit,
  revokeKey,
  listKeys,
  getKeyStats,
  apiKeyAuth,
  RATE_LIMITS,
};
