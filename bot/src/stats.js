import { config } from "./config.js";

/* 從已平倉紀錄算績效。R = 損益 / 當初承擔的風險金額。 */
export function stats(store, cfg = config){
  const ts = store.closedTrades().slice().sort((a, b) => (a.closedAt < b.closedAt ? -1 : 1));
  const n = ts.length;
  if(!n) return { n: 0 };

  const wins = ts.filter(t => (t.pnlUsd ?? 0) > 0);
  const losses = ts.filter(t => (t.pnlUsd ?? 0) <= 0);
  const sumWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const sumLoss = losses.reduce((s, t) => s + t.pnlUsd, 0);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + (t.r ?? 0), 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, t) => s + (t.r ?? 0), 0) / losses.length : 0;
  const winRate = wins.length / n;

  let eq = cfg.risk.bankrollUsd, peak = eq, maxDD = 0, streak = 0, worstStreak = 0;
  for(const t of ts){
    eq += t.pnlUsd ?? 0;
    if(eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if(dd > maxDD) maxDD = dd;
    if((t.pnlUsd ?? 0) <= 0){ streak++; if(streak > worstStreak) worstStreak = streak; }
    else streak = 0;
  }

  return {
    n,
    wins: wins.length,
    winRate,
    avgWinR,
    avgLossR,
    expectancy: winRate * avgWinR + (1 - winRate) * avgLossR,
    profitFactor: sumLoss < 0 ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? 99 : 0),
    netPnl: sumWin + sumLoss,
    maxDD,
    worstStreak,
    equity: eq,
    dryRunCount: ts.filter(t => t.dryRun).length
  };
}

/* 上真錢的門檻。三條全過才算這套打法在你手上真的有效。 */
export function realMoneyGate(store, cfg = config){
  const s = stats(store, cfg);
  const checks = [
    { label: "模擬交易 ≥ 30 筆", ok: s.n >= 30, now: `${s.n ?? 0} 筆` },
    { label: "期望值 > 0.2R", ok: s.n >= 30 && s.expectancy > 0.2, now: s.n ? `${s.expectancy.toFixed(2)}R` : "-" },
    { label: "最大回撤 < 25%", ok: s.n >= 30 && s.maxDD < 25, now: s.n ? `${s.maxDD.toFixed(1)}%` : "-" }
  ];
  return { checks, pass: checks.every(c => c.ok) };
}
