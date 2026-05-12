/**
 * Blend Protocol Adapter for Stellar/Soroban
 *
 * Blend is a universal liquidity protocol primitive on Stellar that enables
 * permissionless lending pools. Users can supply collateral and borrow assets.
 *
 * This adapter tracks:
 * 1. Supply/Collateral positions (bTokens → underlying via b_rate)
 * 2. Borrow/Liability positions (dTokens → underlying via d_rate)
 * 3. BLND emissions (claimable rewards)
 *
 * Contract interface (from blend-contracts-v2):
 *   get_positions(address) → Positions { collateral, liabilities, supply }
 *   get_reserve(asset)     → Reserve { b_rate, d_rate, index, ... }
 *   get_reserve_list()     → Vec<Address>
 *   get_config()           → PoolConfig
 *
 * Reference: https://docs.blend.capital/tech-docs/integrations/integrate-pool
 */
const {
  simulateContractCall,
  getTokenMetadata,
  formatTokenAmount,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative, nativeToScVal } = StellarSdk;

// ── Configuration ─────────────────────────────────────────────────────────────

// Known Blend pool contract IDs on mainnet
// Users can configure additional pools via env
const BLEND_CONFIG = {
  // Array of pool objects: { contractId, name, assets[] }
  // Primary pools on mainnet
  pools: JSON.parse(process.env.BLEND_POOLS || "[]"),
  // Example:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "name": "USDC-XLM Pool"
  //   }
  // ]

  // Well-known mainnet pool IDs (fallback if env not set)
  // These are discovered from Blend's pool factory
  knownPools: [
    // Add known mainnet pool contract IDs here as they're discovered
    // { contractId: "C...", name: "Main Pool" }
  ],
};

function getAllPools() {
  return [...BLEND_CONFIG.pools, ...BLEND_CONFIG.knownPools].filter(
    (p) => p.contractId
  );
}

// ── Contract Queries ─────────────────────────────────────────────────────────

/**
 * Get the list of reserve asset addresses for a pool.
 */
async function getReserveList(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_reserve_list");
    if (!result) return [];
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_reserve_list error for ${poolContractId}:`, e.message);
    return [];
  }
}

/**
 * Get reserve data (including b_rate and d_rate for token conversion).
 */
async function getReserve(poolContractId, assetAddress) {
  try {
    const assetScVal = new Address(assetAddress).toScVal();
    const result = await simulateContractCall(poolContractId, "get_reserve", [assetScVal]);
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_reserve error:`, e.message);
    return null;
  }
}

/**
 * Get user positions in a Blend pool.
 * Returns: { collateral: Map<reserveIndex, amount>, liabilities: Map, supply: Map }
 */
async function getPositions(poolContractId, userAddress) {
  try {
    const userScVal = new Address(userAddress).toScVal();
    const result = await simulateContractCall(poolContractId, "get_positions", [userScVal]);
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    // User may have no positions — that's normal
    if (e.message?.includes("not found") || e.message?.includes("Simulation failed")) {
      return null;
    }
    console.error(`[Blend] get_positions error:`, e.message);
    return null;
  }
}

/**
 * Get pool configuration.
 */
async function getPoolConfig(poolContractId) {
  try {
    const result = await simulateContractCall(poolContractId, "get_config");
    if (!result) return null;
    return scValToNative(result);
  } catch (e) {
    console.error(`[Blend] get_config error:`, e.message);
    return null;
  }
}

// ── Position Resolution ──────────────────────────────────────────────────────

/**
 * Convert protocol token amount (bTokens/dTokens) to underlying asset amount.
 * b_rate and d_rate are fixed-point with 9 decimal places in Blend v2.
 */
function protocolToUnderlying(protocolAmount, rate, decimals = 7) {
  if (!rate || !protocolAmount) return 0;
  // rate is typically a large integer representing a fixed-point number
  // The conversion: underlying = protocolAmount * rate / 10^9
  try {
    const amount = BigInt(protocolAmount);
    const rateVal = BigInt(rate);
    const scaleFactor = BigInt(10 ** 9);
    const underlying = (amount * rateVal) / scaleFactor;
    return Number(underlying) / (10 ** decimals);
  } catch (e) {
    // Fallback for non-BigInt values
    return (Number(protocolAmount) * Number(rate)) / 1e9 / (10 ** decimals);
  }
}

/**
 * Resolve all positions for a user across all configured Blend pools.
 */
