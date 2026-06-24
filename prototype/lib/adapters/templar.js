/**
 * Templar Finance Adapter for Stellar
 *
 * Templar's Stellar deployment uses TWO custody surfaces:
 *   - GDJ4...QBJK (classic G-address): receives collateral deposits as classic
 *     Stellar payments (e.g. 100 XLM deposit shows up as a `payment` op).
 *   - CCLW...UVAG (Soroban contract):  disburses borrowed assets as SAC token
 *     transfers (e.g. 2 USDC borrow arrives via `invoke_host_function`).
 *
 * The actual lending logic — interest accrual, health factor, liquidation —
 * runs off-Stellar on NEAR via Chain Signatures / MPC. So this adapter only
 * sees the on-chain principal of each leg, not live debt or accrued yield.
 *
 * Implementation walks `/accounts/{addr}/operations` once and processes both
 * leg types in a single pass:
 *   - classic `payment` ops to/from the G-address  → collateral transfers
 *   - `invoke_host_function` ops whose asset_balance_changes show a transfer
 *     involving the Soroban contract or G-address → borrow / repay
 *
 * Output: ONE position per active Templar account. When both a collateral
 * deposit and a borrow disbursement are detected, the position renders as a
 * lending position with both legs visible.
 *
 * Honest limitations (all need a NEAR-side query to fix):
 *   - Principal only — no accrued interest on either leg
 *   - No health factor / liquidation buffer
 *   - No borrow APR
 *   - Multi-collateral / multi-borrow positions show only the primary
 *     (largest-USD) asset of each side; the rest are summed into its USD total
 *
 * Adding new custody addresses: append to TEMPLAR_G_ADDRESSES (classic) or
 * TEMPLAR_C_ADDRESSES (Soroban contract).
 */

const TEMPLAR_G_ADDRESSES = new Set([
  "GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK",
]);

const TEMPLAR_C_ADDRESSES = new Set([
  "CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG",
]);

const HORIZON_BASE = "https://horizon.stellar.org";

// Cache per user for 60s — the operations query is paginated; deep history
// can take 5-10 pages per scan.
const CACHE_TTL = 60_000;
const cache = new Map();

