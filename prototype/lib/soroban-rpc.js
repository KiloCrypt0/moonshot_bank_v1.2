/**
 * Soroban RPC Client
 *
 * Handles all Soroban smart contract queries against Stellar mainnet.
 * Uses @stellar/stellar-sdk's rpc module for contract state reads.
 */
const StellarSdk = require("@stellar/stellar-sdk");
const { Contract, rpc, xdr, Address, nativeToScVal, scValToNative } = StellarSdk;

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-rpc.mainnet.stellar.gateway.fm";
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;

const server = new rpc.Server(SOROBAN_RPC_URL);

// ── Low-level helpers ─────────────────────────────────────────────────────────

/**
 * Simulate a contract call (read-only, no transaction needed)
 */
async function simulateContractCall(contractId, method, args = []) {
  const contract = new Contract(contractId);
  const sourceAccount = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"; // dummy source

  // Build a transaction just for simulation
  const account = new StellarSdk.Account(sourceAccount, "0");
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  if (simResult.result) {
    return simResult.result.retval;
  }

  return null;
}

/**
 * Read contract data directly from ledger
 */
async function getContractData(contractId, key, durability = "persistent") {
  try {
    const dur = durability === "temporary"
      ? rpc.Durability.Temporary
      : rpc.Durability.Persistent;
    const result = await server.getContractData(contractId, key, dur);
    return result;
  } catch (e) {
    if (e.code === 404 || e.message?.includes("not found")) return null;
    throw e;
  }
}

// ── Token balance queries ─────────────────────────────────────────────────────

/**
 * Get a Soroban token balance for an address.
 * Works with both SAC (Stellar Asset Contracts) and custom SEP-41 tokens.
 */
async function getTokenBalance(contractId, userAddress) {
  try {
    const addressScVal = new Address(userAddress).toScVal();
    const result = await simulateContractCall(contractId, "balance", [addressScVal]);
    if (result) {
      return scValToNative(result).toString();
    }
    return "0";
  } catch (e) {
    console.error(`Token balance error for ${contractId}:`, e.message);
    return "0";
  }
}

/**
 * Get token metadata (name, symbol, decimals)
 */
async function getTokenMetadata(contractId) {
  try {
    const [nameResult, symbolResult, decimalsResult] = await Promise.allSettled([
      simulateContractCall(contractId, "name"),
      simulateContractCall(contractId, "symbol"),
      simulateContractCall(contractId, "decimals"),
    ]);

    return {
      name: nameResult.status === "fulfilled" && nameResult.value
        ? scValToNative(nameResult.value)
        : "Unknown",
      symbol: symbolResult.status === "fulfilled" && symbolResult.value
        ? scValToNative(symbolResult.value)
        : "???",
      decimals: decimalsResult.status === "fulfilled" && decimalsResult.value
        ? Number(scValToNative(decimalsResult.value))
        : 7,
    };
  } catch (e) {
    console.error(`Token metadata error for ${contractId}:`, e.message);
    return { name: "Unknown", symbol: "???", decimals: 7 };
  }
}

/**
 * Format a raw token amount using its decimals
 */
function formatTokenAmount(rawAmount, decimals) {
  const raw = BigInt(rawAmount);
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`;
}

// ── AMM / LP helpers ──────────────────────────────────────────────────────────

/**
 * Generic: get pool reserves from a Soroban AMM contract.
 * Most Soroban AMMs (Soroswap, Phoenix, Sushi) expose get_reserves().
 */
async function getPoolReserves(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_reserves");
    if (result) {
      const reserves = scValToNative(result);
      return reserves;
    }
    return null;
  } catch (e) {
    console.error(`Pool reserves error for ${poolContractId}:`, e.message);
    return null;
  }
}

/**
 * Get a user's LP token balance in a pool
 */
async function getLPBalance(poolContractId, userAddress) {
  return getTokenBalance(poolContractId, userAddress);
}

/**
 * Get total supply of LP tokens in a pool
 */
async function getLPTotalSupply(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "total_supply");
    if (result) {
      return scValToNative(result).toString();
    }
    return "0";
  } catch (e) {
    console.error(`LP total supply error for ${poolContractId}:`, e.message);
    return "0";
  }
}

module.exports = {
  server,
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
  simulateContractCall,
  getContractData,
  getTokenBalance,
  getTokenMetadata,
  formatTokenAmount,
  getPoolReserves,
  getLPBalance,
  getLPTotalSupply,
};
