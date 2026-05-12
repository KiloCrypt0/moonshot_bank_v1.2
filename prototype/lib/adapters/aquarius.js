/**
 * Aquarius (AQUA) Adapter for Stellar/Soroban
 *
 * Aquarius is Stellar's DeFi hub — an AMM + liquidity incentive layer.
 * Users can:
 *   - Provide liquidity to AMM pools (constant product xy=k and stableswap)
 *   - Earn AQUA rewards on incentivized pools via reward gauges
 *   - Vote with AQUA/ICE tokens to direct liquidity incentives
 *
 * Contract architecture (from AquaToken/soroban-amm):
 *   liquidity_pool_router  — entry point / catalogue of all pools
 *   liquidity_pool         — constant product pool (xy=k)
 *   liquidity_pool_stableswap — optimized for correlated assets
 *   rewards / rewards_gauge — AQUA reward distribution to LPs
 *   token_share            — LP share token (SEP-0041)
 *
 * This adapter tracks:
 * 1. LP positions across Aquarius AMM pools
 * 2. Pending AQUA rewards from reward gauges
 * 3. AQUA/ICE voting locks
 *
 * Reference: https://github.com/AquaToken/soroban-amm
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
const { Address, scValToNative } = StellarSdk;

// ── Configuration ─────────────────────────────────────────────────────────────

const AQUA_CONFIG = {
  // Aquarius AMM router contract (entry point for all pools)
  routerContractId: process.env.AQUA_ROUTER_CONTRACT_ID || null,

  // Known Aquarius AMM pool contracts to track
  // Each pool: { contractId, type, tokens: [{ symbol, contractId, decimals }] }
  pools: JSON.parse(process.env.AQUA_POOLS || "[]"),
  // Example:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "type": "constant_product",
  //     "tokens": [
  //       { "symbol": "XLM", "contractId": "C...", "decimals": 7 },
  //       { "symbol": "USDC", "contractId": "C...", "decimals": 7 }
  //     ],
  //     "rewardGauge": "CDEF..."
  //   }
  // ]

  // AQUA token contract ID (for reward tracking)
  aquaTokenContractId: process.env.AQUA_TOKEN_CONTRACT_ID || null,

  // ICE token contract ID (governance lock token)
  iceTokenContractId: process.env.ICE_TOKEN_CONTRACT_ID || null,

  // AQUA voting/locking contract
  votingContractId: process.env.AQUA_VOTING_CONTRACT_ID || null,

  // Token decimals
  aquaDecimals: 7,
};

// ── LP Position Tracking ─────────────────────────────────────────────────────

/**
 * Get user's LP positions across all configured Aquarius pools.
 */
async function getAquaLPPositions(userAddress) {
  const positions = [];

  for (const pool of AQUA_CONFIG.pools) {
    try {
      // Get user's LP share balance
      const userBalance = await getLPBalance(pool.contractId, userAddress);
      if (!userBalance || BigInt(userBalance) === 0n) continue;

      // Get pool total supply and reserves
      const totalSupply = await getLPTotalSupply(pool.contractId);
      const reserves = await getPoolReserves(pool.contractId);

      let shareOfPool = 0;
      const tokenAmounts = [];

      if (totalSupply && BigInt(totalSupply) > 0n && reserves) {
        shareOfPool = Number(BigInt(userBalance)) / Number(BigInt(totalSupply));

        // Calculate user's share of each reserve
        if (Array.isArray(reserves)) {
          for (let i = 0; i < reserves.length; i++) {
            const token = pool.tokens?.[i] || { symbol: `Token${i}`, decimals: 7 };
            const userAmount = Math.floor(Number(reserves[i]) * shareOfPool);
            tokenAmounts.push({
              symbol: token.symbol,
              amount: formatTokenAmount(userAmount.toString(), token.decimals),
              raw: userAmount,
            });
          }
        }
      }

      const position = {
        protocol: "aquarius",
        type: "lp",
        subtype: pool.type || "constant_product",
        poolContractId: pool.contractId,
        tokens: pool.tokens || [],
        lpBalance: userBalance,
        shareOfPool,
        amounts: tokenAmounts,
        valueUSD: 0, // Enriched by caller
      };

      // Check for pending AQUA rewards on this pool's gauge
      if (pool.rewardGauge) {
        try {
          const rewards = await getPendingRewards(pool.rewardGauge, userAddress);
          if (rewards) {
            position.pendingRewards = rewards;
          }
        } catch (e) {
          // Reward query may fail — non-critical
        }
      }

      positions.push(position);
    } catch (e) {
      console.error(`[Aquarius] LP position error for ${pool.contractId}:`, e.message);
    }
  }

  return positions;
}

