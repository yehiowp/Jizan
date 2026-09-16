/* 回測：拿真實 K 線，算這套停損停利規則過去會怎樣。

   用法（在 bot 資料夾裡）：
     npm run backtest
     npm run backtest -- --days 14 --tokens 30 --resolution 15m

   先讀 src/backtest.js 開頭那段「能回答什麼、不能回答什麼」。
   摘要：這測的是出場規則，不是選幣；而且候選名單有存活者偏差，
   所以數字是上限，不是預期值。報告最後會再講一次。 */

import { config } from "./src/config.js";
import { createCli } from "./src/gmgncli.js";
import {
  normalizeCandles, runToken, buyAndHold, summarize
} from "./src/backtest.js";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const DAYS = Math.max(1, Number(arg("days", 14)));
const TOKENS = Math.max(1, Number(arg("tokens", 25)));
const RES = String(arg("resolution", "15m"));
const CHAINS = String(arg("chains", (config.gmgn.chains.length ? config.gmgn.chains : [config.gmgn.chain])
  .filter(c => c !== "robinhood").join(","))).split(",").map(s => s.trim()).filter(Boolean);

const STOP = config.risk.stopPct;
const TARGET = config.risk.stopPct * config.risk.targetR;

/* 滑價不是一個數字，是一個範圍 —— 所以跑三種，讓你看到這個「邊」有多禁得起磨損。
   迷因幣單邊 3% 已經算順利，8% 是常態，0% 是不可能但當對照組用。 */
const SCENARIOS = [
  { label: "無成本（不可能，只當上限）", slipInPct: 0, slipOutPct: 0 },
  { label: "單邊 3%（順利的情況）",      slipInPct: 3, slipOutPct: 3 },
  { label: "單邊 8%（常見的情況）",      slipInPct: 8, slipOutPct: 8 },
];

const pct = n => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

