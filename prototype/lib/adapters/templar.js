/**
 * Templar Finance Adapter for Stellar/Soroban
 *
 * Templar is a chain-agnostic overcollateralized lending DeFi protocol.
 * It uses isolated "market" contracts, each representing a single
 * COLLATERAL → BORROW asset pair.
 *
 * Architecture (from Templar-Protocol/contracts):
 *   registry — deploys and manages market contracts
 *   market   — single collateral→borrow pair with isolated risk
 *   client/vault — client-side vault interaction helpers
 *
 * This adapter tracks:
 * 1. Collateral deposits per market
 * 2. Borrow positions per market
 * 3. Health factor / liquidation risk
 *
 * Reference: https://github.com/Templar-Protocol/contracts
 */
const {
  simulateContractCall,
  getTokenMetadata,
  formatTokenAmount,
} = require("../soroban-rpc");
const StellarSdk = require("@stellar/stellar-sdk");
const { Address, scValToNative } = StellarSdk;

// ── Configuration ─────────────────────────────────────────────────────────────

const TEMPLAR_CONFIG = {
  // Templar registry contract (manages all markets)
  registryContractId: process.env.TEMPLAR_REGISTRY_CONTRACT_ID || null,

  // Known Templar market contracts
  // Each market is a single collateral→borrow pair
  markets: JSON.parse(process.env.TEMPLAR_MARKETS || "[]"),
  // Example:
  // [
  //   {
  //     "contractId": "CABC...",
  //     "name": "XLM → USDC",
  //     "collateral": { "symbol": "XLM", "contractId": "C...", "decimals": 7 },
  //     "borrow": { "symbol": "USDC", "contractId": "C...", "decimals": 7 }
  //   }
  // ]
};

// ── Contract Queries ─────────────────────────────────────────────────────────

/**
 * Get user's position in a Templar market.
 * Templar markets typically expose a get_position or get_user_position function
 * returning collateral deposited and amount borrowed.
 */
async function getMarketPosition(marketContractId, userAddress) {
  const userScVal = new Address(userAddress).toScVal();

  // Try known function names for position queries
  const methods = ["get_position", "get_user_position", "position"];
  let result = null;

  for (const method of methods) {
    try {
      result = await simulateContractCall(marketContractId, method, [userScVal]);
      if (result) break;
    } catch (e) {
      continue;
    }
  }

  if (!result) return null;

  const position = scValToNative(result);
  return position;
}

/**
 * Get market configuration (collateral/borrow assets, rates, etc.)
 */
async function getMarketConfig(marketContractId) {
  try {
    // Try common config getter names
    for (const method of ["get_config", "config", "get_market_info"]) {
      try {
        const result = await simulateContractCall(marketContractId, method);
        if (result) return scValToNative(result);
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (e) {
    console.error(`[Templar] get_config error:`, e.message);
    return null;
  }
}

/**
 * Get health factor for a user's position (if available).
 */
async function getHealthFactor(marketContractId, userAddress) {
  try {
    const userScVal = new Address(userAddress).toScVal();

    for (const method of ["get_health_factor", "health_factor", "get_health"]) {
      try {
        const result = await simulateContractCall(marketContractId, method, [userScVal]);
        if (result) {
          const val = scValToNative(result);
          // Health factor is typically a fixed-point number
          // > 1.0 means healthy, < 1.0 means at risk of liquidation
          return typeof val === "object" ? Number(val) / 1e7 : Number(val);
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── Position Resolution ──────────────────────────────────────────────────────

/**
 * Resolve all Templar positions for a user across configured markets.
 */
async function resolveUserPositions(userAddress) {
  const positions = [];

  for (const market of TEMPLAR_CONFIG.markets) {
    try {
      const rawPosition = await getMarketPosition(market.contractId, userAddress);
      if (!rawPosition) continue;

      // Parse the position — Templar positions typically contain:
      // { collateral_amount, borrow_amount } or similar fields
      const collateralAmount = rawPosition.collateral_amount
        || rawPosition.collateral
        || rawPosition.deposited
        || 0;

      const borrowAmount = rawPosition.borrow_amount
        || rawPosition.borrowed
        || rawPosition.debt
        || 0;

      // Skip if no meaningful position
      if (BigInt(collateralAmount || 0) === 0n && BigInt(borrowAmount || 0) === 0n) {
        continue;
      }

      const collateralInfo = market.collateral || { symbol: "???", decimals: 7 };
      const borrowInfo = market.borrow || { symbol: "???", decimals: 7 };

      // Get health factor
      const healthFactor = await getHealthFactor(market.contractId, userAddress);

      // Add collateral position
      if (BigInt(collateralAmount || 0) > 0n) {
        positions.push({
          protocol: "templar",
          type: "lending",
          subtype: "collateral",
          marketContractId: market.contractId,
          marketName: market.name || `${collateralInfo.symbol} → ${borrowInfo.symbol}`,
          asset: collateralInfo.symbol,
          assetContractId: collateralInfo.contractId,
          decimals: collateralInfo.decimals,
          underlyingAmount: Number(formatTokenAmount(
            collateralAmount.toString(),
            collateralInfo.decimals
          )),
          healthFactor,
          valueUSD: 0, // Enriched by caller
        });
      }

      // Add borrow position (debt)
      if (BigInt(borrowAmount || 0) > 0n) {
        positions.push({
          protocol: "templar",
          type: "borrowing",
          subtype: "debt",
          marketContractId: market.contractId,
          marketName: market.name || `${collateralInfo.symbol} → ${borrowInfo.symbol}`,
          asset: borrowInfo.symbol,
          assetContractId: borrowInfo.contractId,
          decimals: borrowInfo.decimals,
          underlyingAmount: Number(formatTokenAmount(
            borrowAmount.toString(),
            borrowInfo.decimals
          )),
          healthFactor,
          valueUSD: 0, // Negative — this is debt
        });
      }
    } catch (e) {
      console.error(`[Templar] Error resolving market ${market.contractId}:`, e.message);
    }
  }

  return positions;
}

// ── Registry Discovery (optional) ────────────────────────────────────────────

/**
 * Try to discover markets from the registry contract.
 * This is a nice-to-have — falls back to configured markets if registry fails.
 */
async function discoverMarketsFromRegistry() {
  if (!TEMPLAR_CONFIG.registryContractId) return [];

  try {
    for (const method of ["get_markets", "list_markets", "markets"]) {
      try {
        const result = await simulateContractCall(
          TEMPLAR_CONFIG.registryContractId,
          method
        );
        if (result) {
          const markets = scValToNative(result);
          return Array.isArray(markets) ? markets : [];
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.error(`[Templar] Registry discovery error:`, e.message);
  }

  return [];
}

// ── Adapter Interface ────────────────────────────────────────────────────────

const TemplarAdapter = {
  protocolId: "templar",
  name: "Templar Finance",
  type: "lending",

  isConfigured() {
    return (
      TEMPLAR_CONFIG.markets.length > 0 ||
      TEMPLAR_CONFIG.registryContractId !== null
    );
  },

  /**
   * Get all Templar Finance positions for a user.
   */
  async getPositions(userAddress) {
    if (!this.isConfigured()) return [];
    return resolveUserPositions(userAddress);
  },
};

module.exports = TemplarAdapter;
