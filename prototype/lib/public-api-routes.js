/**
 * Public API + Public Profile Routes
 *
 * This module exports an Express router that can be mounted on the main app.
 * It provides:
 *   1. API key management endpoints (create, list, revoke keys)
 *   2. Authenticated public API endpoints (wallet lookup, history, portfolio)
 *   3. Public portfolio profile endpoints (create, view, manage)
 *
 * Mount with: app.use(require("./lib/public-api-routes")(fetchPortfolioFn));
 */
const express = require("express");
const apiKeys = require("./api-keys");
const profiles = require("./public-profiles");
const historyDb = require("./history-db");

function createRouter(fetchPortfolioFn) {
  const router = express.Router();

  // ══════════════════════════════════════════════════════════════════════════
  // API KEY MANAGEMENT (no auth required — these create/manage keys)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/keys
   * Create a new API key.
   * Body: { email, label?, tier? }
   */
  router.post("/api/v1/keys", (req, res) => {
    try {
      const { email, label, tier } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }
      const key = apiKeys.createKey(email, label || null, tier || "free");
      res.json({
        message: "API key created. Save this — it won't be shown again in full.",
        ...key,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /**
   * GET /api/v1/keys?email=...
   * List API keys for an email (keys are masked).
   */
  router.get("/api/v1/keys", (req, res) => {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "?email= is required" });
    }
    const keys = apiKeys.listKeys(email);
    res.json(
      keys.map((k) => ({
        ...k,
        key: k.key.slice(0, 7) + "..." + k.key.slice(-4),
      }))
    );
  });

  /**
   * DELETE /api/v1/keys
   * Revoke an API key.
   * Body: { key }
   */
  router.delete("/api/v1/keys", (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "key is required" });
    apiKeys.revokeKey(key);
    res.json({ message: "Key revoked" });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATED PUBLIC API (requires X-Api-Key header)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/public/account/:address
   * Look up a wallet's current balances and DeFi positions.
   */
  router.get(
    "/api/v1/public/account/:address",
    apiKeys.apiKeyAuth,
    async (req, res) => {
      try {
        const { address } = req.params;
        const data = await fetchPortfolioFn(address);
        res.json({
          address: data.address,
          totalValueUSD: data.totalValueUSD,
          balanceCount: data.balanceCount,
          xlmPrice: data.xlmPrice,
          balances: data.balances,
          defiPositions: data.defiPositions,
          lastUpdated: data.lastUpdated,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * GET /api/v1/public/account/:address/history?range=30d
   * Get portfolio value history for a wallet.
   */
  router.get(
    "/api/v1/public/account/:address/history",
    apiKeys.apiKeyAuth,
    (req, res) => {
      try {
        const { address } = req.params;
        const range = req.query.range || "30d";
        const snapshots = historyDb.getHistory(address, "mainnet", range);
        res.json({
          address,
          range,
          dataPoints: snapshots.length,
          snapshots: snapshots.map((s) => ({
            timestamp: s.snapshot_at,
            totalValueUSD: s.total_value_usd,
            xlmBalance: s.xlm_balance,
            xlmPriceUSD: s.xlm_price_usd,
          })),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  /**
   * GET /api/v1/public/account/:address/snapshot?date=2026-05-10T14:00:00
   * Get the snapshot closest to a specific date.
   */
  router.get(
    "/api/v1/public/account/:address/snapshot",
    apiKeys.apiKeyAuth,
    (req, res) => {
      try {
        const { address } = req.params;
        const { date } = req.query;
        if (!date) {
          return res.status(400).json({ error: "?date= is required (ISO timestamp)" });
        }
        const snapshot = historyDb.getSnapshotAtDate(address, date, "mainnet");
        if (!snapshot) {
          return res.json({ address, found: false });
        }
        res.json({
          address,
          found: true,
          snapshotDate: snapshot.snapshot_at,
          totalValueUSD: snapshot.total_value_usd,
          xlmBalance: snapshot.xlm_balance,
          tokens: snapshot.tokens,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC PORTFOLIO PROFILES (no auth for viewing, simple auth for managing)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/profiles
   * List all public profiles.
   */
  router.get("/api/v1/profiles", (req, res) => {
    try {
      const list = profiles.listPublicProfiles(parseInt(req.query.limit) || 50);
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/v1/profiles
   * Create a new public profile.
   * Body: { slug, displayName, bio?, avatarEmoji?, wallets: [{ address, label? }] }
   */
  router.post("/api/v1/profiles", (req, res) => {
    try {
      const { slug, displayName, bio, avatarEmoji, wallets, showBalances, showDefi, showHistory } =
        req.body || {};

      if (!slug || !displayName) {
        return res.status(400).json({ error: "slug and displayName are required" });
      }

      const profile = profiles.createProfile(slug, displayName, {
        bio,
        avatarEmoji,
        showBalances,
        showDefi,
        showHistory,
      });

      // Add wallets if provided
      if (Array.isArray(wallets)) {
        for (const w of wallets) {
          if (w.address) {
            profiles.addWalletToProfile(profile.slug, w.address, w.label || null);
          }
        }
      }

      res.json({
        message: "Profile created!",
        url: `/p/${profile.slug}`,
        ...profile,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /**
   * GET /api/v1/profiles/:slug
   * Get a public profile with wallet list.
   */
  router.get("/api/v1/profiles/:slug", (req, res) => {
    try {
      const profile = profiles.getProfile(req.params.slug);
      if (!profile) {
        return res.status(404).json({ error: "Profile not found" });
      }
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * PATCH /api/v1/profiles/:slug
   * Update a profile.
   * Body: { displayName?, bio?, avatarEmoji?, showBalances?, showDefi?, showHistory?, isPublic? }
   */
  router.patch("/api/v1/profiles/:slug", (req, res) => {
    try {
      profiles.updateProfile(req.params.slug, req.body);
      const updated = profiles.getProfile(req.params.slug);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/v1/profiles/:slug
   * Delete a profile.
   */
  router.delete("/api/v1/profiles/:slug", (req, res) => {
    try {
      profiles.deleteProfile(req.params.slug);
      res.json({ message: "Profile deleted" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/v1/profiles/:slug/wallets
   * Add a wallet to a profile.
   * Body: { address, label? }
   */
  router.post("/api/v1/profiles/:slug/wallets", (req, res) => {
    try {
      const { address, label } = req.body || {};
      if (!address) return res.status(400).json({ error: "address is required" });
      profiles.addWalletToProfile(req.params.slug, address, label);
      res.json({ message: "Wallet added to profile" });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/v1/profiles/:slug/wallets
   * Remove a wallet from a profile.
   * Body: { address }
   */
  router.delete("/api/v1/profiles/:slug/wallets", (req, res) => {
    try {
      const { address } = req.body || {};
      if (!address) return res.status(400).json({ error: "address is required" });
      profiles.removeWalletFromProfile(req.params.slug, address);
      res.json({ message: "Wallet removed from profile" });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /**
   * GET /api/v1/profiles/:slug/portfolio
   * Get live portfolio data for a public profile (aggregated across all wallets).
   * No auth required — this is the public view.
   */
  router.get("/api/v1/profiles/:slug/portfolio", async (req, res) => {
    try {
      const profile = profiles.getProfile(req.params.slug);
      if (!profile) {
        return res.status(404).json({ error: "Profile not found" });
      }

      const walletData = [];
      let totalValueUSD = 0;

      for (const wallet of profile.wallets) {
        try {
          const data = await fetchPortfolioFn(wallet.address);
          const entry = {
            address: wallet.address,
            label: wallet.label,
          };

          if (profile.showBalances) {
            entry.totalValueUSD = data.totalValueUSD;
            entry.balances = data.balances;
            totalValueUSD += data.totalValueUSD || 0;
          }

          if (profile.showDefi) {
            entry.defiPositions = data.defiPositions;
          }

          walletData.push(entry);
        } catch (e) {
          walletData.push({
            address: wallet.address,
            label: wallet.label,
            error: "Failed to fetch",
          });
        }
      }

      res.json({
        profile: {
          slug: profile.slug,
          displayName: profile.displayName,
          bio: profile.bio,
          avatarEmoji: profile.avatarEmoji,
        },
        totalValueUSD: profile.showBalances ? totalValueUSD : undefined,
        wallets: walletData,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC PROFILE HTML PAGE (served at /p/:slug)
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/p/:slug", (req, res) => {
    const profile = profiles.getProfile(req.params.slug);
    if (!profile) {
      return res.status(404).send(`
        <html><head><title>Not Found — Moonshot Protocol</title>
        <style>body{font-family:sans-serif;background:#0a0e17;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .c{text-align:center}.c h1{font-size:48px;margin:0}.c p{color:#94a3b8;margin-top:12px}a{color:#6366f1}</style></head>
        <body><div class="c"><h1>404</h1><p>Profile not found</p><a href="/">Go home</a></div></body></html>
      `);
    }

    // Render a self-contained public portfolio page
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${profile.displayName} — Moonshot Protocol</title>
  <meta name="description" content="${profile.bio || profile.displayName + "'s Stellar portfolio on Moonshot Protocol"}">
  <meta property="og:title" content="${profile.displayName} — Moonshot Protocol">
  <meta property="og:description" content="${profile.bio || "Stellar portfolio tracker"}">
  <style>
    :root{--bg:#0a0e17;--card:#1a2332;--border:#2a3a4e;--text:#e2e8f0;--muted:#94a3b8;--accent:#6366f1;--green:#22c55e;--red:#ef4444}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .header{background:#111827;border-bottom:1px solid var(--border);padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
    .logo{font-size:18px;font-weight:700;color:var(--text);text-decoration:none}
    .profile-hero{text-align:center;padding:48px 24px 32px}
    .avatar{font-size:48px;margin-bottom:12px}
    .profile-name{font-size:28px;font-weight:700;margin-bottom:8px}
    .profile-bio{color:var(--muted);font-size:15px;max-width:500px;margin:0 auto}
    .total{font-size:36px;font-weight:700;margin:24px 0 8px;color:var(--green)}
    .wallet-count{color:var(--muted);font-size:13px}
    .content{max-width:800px;margin:0 auto;padding:0 24px 48px}
    .wallet-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
    .wallet-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
    .wallet-label{font-weight:600;font-size:15px}
    .wallet-addr{font-family:monospace;font-size:12px;color:var(--muted)}
    .wallet-value{font-size:20px;font-weight:600}
    .token-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid var(--border)}
    .token-name{font-weight:500;font-size:14px}
    .token-bal{font-size:13px;color:var(--muted)}
    .token-val{text-align:right;font-size:14px}
    .loading{text-align:center;padding:60px;color:var(--muted)}
    .spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .badge{display:inline-block;font-size:11px;padding:3px 10px;border-radius:6px;background:rgba(99,102,241,0.15);color:var(--accent);font-weight:600}
    .defi-row{padding:12px 0;border-top:1px solid var(--border)}
    .defi-protocol{font-size:12px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;font-weight:600}
    .defi-type{font-size:13px;color:var(--muted)}
  </style>
</head>
<body>
  <div class="header">
    <a class="logo" href="/">Moonshot Protocol</a>
    <span class="badge">Public Portfolio</span>
  </div>
  <div class="profile-hero">
    <div class="avatar">${profile.avatarEmoji}</div>
    <div class="profile-name">${profile.displayName}</div>
    ${profile.bio ? `<div class="profile-bio">${profile.bio}</div>` : ""}
    <div id="totalValue" class="total" style="display:none"></div>
    <div class="wallet-count">${profile.wallets.length} wallet${profile.wallets.length !== 1 ? "s" : ""}</div>
  </div>
  <div class="content" id="content">
    <div class="loading"><div class="spinner"></div>Loading portfolio...</div>
  </div>
  <script>
    const SLUG = "${profile.slug}";
    const SHOW_BALANCES = ${profile.showBalances};
    const SHOW_DEFI = ${profile.showDefi};

    function fmt(n, d=2) {
      if (n == null) return "—";
      return new Intl.NumberFormat("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}).format(n);
    }
    function fmtUSD(n) {
      if (n == null) return "—";
      return "$" + fmt(n);
    }
    function short(addr) { return addr ? addr.slice(0,6)+"..."+addr.slice(-4) : ""; }

    async function load() {
      try {
        const res = await fetch("/api/v1/profiles/" + SLUG + "/portfolio");
        const data = await res.json();
        render(data);
      } catch(e) {
        document.getElementById("content").innerHTML = '<div class="loading">Failed to load portfolio</div>';
      }
    }

    function render(data) {
      if (SHOW_BALANCES && data.totalValueUSD != null) {
        const el = document.getElementById("totalValue");
        el.textContent = fmtUSD(data.totalValueUSD);
        el.style.display = "block";
      }

      let html = "";
      for (const w of data.wallets) {
        html += '<div class="wallet-card">';
        html += '<div class="wallet-header"><div>';
        html += '<div class="wallet-label">' + (w.label || "Wallet") + '</div>';
        html += '<div class="wallet-addr">' + short(w.address) + '</div>';
        html += '</div>';
        if (SHOW_BALANCES && w.totalValueUSD != null) {
          html += '<div class="wallet-value">' + fmtUSD(w.totalValueUSD) + '</div>';
        }
        html += '</div>';

        if (SHOW_BALANCES && w.balances) {
          const tokens = w.balances.filter(b => b.type !== "lp_share");
          for (const t of tokens) {
            html += '<div class="token-row"><div>';
            html += '<div class="token-name">' + (t.asset?.code || "XLM") + '</div>';
            html += '<div class="token-bal">' + fmt(parseFloat(t.balance),4) + '</div>';
            html += '</div>';
            html += '<div class="token-val">' + (t.valueUSD > 0 ? fmtUSD(t.valueUSD) : "—") + '</div>';
            html += '</div>';
          }
        }

        if (SHOW_DEFI && w.defiPositions && w.defiPositions.length > 0) {
          for (const pos of w.defiPositions) {
            html += '<div class="defi-row">';
            html += '<div class="defi-protocol">' + (pos.protocol || "DeFi") + '</div>';
            html += '<div class="token-name">' + (pos.asset || pos.type || "Position") + '</div>';
            html += '<div class="defi-type">' + (pos.type || "") + ' — ' + (pos.subtype || "") + '</div>';
            if (pos.underlyingAmount) html += '<div class="token-bal">' + fmt(pos.underlyingAmount,4) + ' ' + (pos.asset||"") + '</div>';
            html += '</div>';
          }
        }

        html += '</div>';
      }

      document.getElementById("content").innerHTML = html || '<div class="loading">No wallets in this profile</div>';
    }

    load();
  </script>
</body>
</html>`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // API DOCS PAGE
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/api/docs", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Docs — Moonshot Protocol</title>
  <style>
    :root{--bg:#0a0e17;--card:#1a2332;--border:#2a3a4e;--text:#e2e8f0;--muted:#94a3b8;--accent:#6366f1;--green:#22c55e}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:32px}
    .container{max-width:800px;margin:0 auto}
    h1{font-size:28px;margin-bottom:8px}
    .sub{color:var(--muted);margin-bottom:40px;font-size:15px}
    h2{font-size:20px;margin:40px 0 16px;color:var(--accent)}
    h3{font-size:16px;margin:24px 0 8px}
    p{color:var(--muted);line-height:1.6;margin-bottom:12px;font-size:14px}
    .endpoint{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px}
    .method{display:inline-block;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px;margin-right:8px}
    .get{background:rgba(34,197,94,0.15);color:var(--green)}
    .post{background:rgba(99,102,241,0.15);color:var(--accent)}
    .delete{background:rgba(239,68,68,0.15);color:#ef4444}
    .patch{background:rgba(234,179,8,0.15);color:#eab308}
    .path{font-family:monospace;font-size:14px}
    .desc{color:var(--muted);font-size:13px;margin-top:8px}
    code{background:var(--card);padding:2px 6px;border-radius:4px;font-size:13px}
    pre{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;margin:12px 0;font-family:monospace;line-height:1.5}
    a{color:var(--accent)}
    .rate{font-size:13px;color:var(--muted);margin-top:8px}
    .tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
    .tier{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
    .tier-name{font-weight:600;margin-bottom:4px}
    .tier-limit{font-size:24px;font-weight:700;color:var(--accent)}
    .tier-unit{font-size:12px;color:var(--muted)}
    .back{color:var(--accent);text-decoration:none;font-size:14px;display:inline-block;margin-bottom:24px}
  </style>
</head>
<body>
  <div class="container">
    <a class="back" href="/">&larr; Back to app</a>
    <h1>Moonshot Protocol API</h1>
    <p class="sub">Programmatic access to Stellar portfolio data, balances, DeFi positions, and historical snapshots.</p>

    <h2>Authentication</h2>
    <p>All <code>/api/v1/public/*</code> endpoints require an API key. Include it as:</p>
    <pre>X-Api-Key: mk_your_key_here</pre>
    <p>Or as a query parameter: <code>?api_key=mk_your_key_here</code></p>

    <h2>Rate limits</h2>
    <div class="tiers">
      <div class="tier"><div class="tier-name">Free</div><div class="tier-limit">30</div><div class="tier-unit">requests / min</div></div>
      <div class="tier"><div class="tier-name">Basic</div><div class="tier-limit">120</div><div class="tier-unit">requests / min</div></div>
      <div class="tier"><div class="tier-name">Pro</div><div class="tier-limit">600</div><div class="tier-unit">requests / min</div></div>
    </div>
    <p>Rate limit headers are included in every response: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code></p>

    <h2>Get an API key</h2>
    <div class="endpoint">
      <span class="method post">POST</span><span class="path">/api/v1/keys</span>
      <div class="desc">Create a new API key. Save it — the full key is only shown once.</div>
      <pre>{
  "email": "you@example.com",
  "label": "My App"
}</pre>
    </div>

    <h2>Wallet endpoints</h2>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/api/v1/public/account/:address</span>
      <div class="desc">Get current balances, DeFi positions, and total portfolio value for a Stellar address.</div>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/api/v1/public/account/:address/history?range=30d</span>
      <div class="desc">Get historical portfolio value snapshots. Ranges: 24h, 7d, 30d, 90d, 1y, all</div>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/api/v1/public/account/:address/snapshot?date=2026-05-10T14:00:00</span>
      <div class="desc">Get the snapshot closest to a specific date/time.</div>
    </div>

    <h2>Public profiles</h2>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/api/v1/profiles</span>
      <div class="desc">List all public portfolio profiles.</div>
    </div>
    <div class="endpoint">
      <span class="method post">POST</span><span class="path">/api/v1/profiles</span>
      <div class="desc">Create a public profile with a shareable URL.</div>
      <pre>{
  "slug": "keb",
  "displayName": "Keb",
  "bio": "Building on Stellar",
  "wallets": [
    { "address": "GABC...", "label": "Main" }
  ]
}</pre>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/api/v1/profiles/:slug/portfolio</span>
      <div class="desc">Get live aggregated portfolio data for a public profile.</div>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span><span class="path">/p/:slug</span>
      <div class="desc">View the public portfolio page in a browser. Share this link!</div>
    </div>

    <h2>Example</h2>
    <pre>curl -H "X-Api-Key: mk_your_key" \\
  https://your-domain.com/api/v1/public/account/GABC...XYZ</pre>

    <h2>JavaScript example</h2>
    <pre>const res = await fetch("/api/v1/public/account/GABC...XYZ", {
  headers: { "X-Api-Key": "mk_your_key" }
});
const data = await res.json();
console.log(data.totalValueUSD);</pre>
  </div>
</body>
</html>`);
  });

  return router;
}

module.exports = createRouter;
