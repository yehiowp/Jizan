import { config } from "./config.js";
import { log } from "./log.js";

/* 自動交易迴圈：自己掃描、自己選、自己下單。

   三件事是刻意這樣設計的，不要拿掉：

   1. 必須「武裝」才會動，而且武裝會自己到期（預設 12 小時）。
      沒有「設定完放著跑一個月」這種狀態 —— 一個沒人看的機器人在迷因幣市場
      跑一個月，結局是可預期的。

   2. 自動模式的門檻一律比手動嚴。它沒有你的判斷力，只能靠更高的標準補：
      分數門檻更高、不接受執行降級、不接受「蜜罐未測」這種未知狀態。

   3. 每一筆都會即時回報它買了什麼、為什麼買。你睡醒要能看懂它做了什麼。 */

/* 固定併發數跑完一批。任何一個丟出例外就整批中止（限流時要停手，不是繼續敲）。

   併發數一律先轉成有效正整數：拿到 undefined / NaN 時，
   Math.min 會算出 NaN、Array.from({length:NaN}) 會建出 0 個 worker，
   結果是回傳一個全是空洞的陣列 —— 不報錯，但一顆都沒驗。
   會安靜跳過工作的失敗方式，比直接爆掉危險得多。 */
export async function mapLimit(items, limit, fn){
  if(!Array.isArray(items) || items.length === 0) return [];
  const n = Number(limit);
  const workerCount = Math.max(1, Math.min(Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1, items.length));
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while(true){
      const i = next++;
      if(i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createAutoTrader({ store, trader, say, cfg = config }){
  let timer = null;
  let running = false;

  /* 自動模式專屬的額外條件。手動模式過得了的，自動模式不一定過得了。 */
  function autoGate(plan){
    const blocks = [];
    const a = cfg.auto;
    const g = plan.gate;

    if(plan.coinScore != null && plan.coinScore < a.minScore){
      blocks.push(`分數 ${plan.coinScore} 低於自動模式門檻 ${a.minScore}`);
    }
    if(g.warnings.length > a.maxWarnings){
      blocks.push(`注意事項 ${g.warnings.length} 條，超過自動模式上限 ${a.maxWarnings}`);
    }
    if(!a.allowDowngrade && g.downgrade.length){
      blocks.push(`有執行降級訊號（${g.downgrade[0].reason}），自動模式不吃降級單`);
    }
    /* 「未測」對人類是「自己判斷」，對機器人只能是「不買」 */
    if(g.metrics.honeypot !== false){
      blocks.push(`蜜罐檢測結果是「${g.metrics.honeypot === true ? "是蜜罐" : "未測"}」，自動模式只接受明確安全`);
    }
    if(g.metrics.rugRatio == null){
      blocks.push("拿不到 rug_ratio，自動模式不賭未知");
    }
    if(plan.quoteError){
      blocks.push(`報價失敗（${plan.quoteError}），不在看不到成交預估的情況下下單`);
    }
    return blocks;
  }

  /* 當日自動交易額度 */
  function dailyBudget(){
    const today = store.autoToday();
    const a = cfg.auto;
    const reasons = [];
    if(today.count >= a.maxTradesPerDay) reasons.push(`今日自動交易已達 ${a.maxTradesPerDay} 筆上限`);
    if(today.spentUsd + cfg.risk.positionUsd > a.maxSpendPerDayUsd){
      reasons.push(`今日自動支出會到 $${(today.spentUsd + cfg.risk.positionUsd).toFixed(2)}，超過上限 $${a.maxSpendPerDayUsd}`);
    }
    return { ok: reasons.length === 0, reasons, today };
  }

  async function cycle(){
    if(running) return { skipped: "上一輪還沒跑完" };
    running = true;
    try {
      /* 1. 武裝狀態。
         過期通知看的是「狀態轉換」而不是「過期多久」：armedUntil 還留著、
         但已經過期且沒有人手動解除，就代表它是自己失效的，通知一次並記下原因。
         用時間窗判斷的話，掃描時機一錯過你就再也不會被告知，
         會以為它還在幫你交易。 */
      if(!store.isAutoArmed()){
        const until = store.autoArmedUntil();
        if(until > 0 && !store.autoDisarmReason()){
          store.disarmAuto("武裝時效到期");
          await say([
            "⏹ 自動交易武裝時效到期，已停止自動下單。",
            `到期時間：${new Date(until).toLocaleString("zh-TW")}`,
            "持倉的停損停利不受影響，照樣掛在 GMGN 那邊。",
            "要繼續請重新 /auto on。"
          ].join("\n"));
        }
        return { skipped: "未武裝" };
      }

      /* 2. 全域交易開關（單日虧損、停機線觸發時會被關掉） */
      if(!store.state.tradingEnabled){
        store.disarmAuto(`交易已停用：${store.state.disabledReason}`);
        await say(`⛔ 交易已停用（${store.state.disabledReason}），自動武裝一併解除。`);
        return { skipped: "交易已停用" };
      }

      /* 3. 當日額度 */
      const budget = dailyBudget();
      if(!budget.ok) return { skipped: budget.reasons[0] };

      /* 4. 掃描 */
      const { all, candidates } = await trader.scan();
      const pool = candidates.filter(c => c.score >= cfg.auto.minScore);
      if(!pool.length){
        return { skipped: `${all.length} 顆裡沒有達到自動門檻 ${cfg.auto.minScore} 的` };
      }

      /* 5. 平行驗證前幾顆。
         逐顆驗的話，前面四顆被刷掉就是四個連續往返才輪到第五顆。
         平行跑一批，一輪能看更多顆而且更快。併發數壓在限流桶容量之下：
         每顆 2 個請求（info + security），權重各 1，桶子是 20。 */
      const batch = pool.slice(0, cfg.auto.vetBatchSize ?? 8);
      const vetted = await mapLimit(batch, cfg.auto.vetConcurrency ?? 4, async coin => {
        try {
          const v = await trader.vet({ address: coin.address, coin, usdAmount: cfg.risk.positionUsd });
          return { coin, v };
        } catch(e){
          if(e.code === "RATE_LIMIT") throw e;          // 限流要讓整輪停手，不是吞掉
          log.warn("自動交易驗證失敗", { symbol: coin.symbol, error: e.message });
          return { coin, v: null, error: e.message };
        }
      }).catch(e => {
        if(e.code === "RATE_LIMIT"){
          log.warn("自動交易遇到限流，這輪停手", { hint: e.hint });
          return null;
        }
        throw e;
      });
      if(vetted === null) return { skipped: "限流" };

      /* 沒過閘的記下來，十五分鐘內不重驗 —— 省往返也省限流額度 */
      const passed = [];
      for(const { coin, v } of vetted){
        if(!v) continue;
        if(!v.pass){
          store.markRejected(coin.address);
          log.info("自動交易跳過", { symbol: coin.symbol, reasons: v.reasons.slice(0, 2) });
          continue;
        }
        passed.push({ coin, v });
      }
      if(!passed.length) return { skipped: `驗了 ${batch.length} 顆都沒過閘` };

      /* 分數最高的優先 */
      passed.sort((a, b) => b.coin.score - a.coin.score);

      for(const { coin, v } of passed){
        /* 到這裡才報價 —— 只有真要買的那顆需要付這個往返 */
        let plan;
        try {
          plan = await trader.prepareBuy({ address: coin.address, coin, vetted: v, usdAmount: cfg.risk.positionUsd });
        } catch(e){
          if(e.code === "RATE_LIMIT") return { skipped: "限流" };
          log.warn("自動交易報價失敗", { symbol: coin.symbol, error: e.message });
          continue;
        }

        plan.coinScore = coin.score;
        const extra = autoGate(plan);

        if(!plan.canExecute || extra.length){
          store.markRejected(coin.address);
          log.info("自動交易跳過", {
            symbol: coin.symbol,
            reasons: [...plan.gate.blocks, ...plan.riskCheck.reasons, ...extra].slice(0, 3)
          });
          continue;
        }

        /* 6. 下單 */
        const res = await trader.executeBuy(plan);
        if(!res.ok){
          await say(`🤖 自動買入失敗 ${coin.symbol}：${res.error}`);
          return { attempted: coin.symbol, ok: false, error: res.error };
        }

        store.recordAutoBuy(plan.usdAmount);
        const after = store.autoToday();
        const p = res.position;

        await say([
          `🤖 自動買入 ${p.symbol}${p.dryRun ? "（模擬）" : ""}`,
          "",
          `為什麼買：分數 ${coin.score}/100，三道閘門全過`,
          `深度 $${Math.round(plan.gate.metrics.depth).toLocaleString()}　持有人 ${coin.holders}`,
          `rug_ratio ${plan.gate.metrics.rugRatio?.toFixed(2) ?? "?"}　前十持有 ${(coin.top10 * 100).toFixed(0)}%`,
          `1h ${coin.ch1h >= 0 ? "+" : ""}${coin.ch1h.toFixed(1)}%　5m ${coin.ch5m >= 0 ? "+" : ""}${coin.ch5m.toFixed(1)}%`,
          plan.gate.warnings.length ? `注意：${plan.gate.warnings[0]}` : "",
          "",
          `投入 $${p.costUsd}　進場 ${p.entryPrice}`,
          `停損 ${p.stopPrice.toExponential(3)}（-${cfg.risk.stopPct}%）`,
          `停利 ${p.targetPrice.toExponential(3)}（+${(cfg.risk.stopPct * cfg.risk.targetR).toFixed(0)}%）`,
          res.strategyMissing
            ? "⚠️ 伺服器端停損停利沒建立成功，這個部位沒有自動出場，請手動處理"
            : "停損停利已掛在 GMGN 伺服器端",
          p.hash ? `tx: ${p.hash}` : "",
          "",
          `今日自動交易 ${after.count}/${cfg.auto.maxTradesPerDay} 筆　支出 $${after.spentUsd.toFixed(0)}/$${cfg.auto.maxSpendPerDayUsd}`,
          `武裝剩餘 ${((store.autoArmedUntil() - Date.now()) / 3600000).toFixed(1)} 小時`,
          `不想要這筆就 /sell ${p.id}`
        ].filter(Boolean).join("\n"));

        return { attempted: coin.symbol, ok: true, position: p };
      }

      return { skipped: `${passed.length} 顆過閘的都沒通過自動模式的額外條件` };
    } finally {
      running = false;
    }
  }

  return {
    cycle,
    autoGate,
    dailyBudget,

    start(){
      if(timer) return;
      timer = setInterval(() => {
        cycle().catch(e => log.error("自動交易迴圈出錯", { error: e.message }));
      }, cfg.timing.scanIntervalSec * 1000);
      timer.unref?.();
      log.info("自動交易迴圈已啟動", {
        everySec: cfg.timing.scanIntervalSec,
        armed: store.isAutoArmed(),
        minScore: cfg.auto.minScore
      });
    },
    stop(){ if(timer){ clearInterval(timer); timer = null; } }
  };
}
