/**
 * Solv Protocol Adapter for Stellar/Soroban
 *
 * Solv Protocol on Stellar enables:
 * - Bridging SolvBTC to Stellar via Axelar
 * - USDC yield vaults backed by BTC strategies (4-6% APY)
 * - SolvBTC LP positions on Stellar DEXs
 *
 * This adapter tracks:
 * 1. SolvBTC token balance (via token-resolver, but also LP positions)
 * 2. Vault deposits (USDC deposited into Solv's yield strategies)
 * 3. Pending yield / claimable rewards
 */
const {
  simulateContractCall,
  getTokenBalance,
  formatTokenAmount,
  getLPBalance,
  getLPTotalSupply,
  getPoolReserves,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative } = StellarSdk;

// ── Configuration ─────────────────────────────────────────────────────────────

const SOLV_CONFIG = {
  // Solv vault contract for USDC yield strategies
  vaultContractId: process.env.SOLV_VAULT_CONTRACT_ID || null,

  // SolvBTC-paired LP pools to track
  // These are Soroban AMM pools where one side is SolvBTC
  lpPools: JSON.parse(process.env.SOLV_LP_POOLS || "[]"),
  // Example:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "dex": "sushiswap-v3",
  //     "token0": { "symbol": "SolvBTC", "contractId": "C...", "decimals": 8 },
  //     "token1": { "symbol": "USDC", "contractId": "C...", "decimals": 7 }
  //   }
  // ]

  // SolvBTC staking / Babylon staking contract
  stakingContractId: process.env.SOLV_STAKING_CONTRACT_ID || null,

  // Token decimals
  solvBtcDecimals: 8,
  usdcDecimals: 7,
};

// ── Vault position tracking ───────────────────────────────────────────────────

/**
 * Get a user's deposit in Solv's USDC yield vault.
 * Returns the deposited amount, accrued yield, and current APY.
 */
async function getVaultPosition(userAddress) {
  if (!SOLV_CONFIG.vaultContractId) return null;

  try {
    const userScVal = new Address(userAddress).toScVal();

    // Query user's vault deposit
    const depositResult = await simulateContractCall(
      SOLV_CONFIG.vaultContractId,
      "get_deposit",
      [userScVal]
    );

    if (!depositResult) return null;

    const deposit = scValToNative(depositResult);
    if (!deposit || BigInt(deposit.amount || 0) === 0n) return null;

    // Query accrued yield
    let accruedYield = "0";
    try {
      const yieldResult = await simulateContractCall(
        SOLV_CONFIG.vaultContractId,
        "get_accrued_yield",
        [userScVal]
      );
      if (yieldResult) {
        accruedYield = scValToNative(yieldResult).toString();
      }
    } catch (e) {
      // Yield query may not be available
    }

    // Query vault APY
    let apy = null;
    try {
      const apyResult = await simulateContractCall(
        SOLV_CONFIG.vaultContractId,
        "get_apy"
      );
      if (apyResult) {
        apy = Number(scValToNative(apyResult)) / 100; // Basis points to percentage
      }
    } catch (e) {
      apy = 5.0; // Fallback to advertised ~4-6%
    }

    return {
      protocol: "solv-protocol",
      type: "vault",
      contractId: SOLV_CONFIG.vaultContractId,
      deposited: {
        amount: formatTokenAmount(deposit.amount.toString(), SOLV_CONFIG.usdcDecimals),
        asset: "USDC",
      },
      yield: {
        accrued: formatTokenAmount(accruedYield, SOLV_CONFIG.usdcDecimals),
        asset: "USDC",
        apy: apy,
      },
      depositTimestamp: deposit.timestamp || null,
      valueUSD: 0, // Enriched later — deposit + yield in USDC ≈ USD
    };
  } catch (e) {
    console.error(`Solv vault position error:`, e.message);
    return null;
  }
}

// ── Staking position tracking ─────────────────────────────────────────────────

/**
 * Get a user's SolvBTC staking position (e.g., Babylon staking).
 */
