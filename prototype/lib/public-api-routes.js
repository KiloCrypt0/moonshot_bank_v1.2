/**
 * Public API + Public Profile Routes
 *
 * All endpoints are open — no API key needed. Stellar data is public.
 * Rate limiting is applied globally to /api/v1 in server.js — no per-route
 * middleware here (double-count avoidance).
 */
const express = require("express");
const path = require("path");
const profiles = require("./public-profiles");
const historyDb = require("./history-db");
const profileAuth = require("./profile-auth");

// Escape user-controlled strings before injecting into server-rendered HTML.
// The profile page renders displayName/bio/avatarEmoji directly into the DOM
// and shares an origin with the main SPA (which stores Freighter wallet-
// connection state) — unescaped output here is a wallet-hijack surface, not
// just cosmetic XSS.
function htmlEscape(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createRouter(fetchPortfolioFn) {
  const router = express.Router();

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — open, rate-limited by IP
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/api/v1/public/account/:address", async (req, res) => {
    try {
      const data = await fetchPortfolioFn(req.params.address);
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
  });

  router.get("/api/v1/public/account/:address/history", (req, res) => {
    try {
      const { address } = req.params;
      const range = req.query.range || "30d";
      const snapshots = historyDb.getHistory(address, "mainnet", range);
      res.json({
        address, range, dataPoints: snapshots.length,
        snapshots: snapshots.map(s => ({
          timestamp: s.snapshot_at, totalValueUSD: s.total_value_usd,
          xlmBalance: s.xlm_balance, xlmPriceUSD: s.xlm_price_usd,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/api/v1/public/account/:address/snapshot", (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: "?date= required (ISO timestamp)" });
      const snapshot = historyDb.getSnapshotAtDate(req.params.address, date, "mainnet");
      if (!snapshot) return res.json({ address: req.params.address, found: false });
      res.json({
        address: req.params.address, found: true,
        snapshotDate: snapshot.snapshot_at, totalValueUSD: snapshot.total_value_usd,
        xlmBalance: snapshot.xlm_balance, tokens: snapshot.tokens,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // AUTH — signature-challenge for profile ownership
  // ══════════════════════════════════════════════════════════════════════════

  // Client asks for a challenge, signs it with the wallet being claimed,
  // and includes the { challengeToken, signature } pair in the mutation
  // body below. See lib/profile-auth.js for full flow.
  router.post("/api/v1/auth/challenge", (req, res) => {
    try {
      const { address, action, slug } = req.body || {};
      const c = profileAuth.issueChallenge({ address, action, slug });
      res.json(c);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Helper: given a request body containing { challengeToken, signature }
  // and an expected (address, action, slug), verify the challenge or throw.
  function requireSignedChallenge({ challengeToken, signature }, expected) {
    if (!challengeToken || !signature) {
      throw new Error("challengeToken and signature required");
    }
    profileAuth.verifyAndConsume({
      token: challengeToken,
      address: expected.address,
      signatureBase64: signature,
      expectedAction: expected.action,
      expectedSlug: expected.slug,
    });
  }

  // Helper: verify the caller controls at least one wallet on the profile,
  // for actions that operate on the profile as a whole (patch / delete).
  function requireProfileControl(slug, body, action) {
    const profile = profiles.getProfile(slug);
    if (!profile) { const err = new Error("Profile not found"); err.status = 404; throw err; }
    const currentAddresses = new Set((profile.wallets || []).map(w => w.address));
    if (currentAddresses.size === 0) {
      throw new Error("Profile has no wallets; cannot verify control");
    }
    const { challengeToken, signature, address } = body || {};
    if (!address || !currentAddresses.has(address)) {
      throw new Error("address must be one of the profile's current wallets");
    }
    requireSignedChallenge({ challengeToken, signature }, { address, action, slug });
    return profile;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILES API
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/api/v1/profiles", (req, res) => {
    try { res.json(profiles.listPublicProfiles(parseInt(req.query.limit) || 50)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create requires at least one wallet claim, each with its own signed
  // challenge for action=create-profile bound to this slug.
  router.post("/api/v1/profiles", (req, res) => {
    try {
      const { slug, displayName, bio, avatarEmoji, wallets, showBalances, showDefi, showHistory } = req.body || {};
      if (!slug || !displayName) return res.status(400).json({ error: "slug and displayName are required" });
      if (!Array.isArray(wallets) || wallets.length === 0) {
        return res.status(400).json({ error: "At least one signed wallet claim is required to create a profile" });
      }

      // Verify every wallet claim BEFORE writing anything. If any verification
      // fails, no partial profile is created.
      for (const w of wallets) {
        if (!w || !w.address) return res.status(400).json({ error: "Each wallet must include an address" });
        requireSignedChallenge(
          { challengeToken: w.challengeToken, signature: w.signature },
          { address: w.address, action: "create-profile", slug }
        );
      }

      const profile = profiles.createProfile(slug, displayName, { bio, avatarEmoji, showBalances, showDefi, showHistory });
      for (const w of wallets) {
        profiles.addWalletToProfile(profile.slug, w.address, w.label || null);
      }
      res.json({ message: "Profile created!", url: `/p/${profile.slug}`, ...profiles.getProfile(profile.slug) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get("/api/v1/profiles/:slug", (req, res) => {
    try {
      const profile = profiles.getProfile(req.params.slug);
      if (!profile) return res.status(404).json({ error: "Profile not found" });
      res.json(profile);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lookup any profiles that include this wallet address. Used by the SPA
  // Profile tab to switch from Create → Manage when the connected wallet
  // already owns a profile. Public read; a Stellar G-address isn't sensitive.
  router.get("/api/v1/profiles/by-wallet/:address", (req, res) => {
    try {
      const { address } = req.params;
      if (!/^G[A-Z2-7]{55}$/.test(address)) {
        return res.status(400).json({ error: "Not a valid Stellar address" });
      }
      res.json({ address, profiles: profiles.listProfilesByWallet(address) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get("/api/v1/profiles/check/:slug", (req, res) => {
    res.json({ slug: req.params.slug, available: profiles.isSlugAvailable(req.params.slug) });
  });

  // Patch requires signature from any wallet currently on the profile.
  router.patch("/api/v1/profiles/:slug", (req, res) => {
    try {
      requireProfileControl(req.params.slug, req.body, "modify-profile");
      // Strip the auth fields before passing to updateProfile so they can't
      // accidentally become columns.
      const { challengeToken, signature, address, ...updates } = req.body || {};
      profiles.updateProfile(req.params.slug, updates);
      res.json(profiles.getProfile(req.params.slug));
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  router.delete("/api/v1/profiles/:slug", (req, res) => {
    try {
      requireProfileControl(req.params.slug, req.body, "delete-profile");
      profiles.deleteProfile(req.params.slug);
      res.json({ message: "Profile deleted" });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // Adding a wallet requires signature from the wallet being ADDED (proves
  // control of the new wallet) — not from an existing profile wallet.
  router.post("/api/v1/profiles/:slug/wallets", (req, res) => {
    try {
      const { address, label, challengeToken, signature } = req.body || {};
      if (!address) return res.status(400).json({ error: "address is required" });
      requireSignedChallenge(
        { challengeToken, signature },
        { address, action: "add-wallet", slug: req.params.slug }
      );
      profiles.addWalletToProfile(req.params.slug, address, label);
      res.json({ message: "Wallet added" });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Removing a wallet requires signature from the wallet being REMOVED
  // (only its controller can pull it off a profile).
  router.delete("/api/v1/profiles/:slug/wallets", (req, res) => {
    try {
      const { address, challengeToken, signature } = req.body || {};
      if (!address) return res.status(400).json({ error: "address is required" });
      requireSignedChallenge(
        { challengeToken, signature },
        { address, action: "remove-wallet", slug: req.params.slug }
      );
      profiles.removeWalletFromProfile(req.params.slug, address);
      res.json({ message: "Wallet removed" });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get("/api/v1/profiles/:slug/portfolio", async (req, res) => {
    try {
      const profile = profiles.getProfile(req.params.slug);
      if (!profile) return res.status(404).json({ error: "Profile not found" });
      const walletData = [];
      let totalValueUSD = 0;
      for (const wallet of profile.wallets) {
        try {
          const data = await fetchPortfolioFn(wallet.address);
          const entry = { address: wallet.address, label: wallet.label };
          if (profile.showBalances) { entry.totalValueUSD = data.totalValueUSD; entry.balances = data.balances; totalValueUSD += data.totalValueUSD || 0; }
          if (profile.showDefi) { entry.defiPositions = data.defiPositions; }
          walletData.push(entry);
        } catch (e) { walletData.push({ address: wallet.address, label: wallet.label, error: "Failed to fetch" }); }
      }
      res.json({
        profile: { slug: profile.slug, displayName: profile.displayName, bio: profile.bio, avatarEmoji: profile.avatarEmoji },
        totalValueUSD: profile.showBalances ? totalValueUSD : undefined, wallets: walletData,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC PROFILE PAGE — /p/:slug
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/p/:slug", (_req, res) => {
    // Serve the main SPA — the client-side JS detects the /p/{slug} path,
    // fetches the profile via /api/v1/profiles/:slug/portfolio, and puts
    // the SPA into shared-view mode so the visitor gets the full main-app
    // experience (all tabs, DeFi, NFTs, history) scoped to the profile's
    // wallets, with an identity banner. Previous handler served a bare
    // custom HTML that was strictly less useful.
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // API DOCS PAGE — /api/docs
  // ══════════════════════════════════════════════════════════════════════════

  router.get("/api/docs", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>API — Stellar Scope</title>
<style>
:root{--bg:#0a0e17;--card:#1a2332;--border:#2a3a4e;--text:#e2e8f0;--muted:#94a3b8;--accent:#6366f1;--green:#22c55e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:32px}
.container{max-width:800px;margin:0 auto}
h1{font-size:28px;margin-bottom:8px}
.sub{color:var(--muted);margin-bottom:40px;font-size:15px}
h2{font-size:20px;margin:40px 0 16px;color:var(--accent)}
p{color:var(--muted);line-height:1.6;margin-bottom:12px;font-size:14px}
.endpoint{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px}
.method{display:inline-block;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px;margin-right:8px}
.get{background:rgba(34,197,94,0.15);color:var(--green)}
.post{background:rgba(99,102,241,0.15);color:var(--accent)}
.path{font-family:monospace;font-size:14px}
.desc{color:var(--muted);font-size:13px;margin-top:8px}
code{background:var(--card);padding:2px 6px;border-radius:4px;font-size:13px}
pre{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;margin:12px 0;font-family:monospace;line-height:1.5}
a{color:var(--accent)}
.back{text-decoration:none;font-size:14px;display:inline-block;margin-bottom:24px}
.free-badge{display:inline-block;font-size:12px;padding:4px 12px;border-radius:6px;background:rgba(34,197,94,0.15);color:var(--green);font-weight:600;margin-left:12px}
</style></head><body>
<div class="container">
<a class="back" href="/">&larr; Back to app</a>
<h1>Stellar Scope API <span class="free-badge">Free &amp; Open</span></h1>
<p class="sub">Query any Stellar wallet's balances, DeFi positions, and historical snapshots. No API key needed — all Stellar data is public.</p>

<h2>Rate limits</h2>
<p>60 requests per minute per IP address. Rate limit headers are included in every response: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code></p>

<h2>Wallet endpoints</h2>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/api/v1/public/account/:address</span>
  <div class="desc">Get current balances, DeFi positions, and total portfolio value for any Stellar address.</div>
</div>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/api/v1/public/account/:address/history?range=30d</span>
  <div class="desc">Get historical portfolio value snapshots. Ranges: 24h, 7d, 30d, 90d, 1y, all</div>
</div>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/api/v1/public/account/:address/snapshot?date=2026-05-10T14:00:00</span>
  <div class="desc">Get the closest snapshot to a specific date/time.</div>
</div>

<h2>Public profiles</h2>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/api/v1/profiles</span>
  <div class="desc">List all public portfolio profiles.</div>
</div>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/api/v1/profiles/:slug/portfolio</span>
  <div class="desc">Get live aggregated portfolio data for a public profile.</div>
</div>
<div class="endpoint">
  <span class="method get">GET</span><span class="path">/p/:slug</span>
  <div class="desc">View a shareable portfolio page in the browser.</div>
</div>

<h2>Example</h2>
<pre>// Fetch any wallet — no key needed
fetch("https://moonshotbank-production.up.railway.app/api/v1/public/account/GABC...XYZ")
  .then(r => r.json())
  .then(data => console.log(data.totalValueUSD));</pre>

<pre>// cURL
curl https://moonshotbank-production.up.railway.app/api/v1/public/account/GABC...XYZ</pre>
</div></body></html>`);
  });

  return router;
}

module.exports = createRouter;
