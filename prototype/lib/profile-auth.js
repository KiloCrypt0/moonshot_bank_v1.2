/**
 * Profile Ownership Auth — Stellar Ed25519 signature-challenge flow
 *
 * Enforces that only the controller of a wallet can add it to a public
 * profile, and only a wallet already on a profile can modify it. Deleting a
 * profile, and consenting to a new wallet joining it, require the profile
 * OWNER — the wallet that created it.
 *
 * A challenge may be bound to a `target` address as well as a slug. Adding or
 * removing a wallet signs over the address being added/removed, so a signature
 * collected for one wallet cannot be replayed to attach a different one.
 *
 * Flow (per operation):
 *   1. Client POSTs { address, action } to /api/v1/auth/challenge
 *   2. Server returns { token, message, expiresAt } and stashes the token
 *      + address + action in a short-TTL in-memory store.
 *   3. Client asks the wallet to sign `message` via Stellar Wallets Kit's
 *      signMessage() and gets a base64-encoded signature back.
 *   4. Client submits the mutation with { challengeToken, signature } in
 *      the request body (or per-wallet in the wallets array).
 *   5. Server calls verifyAndConsume(...) which:
 *        - looks up the token
 *        - checks expiry
 *        - reconstructs the expected message
 *        - verifies the ed25519 signature against the G-address's pubkey
 *        - deletes the token (single-use, no replay)
 *
 * The signed message includes the domain and action, so a signature issued
 * for a different site or a different action can't be replayed here.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const crypto = require("crypto");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DOMAIN = process.env.STELLARSCOPE_DOMAIN || "stellarscope.xyz";

// Actions a client can request a challenge for. Keeping this closed prevents
// callers from smuggling arbitrary strings into the signed payload.
// `add-wallet` used to be the ONLY signature required to attach a wallet to
// someone else's profile — which then made the attacker "a wallet on the
// profile" and handed them PATCH and DELETE. It is deliberately gone, not
// renamed-and-kept: a stale cached frontend now gets a clean 400 instead of
// silently different security properties.
const ACTIONS = new Set([
  "create-profile",        // POST /api/v1/profiles — one sig per claimed wallet
  "authorize-add-wallet",  // POST /api/v1/profiles/:slug/wallets — signed by the OWNER, bound to the wallet being added
  "claim-wallet",          // POST /api/v1/profiles/:slug/wallets — signed by the wallet BEING ADDED
  "modify-profile",        // PATCH /api/v1/profiles/:slug — any wallet on the profile
  "delete-profile",        // DELETE /api/v1/profiles/:slug — OWNER only
  "remove-wallet",         // DELETE /api/v1/profiles/:slug/wallets — owner, or the wallet itself
]);

// slug-scoped context so a signed challenge for one profile can't be reused
// on another. Empty string when the action doesn't yet reference a slug
// (e.g. create-profile with a not-yet-existing slug — the slug is bound
// in-body at mutation time).
const _pending = new Map(); // token -> { address, action, slug, target, expiresAt }

// Accepting a signature over sha256(message) means accepting anything a wallet
// will sign as a "32-byte transaction hash" — such an API is a signing oracle
// for this challenge. Off by default; the flag exists so that a real wallet
// found to need it is an env change, not a redeploy.
const ALLOW_HASH_VARIANTS = process.env.PROFILE_AUTH_ALLOW_HASH_VARIANTS === "1";

function _cleanup() {
  const now = Date.now();
  for (const [t, c] of _pending) if (c.expiresAt < now) _pending.delete(t);
}
setInterval(_cleanup, 60_000).unref?.();

function _isValidStellarAddress(s) {
  if (typeof s !== "string" || s.length !== 56 || !s.startsWith("G")) return false;
  try { Keypair.fromPublicKey(s); return true; } catch { return false; }
}

function _buildMessage({ token, address, action, slug, target, expiresAt }) {
  const lines = [
    "Stellar Scope authorization",
    `domain: ${DOMAIN}`,
    `action: ${action}`,
    `address: ${address}`,
  ];
  if (slug) lines.push(`profile: ${slug}`);
  // The wallet this action operates ON, when that differs from the signer.
  // Without it, an owner's add-wallet consent for W1 could be replayed to
  // attach W2 instead.
  if (target) lines.push(`wallet: ${target}`);
  lines.push(`token: ${token}`);
  lines.push(`expires: ${new Date(expiresAt).toISOString()}`);
  return lines.join("\n");
}

/**
 * Issue a challenge for an (address, action[, slug]) tuple.
 * Client will sign the returned `message` and later hand back both the
 * token and the base64 signature. Returns the info the client needs.
 */