async function getStakingPosition(userAddress) {
  if (!SOLV_CONFIG.stakingContractId) return null;

  try {
    const userScVal = new Address(userAddress).toScVal();

    const stakeResult = await simulateContractCall(
      SOLV_CONFIG.stakingContractId,
      "get_stake",
      [userScVal]
    );

    if (!stakeResult) return null;

    const stake = scValToNative(stakeResult);
    if (!stake || BigInt(stake.amount || 0) === 0n) return null;

    // Query staking rewards
    let rewards = "0";
    try {
      const rewardsResult = await simulateContractCall(
        SOLV_CONFIG.stakingContractId,
        "get_rewards",
        [userScVal]
      );
      if (rewardsResult) {
        rewards = scValToNative(rewardsResult).toString();
      }
    } catch (e) {}

    return {
      protocol: "solv-protocol",
      type: "staking",
      contractId: SOLV_CONFIG.stakingContractId,
      staked: {
        amount: formatTokenAmount(stake.amount.toString(), SOLV_CONFIG.solvBtcDecimals),
        asset: "SolvBTC",
      },
      rewards: {
        amount: formatTokenAmount(rewards, SOLV_CONFIG.solvBtcDecimals),
        asset: "SolvBTC",
      },
      lockUntil: stake.lock_until || null,
      valueUSD: 0, // Enriched later
    };
  } catch (e) {
    console.error(`Solv staking position error:`, e.message);
    return null;
  }
}

// ── LP position tracking ──────────────────────────────────────────────────────

/**
 * Get user's LP positions in SolvBTC-paired pools.
 */
async function getSolvLPPositions(userAddress) {
  const positions = [];

  for (const pool of SOLV_CONFIG.lpPools) {
    try {
      const userBalance = await getLPBalance(pool.contractId, userAddress);
      if (BigInt(userBalance) === 0n) continue;

      const totalSupply = await getLPTotalSupply(pool.contractId);
      const reserves = await getPoolReserves(pool.contractId);

      let shareOfPool = 0;
      let reserveToken0 = "0";
      let reserveToken1 = "0";

      if (totalSupply && BigInt(totalSupply) > 0n && reserves) {
        shareOfPool = Number(BigInt(userBalance)) / Number(BigInt(totalSupply));
        // Calculate user's share of each reserve
        if (Array.isArray(reserves)) {
          reserveToken0 = formatTokenAmount(
            Math.floor(Number(reserves[0]) * shareOfPool).toString(),
            pool.token0.decimals
          );
          reserveToken1 = formatTokenAmount(
            Math.floor(Number(reserves[1]) * shareOfPool).toString(),
            pool.token1.decimals
          );
        }
      }

      positions.push({
        protocol: "solv-protocol",
        type: "lp",
        dex: pool.dex,
        poolContractId: pool.contractId,
        token0: pool.token0,
        token1: pool.token1,
        lpBalance: userBalance,
        shareOfPool,
        amounts: {
          token0: reserveToken0,
          token1: reserveToken1,
        },
        valueUSD: 0, // Enriched later
      });
    } catch (e) {
      console.error(`Solv LP position error for ${pool.contractId}:`, e.message);
    }
  }

  return positions;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

const SolvProtocolAdapter = {
  protocolId: "solv-protocol",
  name: "Solv Protocol",
  type: "yield",

  isConfigured() {
    return (
      SOLV_CONFIG.vaultContractId !== null ||
      SOLV_CONFIG.stakingContractId !== null ||
      SOLV_CONFIG.lpPools.length > 0
    );
  },

  /**
   * Get all Solv Protocol positions for a user.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];

    const [vault, staking, lps] = await Promise.allSettled([
      getVaultPosition(userAddress),
      getStakingPosition(userAddress),
      getSolvLPPositions(userAddress),
    ]);

    const positions = [];

    if (vault.status === "fulfilled" && vault.value) {
      // USDC vault deposit ≈ USD value
      vault.value.valueUSD =
        parseFloat(vault.value.deposited.amount) +
        parseFloat(vault.value.yield.accrued);
      positions.push(vault.value);
    }

    if (staking.status === "fulfilled" && staking.value) {
      positions.push(staking.value);
    }

    if (lps.status === "fulfilled" && lps.value) {
      positions.push(...lps.value);
    }

    return positions;
  },
};

module.exports = SolvProtocolAdapter;