// ── Reward Tracking ──────────────────────────────────────────────────────────

/**
 * Get pending AQUA rewards for a user from a reward gauge.
 */
async function getPendingRewards(gaugeContractId, userAddress) {
  try {
    const userScVal = new Address(userAddress).toScVal();

    // Try common reward query methods
    let result = null;
    for (const method of ["get_user_reward", "get_rewards", "claimable"]) {
      try {
        result = await simulateContractCall(gaugeContractId, method, [userScVal]);
        if (result) break;
      } catch (e) {
        continue;
      }
    }

    if (!result) return null;

    const rewardAmount = scValToNative(result);
    if (!rewardAmount || BigInt(rewardAmount) === 0n) return null;

    return {
      amount: formatTokenAmount(rewardAmount.toString(), AQUA_CONFIG.aquaDecimals),
      raw: rewardAmount.toString(),
      asset: "AQUA",
    };
  } catch (e) {
    return null;
  }
}

// ── Voting / Lock Tracking ───────────────────────────────────────────────────

/**
 * Get user's AQUA/ICE voting locks.
 */
async function getVotingPosition(userAddress) {
  if (!AQUA_CONFIG.votingContractId) return null;

  try {
    const userScVal = new Address(userAddress).toScVal();

    const result = await simulateContractCall(
      AQUA_CONFIG.votingContractId,
      "get_user_lock",
      [userScVal]
    );

    if (!result) return null;

    const lock = scValToNative(result);
    if (!lock || BigInt(lock.amount || 0) === 0n) return null;

    return {
      protocol: "aquarius",
      type: "staking",
      subtype: "voting_lock",
      contractId: AQUA_CONFIG.votingContractId,
      staked: {
        amount: formatTokenAmount(lock.amount.toString(), AQUA_CONFIG.aquaDecimals),
        asset: "AQUA",
      },
      lockEnd: lock.unlock_time || lock.end || null,
      votingPower: lock.voting_power
        ? formatTokenAmount(lock.voting_power.toString(), AQUA_CONFIG.aquaDecimals)
        : null,
      valueUSD: 0,
    };
  } catch (e) {
    console.error(`[Aquarius] Voting position error:`, e.message);
    return null;
  }
}

/**
 * Get user's raw AQUA and ICE token balances (informational).
 */
async function getAquaTokenBalances(userAddress) {
  const balances = {};

  if (AQUA_CONFIG.aquaTokenContractId) {
    try {
      const bal = await getTokenBalance(AQUA_CONFIG.aquaTokenContractId, userAddress);
      if (BigInt(bal) > 0n) {
        balances.aqua = formatTokenAmount(bal, AQUA_CONFIG.aquaDecimals);
      }
    } catch (e) {}
  }

  if (AQUA_CONFIG.iceTokenContractId) {
    try {
      const bal = await getTokenBalance(AQUA_CONFIG.iceTokenContractId, userAddress);
      if (BigInt(bal) > 0n) {
        balances.ice = formatTokenAmount(bal, AQUA_CONFIG.aquaDecimals);
      }
    } catch (e) {}
  }

  return Object.keys(balances).length > 0 ? balances : null;
}

// ── Adapter Interface ────────────────────────────────────────────────────────

const AquariusAdapter = {
  protocolId: "aquarius",
  name: "Aquarius",
  type: "amm",

  isConfigured() {
    return (
      AQUA_CONFIG.pools.length > 0 ||
      AQUA_CONFIG.routerContractId !== null ||
      AQUA_CONFIG.votingContractId !== null
    );
  },

  /**
   * Get all Aquarius positions for a user.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];

    const [lps, voting] = await Promise.allSettled([
      getAquaLPPositions(userAddress),
      getVotingPosition(userAddress),
    ]);

    const positions = [];

    if (lps.status === "fulfilled" && lps.value) {
      positions.push(...lps.value);
    }

    if (voting.status === "fulfilled" && voting.value) {
      positions.push(voting.value);
    }

    return positions;
  },
};

module.exports = AquariusAdapter;