function issueChallenge({ address, action, slug, target }) {
  if (!_isValidStellarAddress(address)) throw new Error("Invalid Stellar address");
  if (!ACTIONS.has(action)) throw new Error("Unknown action");
  if (target !== undefined && target !== null && target !== "" && !_isValidStellarAddress(target)) {
    throw new Error("Invalid target address");
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const record = { address, action, slug: slug || "", target: target || "", expiresAt };
  _pending.set(token, record);
  const message = _buildMessage({ token, ...record });
  return { token, message, expiresAt };
}

/**
 * Verify a signed challenge and consume it (single-use).
 * Throws on any failure; returns the record on success so callers can
 * introspect what was actually authorized. `signatureBase64` is what the
 * user's wallet returned from signMessage().
 */
function verifyAndConsume({ token, address, signatureBase64, expectedAction, expectedSlug, expectedTarget }) {
  const record = _pending.get(token);
  if (!record) throw new Error("Invalid or already-used challenge");
  if (record.expiresAt < Date.now()) { _pending.delete(token); throw new Error("Challenge expired"); }
  if (record.address !== address) throw new Error("Challenge does not match address");
  if (expectedAction && record.action !== expectedAction) throw new Error("Challenge action mismatch");
  // Both of these compare unconditionally and normalise absent to "". The
  // previous `expectedSlug !== undefined &&` form was skipped whenever a caller
  // forgot the argument, so a route that omitted it got no binding at all —
  // exactly the failure mode this module exists to prevent. Fail closed.
  if ((record.slug || "") !== (expectedSlug || "")) throw new Error("Challenge profile mismatch");
  if ((record.target || "") !== (expectedTarget || "")) throw new Error("Challenge target mismatch");

  const message = _buildMessage({ token, ...record });
  let sig;
  try { sig = Buffer.from(String(signatureBase64), "base64"); }
  catch { throw new Error("Signature is not valid base64"); }
  if (sig.length !== 64) throw new Error("Signature has wrong length");

  const kp = Keypair.fromPublicKey(address);
  // Wallets vary on how they wrap message signing:
  //   1. raw       ed25519.sign(msg_bytes)
  //   2. sep53     ed25519.sign("Stellar Signed Message:\n" + msg_bytes)
  //   3. rawHash   ed25519.sign(sha256(msg_bytes))
  //   4. sep53Hash ed25519.sign(sha256("Stellar Signed Message:\n" + msg_bytes))
  //
  // Only 1 and 2 are ACCEPTED. A signature over a sha256 digest is
  // indistinguishable from a signature over a 32-byte transaction hash, so
  // accepting 3 and 4 turns any wallet that signs a caller-supplied hash into a
  // signing oracle for this challenge.
  //
  // 3 and 4 are still COMPUTED, and a match is logged on the failure path. That
  // diagnostic is the whole point: without it, a wallet that only produces hash
  // signatures is indistinguishable from a wrong key, a wrong message or a
  // cancelled prompt, and there would be no evidence on which to decide whether
  // PROFILE_AUTH_ALLOW_HASH_VARIANTS is ever needed.
  const rawBytes = Buffer.from(message, "utf8");
  const sep53Bytes = Buffer.concat([
    Buffer.from("Stellar Signed Message:\n", "utf8"),
    rawBytes,
  ]);
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const accepted = [
    ["raw",   rawBytes],
    ["sep53", sep53Bytes],
  ];
  const hashVariants = [
    ["rawHash",   sha(rawBytes)],
    ["sep53Hash", sha(sep53Bytes)],
  ];
  const variants = ALLOW_HASH_VARIANTS ? [...accepted, ...hashVariants] : accepted;

  let ok = false;
  let format = null;
  for (const [name, bytes] of variants) {
    if (kp.verify(bytes, sig)) { ok = true; format = name; break; }
  }
  if (ok) {
    console.log(`[profile-auth] verified via ${format} for ${address.slice(0,8)}…`);
  } else {
    const wouldMatch = ALLOW_HASH_VARIANTS
      ? null
      : hashVariants.find(([, bytes]) => kp.verify(bytes, sig));
    if (wouldMatch) {
      console.warn(
        `[profile-auth] verify REJECTED for ${address.slice(0,8)}…: hash-variant ` +
        `WOULD have matched (${wouldMatch[0]}). This wallet signs a digest rather ` +
        `than the message. Set PROFILE_AUTH_ALLOW_HASH_VARIANTS=1 only if this is ` +
        `a wallet you intend to support.`
      );
    } else {
      console.warn(
        `[profile-auth] verify FAILED for ${address.slice(0,8)}… ` +
        `(tried ${variants.map(v => v[0]).join(", ")}); sig=${sig.length}b, msgLen=${rawBytes.length}b`
      );
    }
    throw new Error("Signature verification failed");
  }

  _pending.delete(token); // single-use — no replay
  return record;
}

module.exports = {
  issueChallenge,
  verifyAndConsume,
  ACTIONS,
  ALLOW_HASH_VARIANTS,
  _isValidStellarAddress,
  _buildMessage,
  _pending, // exposed for tests only
};
