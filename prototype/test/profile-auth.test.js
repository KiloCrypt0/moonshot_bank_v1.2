const { wallet, signChallenge } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const profileAuth = require("../lib/profile-auth");

test("a real ed25519 signature over the raw message verifies", () => {
  const kp = wallet();
  const auth = signChallenge(profileAuth, { keypair: kp, action: "modify-profile", slug: "keb" });
  const record = profileAuth.verifyAndConsume({
    token: auth.challengeToken,
    address: auth.address,
    signatureBase64: auth.signature,
    expectedAction: "modify-profile",
    expectedSlug: "keb",
    expectedTarget: null,
  });
  assert.equal(record.action, "modify-profile");
  assert.equal(record.slug, "keb");
});

test("the SEP-53 prefixed variant also verifies", () => {
  const kp = wallet();
  const auth = signChallenge(profileAuth, {
    keypair: kp, action: "modify-profile", slug: "keb", variant: "sep53",
  });
  assert.doesNotThrow(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
  }));
});

test("a challenge is single-use — replay is rejected", () => {
  const kp = wallet();
  const auth = signChallenge(profileAuth, { keypair: kp, action: "modify-profile", slug: "keb" });
  const args = {
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
  };
  profileAuth.verifyAndConsume(args);
  assert.throws(() => profileAuth.verifyAndConsume(args), /already-used/);
});

test("a signature for one profile cannot be used on another", () => {
  const kp = wallet();
  const auth = signChallenge(profileAuth, { keypair: kp, action: "modify-profile", slug: "alice" });
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile", expectedSlug: "bob", expectedTarget: null,
  }), /profile mismatch/);
});

test("omitting expectedSlug fails closed rather than skipping the check", () => {
  // The previous implementation was `if (expectedSlug !== undefined && ...)`,
  // so a route that forgot the argument silently got no slug binding at all.
  const kp = wallet();
  const auth = signChallenge(profileAuth, { keypair: kp, action: "modify-profile", slug: "alice" });
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile",
  }), /profile mismatch/);
});

test("an add-wallet consent signed for W1 cannot be replayed to add W2", () => {
  // The core of the takeover fix: the owner's consent names the exact address.
  const owner = wallet();
  const w1 = wallet().publicKey();
  const w2 = wallet().publicKey();
  const auth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug: "keb", target: w1,
  });
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "authorize-add-wallet", expectedSlug: "keb", expectedTarget: w2,
  }), /target mismatch/);
});

test("omitting expectedTarget on a target-bound challenge fails closed", () => {
  const owner = wallet();
  const target = wallet().publicKey();
  const auth = signChallenge(profileAuth, {
    keypair: owner, action: "authorize-add-wallet", slug: "keb", target,
  });
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "authorize-add-wallet", expectedSlug: "keb",
  }), /target mismatch/);
});

test("the target address is bound into the signed message text", () => {
  const target = wallet().publicKey();
  const msg = profileAuth._buildMessage({
    token: "t", address: "GA", action: "authorize-add-wallet",
    slug: "keb", target, expiresAt: Date.now(),
  });
  assert.match(msg, new RegExp(`^wallet: ${target}$`, "m"));
});

test("the retired add-wallet action can no longer get a challenge", () => {
  assert.equal(profileAuth.ACTIONS.has("add-wallet"), false);
  assert.throws(() => profileAuth.issueChallenge({
    address: wallet().publicKey(), action: "add-wallet", slug: "keb",
  }), /Unknown action/);
});

test("a signature over sha256(message) is rejected by default", () => {
  // Accepting a digest signature means accepting anything a wallet will sign as
  // a "32-byte transaction hash".
  assert.equal(profileAuth.ALLOW_HASH_VARIANTS, false);
  const kp = wallet();
  const auth = signChallenge(profileAuth, {
    keypair: kp, action: "modify-profile", slug: "keb", variant: "rawHash",
  });
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
  }), /Signature verification failed/);
});

test("rejecting a hash-variant signature logs that it WOULD have matched", () => {
  // Without this diagnostic, a wallet that only signs digests is
  // indistinguishable from a wrong key or a cancelled prompt, and there is no
  // evidence on which to decide whether the env flag is ever needed.
  const kp = wallet();
  const auth = signChallenge(profileAuth, {
    keypair: kp, action: "modify-profile", slug: "keb", variant: "sep53Hash",
  });
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    assert.throws(() => profileAuth.verifyAndConsume({
      token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
      expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
    }));
  } finally {
    console.warn = original;
  }
  assert.ok(
    warnings.some((w) => /WOULD have matched \(sep53Hash\)/.test(w)),
    `expected a hash-variant diagnostic, got: ${JSON.stringify(warnings)}`
  );
});

test("a signature by a different key is rejected", () => {
  const kp = wallet();
  const other = wallet();
  const { token, message } = profileAuth.issueChallenge({
    address: kp.publicKey(), action: "modify-profile", slug: "keb",
  });
  // Buffer.from(): Keypair.sign returns a Uint8Array in stellar-sdk 17.
  const signature = Buffer.from(other.sign(Buffer.from(message, "utf8"))).toString("base64");
  assert.throws(() => profileAuth.verifyAndConsume({
    token, address: kp.publicKey(), signatureBase64: signature,
    expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
  }), /Signature verification failed/);
});

test("an expired challenge is rejected", () => {
  const kp = wallet();
  const auth = signChallenge(profileAuth, { keypair: kp, action: "modify-profile", slug: "keb" });
  profileAuth._pending.get(auth.challengeToken).expiresAt = Date.now() - 1;
  assert.throws(() => profileAuth.verifyAndConsume({
    token: auth.challengeToken, address: auth.address, signatureBase64: auth.signature,
    expectedAction: "modify-profile", expectedSlug: "keb", expectedTarget: null,
  }), /expired/);
});

test("a malformed target address is refused at issue time", () => {
  assert.throws(() => profileAuth.issueChallenge({
    address: wallet().publicKey(), action: "authorize-add-wallet",
    slug: "keb", target: "not-an-address",
  }), /Invalid target address/);
});