async function _scanFlows(userAddress) {
  // Aggregate net flows per asset across both classic payments (G-address)
  // and Soroban contract transfers (C-address).
  // Returns Map<key, { code, issuer|null, sent, received }>
  //   sent     = user → Templar (deposit / repayment)
  //   received = Templar → user (withdrawal / borrow)
  const perAsset = new Map();
  let cursor = "";
  let pages = 0;
  const MAX_PAGES = 20;

  while (pages < MAX_PAGES) {
    const url = `${HORIZON_BASE}/accounts/${userAddress}/operations?order=desc&include_failed=false&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      data = await res.json();
    } catch (e) {
      break;
    }
    const records = data?._embedded?.records || [];
    if (records.length === 0) break;

    for (const op of records) {
      if (op.type === "payment") {
        const isToTemplar = TEMPLAR_G_ADDRESSES.has(op.to);
        const isFromTemplar = TEMPLAR_G_ADDRESSES.has(op.from);
        if (!isToTemplar && !isFromTemplar) continue;
        if (op.from !== userAddress && op.to !== userAddress) continue;
        const code = op.asset_type === "native" ? "XLM" : op.asset_code;
        const issuer = op.asset_type === "native" ? null : op.asset_issuer;
        const amount = parseFloat(op.amount || "0");
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const agg = _getOrInit(perAsset, code, issuer);
        if (isToTemplar && op.from === userAddress) agg.sent += amount;
        else if (isFromTemplar && op.to === userAddress) agg.received += amount;
      } else if (op.type === "invoke_host_function") {
        // Walk the operation's token-transfer changes. Horizon surfaces
        // Soroban SAC transfers here even though they don't appear in
        // /payments — this is how we catch the borrow disbursement.
        for (const change of op.asset_balance_changes || []) {
          if (change.type !== "transfer") continue;
          const from = change.from;
          const to = change.to;
          const isToTemplar = TEMPLAR_C_ADDRESSES.has(to) || TEMPLAR_G_ADDRESSES.has(to);
          const isFromTemplar = TEMPLAR_C_ADDRESSES.has(from) || TEMPLAR_G_ADDRESSES.has(from);
          if (!isToTemplar && !isFromTemplar) continue;
          if (from !== userAddress && to !== userAddress) continue;
          const code = change.asset_type === "native" ? "XLM" : change.asset_code;
          const issuer = change.asset_type === "native" ? null : change.asset_issuer;
          const amount = parseFloat(change.amount || "0");
          if (!Number.isFinite(amount) || amount <= 0) continue;
          const agg = _getOrInit(perAsset, code, issuer);
          if (isToTemplar && from === userAddress) agg.sent += amount;
          else if (isFromTemplar && to === userAddress) agg.received += amount;
        }
      }
    }

    cursor = records[records.length - 1].paging_token;
    pages++;
    if (records.length < 200) break;
  }

  return perAsset;
}

function _getOrInit(perAsset, code, issuer) {
  const key = `${code}:${issuer || "native"}`;
  if (!perAsset.has(key)) {
    perAsset.set(key, { code, issuer, sent: 0, received: 0 });
  }
  return perAsset.get(key);
}

function _priceFor(code, priceCtx) {
  if (code === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  if (code === "USDC" || code === "USDx" || code === "PYUSD") return 1;
  return 0;
}

function _fmt(amount) {
  return amount.toFixed(amount < 1 ? 6 : 2);
}

const TemplarAdapter = {
  protocolId: "templar",
  name: "Templar Finance",
  type: "lending",

  isConfigured() {
    return TEMPLAR_G_ADDRESSES.size > 0 || TEMPLAR_C_ADDRESSES.size > 0;
  },

  async getPositions(userAddress, priceCtx) {
    if (!this.isConfigured()) return [];

    const cached = cache.get(userAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.positions;
    }

    let perAsset;
    try {
      perAsset = await _scanFlows(userAddress);
    } catch (e) {
      console.warn(`Templar scan failed for ${userAddress}:`, e.message);
      return [];
    }

    // Split per-asset nets into collateral (net flow into Templar) and
    // borrows (net flow out to user without prior matching deposit).
    const collateral = [];
    const borrows = [];
    for (const [, agg] of perAsset) {
      const net = agg.sent - agg.received;
      const priceUSD = _priceFor(agg.code, priceCtx);
      if (net > 0) {
        collateral.push({ code: agg.code, amount: net, usd: net * priceUSD });
      } else if (net < 0) {
        borrows.push({ code: agg.code, amount: -net, usd: -net * priceUSD });
      }
    }

    if (collateral.length === 0 && borrows.length === 0) {
      cache.set(userAddress, { ts: Date.now(), positions: [] });
      return [];
    }

    // Sort by USD so the primary asset of each side is well-defined; the
    // remaining same-side assets are summed into the totals but only the
    // primary asset is rendered as the label (UI limitation we accept).
    collateral.sort((a, b) => b.usd - a.usd);
    borrows.sort((a, b) => b.usd - a.usd);
    const primaryCol = collateral[0] || null;
    const primaryBor = borrows[0] || null;
    const collateralUSD = collateral.reduce((s, c) => s + c.usd, 0);
    const borrowUSD = borrows.reduce((s, b) => s + b.usd, 0);

    const position = {
      protocol: "templar",
      type: "vault",
      contractId: null,
      vaultName: primaryBor && primaryCol
        ? "Templar lending position"
        : `Templar ${(primaryCol || primaryBor).code} deposit`,
      receiptSymbol: (primaryCol || primaryBor).code,
      deposited: primaryCol ? {
        amount: _fmt(primaryCol.amount),
        asset: primaryCol.code,
      } : null,
      yield: {
        accrued: "0",
        asset: (primaryCol || primaryBor).code,
        apy: null,
      },
      valueUSD: collateralUSD - borrowUSD,
    };

    if (primaryBor) {
      position.borrow = {
        amount: _fmt(primaryBor.amount),
        asset: primaryBor.code,
        valueUSD: borrowUSD,
      };
    }

    const positions = [position];
    cache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  },
};

module.exports = TemplarAdapter;
