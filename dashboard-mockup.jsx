import { useState } from "react";

const MOCK_DATA = {
  address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  totalValueUSD: 47823.45,
  xlmPrice: { usd: 0.1741, change24h: 5.58 },
  balances: [
    { type: "native", asset: { code: "XLM" }, balance: "185420.00", available: "185218.50", reserved: "201.50", valueUSD: 32279.42, price: { usd: 0.1741, change24h: 5.58 } },
    { type: "token", asset: { code: "USDC", issuer: "GA5ZS...KZVN" }, balance: "12500.00", valueUSD: 12500.00, price: { usd: 1.00, change24h: 0.01 }, trustline: { limit: "922337203685.4775807", authorized: true } },
    { type: "token", asset: { code: "yXLM", issuer: "GARD...W7EY" }, balance: "15000.00", valueUSD: 2612.10, price: { usd: 0.1741, change24h: 5.20 }, trustline: { limit: "922337203685.4775807", authorized: true } },
    { type: "token", asset: { code: "AQUA", issuer: "GBNZ...IRTH" }, balance: "245000.00", valueUSD: 431.95, price: { usd: 0.00176, change24h: -2.3 }, trustline: { limit: "922337203685.4775807", authorized: true } },
    { type: "token", asset: { code: "SHX", issuer: "GDST...QUFK" }, balance: "500000.00", valueUSD: 0, price: null, trustline: { limit: "922337203685.4775807", authorized: true } },
    { type: "lp_share", poolId: "abc123", shares: "1250.00", valueUSD: 0 },
  ],
  history: [
    { type: "payment", createdAt: "2026-04-17T10:30:00Z", from: "GBXF...YY4R", to: "GA5Z...KZVN", amount: "1500.00", assetCode: "USDC" },
    { type: "path_payment_strict_receive", createdAt: "2026-04-16T22:15:00Z", from: "GA5Z...KZVN", to: "GA5Z...KZVN", amount: "10000.00", assetCode: "XLM", sourceAmount: "1741.00", sourceAssetCode: "USDC" },
    { type: "change_trust", createdAt: "2026-04-15T08:00:00Z", assetCode: "AQUA", limit: "922337203685.4775807" },
    { type: "manage_sell_offer", createdAt: "2026-04-14T16:45:00Z", sellingAsset: "XLM", buyingAsset: "USDC", amount: "5000", price: "0.1720" },
  ],
  claimable: [
    { asset: { code: "AQUA" }, amount: "5000.00", sponsor: "GBNZ...IRTH" },
    { asset: { code: "XLM" }, amount: "100.00", sponsor: "GCNY...QR4P" },
  ],
};

