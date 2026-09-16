/* 回測引擎：給一段真實 K 線，算出「照這套停損停利規則進出場會怎樣」。

   ⚠️ 這支能回答什麼、不能回答什麼，講在前面，因為這決定了結果值不值得信：

   能回答：出場規則的幾何。停損 35%、停利 +70% 這組數字，
           放在真實的迷因幣價格路徑上，打得中幾次、期望值多少。

   不能回答：選幣。閘門讀的是流動性、籌碼集中度、貔貅旗標、聰明錢人數 ——
           GMGN 只給「現在」的值，沒有歷史快照，所以沒辦法重建
           「三天前這顆幣在閘門眼裡長什麼樣」。熱門榜也只有現在的。

   而且候選名單本身有存活者偏差：今天還在熱門榜上的幣，
   本來就是沒有歸零的那些。歸零的不會出現在名單裡。
   所以這裡算出來的數字是「上限」，不是「預期值」。 */

/* K 線欄位名稱各家不同，而且常常是字串。
   解析錯了會產出一個看起來很有說服力的假數字 —— 所以寧可丟錯誤，不要猜。 */
const pick = (row, keys) => {
  for(const k of keys){
    if(row[k] !== undefined && row[k] !== null && row[k] !== "") return Number(row[k]);
  }
  return NaN;
};

export function normalizeCandles(raw){
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.list) ? raw.list
    : Array.isArray(raw?.klines) ? raw.klines
    : Array.isArray(raw?.candles) ? raw.candles
    : Array.isArray(raw?.data) ? raw.data
    : null;
  if(!list) throw new Error("看不懂 kline 的回傳格式（找不到陣列）");

  const out = [];
  for(const row of list){
    if(!row || typeof row !== "object") throw new Error("kline 裡有不是物件的元素");
    const t = pick(row, ["time", "timestamp", "ts", "t", "open_time"]);
    const o = pick(row, ["open", "o"]);
    const h = pick(row, ["high", "h"]);
    const l = pick(row, ["low", "l"]);
    const c = pick(row, ["close", "c"]);
    if(![t, o, h, l, c].every(Number.isFinite)) throw new Error("kline 缺少 time/open/high/low/close 其中之一");
    if(h < l) throw new Error("kline 的 high 小於 low，資料有問題");
    if(o <= 0 || c <= 0 || l <= 0) throw new Error("kline 有非正數的價格");
    out.push({ t, o, h, l, c });
  }
  if(out.length < 3) throw new Error("K 線根數太少，不足以模擬");
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* 從 entryIndex 這根的開盤進場，往後走到停損、停利、或走完。

   同一根 K 線裡同時碰到停損和停利時，無從得知哪個先發生 ——
   一律當成停損。這條規則看起來保守得誇張，但相反的假設會讓迷因幣的
   回測結果憑空好上一大截，而那個「好」完全是假的。
   ambiguous 會被記下來：比例高就代表這個結果很脆弱。 */
export function simulateOne(candles, {
  entryIndex,
  stopPct,
  targetPct,
  slipInPct = 0,
  slipOutPct = 0,
  maxBars = Infinity,
} = {}){
  const entryBar = candles[entryIndex];
  if(!entryBar) return null;

  const entry = entryBar.o * (1 + slipInPct / 100);
  const stop = entry * (1 - stopPct / 100);
  const target = entry * (1 + targetPct / 100);

  let exit = null, outcome = null, ambiguous = false, exitIndex = entryIndex;

  const last = Math.min(candles.length - 1, entryIndex + maxBars);
  for(let i = entryIndex; i <= last; i++){
    const b = candles[i];
    const hitStop = b.l <= stop;
    const hitTarget = b.h >= target;

    if(hitStop && hitTarget){ ambiguous = true; exit = stop; outcome = "stop"; exitIndex = i; break; }
    if(hitStop){ exit = stop; outcome = "stop"; exitIndex = i; break; }
    if(hitTarget){ exit = target; outcome = "target"; exitIndex = i; break; }
  }

  if(exit === null){
    exit = candles[last].c;
    outcome = "timeout";       // 沒碰到任何一邊，用最後收盤結算
    exitIndex = last;
  }

  const exitNet = exit * (1 - slipOutPct / 100);
  const retPct = (exitNet - entry) / entry * 100;

  /* R = 損益 / 當初承擔的風險。跟機器人帳本裡的 R 是同一個定義。 */
  return {
    outcome,
    ambiguous,
    entry,
    exit: exitNet,
    retPct,
    r: retPct / stopPct,
    bars: exitIndex - entryIndex,
    entryTime: entryBar.t,
    exitTime: candles[exitIndex].t,
  };
}

