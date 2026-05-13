# Stellar Moonshot Bank — Technical Architecture Spec

## Overview

Stellar Moonshot Bank is a standalone portfolio tracking protocol for the Stellar network, providing comprehensive visibility into wallet holdings across all asset types: native XLM, trustline tokens, SDEX positions, liquidity pool shares, Soroban DeFi positions, claimable balances, and NFTs.

## System Architecture

### High-Level Data Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Frontend   │────▶│   API Gateway    │────▶│  Horizon API │
│  (React/RN)  │◀────│  (Node.js/Express)│◀────│  (Stellar)   │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │    ▲                    
                           ▼    │                    
                    ┌──────────────────┐     ┌─────────────┐
                    │   Price Engine   │────▶│ Soroban RPC  │
                    │  (Aggregator)    │     └─────────────┘
                    └──────────────────┘              
                           │    ▲                    
                           ▼    │                    
                    ┌──────────────────┐              
                    │    Database      │              
                    │  (PostgreSQL)    │              
                    └──────────────────┘              
```

### Core Components

#### 1. Account Resolver
Fetches full account state from Horizon's `/accounts/{id}` endpoint. Returns:
- Native XLM balance (including reserved/available split)
- All trustlines with balances and limits
- Liquidity pool shares
- Sponsorship info (who's paying reserves)

#### 2. Asset Registry
Maintains a catalog of known Stellar assets with metadata:
- Asset code, issuer, domain (from stellar.toml)
- Logo URLs, descriptions
- Market cap, 24h volume
- Classification (stablecoin, bridge asset, LP token, Soroban token, NFT)

#### 3. Price Engine
Aggregates pricing from multiple sources:
- **SDEX orderbook**: Mid-price from Horizon `/order_book` endpoint
- **Soroban AMMs**: Query pool contracts for reserve ratios
- **External feeds**: CoinGecko/CoinMarketCap for XLM and major assets
- **Fallback logic**: If SDEX liquidity < threshold, use external price; smooth prices with TWAP

#### 4. Soroban Position Tracker
Per-protocol adapters for Soroban DeFi:
- **AMM positions**: Query LP contract for user's share of reserves
- **Lending positions**: Query lending protocol for deposits/borrows
- **Vaults/strategies**: Query vault contracts for underlying value
- Each adapter implements a standard `PositionAdapter` interface

#### 5. Transaction History Engine
Processes operations and effects from Horizon:
- `/accounts/{id}/operations` with cursor-based pagination
- Decodes operation types (payments, path payments, manage offers, LP deposits/withdrawals)
- Groups related operations into logical "transactions"
- Soroban contract invocations decoded via XDR

#### 6. Claimable Balance Tracker
Monitors `/claimable_balances` for the user's account:
- Pending airdrops and rewards
- Time-locked balances with unlock schedules
- Displays claimable vs. not-yet-claimable status

## Tech Stack

### Backend
- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js or Fastify
- **Stellar SDK**: `@stellar/stellar-sdk` (Horizon + Soroban RPC)
- **Database**: PostgreSQL (asset registry, price history, cached positions)
- **Cache**: Redis (hot account data, rate limit management)
- **Job Queue**: Bull/BullMQ (background price updates, position sync)

### Frontend
- **Web**: React 18+ with TypeScript, Vite
- **Mobile**: React Native (shared component library)
- **State**: Zustand or TanStack Query
- **Charts**: Recharts or D3
- **Wallet Connect**: Freighter SDK, WalletConnect

### Infrastructure
- **Hosting**: Vercel (web) + Railway/Fly.io (API)
- **Monitoring**: Sentry, Prometheus + Grafana
- **CI/CD**: GitHub Actions

## API Design

### REST Endpoints

```
GET  /api/v1/account/:address          → Full portfolio summary
GET  /api/v1/account/:address/balances → Token balances with prices
GET  /api/v1/account/:address/defi     → Soroban DeFi positions
GET  /api/v1/account/:address/lp       → Liquidity pool positions
GET  /api/v1/account/:address/history  → Transaction history
GET  /api/v1/account/:address/claimable → Claimable balances
GET  /api/v1/account/:address/nfts     → NFT holdings
GET  /api/v1/prices/:asset_code/:issuer → Current + historical price
GET  /api/v1/assets/search?q=          → Asset search/discovery
```

### WebSocket
```
ws://api/v1/stream/:address → Real-time balance updates via Horizon SSE
```

## Data Models

### Portfolio Summary
```typescript
interface PortfolioSummary {
  address: string;
  totalValueUSD: number;
  change24h: { amount: number; percent: number };
  breakdown: {
    native: { xlm: number; usd: number };
    tokens: TokenBalance[];
    lpPositions: LPPosition[];
    defiPositions: DefiPosition[];
    claimableBalances: ClaimableBalance[];
    nfts: NFTHolding[];
  };
  lastUpdated: string;
}

interface TokenBalance {
  asset: { code: string; issuer: string; domain?: string; logo?: string };
  balance: string;
  valueUSD: number;
  price: { usd: number; change24h: number };
  trustline: { limit: string; authorized: boolean };
}

interface LPPosition {
  poolId: string;
  assets: [AssetInfo, AssetInfo];
  shares: string;
  reserves: [string, string];
  valueUSD: number;
  feesEarned24h: number;
}

interface DefiPosition {
  protocol: string;
  type: 'lending' | 'borrowing' | 'staking' | 'vault';
  contractId: string;
  assets: AssetInfo[];
  deposited: string;
  valueUSD: number;
  apy?: number;
}
```

## Pricing Strategy

### Price Resolution Order
1. Check Redis cache (TTL: 30s for major assets, 60s for others)
2. Query SDEX orderbook — use mid-price if spread < 5% and depth > $1000
3. Query Soroban AMM pools for Soroban-native tokens
4. Fall back to external API (CoinGecko) for XLM and bridged assets
5. For exotic assets with no liquidity: mark as "unpriced" in UI

### Anti-Manipulation
- Reject prices where SDEX spread > 10%
- Use 5-minute TWAP for portfolio valuation (not spot)
- Flag assets with < $100 in orderbook depth

## Soroban Integration

### Adapter Interface
```typescript
interface ProtocolAdapter {
  protocolId: string;
  name: string;
  contractIds: string[];
  
  getPositions(address: string): Promise<DefiPosition[]>;
  getHistoricalValue(address: string, from: Date, to: Date): Promise<ValuePoint[]>;
  getTVL(): Promise<number>;
}
```

### Known Protocols to Support (initial)
- Blend (lending/borrowing)
- Soroswap (AMM)
- Phoenix (DEX aggregator)
- Aquarius (liquidity rewards)
- Custom LP contracts

## Security Considerations

- **Read-only by design**: Never request secret keys; only public addresses
- **Rate limiting**: Per-IP and per-address limits on API
- **Input validation**: Stellar address format validation (G... or M... for muxed)
- **CORS**: Restrict to known frontend origins in production
- **No PII storage**: Only public blockchain data

## MVP Scope

### Phase 1 (4-6 weeks)
- Account lookup by public key
- XLM + trustline token balances with USD values
- SDEX LP positions
- Basic transaction history
- Price data from SDEX + CoinGecko
- Web dashboard

### Phase 2 (4-6 weeks)
- Soroban DeFi position tracking (Blend, Soroswap)
- Claimable balance monitoring
- Portfolio history charts
- Multi-wallet support
- Freighter wallet connect

### Phase 3 (4-6 weeks)
- NFT gallery
- Mobile app (React Native)
- Push notifications (large balance changes)
- Protocol-level analytics (TVL, user counts)
- Public API for third-party integrations
