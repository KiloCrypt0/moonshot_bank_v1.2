require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("@stellar/stellar-sdk");

/**
 * Pins the @stellar/stellar-sdk surface the app actually uses — 16 modules
 * require it. A moved or renamed export fails here, at `npm test`, instead of
 * at 2am on a live route.
 *
 * This exists because of the 15 -> 17 bump (two majors, taken to clear the
 * axios SSRF and toml prototype-pollution advisories that stellar-sdk 15
 * pinned).
 */
const SURFACE = [
  ["Horizon.Server", () => S.Horizon.Server, "function"],
  ["rpc.Server", () => S.rpc.Server, "function"],
  ["Keypair.fromPublicKey", () => S.Keypair.fromPublicKey, "function"],
  ["Keypair.random", () => S.Keypair.random, "function"],
  ["Address", () => S.Address, "function"],
  ["nativeToScVal", () => S.nativeToScVal, "function"],
  ["scValToNative", () => S.scValToNative, "function"],
  ["xdr.ScVal.fromXDR", () => S.xdr.ScVal.fromXDR, "function"],
  ["TransactionBuilder", () => S.TransactionBuilder, "function"],
  ["Account", () => S.Account, "function"],
  ["Asset", () => S.Asset, "function"],
  ["Asset.native", () => S.Asset.native, "function"],
  ["Networks.PUBLIC", () => S.Networks.PUBLIC, "string"],
];

for (const [name, get, kind] of SURFACE) {
  test(`stellar-sdk exposes ${name}`, () => {
    assert.equal(typeof get(), kind, `${name} is not a ${kind}`);
  });
}

test("ed25519 sign/verify still round-trips through base64", () => {
  // This is the profile-auth path: the wallet signs, hands back base64, and
  // verifyAndConsume decodes and verifies. It is the single most
  // security-sensitive use of the SDK in the app.
  const kp = S.Keypair.random();
  const message = Buffer.from("Stellar Scope authorization\naction: modify-profile", "utf8");
  const signature = Buffer.from(kp.sign(message));

  assert.equal(signature.length, 64, "ed25519 signatures must be 64 bytes");
  const overTheWire = signature.toString("base64");
  const decoded = Buffer.from(overTheWire, "base64");
  assert.equal(decoded.length, 64);
  assert.equal(S.Keypair.fromPublicKey(kp.publicKey()).verify(message, decoded), true);

  // And a signature by a different key must not verify.
  const other = S.Keypair.random();
  assert.equal(
    S.Keypair.fromPublicKey(kp.publicKey()).verify(message, Buffer.from(other.sign(message))),
    false
  );
});

test("Keypair.sign returns bytes that must be wrapped before .toString('base64')", () => {
  // SDK 15 returned a Buffer here; 17 returns a plain Uint8Array, whose
  // .toString("base64") silently yields "12,34,56,…". Anything doing that on
  // the raw return value produces a garbage signature.
  const sig = S.Keypair.random().sign(Buffer.from("x"));
  assert.equal(sig.length, 64);
  assert.equal(Buffer.from(sig).toString("base64").length, 88);
});