async function main(){
  const cli = createCli();

  const chk = await cli.configCheck();
  if(!chk.ok){
    console.error(`\n❌ gmgn-cli 還沒設定好：${chk.error}`);
    console.error(`   ${chk.hint ?? ""}\n`);
    process.exit(1);
  }

  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;

  console.log(`\n════ 回測 ════`);
  console.log(`區間 ${DAYS} 天　K 線 ${RES}　鏈 ${CHAINS.join(" / ")}`);
  console.log(`規則 停損 -${STOP}%　停利 +${TARGET}%\n`);

  /* 1. 候選名單。只能拿現在的熱門榜 —— 歷史榜單不存在。 */
  const candidates = [];
  for(const chain of CHAINS){
    try {
      const rows = await cli.trending({ chain, interval: "24h", limit: TOKENS });
      for(const r of rows){
        const address = r.address ?? r.token_address ?? r.contract ?? r.ca;
        const symbol = r.symbol ?? r.name ?? "?";
        if(address) candidates.push({ chain, address, symbol });
      }
    } catch(e){
      console.error(`⚠️ ${chain} 熱門榜抓不到：${e.message}`);
    }
  }
  const picked = candidates.slice(0, TOKENS);
  if(!picked.length){
    console.error("❌ 一顆候選都沒有，沒辦法回測。\n");
    process.exit(1);
  }
  console.log(`候選 ${picked.length} 顆，開始抓 K 線…\n`);

  /* 2. 抓 K 線。一顆一顆抓，讓限流漏桶有機會發揮作用。 */
  const series = [];
  const skipped = [];
  for(const c of picked){
    try {
      const raw = await cli.kline({ chain: c.chain, address: c.address, resolution: RES, from, to });
      const candles = normalizeCandles(raw);
      series.push({ ...c, candles });
      process.stdout.write(`  ✓ ${c.symbol} (${candles.length} 根)\n`);
    } catch(e){
      skipped.push({ ...c, why: e.message });
      process.stdout.write(`  ✗ ${c.symbol}：${e.message}\n`);
    }
  }

  if(!series.length){
    console.error("\n❌ 一顆都沒抓到可用的 K 線。上面的錯誤訊息就是原因。\n");
    process.exit(1);
  }

  /* 3. 每個滑價情境各跑一遍 */
  console.log(`\n可用 ${series.length} 顆（跳過 ${skipped.length} 顆）\n`);

  for(const sc of SCENARIOS){
    const trades = [];
    let holdSum = 0, holdN = 0;
    for(const s of series){
      trades.push(...runToken(s.candles, {
        stopPct: STOP, targetPct: TARGET,
        slipInPct: sc.slipInPct, slipOutPct: sc.slipOutPct,
      }));
      const bh = buyAndHold(s.candles, { slipInPct: sc.slipInPct, slipOutPct: sc.slipOutPct });
      if(bh){ holdSum += bh.retPct; holdN++; }
    }

    const r = summarize(trades, {
      stopPct: STOP,
      bankrollUsd: config.risk.bankrollUsd,
      positionUsd: config.risk.positionUsd,
      killSwitchUsd: config.risk.killSwitchUsd,
    });

    console.log(`── ${sc.label} ──`);
    if(!r.n){
      console.log(`   沒有任何一筆交易${r.notTaken ? `（第一筆之前淨值就低於停機線）` : ""}\n`);
      continue;
    }
    console.log(`   筆數 ${r.n}　勝率 ${(r.winRate * 100).toFixed(0)}%`);
    console.log(`   期望值 ${r.expectancy.toFixed(3)}R　獲利因子 ${r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)}`);
    console.log(`   停利 ${r.byOutcome.target}　停損 ${r.byOutcome.stop}　到期 ${r.byOutcome.timeout}`);
    console.log(`   最大回撤 ${r.maxDD.toFixed(1)}%　最長連敗 ${r.worstStreak}`);
    console.log(`   以每筆 $${config.risk.positionUsd} 計，${DAYS} 天淨損益 ${r.netUsd >= 0 ? "+" : ""}$${r.netUsd.toFixed(0)}`);
    if(r.halted != null){
      console.log(`   🛑 淨值跌破停機線 $${config.risk.killSwitchUsd}，第 ${r.halted} 筆之後全面停止`);
      console.log(`      後面還有 ${r.notTaken} 筆沒有發生 —— 真的在跑的時候，機器人已經停了`);
    }
    console.log(`   對照：同期買進抱著不動，平均每顆 ${pct(holdN ? holdSum / holdN : 0)}`);
    const ambRate = r.ambiguous / r.n * 100;
    console.log(`   同根同時觸發停損停利：${r.ambiguous} 筆（${ambRate.toFixed(0)}%）${ambRate > 20 ? "　⚠️ 比例偏高，這個結果很脆弱" : ""}`);
    console.log("");
  }

  console.log(`════ 這份數字能信到什麼程度 ════

1. 測的是「出場規則」，不是「選幣」。
   閘門讀的流動性、籌碼集中度、貔貅旗標、聰明錢人數，GMGN 只給現在的值，
   沒有歷史快照，所以沒辦法重建三天前那些幣在閘門眼裡長什麼樣。
   這裡等於「隨機挑熱門幣，照規則進出場」。

2. 存活者偏差，而且很嚴重。
   候選來自「現在」的熱門榜 —— 已經歸零的幣不會在榜上。
   真正跑起來時，機器人會遇到那些幣，這份回測不會。
   所以上面每一個數字都是上限，不是預期值。

3. 同一根 K 線同時碰到停損停利時，一律算停損。
   哪個先發生無從得知，而假設成停利會讓結果憑空好一大截。
   上面有印同根觸發的比例，超過 20% 就代表這個結果禁不起挑戰。

4. 進場點是機械式的（出場後接著下一筆），不是機器人真正的進場時機。
   機器人是掃到符合條件才買，不是有空位就買。

要看「這套選幣在現在的市場有沒有用」，唯一的辦法還是 DRY_RUN=true 跑一週，
然後看 /stats。那個數字沒有以上任何一條問題。
`);
}

main().catch(e => {
  console.error(`\n❌ 回測失敗：${e.message}`);
  if(e.hint) console.error(`   ${e.hint}`);
  console.error("");
  process.exit(1);
});
