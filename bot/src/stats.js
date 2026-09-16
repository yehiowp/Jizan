import { config } from "./config.js";

/* 從已平倉紀錄算績效。R = 損益 / 當初承擔的風險金額。 */
/* mode: "all" | "dry"（模擬）| "live"（真錢）

   分開算是必要的，不是講究：模擬單的勝率是你「該不該上真錢」的依據，
   真錢單的勝率才是你「現在到底有沒有在賺」。兩者混在一起算，
   上真錢之後那串漂亮的模擬紀錄會一直把真實績效稀釋掉，
   等你發現不對的時候已經虧掉一輪了。 */
export function stats(store, cfg = config, { mode = "all" } = {}){
  const ts = store.closedTrades()
    .filter(t => mode === "all" || (mode === "dry" ? !!t.dryRun : !t.dryRun))
    .slice().sort((a, b) => (a.closedAt < b.closedAt ? -1 : 1));
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
    mode,
    dryRunCount: ts.filter(t => t.dryRun).length
  };
}

/* 上真錢的門檻。三條全過才算這套打法在你手上真的有效。 */
/* 上真錢的門檻只看模擬單 —— 它問的就是「模擬跑得夠好了嗎」。
   拿混合統計來判斷，等於用真錢的成績去決定要不要上真錢，邏輯是反的。 */
export function realMoneyGate(store, cfg = config){
  const s = stats(store, cfg, { mode: "dry" });
  const checks = [
    { label: "模擬交易 ≥ 30 筆", ok: s.n >= 30, now: `${s.n ?? 0} 筆` },
    { label: "期望值 > 0.2R", ok: s.n >= 30 && s.expectancy > 0.2, now: s.n ? `${s.expectancy.toFixed(2)}R` : "-" },
    { label: "最大回撤 < 25%", ok: s.n >= 30 && s.maxDD < 25, now: s.n ? `${s.maxDD.toFixed(1)}%` : "-" }
  ];
  return { checks, pass: checks.every(c => c.ok) };
}
