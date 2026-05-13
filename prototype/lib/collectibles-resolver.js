/**
 * Soroban Collectibles Resolver
 *
 * Stellar has TWO NFT models:
 *   1. SEP-39 "classic NFTs" — non-fungible classic assets with a stellar.toml
 *      entry. The lib/nft-resolver.js module handles these.
 *   2. SEP-50 Soroban contract NFTs — issued by smart contracts with an
 *      ERC-721-like interface (`name`, `symbol`, `owner_of`, `token_uri`,
 *      and a non-standard `get_owner_tokens(owner)` for enumeration).
 *
 * This module handles case (2) by proxying SDF's official Freighter backend.
 *
 * Why proxy rather than reimplement?
 * --------------------------------------------------------------------------
 * To find a wallet's NFTs in a Soroban contract, you call `get_owner_tokens`
 * via Soroban RPC. That requires (a) a Soroban RPC client and (b) knowing
 * which contract IDs to query, since there is no global NFT registry on
 * Stellar today.
 *
 * The Stellar Development Foundation's Freighter wallet solved this for its
 * users by maintaining a curated list of NFT contracts (configured via env)
 * and exposing a clean HTTPS endpoint that does the contract simulation
 * server-side. The Meridian 2025 NFT contracts are baked in. We could replicate
 * this ourselves but it would be ~3 hours of work, requires hardcoding the
 * same contracts SDF already hardcodes, and provides no value over the
 * official endpoint.
 *
 * For a portfolio tracker, using SDF's endpoint is the right tradeoff: we get
 * the same NFT discovery the Freighter UI has, the same security scanning,
 * and any new collections SDF adds in the future.
 *
 * Source code we're talking to:
 *   https://github.com/stellar/freighter-backend-v2/blob/main/internal/api/handlers/collectibles.go
 *
 * Production endpoint (discovered by inspecting Freighter's network traffic):
 *   POST https://freighter-backend-v2.stellar.org/api/v1/collectibles?network=PUBLIC
 *   Body: { "owner": "G...", "contracts": [] }
 *
 * Response shape (verified live):
 *   {
 *     "data": {
 *       "collections": [
 *         {
 *           "collection": {
 *             "address": "C...",
 *             "name": "Talk",
 *             "symbol": "TALKMP25",
 *             "collectibles": [
 *               { "owner": "G...", "token_uri": "https://...", "token_id": "12622" },
 *               ...
 *             ]
 *           }
 *         } | { "error": { ... } }
 *       ]
 *     }
 *   }
 *
 * The `token_uri` resolves to a JSON document (NOT a direct image) with shape:
 *   {
 *     "name": "Meridian 2025 37 #12622",
 *     "description": "...",
 *     "image": "https://.../M25_37.png",
 *     "external_url": "...",
 *     "attributes": [{ "trait_type": "...", "value": "..." }, ...]
 *   }
 *
 * We fetch metadata JSON for each token in parallel (bounded concurrency)
 * and return a flat list of collectibles ready for the frontend to render.
 */

const FREIGHTER_BACKEND_URL = "https://freighter-backend-v2.stellar.org";
const COLLECTIBLES_ENDPOINT = "/api/v1/collectibles";

// How long to wait for the Freighter backend before giving up. The endpoint
// can be slow when it has to do many Soroban simulations.
const FREIGHTER_TIMEOUT_MS = 30_000;

// How long to wait for each individual token's metadata JSON.
const METADATA_TIMEOUT_MS = 5_000;

// Bound the number of concurrent metadata fetches. NFT image hosts like
// Pinata can rate-limit aggressive parallelism.
const METADATA_CONCURRENCY = 8;

// Cache resolved metadata for an hour. NFT metadata is effectively immutable
// (IPFS content-addressed) so this is safe and significantly speeds up
// repeat views.
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;
const metadataCache = new Map();

async function fetchWithTimeout(url, ms, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch the OpenSea-style metadata JSON for one NFT and pull out the fields
 * we care about. Errors are swallowed — we still return a usable record so
 * the UI can show "name unknown" rather than failing the whole gallery.
 */
async function fetchTokenMetadata(tokenUri) {
  const cached = metadataCache.get(tokenUri);
  if (cached && Date.now() - cached.ts < METADATA_CACHE_TTL_MS) {
    return cached.metadata;
  }

  let metadata = null;
  try {
    const res = await fetchWithTimeout(tokenUri, METADATA_TIMEOUT_MS);
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json") || ct.includes("text/plain")) {
        const json = await res.json();
        metadata = {
          name: json.name || null,
          description: json.description || null,
          image: json.image || null,
          externalUrl: json.external_url || null,
          attributes: Array.isArray(json.attributes) ? json.attributes : [],
        };
      } else if (ct.startsWith("image/")) {
        // Some contracts return a direct image URL from token_uri rather than
        // a metadata document. Handle that gracefully.
        metadata = { name: null, description: null, image: tokenUri, externalUrl: null, attributes: [] };
      }
    }
  } catch (e) {
    // Network error, timeout, or non-JSON response — leave metadata as null.
  }

  metadataCache.set(tokenUri, { metadata, ts: Date.now() });
  return metadata;
}

