/**
 * API Rate Limiting — by IP address
 *
 * No API keys needed — all Stellar data is public.
 * This module just prevents abuse with simple per-IP rate limiting.
 */

// In-memory sliding window per IP
const requestWindows = new Map();
const RATE_LIMIT = 60; // requests per minute for everyone
const WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  const now = Date.now();

  if (!requestWindows.has(ip)) {
    requestWindows.set(ip, []);
  }

  const window = requestWindows.get(ip);

  // Remove old entries
  while (window.length > 0 && window[0] < now - WINDOW_MS) {
    window.shift();
  }

  if (window.length >= RATE_LIMIT) {
    return {
      allowed: false,
      limit: RATE_LIMIT,
      remaining: 0,
      resetMs: window[0] + WINDOW_MS - now,
    };
  }

  window.push(now);

  return {
    allowed: true,
    limit: RATE_LIMIT,
    remaining: RATE_LIMIT - window.length,
    resetMs: WINDOW_MS,
  };
}

// Clean up old IPs every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, window] of requestWindows) {
    if (window.length === 0 || window[window.length - 1] < now - WINDOW_MS) {
      requestWindows.delete(ip);
    }
  }
}, 300_000);

/**
 * Express middleware — rate limits by IP, no auth needed.
 */
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const check = checkRateLimit(ip);

  res.set("X-RateLimit-Limit", check.limit);
  res.set("X-RateLimit-Remaining", check.remaining);

  if (!check.allowed) {
    res.set("Retry-After", Math.ceil(check.resetMs / 1000));
    return res.status(429).json({
      error: "Rate limit exceeded — 60 requests per minute",
      retryAfterSeconds: Math.ceil(check.resetMs / 1000),
    });
  }

  next();
}

module.exports = {
  checkRateLimit,
  rateLimitMiddleware,
  RATE_LIMIT,
};
