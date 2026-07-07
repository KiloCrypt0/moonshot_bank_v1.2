/**
 * Profile Ownership Auth — Stellar Ed25519 signature-challenge flow
 *
 * Enforces that only the controller of a wallet can add it to a public
 * profile, and only a wallet already on a profile can modify or delete it.
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
const ACTIONS = new Set([
  "create-profile",   // used at initial POST /api/v1/profiles — one sig per claimed wallet
  "add-wallet",       // POST /api/v1/profiles/:slug/wallets
  "modify-profile",   // PATCH /api/v1/profiles/:slug
  "delete-profile",   // DELETE /api/v1/profiles/:slug
  "remove-wallet",    // DELETE /api/v1/profiles/:slug/wallets
]);

// slug-scoped context so a signed challenge for one profile can't be reused
// on another. Empty string when the action doesn't yet reference a slug
// (e.g. create-profile with a not-yet-existing slug — the slug is bound
// in-body at mutation time).
const _pending = new Map(); // token -> { address, action, slug, expiresAt }

function _cleanup() {
  const now = Date.now();
  for (const [t, c] of _pending) if (c.expiresAt < now) _pending.delete(t);
}
setInterval(_cleanup, 60_000).unref?.();

function _isValidStellarAddress(s) {
  if (typeof s !== "string" || s.length !== 56 || !s.startsWith("G")) return false;
  try { Keypair.fromPublicKey(s); return true; } catch { return false; }
}

function _buildMessage({ token, address, action, slug, expiresAt }) {
  const lines = [
    "Stellar Scope authorization",
    `domain: ${DOMAIN}`,
    `action: ${action}`,
    `address: ${address}`,
  ];
  if (slug) lines.push(`profile: ${slug}`);
  lines.push(`token: ${token}`);
  lines.push(`expires: ${new Date(expiresAt).toISOString()}`);
  return lines.join("\n");
}

/**
 * Issue a challenge for an (address, action[, slug]) tuple.
 * Client will sign the returned `message` and later hand back both the
 * token and the base64 signature. Returns the info the client needs.
 */
function issueChallenge({ address, action, slug }) {
  if (!_isValidStellarAddress(address)) throw new Error("Invalid Stellar address");
  if (!ACTIONS.has(action)) throw new Error("Unknown action");
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const record = { address, action, slug: slug || "", expiresAt };
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
function verifyAndConsume({ token, address, signatureBase64, expectedAction, expectedSlug }) {
  const record = _pending.get(token);
  if (!record) throw new Error("Invalid or already-used challenge");
  if (record.expiresAt < Date.now()) { _pending.delete(token); throw new Error("Challenge expired"); }
  if (record.address !== address) throw new Error("Challenge does not match address");
  if (expectedAction && record.action !== expectedAction) throw new Error("Challenge action mismatch");
  if (expectedSlug !== undefined && record.slug !== expectedSlug) throw new Error("Challenge profile mismatch");

  const message = _buildMessage({ token, ...record });
  let sig;
  try { sig = Buffer.from(String(signatureBase64), "base64"); }
  catch { throw new Error("Signature is not valid base64"); }
  if (sig.length !== 64) throw new Error("Signature has wrong length");

  const kp = Keypair.fromPublicKey(address);
  // Wallets vary on how they wrap message signing:
  //   1. Raw:      ed25519.sign(msg_bytes)                  — some libraries
  //   2. SEP-53:   ed25519.sign("Stellar Signed Message:\n" + msg_bytes)
  //                                                           — Stellar Wallets Kit / Freighter
  // Try both and accept whichever verifies. Log which one won so we can
  // simplify later once wallet behavior is confirmed.
  const rawBytes = Buffer.from(message, "utf8");
  const sep53Bytes = Buffer.concat([
    Buffer.from("Stellar Signed Message:\n", "utf8"),
    rawBytes,
  ]);
  let ok = kp.verify(rawBytes, sig);
  let format = ok ? "raw" : null;
  if (!ok) {
    ok = kp.verify(sep53Bytes, sig);
    if (ok) format = "sep53";
  }
  if (ok) console.log(`[profile-auth] verified via ${format} for ${address.slice(0,8)}…`);
  else console.warn(`[profile-auth] verify FAILED for ${address.slice(0,8)}… (tried raw + sep53); sig=${sig.length}b`);
  if (!ok) throw new Error("Signature verification failed");

  _pending.delete(token); // single-use — no replay
  return record;
}

module.exports = {
  issueChallenge,
  verifyAndConsume,
  ACTIONS,
  _isValidStellarAddress,
  _pending, // exposed for tests only
};
