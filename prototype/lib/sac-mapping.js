/**
 * Stellar Asset Contract (SAC) ↔ Classic Asset Mapping
 *
 * On Stellar, classic assets (native XLM, classic-issued tokens like Circle's
 * USDC) can be wrapped into Soroban contracts called SACs (Stellar Asset
 * Contracts). The wrapped balance is the same economic asset as the underlying
 * classic balance — they're two interfaces to the same value.
 *
 * Problem: our probe-based Soroban discovery (token-universe.js) includes the
 * well-known SACs, so wallets that hold the underlying classic asset also
 * appear to "hold" the SAC at the same amount. This double-counts value:
 * a wallet with 100 XLM appears as 100 XLM native + 100 XLM SAC = 200 XLM.
 *
 * Solution: this mapping lets the server merge the two representations into
 * a single balance entry, attributing the value once to the underlying
 * classic asset (which is what the user actually holds).
 *
 * Currently mapped:
 *   - XLM SAC  ↔ native XLM
 *   - USDC SAC ↔ Circle USDC (GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)
 *
 * Additional SAC pairs can be added here as we learn about them. If a
 * Soroban-only token (no classic representation) is in our universe, it
 * does NOT need an entry here — it correctly shows up only on the Soroban
 * side.
 */

// SAC contract ID → classic asset descriptor that it wraps
const SAC_TO_CLASSIC = {
  // Native XLM Stellar Asset Contract
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA": {
    type: "native",
    code: "XLM",
    issuer: null,
  },
  // Circle's USDC Stellar Asset Contract
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75": {
    type: "credit_alphanum4",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
};

/**
 * Get the classic asset descriptor wrapped by a SAC contract ID, or null if
 * the contract is not a known SAC.
 */
function classicForSAC(contractId) {
  return SAC_TO_CLASSIC[contractId] || null;
}

/**
 * Check whether a balance entry from the classic side matches the underlying
 * classic asset of a SAC entry. Used by the deduplication logic in server.js.
 */
function classicMatches(classicEntry, sacUnderlying) {
  if (!classicEntry || !sacUnderlying) return false;
  if (classicEntry.type !== sacUnderlying.type) return false;
  if (sacUnderlying.type === "native") return true; // both native
  // For credit_alphanum* types, compare code + issuer
  const eAsset = classicEntry.asset || {};
  return eAsset.code === sacUnderlying.code && eAsset.issuer === sacUnderlying.issuer;
}

/**
 * Return true if the given contractId is a SAC for a well-known classic asset.
 */
function isKnownSAC(contractId) {
  return Object.prototype.hasOwnProperty.call(SAC_TO_CLASSIC, contractId);
}

module.exports = {
  SAC_TO_CLASSIC,
  classicForSAC,
  classicMatches,
  isKnownSAC,
};
