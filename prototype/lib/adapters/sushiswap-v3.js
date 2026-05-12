/**
 * SushiSwap V3 Protocol Adapter for Stellar/Soroban
 *
 * SushiSwap V3 uses concentrated liquidity (forked from Uniswap V3 design).
 * On Soroban, positions are tracked as contract state rather than NFTs.
 *
 * Key concepts:
 * - Factory contract: creates and indexes pool contracts
 * - Pool contracts: hold reserves for a specific token pair + fee tier
 * - Positions: a user's liquidity within a specific price range (tick range)
 * - Ticks: discrete price points defining position boundaries
 *
 * To track LP positions we need to:
 * 1. Query the factory for all pools
 * 2. For each pool, check if the user has an active position
 * 3. Calculate the position's current value based on reserves and tick range
 */
const {
  simulateContractCall,
  getTokenBalance,
  getTokenMetadata,
  formatTokenAmount,
  getLPBalance,
  getLPTotalSupply,
  getPoolReserves,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, nativeToScVal, scValToNative } = StellarSdk;

// ── Configuration ─────────────────────────────────────────────────────────────

const SUSHI_CONFIG = {
  // Set these via environment variables with your actual deployed contract IDs
  factoryContractId: process.env.SUSHI_FACTORY_CONTRACT_ID || null,
  // Known pool contract IDs (token pairs)
  // Add pools as they're deployed on Stellar
  pools: JSON.parse(process.env.SUSHI_POOLS || "[]"),
  // Example pool config structure:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "token0": { "contractId": "CDEF...", "symbol": "XLM", "decimals": 7 },
  //     "token1": { "contractId": "CGHI...", "symbol": "USDC", "decimals": 7 },
  //     "feeTier": 3000
  //   }
  // ]
};

// ── Position math ─────────────────────────────────────────────────────────────

/**
 * Calculate value of a concentrated liquidity position.
 * In V3, a position's value depends on which side of the range the current
 * price falls:
 * - Below range: 100% token0
 * - Above range: 100% token1
 * - In range: mix of both tokens
 */
function calculatePositionValue(position, currentSqrtPrice) {
  const { liquidity, tickLower, tickUpper } = position;
  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);

  let amount0 = 0;
  let amount1 = 0;

  if (currentSqrtPrice <= sqrtPriceLower) {
    // Current price below range — all token0
    amount0 = liquidity * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
  } else if (currentSqrtPrice >= sqrtPriceUpper) {
    // Current price above range — all token1
    amount1 = liquidity * (sqrtPriceUpper - sqrtPriceLower);
  } else {
    // In range — mix of both
    amount0 = liquidity * (1 / currentSqrtPrice - 1 / sqrtPriceUpper);
    amount1 = liquidity * (currentSqrtPrice - sqrtPriceLower);
  }

  return { amount0, amount1 };
}

// ── Adapter interface ─────────────────────────────────────────────────────────

const SushiSwapV3Adapter = {
  protocolId: "sushiswap-v3",
  name: "SushiSwap V3",
  type: "dex",

  isConfigured() {
    return SUSHI_CONFIG.factoryContractId !== null || SUSHI_CONFIG.pools.length > 0;
  },

  /**
   * Get all LP positions for a user across SushiSwap V3 pools.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];

    const positions = [];

    for (const pool of SUSHI_CONFIG.pools) {
      try {
        // Check if user has liquidity in this pool
        const userAddressScVal = new Address(userAddress).toScVal();

        // Query user's position(s) in this pool
        // SushiSwap V3 on Soroban stores positions keyed by (owner, tickLower, tickUpper)
        const positionResult = await simulateContractCall(
          pool.contractId,
          "get_position",
          [userAddressScVal]
        );

        if (!positionResult) continue;

        const positionData = scValToNative(positionResult);

        // If position has zero liquidity, skip
        if (!positionData || !positionData.liquidity || BigInt(positionData.liquidity) === 0n) {
          continue;
        }

        // Get current pool state for price calculation
        const poolState = await simulateContractCall(pool.contractId, "get_pool_state");
        const state = poolState ? scValToNative(poolState) : null;

        let valueToken0 = "0";
        let valueToken1 = "0";

        if (state && state.sqrt_price) {
          const currentSqrtPrice = Number(state.sqrt_price) / 2 ** 96; // Q96 format
          const values = calculatePositionValue(
            {
              liquidity: Number(positionData.liquidity),
              tickLower: positionData.tick_lower,
              tickUpper: positionData.tick_upper,
            },
            currentSqrtPrice
          );
          valueToken0 = formatTokenAmount(
            Math.floor(values.amount0).toString(),
            pool.token0.decimals
          );
          valueToken1 = formatTokenAmount(
            Math.floor(values.amount1).toString(),
            pool.token1.decimals
          );
        }

        // Unclaimed fees
        let unclaimedFees0 = "0";
        let unclaimedFees1 = "0";
        try {
          const feesResult = await simulateContractCall(
            pool.contractId,
            "get_unclaimed_fees",
            [userAddressScVal]
          );
          if (feesResult) {
            const fees = scValToNative(feesResult);
            unclaimedFees0 = formatTokenAmount(
              (fees.amount0 || "0").toString(),
              pool.token0.decimals
            );
            unclaimedFees1 = formatTokenAmount(
              (fees.amount1 || "0").toString(),
              pool.token1.decimals
            );
          }
        } catch (e) {
          // Fees query not supported or failed — non-critical
        }

        positions.push({
          protocol: "sushiswap-v3",
          type: "concentrated_lp",
          poolContractId: pool.contractId,
          feeTier: pool.feeTier,
          token0: pool.token0,
          token1: pool.token1,
          position: {
            liquidity: positionData.liquidity.toString(),
            tickLower: positionData.tick_lower,
            tickUpper: positionData.tick_upper,
            inRange: state
              ? state.tick >= positionData.tick_lower && state.tick < positionData.tick_upper
              : null,
          },
          amounts: {
            token0: valueToken0,
            token1: valueToken1,
          },
          unclaimedFees: {
            token0: unclaimedFees0,
            token1: unclaimedFees1,
          },
          valueUSD: 0, // Enriched by price engine later
        });
      } catch (e) {
        console.error(`SushiV3 position error for pool ${pool.contractId}:`, e.message);
      }
    }

    return positions;
  },

  /**
   * Get all pools from the factory (if factory contract ID is available).
   * Useful for discovery.
   */
  async getPools() {
    if (!SUSHI_CONFIG.factoryContractId) return SUSHI_CONFIG.pools;

    try {
      const result = await simulateContractCall(
        SUSHI_CONFIG.factoryContractId,
        "get_all_pools"
      );
      if (result) return scValToNative(result);
    } catch (e) {
      console.error("SushiV3 pool discovery error:", e.message);
    }

    return SUSHI_CONFIG.pools;
  },
};

module.exports = SushiSwapV3Adapter;
