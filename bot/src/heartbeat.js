import { config } from "./config.js";
import { log } from "./log.js";
import { stats } from "./stats.js";

/* 定期回報「我還活著」。

   為什麼需要：機器人放在家裡的手機上沒人看時，你判斷它有沒有在運作的唯一依據
   就是「有沒有收到訊息」。但沒有訊息有兩種可能 —— 市場很安靜，或者它三天前
   就掛了。這兩件事對你的意義完全相反，不該長得一樣。

   心跳只在「真的還活著」時才送得出去，所以收不到心跳本身就是訊號。 */
export function createHeartbeat({ store, say, cfg = config }){
  let timer = null;

  async function beat(){
    const s = stats(store, cfg);
    const open = store.openPositions();
    const t = store.autoToday();
    const armed = store.isAutoArmed();

    const lines = [
      "💓 還在跑",
      cfg.mode.dryRun ? "🧪 模擬模式" : "💸 真錢模式",
      armed
        ? `🤖 自動交易武裝中，剩 ${((store.autoArmedUntil() - Date.now()) / 3600000).toFixed(1)} 小時`
        : `🤖 自動交易待命中${store.autoDisarmReason() ? `（${store.autoDisarmReason()}）` : ""}`,
      "",
      `持倉 ${open.length}/${cfg.risk.maxOpenPositions}　今日自動 ${t.count}/${cfg.auto.maxTradesPerDay} 筆`,
      `今日已實現 $${store.realizedToday().toFixed(2)}　累計 $${store.realizedTotal().toFixed(2)}`,
      s.n ? `已平倉 ${s.n} 筆　期望值 ${s.expectancy.toFixed(2)}R` : "尚未平倉任何一筆"
    ];

    if(!store.state.tradingEnabled){
      lines.push("", `⛔ 交易已停用：${store.state.disabledReason}`);
    }

    await say(lines.join("\n"));
  }

  return {
    beat,
    start(){
      if(timer || !(cfg.timing.heartbeatHours > 0)) return;
      const ms = cfg.timing.heartbeatHours * 3600 * 1000;
      timer = setInterval(() => {
        beat().catch(e => log.warn("心跳送不出去", { error: e.message }));
      }, ms);
      timer.unref?.();
      log.info("心跳已啟動", { everyHours: cfg.timing.heartbeatHours });
    },
    stop(){ if(timer){ clearInterval(timer); timer = null; } }
  };
}
