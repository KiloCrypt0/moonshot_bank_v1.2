/**
 * Sentora Vaults Adapter (Stellar DeFi Hub)
 *
 * Source: https://github.com/Into-The-Block-Corp/StellarVaults
 * Verified WASM per stellar.expert; commit c29a8bf9398dfd5817b43db5e474543efc9932ff.
 *
 * Contract shape — principal-only escrow, no on-chain yield accrual:
 *   - Write:  deposit(from, amount, referral_id) → u64 deposit_id
 *   - Write:  withdraw(from, amount)
 *   - Read:   *no public read method exposed*
 *   - Storage: persistent enum key `DepositStorageKey::Deposit(Address)`
 *              → struct DepositRecord { owner: Address, amount: u128 }
 *
 * Since the contract has no `balance(user)` accessor, we read the storage
 * entry directly via getContractData with the reconstructed enum key.
 * Soroban enum variants serialize as Vec[Symbol(variantName), args...].
 *
 * Yield is not accrued on-chain — the DepositRecord only tracks principal.
 * Any yield distribution happens off-chain (or via a separate contract),
 * so we can't report accrued yield or APY from on-chain data alone.
 */
const { getContractData } = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, xdr, nativeToScVal, scValToNative } = StellarSdk;

// Vault registry — add new Sentora vaults here as they launch.
// underlyingSymbol / underlyingDecimals: for the token users deposited.
// name: display label for the vault card.
// externalUrl: click-through for manage / more info.
const VAULTS = [
  {
    vaultContractId:      "CA54LVHMAY7HGLMVPN4W72XJB4OGKVZBZX26FWN6JD4P3HJFWQUQEHJO",
    name:                 "Sentora XLM Vault",
    underlyingContractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    underlyingSymbol:     "XLM",
    underlyingDecimals:   7,
    externalUrl:          "https://defi.stellar.org",
  },
];

// Cache per user for 60s — matches other lending/vault adapters.
const CACHE_TTL = 60_000;
const _cache = new Map();

async function _readDepositRecord(vaultId, userAddress) {
  // Reconstruct DepositStorageKey::Deposit(address) enum key.
  const key = xdr.ScVal.scvVec([
    nativeToScVal("Deposit", { type: "symbol" }),
    new Address(userAddress).toScVal(),
  ]);
  const entry = await getContractData(vaultId, key, "persistent").catch(() => null);
  if (!entry) return null;
  try {
    const inner = entry.val.contractData().val();
    return scValToNative(inner);
  } catch (e) {
    return null;
  }
}

function _priceFor(sym, priceCtx) {
  const s = (sym || "").toUpperCase();
  if (s === "XLM") return priceCtx?.xlmPrice?.usd || 0;
  if (["USDC","USDY","PYUSD","EURC","MGUSD","USST","YLDS","USTBL"].includes(s)) return 1;
  return 0;
}

const SentoraAdapter = {
  protocolId: "sentora",
  name: "Sentora Vaults",
  type: "vault",

  isConfigured() { return VAULTS.length > 0; },

  async getPositions(userAddress, priceCtx) {
    if (!userAddress || !userAddress.startsWith("G")) return [];
    const cached = _cache.get(userAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.positions;

    const positions = [];
    for (const v of VAULTS) {
      const record = await _readDepositRecord(v.vaultContractId, userAddress).catch(() => null);
      if (!record) continue;
      const rawAmount = BigInt(record.amount || "0");
      if (rawAmount === 0n) continue;

      const divisor = 10 ** v.underlyingDecimals;
      const amountNum = Number(rawAmount) / divisor;
      const priceUSD = _priceFor(v.underlyingSymbol, priceCtx);

      positions.push({
        protocol: "sentora",
        type: "vault",
        contractId: v.vaultContractId,
        vaultName: v.name,
        receiptSymbol: v.underlyingSymbol,
        deposited: {
          amount: amountNum.toFixed(amountNum < 1 ? 6 : 2),
          asset: v.underlyingSymbol,
        },
        yield: {
          // The vault contract only tracks principal; any yield distribution
          // happens off-chain. We can't report accrued yield from on-chain.
          accrued: "0",
          asset: v.underlyingSymbol,
          apy: null,
        },
        valueUSD: amountNum * priceUSD,
        externalUrl: v.externalUrl,
      });
    }

    _cache.set(userAddress, { ts: Date.now(), positions });
    return positions;
  },
};

module.exports = SentoraAdapter;