/* 一顆幣跑一連串「不重疊」的交易：出場之後才找下一個進場點。
   讓進場點重疊會膨脹筆數、低估變異 —— 同一段行情被重複計算好幾次。 */
export function runToken(candles, opts = {}){
  const { warmupBars = 0, maxBars = Infinity } = opts;
  const trades = [];
  let i = warmupBars;
  while(i < candles.length - 1){
    const t = simulateOne(candles, { ...opts, entryIndex: i, maxBars });
    if(!t) break;
    trades.push(t);
    const step = Math.max(1, t.bars);
    i += step + 1;             // 下一筆從出場之後開始
  }
  return trades;
}

/* 買進抱著不動，同一段區間。沒有這個對照組，任何回測結果都沒有意義 ——
   規則跑贏了才叫規則有用，跑輸就只是把手續費送出去。 */
export function buyAndHold(candles, { slipInPct = 0, slipOutPct = 0, warmupBars = 0 } = {}){
  const a = candles[warmupBars];
  const b = candles[candles.length - 1];
  if(!a || !b) return null;
  const entry = a.o * (1 + slipInPct / 100);
  const exit = b.c * (1 - slipOutPct / 100);
  return { retPct: (exit - entry) / entry * 100 };
}

export function summarize(trades, {
  stopPct = 35, bankrollUsd = 100, positionUsd = 20, killSwitchUsd = 0,
} = {}){
  if(!trades.length) return { n: 0 };

  /* 先把停機線套上去。真的跑起來時，淨值跌破停機線機器人就全面停止，
     後面那些交易根本不會發生 —— 不模擬它的話，報表會出現 118% 這種
     「淨值變負數」的回撤，而那是一個永遠不會發生的數字。
     （單日虧損上限沒有模擬，所以這裡仍然略微偏悲觀。） */
  const riskUsd = positionUsd * (stopPct / 100);
  const taken = [];
  let halted = null, equity = bankrollUsd;
  for(const t of trades){
    if(killSwitchUsd > 0 && equity < killSwitchUsd){ halted = taken.length; break; }
    equity += t.r * riskUsd;
    taken.push(t);
  }

  const ts = taken;
  const n = ts.length;
  if(!n) return { n: 0, halted: 0, notTaken: trades.length };

  const wins = ts.filter(t => t.r > 0);
  const losses = ts.filter(t => t.r <= 0);
  const sumWin = wins.reduce((s, t) => s + t.r, 0);
  const sumLoss = losses.reduce((s, t) => s + t.r, 0);
  const winRate = wins.length / n;
  const avgWinR = wins.length ? sumWin / wins.length : 0;
  const avgLossR = losses.length ? sumLoss / losses.length : 0;

  let eq = bankrollUsd, peak = eq, maxDD = 0, streak = 0, worstStreak = 0;
  for(const t of ts){
    eq += t.r * riskUsd;
    if(eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if(dd > maxDD) maxDD = dd;
    if(t.r <= 0){ streak++; if(streak > worstStreak) worstStreak = streak; }
    else streak = 0;
  }

  return {
    n,
    halted,                        // 停機線在第幾筆觸發（null = 沒觸發）
    notTaken: trades.length - n,   // 因為停機而沒發生的交易筆數
    wins: wins.length,
    winRate,
    avgWinR,
    avgLossR,
    expectancy: winRate * avgWinR + (1 - winRate) * avgLossR,
    profitFactor: sumLoss < 0 ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? Infinity : 0),
    maxDD,
    worstStreak,
    equity: eq,
    netUsd: eq - bankrollUsd,
    byOutcome: {
      target: ts.filter(t => t.outcome === "target").length,
      stop: ts.filter(t => t.outcome === "stop").length,
      timeout: ts.filter(t => t.outcome === "timeout").length,
    },
    ambiguous: ts.filter(t => t.ambiguous).length,
  };
}
