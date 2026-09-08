const { wallet, signChallenge, request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const profileAuth = require("../lib/profile-auth");
const profiles = require("../lib/public-profiles");
const historyDb = require("../lib/history-db");
const createPublicApiRoutes = require("../lib/public-api-routes");

// Mount just the profile router — no Horizon, no adapters, no listening port.
const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(createPublicApiRoutes(async (address) => ({
  address, totalValueUSD: 0, balances: [], defiPositions: [],
})));

let n = 0;
function freshSlug() { return `p${++n}${Date.now().toString(36)}`; }

/** Create a profile owned by `owner` through the real HTTP route. */
async function createProfile(owner, extra = {}) {
  const slug = freshSlug();
  const claim = signChallenge(profileAuth, {
    keypair: owner, action: "create-profile", slug,
  });
  const res = await request(app, "POST", "/api/v1/profiles", {
    body: {
      slug,
      displayName: "Test Profile",
      wallets: [{ address: owner.publicKey(), challengeToken: claim.challengeToken, signature: claim.signature }],
      ...extra,
    },
  });
  assert.equal(res.status, 200, `profile creation failed: ${res.raw}`);
  return { slug, res };
}

test("a profile records its creator as owner", async () => {
  const owner = wallet();
  const { slug } = await createProfile(owner);
  const got = await request(app, "GET", `/api/v1/profiles/${slug}`);
  assert.equal(got.body.ownerAddress, owner.publicKey());
});

test("REGRESSION: an outside wallet cannot take over a profile", async () => {
  // The original hole, end to end: POST /profiles/:slug/wallets required only a
  // signature from the wallet being added. An attacker signed for their OWN
  // wallet against someone else's slug, joined the profile, and was then "a
  // wallet on the profile" — enough to rename, re-point or delete it.
  const owner = wallet();
  const attacker = wallet();
  const { slug } = await createProfile(owner);

  // 1. The retired single-signature action cannot even get a challenge.
  const challenge = await request(app, "POST", "/api/v1/auth/challenge", {
    body: { address: attacker.publicKey(), action: "add-wallet", slug },
  });
  assert.equal(challenge.status, 400);
  assert.match(challenge.body.error, /Unknown action/);

  // 2. Self-signing the new pair of actions is not enough either: the owner
  //    consent must come from the owner's key.
  const selfAuth = signChallenge(profileAuth, {
    keypair: attacker, action: "authorize-add-wallet", slug, target: attacker.publicKey(),
  });
  const selfClaim = signChallenge(profileAuth, {
    keypair: attacker, action: "claim-wallet", slug, target: attacker.publicKey(),
  });
  const join = await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: attacker.publicKey(), ownerAuth: selfAuth, walletClaim: selfClaim },
  });
  assert.equal(join.status, 400);
  assert.match(join.body.error, /Only the profile owner/);

  // 3. And the attacker still cannot edit or delete.
  const patchAuth = signChallenge(profileAuth, {
    keypair: attacker, action: "modify-profile", slug,
  });
  const patch = await request(app, "PATCH", `/api/v1/profiles/${slug}`, {
    body: { ...patchAuth, displayName: "pwned" },
  });
  assert.equal(patch.status, 400);

  const delAuth = signChallenge(profileAuth, {
    keypair: attacker, action: "delete-profile", slug,
  });
  const del = await request(app, "DELETE", `/api/v1/profiles/${slug}`, { body: delAuth });
  assert.equal(del.status, 400);

  // The profile is untouched and still owned by its creator.
  const after = await request(app, "GET", `/api/v1/profiles/${slug}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.displayName, "Test Profile");
  assert.equal(after.body.ownerAddress, owner.publicKey());
  assert.equal(after.body.wallets.length, 1);
});

test("the owner can add a wallet with consent + claim", async () => {
  const owner = wallet();
  const joiner = wallet();
  const { slug } = await createProfile(owner);

  const ownerAuth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: joiner.publicKey(),
  });
  const walletClaim = signChallenge(profileAuth, {
    keypair: joiner, action: "claim-wallet", slug, target: joiner.publicKey(),
  });
  const res = await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: joiner.publicKey(), label: "second", ownerAuth, walletClaim },
  });
  assert.equal(res.status, 200, res.raw);

  const got = await request(app, "GET", `/api/v1/profiles/${slug}`);
  assert.deepEqual(got.body.wallets.map((w) => w.address).sort(),
    [owner.publicKey(), joiner.publicKey()].sort());
});

test("PLUMBING: owner consent for W1 cannot add W2 through the route", async () => {
  // This is the test that catches requireSignedChallenge failing to forward
  // `target`. The unit-level target test passes even when the route drops it.
  const owner = wallet();
  const w1 = wallet();
  const w2 = wallet();
  const { slug } = await createProfile(owner);

  const ownerAuthForW1 = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: w1.publicKey(),
  });
  const claimForW2 = signChallenge(profileAuth, {
    keypair: w2, action: "claim-wallet", slug, target: w2.publicKey(),
  });
  const res = await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: w2.publicKey(), ownerAuth: ownerAuthForW1, walletClaim: claimForW2 },
  });
  assert.equal(res.status, 400, res.raw);
  assert.match(res.body.error, /target mismatch/);

  const got = await request(app, "GET", `/api/v1/profiles/${slug}`);
  assert.equal(got.body.wallets.length, 1);
});

test("owner consent without the new wallet's claim is refused", async () => {
  const owner = wallet();
  const joiner = wallet();
  const { slug } = await createProfile(owner);
  const ownerAuth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: joiner.publicKey(),
  });
  const res = await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: joiner.publicKey(), ownerAuth },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /walletClaim/);
});

test("any wallet on the profile may edit it", async () => {
  // Per product decision: edits are open to every listed wallet. That is only
  // safe because joining now requires the owner's consent.
  const owner = wallet();
  const member = wallet();
  const { slug } = await createProfile(owner);

  const ownerAuth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: member.publicKey(),
  });
  const walletClaim = signChallenge(profileAuth, {
    keypair: member, action: "claim-wallet", slug, target: member.publicKey(),
  });
  await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: member.publicKey(), ownerAuth, walletClaim },
  });

  const patchAuth = signChallenge(profileAuth, {
    keypair: member, action: "modify-profile", slug,
  });
  const res = await request(app, "PATCH", `/api/v1/profiles/${slug}`, {
    body: { ...patchAuth, displayName: "Renamed by member" },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.displayName, "Renamed by member");
});

test("a non-owner member may NOT delete the profile", async () => {
  const owner = wallet();
  const member = wallet();
  const { slug } = await createProfile(owner);

  const ownerAuth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: member.publicKey(),
  });
  const walletClaim = signChallenge(profileAuth, {
    keypair: member, action: "claim-wallet", slug, target: member.publicKey(),
  });
  await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: member.publicKey(), ownerAuth, walletClaim },
  });

  const delAuth = signChallenge(profileAuth, { keypair: member, action: "delete-profile", slug });
  const res = await request(app, "DELETE", `/api/v1/profiles/${slug}`, { body: delAuth });
  assert.equal(res.status, 400, res.raw);
  assert.match(res.body.error, /Only the profile owner/);
  assert.equal((await request(app, "GET", `/api/v1/profiles/${slug}`)).status, 200);
});

test("the owner may delete the profile", async () => {
  const owner = wallet();
  const { slug } = await createProfile(owner);
  const delAuth = signChallenge(profileAuth, { keypair: owner, action: "delete-profile", slug });
  const res = await request(app, "DELETE", `/api/v1/profiles/${slug}`, { body: delAuth });
  assert.equal(res.status, 200, res.raw);
  assert.equal((await request(app, "GET", `/api/v1/profiles/${slug}`)).status, 404);
});

test("a wallet can remove itself; the owner's wallet cannot be removed", async () => {
  const owner = wallet();
  const member = wallet();
  const { slug } = await createProfile(owner);

  const ownerAuth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug, target: member.publicKey(),
  });
  const walletClaim = signChallenge(profileAuth, {
    keypair: member, action: "claim-wallet", slug, target: member.publicKey(),
  });
  await request(app, "POST", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: member.publicKey(), ownerAuth, walletClaim },
  });

  // Owner wallet is protected — removing it would orphan the profile.
  const ownerRemoval = signChallenge(profileAuth, {
    keypair: owner, action: "remove-wallet", slug, target: owner.publicKey(),
  });
  const refused = await request(app, "DELETE", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: owner.publicKey(), ...ownerRemoval },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /owner wallet/);

  // The member can pull its own wallet off.
  const selfRemoval = signChallenge(profileAuth, {
    keypair: member, action: "remove-wallet", slug, target: member.publicKey(),
  });
  const ok = await request(app, "DELETE", `/api/v1/profiles/${slug}/wallets`, {
    body: { address: member.publicKey(), ...selfRemoval },
  });
  assert.equal(ok.status, 200, ok.raw);
  const got = await request(app, "GET", `/api/v1/profiles/${slug}`);
  assert.deepEqual(got.body.wallets.map((w) => w.address), [owner.publicKey()]);
});

test("PATCH cannot hide a profile into an unrecoverable state", async () => {
  // getProfile filters is_public = 1, so accepting isPublic:false made the
  // profile unreachable to its owner AND to the delete path.
  const owner = wallet();
  const { slug } = await createProfile(owner);
  const auth = signChallenge(profileAuth, { keypair: owner, action: "modify-profile", slug });
  const res = await request(app, "PATCH", `/api/v1/profiles/${slug}`, {
    body: { ...auth, isPublic: false },
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal((await request(app, "GET", `/api/v1/profiles/${slug}`)).status, 200);
});

test("creation is atomic — a failed wallet insert leaves no profile", async () => {
  const owner = wallet();
  const slug = freshSlug();
  const claim = signChallenge(profileAuth, { keypair: owner, action: "create-profile", slug });

  profiles._setAddWalletImpl(() => { throw new Error("simulated wallet insert failure"); });
  try {
    const res = await request(app, "POST", "/api/v1/profiles", {
      body: {
        slug, displayName: "Doomed",
        wallets: [{ address: owner.publicKey(), challengeToken: claim.challengeToken, signature: claim.signature }],
      },
    });
    assert.equal(res.status, 400);
  } finally {
    profiles._setAddWalletImpl(null);
  }
  assert.equal(profiles.getProfile(slug), null, "no partial profile should survive");
});

test("owner_address backfill adopts the lowest-display_order wallet", async () => {
  const db = historyDb.db;
  const slug = freshSlug();
  const first = wallet().publicKey();
  const second = wallet().publicKey();
  // Simulate a pre-ownership row, inserted the way the old code would have.
  const { lastInsertRowid: id } = db.prepare(
    "INSERT INTO public_profiles (slug, display_name, owner_address) VALUES (?, ?, NULL)"
  ).run(slug, "Legacy");
  db.prepare("INSERT INTO profile_wallets (profile_id, address, display_order) VALUES (?, ?, ?)")
    .run(id, second, 2);
  db.prepare("INSERT INTO profile_wallets (profile_id, address, display_order) VALUES (?, ?, ?)")
    .run(id, first, 1);

  profiles.runBackfills();
  assert.equal(profiles.getProfile(slug).ownerAddress, first);

  // Idempotent: running migrations and backfills again changes nothing.
  profiles.runMigrations();
  profiles.runBackfills();
  assert.equal(profiles.getProfile(slug).ownerAddress, first);
});

test("slug availability compares the slugified form", async () => {
  const owner = wallet();
  const slug = freshSlug();
  const claim = signChallenge(profileAuth, { keypair: owner, action: "create-profile", slug });
  await request(app, "POST", "/api/v1/profiles", {
    body: {
      slug, displayName: "Taken",
      wallets: [{ address: owner.publicKey(), challengeToken: claim.challengeToken, signature: claim.signature }],
    },
  });
  // The raw string differs but slugifies to the same thing. Before the fix the
  // route compared the raw string, so this reported available and then collided.
  const raw = slug.toUpperCase();
  const res = await request(app, "GET", `/api/v1/profiles/check/${encodeURIComponent(raw)}`);
  assert.equal(res.body.slug, slug);
  assert.equal(res.body.available, false);
});
