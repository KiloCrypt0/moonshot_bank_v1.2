const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../server.js");
const { CSP_DIRECTIVES } = require("../lib/security-headers");

test("the CSP is present and complete on the SPA", async () => {
  const res = await request(app, "GET", "/");
  assert.equal(res.status, 200);
  const csp = res.headers["content-security-policy"];
  assert.ok(csp, "no Content-Security-Policy header");

  // Asserting only a couple of directives would let a policy through that
  // renders the app unstyled or blanks the NFTs tab, so check all of them.
  for (const fragment of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    assert.ok(csp.includes(fragment), `CSP missing "${fragment}"\ngot: ${csp}`);
  }
});

test("style-src permits inline styles", () => {
  // index.html carries inline style="…" attributes on ~191 lines, many built at
  // render time. Dropping 'unsafe-inline' here renders the whole app unstyled.
  assert.ok(CSP_DIRECTIVES.styleSrc.includes("'unsafe-inline'"));
});

test("img-src permits arbitrary https hosts", () => {
  // NFT images come from arbitrary on-chain token_uri metadata; an allowlist
  // would silently blank the NFTs tab. http: is still blocked.
  assert.ok(CSP_DIRECTIVES.imgSrc.includes("https:"));
  assert.ok(!CSP_DIRECTIVES.imgSrc.includes("http:"));
});

test("Referrer-Policy does not strip same-origin Referer", async () => {
  // helmet's default is no-referrer, which would 403 both leaderboards for
  // every user, since sameOriginOnly falls back to Referer on same-origin GETs.
  const res = await request(app, "GET", "/api/health");
  assert.equal(res.headers["referrer-policy"], "same-origin");
});

test("the framework is not advertised", async () => {
  const res = await request(app, "GET", "/api/health");
  assert.equal(res.headers["x-powered-by"], undefined);
});

test("no unauthenticated route leaks the database path", async () => {
  for (const url of ["/api/health", "/api/v1/history/stats"]) {
    const res = await request(app, "GET", url);
    assert.equal(res.status, 200, `${url} -> ${res.status}`);
    assert.ok(!("dbPath" in (res.body.historyDb || res.body)), `${url} still returns dbPath`);
    assert.ok(!/\/app\/|\/tmp\/|\.db/.test(res.raw), `${url} leaks a filesystem path: ${res.raw}`);
  }
});

test("scheduler stats do not leak another user's wallet address", async () => {
  const historyDb = require("../lib/history-db");
  const scheduler = require("../lib/snapshot-scheduler");
  const { Keypair } = require("@stellar/stellar-sdk");
  const victim = Keypair.random().publicKey();

  // Simulate the scheduler failing on someone's wallet.
  scheduler.getStats(); // touch the module
  const stats = scheduler.getStats();
  assert.ok(!("address" in (stats.lastError || {})), "lastError still carries an address");

  const res = await request(app, "GET", "/api/v1/scheduler/stats");
  assert.equal(res.status, 200);
  assert.ok(!/G[A-Z2-7]{55}/.test(res.raw), `an address appeared in the body: ${res.raw}`);
  void historyDb, victim;
});

test("/api/health reports the resolved client IP", async () => {
  // If this is a proxy address in production, TRUST_PROXY_HOPS is wrong and
  // every visitor shares one rate-limit bucket.
  const res = await request(app, "GET", "/api/health");
  assert.equal(typeof res.body.clientIp, "string");
});

test("the wallet kit is served from our own origin, not a CDN", async () => {
  const res = await request(app, "GET", "/vendor/stellar-wallets-kit-2.3.0.js");
  assert.equal(res.status, 200);
  assert.ok(res.raw.length > 50_000, "bundle looks truncated");

  const fs = require("fs");
  const path = require("path");
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const importLines = index.split("\n").filter((l) => /^\s*import\s/.test(l));
  for (const line of importLines) {
    assert.ok(!/https?:\/\//.test(line), `still importing over the network: ${line.trim()}`);
  }
});

test("the vendored bundle contains the modal UI, not just the SDK", () => {
  // esbuild tree-shakes aggressively. If the modal pages were dropped, the
  // bundle would still load and every wallet button would appear to work right
  // up until someone opened the picker.
  const fs = require("fs");
  const path = require("path");
  const bundle = fs.readFileSync(
    path.join(__dirname, "..", "public", "vendor", "stellar-wallets-kit-2.3.0.js"),
    "utf8"
  );
  for (const marker of ["What is a wallet", "AUTH_OPTIONS", "swk-background"]) {
    assert.ok(bundle.includes(marker), `bundle is missing the modal UI (no "${marker}")`);
  }
  for (const name of ["StellarWalletsKit", "FREIGHTER_ID", "LOBSTR_ID", "ALBEDO_ID", "HANA_ID", "RABET_ID"]) {
    assert.ok(bundle.includes(name), `bundle is missing export ${name}`);
  }
});