async function resolveUserPositions(userAddress) {
  const pools = getAllPools();
  const positions = [];

  for (const pool of pools) {
    try {
      const userPositions = await getPositions(pool.contractId, userAddress);
      if (!userPositions) continue;

      // Get reserve list to map indices to asset addresses
      const reserveList = await getReserveList(pool.contractId);
      if (!reserveList || reserveList.length === 0) continue;

      // Process collateral positions (most common for suppliers)
      const collateralMap = userPositions.collateral || userPositions.Collateral || new Map();
      for (const [reserveIndex, bTokenAmount] of Object.entries(collateralMap)) {
        if (!bTokenAmount || BigInt(bTokenAmount) === 0n) continue;

        const assetAddress = reserveList[Number(reserveIndex)];
        if (!assetAddress) continue;

        const reserve = await getReserve(pool.contractId, assetAddress);
        let metadata = { symbol: "???", decimals: 7 };
        try {
          metadata = await getTokenMetadata(assetAddress);
        } catch (e) { /* use defaults */ }

        const underlyingAmount = protocolToUnderlying(
          bTokenAmount,
          reserve?.b_rate || reserve?.bRate,
          metadata.decimals
        );

        positions.push({
          protocol: "blend",
          type: "lending",
          subtype: "collateral",
          poolContractId: pool.contractId,
          poolName: pool.name || "Blend Pool",
          assetAddress,
          asset: metadata.symbol,
          decimals: metadata.decimals,
          protocolTokens: bTokenAmount.toString(),
          underlyingAmount,
          reserveIndex: Number(reserveIndex),
          valueUSD: 0, // Enriched by caller
        });
      }

      // Process supply positions (non-collateral supply)
      const supplyMap = userPositions.supply || userPositions.Supply || new Map();
      for (const [reserveIndex, bTokenAmount] of Object.entries(supplyMap)) {
        if (!bTokenAmount || BigInt(bTokenAmount) === 0n) continue;

        const assetAddress = reserveList[Number(reserveIndex)];
        if (!assetAddress) continue;

        const reserve = await getReserve(pool.contractId, assetAddress);
        let metadata = { symbol: "???", decimals: 7 };
        try {
          metadata = await getTokenMetadata(assetAddress);
        } catch (e) {}

        const underlyingAmount = protocolToUnderlying(
          bTokenAmount,
          reserve?.b_rate || reserve?.bRate,
          metadata.decimals
        );

        positions.push({
          protocol: "blend",
          type: "lending",
          subtype: "supply",
          poolContractId: pool.contractId,
          poolName: pool.name || "Blend Pool",
          assetAddress,
          asset: metadata.symbol,
          decimals: metadata.decimals,
          protocolTokens: bTokenAmount.toString(),
          underlyingAmount,
          reserveIndex: Number(reserveIndex),
          valueUSD: 0,
        });
      }

      // Process liability positions (borrows)
      const liabilitiesMap = userPositions.liabilities || userPositions.Liabilities || new Map();
      for (const [reserveIndex, dTokenAmount] of Object.entries(liabilitiesMap)) {
        if (!dTokenAmount || BigInt(dTokenAmount) === 0n) continue;

        const assetAddress = reserveList[Number(reserveIndex)];
        if (!assetAddress) continue;

        const reserve = await getReserve(pool.contractId, assetAddress);
        let metadata = { symbol: "???", decimals: 7 };
        try {
          metadata = await getTokenMetadata(assetAddress);
        } catch (e) {}

        const underlyingAmount = protocolToUnderlying(
          dTokenAmount,
          reserve?.d_rate || reserve?.dRate,
          metadata.decimals
        );

        positions.push({
          protocol: "blend",
          type: "borrowing",
          subtype: "liability",
          poolContractId: pool.contractId,
          poolName: pool.name || "Blend Pool",
          assetAddress,
          asset: metadata.symbol,
          decimals: metadata.decimals,
          protocolTokens: dTokenAmount.toString(),
          underlyingAmount,
          reserveIndex: Number(reserveIndex),
          valueUSD: 0, // Negative value — this is debt
        });
      }
    } catch (e) {
      console.error(`[Blend] Error resolving positions for pool ${pool.contractId}:`, e.message);
    }
  }

  return positions;
}

// ── Adapter Interface ────────────────────────────────────────────────────────

const BlendAdapter = {
  protocolId: "blend",
  name: "Blend Protocol",
  type: "lending",

  isConfigured() {
    return getAllPools().length > 0;
  },

  /**
   * Get all Blend Protocol positions for a user.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];
    return resolveUserPositions(userAddress);
  },
};

module.exports = BlendAdapter;
