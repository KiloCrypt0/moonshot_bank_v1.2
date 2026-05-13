/**
 * The 15 tracked assets used to build the Portfolio Whale candidate pool.
 *
 * For each asset we fetch top holders from Stellar Expert, union those wallets,
 * then score each wallet's full portfolio (classic via Horizon + Soroban via SE
 * holder data) to produce the leaderboard.
 *
 * priceHintUSD: used for Soroban tokens that aren't on the SDEX.
 *   null = try SDEX pricing (classic) or skip if unavailable.
 *   "btc" = fetch live BTC price from CoinGecko and multiply.
 * minTokenBalance: minimum whole-token units to include a holder (dust filter).
 * decimals: divisor exponent (10^n) to convert raw SE balance to token units.
 */
module.exports = [
  // ── Soroban tokens ────────────────────────────────────────────────────────
  {
    symbol: "SOLVBTC",
    name: "SolvBTC",
    kind: "soroban",
    contractId: "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN",
    decimals: 8,          // Bitcoin-denominated
    minTokenBalance: 0.001,
    priceHintUSD: "btc",  // live BTC price from CoinGecko
  },
  {
    symbol: "XSOLVBTC",
    name: "SolvBTC.BBN",
    kind: "soroban",
    contractId: "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J",
    decimals: 8,
    minTokenBalance: 0.001,
    priceHintUSD: "btc",
  },
  {
    symbol: "USDC",
    name: "USDC (Soroban SAC)",
    kind: "soroban",
    contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    decimals: 7,
    minTokenBalance: 10000,
    priceHintUSD: 1.0,
  },
  {
    symbol: "PYUSD",
    name: "PYUSD (Soroban)",
    kind: "soroban",
    contractId: "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2",
    decimals: 7,
    minTokenBalance: 10000,
    priceHintUSD: 1.0,
  },
  {
    symbol: "EUTBL",
    name: "EUTBL (Spiko EU T-bills)",
    kind: "soroban",
    contractId: "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF",
    decimals: 7,
    minTokenBalance: 1,
    priceHintUSD: 1.08,   // EUR-denominated, approximate USD
  },
  {
    symbol: "UKTBL",
    name: "UKTBL (Spiko UK T-bills)",
    kind: "soroban",
    contractId: "CDT3KU6TQZNOHKNOHNAFFDQZDURVC3MSTL4ML7TUTZGNOPBZCLABP4FR",
    decimals: 7,
    minTokenBalance: 1,
    priceHintUSD: 1.27,   // GBP-denominated, approximate USD
  },
  {
    symbol: "EURAU",
    name: "EURAU (AllUnity EUR)",
    kind: "soroban",
    contractId: "CB44W727WSLHPXJ47A6DHF5D34RKWSOZAMEDXO3CF5TEEEQ2ZX4V3VRI",
    decimals: 7,
    minTokenBalance: 10000,
    priceHintUSD: 1.08,
  },
  {
    symbol: "EURCV",
    name: "EURCV (SG Forge)",
    kind: "soroban",
    contractId: "CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH",
    decimals: 7,
    minTokenBalance: 10000,
    priceHintUSD: 1.08,
  },

  // ── Classic assets (code + full issuer) ───────────────────────────────────
  // priceHintUSD on classic assets is a fallback if SDEX + CoinGecko both fail.
  // These are approximate; the scorer tries CoinGecko first via pricingEngine.
  {
    symbol: "EURC",
    name: "EURC (Circle)",
    kind: "classic",
    code: "EURC",
    issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "euro-coin",
    priceHintUSD: 1.09,
  },
  {
    symbol: "BLND",
    name: "BLND (Blend Protocol)",
    kind: "classic",
    code: "BLND",
    issuer: "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "blend",
    priceHintUSD: null,   // volatile — use CoinGecko only
  },
  {
    symbol: "AQUA",
    name: "AQUA (Aquarius)",
    kind: "classic",
    code: "AQUA",
    issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "aquarius",
    priceHintUSD: null,
  },
  {
    symbol: "YBX",
    name: "YBX (YieldBlox)",
    kind: "classic",
    code: "YBX",
    issuer: "GBUYYBXWCLT2MOSSHRFCKMEDFOVSCAXNIEW424GLN666OEXHAAWBDYMX",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "yieldblox",
    priceHintUSD: null,
  },
  {
    symbol: "SHX",
    name: "SHX (Stronghold)",
    kind: "classic",
    code: "SHX",
    issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "stronghold-token",
    priceHintUSD: null,
  },
  {
    symbol: "CETES",
    name: "CETES (Etherfuse Mexican T-bills)",
    kind: "classic",
    code: "CETES",
    issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "cetes",
    priceHintUSD: 0.055,  // ~1 MXN per CETES unit, ~0.055 USD
  },
  {
    symbol: "USDY",
    name: "USDY (Ondo)",
    kind: "classic",
    code: "USDY",
    issuer: "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "ondo-us-dollar-yield",
    priceHintUSD: 1.10,
  },
  {
    symbol: "BENJI",
    name: "BENJI (Franklin Templeton)",
    kind: "classic",
    code: "BENJI",
    issuer: "GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5",
    decimals: 7,
    minTokenBalance: 10000,
    coingeckoId: "franklin-templeton-benji",
    priceHintUSD: 1.00,
  },
];