const fmt = (n, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const fmtUSD = (n) => n >= 1e6 ? "$" + fmt(n / 1e6) + "M" : n >= 1e3 ? "$" + fmt(n / 1e3) + "K" : "$" + fmt(n);
const shorten = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "";

const colors = { XLM: "#4c6ef5", USDC: "#2775ca", yXLM: "#8b5cf6", AQUA: "#06b6d4", SHX: "#f97316" };

function TokenIcon({ code, type }) {
  const bg = colors[code] || (type === "lp_share" ? "#22c55e" : "#334155");
  return (
    <div style={{ width: 40, height: 40, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: "#fff", flexShrink: 0 }}>
      {code ? code.slice(0, 2) : "LP"}
    </div>
  );
}

function StatCard({ label, value, sub, subColor }) {
  return (
    <div style={{ background: "#1a2332", border: "1px solid #2a3a4e", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: subColor || "#64748b", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function StellarDeBank() {
  const [tab, setTab] = useState("tokens");
  const [address, setAddress] = useState(MOCK_DATA.address);
  const [loaded, setLoaded] = useState(true);
  const d = MOCK_DATA;

  const tokens = d.balances.filter((b) => b.type === "native" || b.type === "token");
  const lpCount = d.balances.filter((b) => b.type === "lp_share").length;
  const pricedTokens = tokens.filter((b) => b.valueUSD > 0);

  return (
    <div style={{ background: "#0a0e17", color: "#e2e8f0", minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ background: "#111827", borderBottom: "1px solid #2a3a4e", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 22, fontWeight: 700 }}>
          <div style={{ width: 36, height: 36, background: "linear-gradient(135deg, #4c6ef5, #a855f7)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>S</div>
          Stellar DeBank
        </div>
        <div style={{ flex: 1, maxWidth: 560, margin: "0 32px", display: "flex", gap: 8 }}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Enter Stellar address (G...)"
            style={{ flex: 1, background: "#0a0e17", border: "1px solid #2a3a4e", borderRadius: 12, padding: "10px 16px", color: "#e2e8f0", fontSize: 13, outline: "none", fontFamily: "monospace" }}
          />
          <button style={{ background: "#6366f1", color: "#fff", border: "none", borderRadius: 12, padding: "10px 24px", fontWeight: 600, cursor: "pointer" }}>
            Track
          </button>
        </div>
        <div style={{ background: "#1a2332", border: "1px solid #2a3a4e", borderRadius: 20, padding: "6px 14px", fontSize: 12, color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />
          Mainnet
        </div>
      </div>

      {/* Main */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 32 }}>
        {/* Portfolio Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#64748b", marginBottom: 8, wordBreak: "break-all" }}>{d.address}</div>
            <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: -1.5, marginBottom: 4 }}>${fmt(d.totalValueUSD)}</div>
            <div style={{ fontSize: 15, fontWeight: 500, color: d.xlmPrice.change24h >= 0 ? "#22c55e" : "#ef4444" }}>
              XLM {d.xlmPrice.change24h >= 0 ? "+" : ""}{fmt(d.xlmPrice.change24h)}% (24h)
            </div>
            <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 13, color: "#64748b" }}>
              <span>Assets: <span style={{ color: "#94a3b8", fontWeight: 500 }}>{d.balances.length}</span></span>
              <span>Subentries: <span style={{ color: "#94a3b8", fontWeight: 500 }}>12</span></span>
            </div>
          </div>
          <button style={{ background: "#1a2332", border: "1px solid #2a3a4e", borderRadius: 12, padding: "10px 20px", color: "#94a3b8", fontSize: 14, cursor: "pointer" }}>
            Refresh
          </button>
        </div>

        {/* Breakdown bar */}
        <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2, marginBottom: 16 }}>
          {pricedTokens.map((b, i) => {
            const pct = (b.valueUSD / d.totalValueUSD) * 100;
            if (pct < 0.5) return null;
            return <div key={i} style={{ width: pct + "%", height: "100%", borderRadius: 4, background: colors[b.asset.code] || "#6366f1" }} />;
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 32, fontSize: 13 }}>
          {pricedTokens.map((b, i) => {
            const pct = (b.valueUSD / d.totalValueUSD) * 100;
            if (pct < 0.5) return null;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 3, background: colors[b.asset.code] || "#6366f1" }} />
                {b.asset.code} {fmt(pct)}%
              </div>
            );
          })}
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
          <StatCard label="XLM Balance" value={fmt(185420, 0)} sub="185,218.50 available" />
          <StatCard label="XLM Price" value={"$" + fmt(d.xlmPrice.usd, 4)} sub={`+${fmt(d.xlmPrice.change24h)}%`} subColor="#22c55e" />
          <StatCard label="Token Types" value={tokens.length} sub={`${pricedTokens.length} priced`} />
          <StatCard label="LP Positions" value={lpCount} sub="Liquidity pools" />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #2a3a4e", marginBottom: 24 }}>
          {[
            { id: "tokens", label: "Tokens", count: tokens.length },
            { id: "history", label: "History", count: d.history.length },
            { id: "claimable", label: "Claimable", count: d.claimable.length },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "12px 20px",
                fontSize: 14,
                fontWeight: 500,
                color: tab === t.id ? "#e2e8f0" : "#64748b",
                background: "none",
                border: "none",
                borderBottom: `2px solid ${tab === t.id ? "#6366f1" : "transparent"}`,
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {t.label}
              <span style={{ background: "#243044", borderRadius: 10, padding: "1px 7px", fontSize: 11, marginLeft: 6 }}>{t.count}</span>
            </button>
          ))}
        </div>

        {/* Token List */}
        {tab === "tokens" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "8px 20px", fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>
              <div>Asset</div>
              <div style={{ textAlign: "right" }}>Balance</div>
              <div style={{ textAlign: "right" }}>Price</div>
              <div style={{ textAlign: "right" }}>Value</div>
            </div>
            {tokens.map((t, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", alignItems: "center", padding: "16px 20px", background: "#1a2332", borderRadius: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <TokenIcon code={t.asset.code} type={t.type} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{t.asset.code}</div>
                    <div style={{ fontSize: 12, color: "#64748b", fontFamily: "monospace" }}>
                      {t.type === "native" ? "Native" : shorten(t.asset.issuer)}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "right", fontWeight: 500 }}>
                  {fmt(parseFloat(t.balance), parseFloat(t.balance) < 1 ? 7 : 2)}
                  {t.type === "native" && (
                    <div style={{ fontSize: 12, color: "#64748b" }}>{t.available} avail</div>
                  )}
                </div>
                <div style={{ textAlign: "right", fontSize: 14 }}>
                  {t.price ? "$" + fmt(t.price.usd, t.price.usd < 0.01 ? 6 : 4) : ""}
                  {t.price?.change24h != null && (
                    <div style={{ fontSize: 12, color: t.price.change24h >= 0 ? "#22c55e" : "#ef4444" }}>
                      {t.price.change24h >= 0 ? "+" : ""}{fmt(t.price.change24h)}%
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", fontWeight: 600, fontSize: 15 }}>
                  {t.valueUSD > 0 ? fmtUSD(t.valueUSD) : <span style={{ fontSize: 12, color: "#64748b", fontStyle: "italic" }}>No price</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* History */}
        {tab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {d.history.map((tx, i) => {
              const typeColors = { payment: "#3b82f6", path_payment_strict_receive: "#6366f1", change_trust: "#a855f7", manage_sell_offer: "#eab308" };
              const bgColors = { payment: "rgba(59,130,246,0.15)", path_payment_strict_receive: "rgba(99,102,241,0.15)", change_trust: "rgba(168,85,247,0.15)", manage_sell_offer: "rgba(234,179,8,0.15)" };
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 16, alignItems: "center", padding: "14px 20px", background: "#1a2332", borderRadius: 12, fontSize: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, textTransform: "capitalize", padding: "4px 10px", borderRadius: 6, textAlign: "center", background: bgColors[tx.type] || "#243044", color: typeColors[tx.type] || "#94a3b8" }}>
                    {tx.type.replace(/_/g, " ")}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 13 }}>
                    {tx.type === "payment" && <span>from <strong style={{ color: "#e2e8f0" }}>{tx.from}</strong></span>}
                    {tx.type === "path_payment_strict_receive" && <span>Swap {tx.sourceAssetCode} → <strong style={{ color: "#e2e8f0" }}>{tx.assetCode}</strong></span>}
                    {tx.type === "change_trust" && <span>Added trustline for <strong style={{ color: "#e2e8f0" }}>{tx.assetCode}</strong></span>}
                    {tx.type === "manage_sell_offer" && <span>{tx.sellingAsset} → {tx.buyingAsset}</span>}
                  </div>
                  <div style={{ fontWeight: 600, textAlign: "right" }}>
                    {tx.amount && `${tx.amount} ${tx.assetCode || ""}`}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Claimable */}
        {tab === "claimable" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {d.claimable.map((cb, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 16, alignItems: "center", padding: "16px 20px", background: "#1a2332", borderRadius: 12 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{cb.asset.code}</div>
                  <div style={{ fontSize: 13, color: "#64748b", fontFamily: "monospace" }}>from {cb.sponsor}</div>
                </div>
                <div style={{ fontSize: 13, color: "#64748b" }}>1 claimant</div>
                <div style={{ fontWeight: 600, textAlign: "right" }}>{fmt(parseFloat(cb.amount))} {cb.asset.code}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