/**
 * Resolve a batch of token_uri URLs in parallel with bounded concurrency.
 */
async function resolveAllMetadata(items) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fetchTokenMetadata(items[i].token_uri);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(METADATA_CONCURRENCY, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Main entry point. Given a Stellar account address, return all the
 * Soroban NFTs the account holds across the contracts Freighter knows
 * about (currently the three Meridian Pay collections, plus any others
 * SDF adds in the future).
 *
 * Returns:
 *   {
 *     collections: [
 *       {
 *         address: "C...",        // Soroban contract address
 *         name: "Talk",           // contract's `name` field
 *         symbol: "TALKMP25",     // contract's `symbol` field
 *         count: 67,              // number of NFTs held in this collection
 *         items: [
 *           {
 *             tokenId: "12622",
 *             tokenUri: "https://...",
 *             metadata: {
 *               name, description, image, externalUrl, attributes
 *             } | null,
 *           },
 *           ...
 *         ]
 *       },
 *       ...
 *     ],
 *     errors: [                   // collections that failed to load
 *       { contractAddress, message },
 *       ...
 *     ],
 *     source: "freighter-backend-v2",  // attribution for the UI
 *   }
 */
async function resolveSorobanCollectibles(address, { network = "PUBLIC" } = {}) {
  if (!address) {
    throw new Error("address is required");
  }

  const url = `${FREIGHTER_BACKEND_URL}${COLLECTIBLES_ENDPOINT}?network=${encodeURIComponent(network)}`;
  let resp;
  try {
    resp = await fetchWithTimeout(url, FREIGHTER_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Empty `contracts` array means "only auto-discovered collections" —
      // the backend will still add the hardcoded Meridian Pay contracts.
      body: JSON.stringify({ owner: address, contracts: [] }),
    });
  } catch (e) {
    const err = new Error(`Freighter backend unreachable: ${e.message}`);
    err.cause = e;
    throw err;
  }

  if (!resp.ok) {
    throw new Error(`Freighter backend returned HTTP ${resp.status}`);
  }

  const body = await resp.json();
  const rawCollections = body?.data?.collections ?? [];

  const successfulCollections = [];
  const errors = [];

  for (const entry of rawCollections) {
    if (entry.error) {
      // Most often this is "No collectibles available for this collection"
      // meaning the wallet doesn't hold any NFTs from that contract — not
      // really an error from the user's perspective. Skip the "no items"
      // case quietly; surface only genuine failures.
      const msg = entry.error.error_message || "";
      if (!/no collectibles available/i.test(msg)) {
        errors.push({
          contractAddress: entry.error.collection_address || null,
          message: msg,
        });
      }
      continue;
    }
    if (entry.collection) {
      successfulCollections.push(entry.collection);
    }
  }

  // Resolve metadata for every collectible across every collection in a
  // single bounded-concurrency batch, so a slow collection doesn't block
  // a fast one.
  const flatItems = [];
  for (const col of successfulCollections) {
    for (const c of col.collectibles || []) {
      flatItems.push({ collectionAddress: col.address, ...c });
    }
  }

  const metadataResults = await resolveAllMetadata(flatItems);

  // Reassemble into per-collection structure
  const byCollection = new Map();
  flatItems.forEach((item, i) => {
    if (!byCollection.has(item.collectionAddress)) {
      const col = successfulCollections.find((c) => c.address === item.collectionAddress);
      byCollection.set(item.collectionAddress, {
        address: col.address,
        name: col.name,
        symbol: col.symbol,
        count: 0,
        items: [],
      });
    }
    const target = byCollection.get(item.collectionAddress);
    target.items.push({
      tokenId: item.token_id,
      tokenUri: item.token_uri,
      metadata: metadataResults[i],
    });
    target.count++;
  });

  return {
    collections: Array.from(byCollection.values()),
    errors,
    source: "freighter-backend-v2",
  };
}

module.exports = {
  resolveSorobanCollectibles,
};
