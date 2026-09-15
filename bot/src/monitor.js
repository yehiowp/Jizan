import { config } from "./config.js";
import { exitSignal } from "./risk.js";
import { log } from "./log.js";

/* 停損停利是掛在 GMGN 伺服器端執行的，這裡不負責出場。
   這支只做三件事：更新報價、在接近停損時提醒、偵測「該觸發卻還在持倉」的異常。 */
export function createMonitor({ store, trader, say, cfg = config }){
  let timer = null;
  const warned = new Set();

  async function tick(){
    const open = store.openPositions();
    if(!open.length) return;

    let positions;
    try {
      positions = await trader.refreshPositions();
    } catch(e){
      if(e.code === "RATE_LIMIT"){
        log.warn("監控遇到限流，這輪跳過", { hint: e.hint });
        return;
      }
      throw e;
    }

    for(const p of positions){
      const signal = exitSignal(p, p.lastPrice, cfg);
      if(!signal) { warned.delete(p.id); continue; }

      const key = `${p.id}:${signal.reason}`;
      if(warned.has(key)) continue;
      warned.add(key);

      const move = p.entryPrice > 0 ? (p.lastPrice / p.entryPrice - 1) * 100 : 0;
      const lines = [
        `⚠️ ${p.symbol} 觸及${signal.reason}條件`,
        `進場 ${p.entryPrice} → 現價 ${p.lastPrice}（${move >= 0 ? "+" : ""}${move.toFixed(1)}%）`
      ];

      if(p.strategyOrderId && !p.dryRun){
        /* 正常情況 GMGN 應該已經幫你賣掉了。還在持倉代表策略單可能沒生效。 */
        lines.push(`伺服器端策略單 ${p.strategyOrderId} 應該已經觸發。`,
                   `如果這個部位還在，代表策略單沒生效 —— 用 /sell ${p.id} 手動出場。`);
      } else {
        lines.push(`這個部位沒有伺服器端停損，要手動處理：/sell ${p.id}`);
      }
      await say(lines.join("\n"));
    }
  }

  return {
    start(){
      if(timer) return;
      timer = setInterval(() => {
        tick().catch(e => log.error("監控出錯", { error: e.message }));
      }, cfg.timing.monitorIntervalSec * 1000);
      timer.unref?.();
      log.info("監控已啟動", { everySec: cfg.timing.monitorIntervalSec });
    },
    stop(){ if(timer){ clearInterval(timer); timer = null; } },
    tick
  };
}
