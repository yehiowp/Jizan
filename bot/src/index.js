import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "./config.js";
import { log } from "./log.js";
import { createStore } from "./store.js";
import { createCli, createBucket } from "./gmgncli.js";
import { createTrader } from "./trader.js";
import { createRadar } from "./radar.js";
import { createBot } from "./bot.js";
import { createMonitor } from "./monitor.js";
import { createAutoTrader } from "./autotrader.js";
import { createNarrative } from "./narrative.js";
import { createReconciler } from "./reconcile.js";
import { createHeartbeat } from "./heartbeat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, "..", "data", "state.json");

async function main(){
  const v = validateConfig();
  for(const w of v.warnings) log.warn("設定提醒", { w });
  if(!v.ok){
    for(const e of v.errors) log.error("設定錯誤", { e });
    process.exit(1);
  }

  /* 真錢模式的最後一道門：CLI 的自動下單開關必須是操作者自己開的。
     這支程式不會、也不該替你設定這個環境變數。 */
  if(!config.mode.dryRun && process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1"){
    log.error("真錢模式需要你本人開啟自動下單", {
      how: "在啟動機器人的 shell 執行 export GMGN_ALLOW_AUTOMATED_TRADES=1",
      why: "這是 GMGN 的程式碼層防線，用來擋掉「讀到惡意指令就自己加 --yes」的 agent"
    });
    process.exit(1);
  }

  /* 自動交易 + 真錢：再講一次它實際的意思，然後照你的決定跑 */
  if(config.mode.autoBuy && !config.mode.dryRun){
    log.warn("自動交易 + 真錢模式", {
      meaning: "武裝後機器人會自己選幣、自己下單，不再徵詢你",
      bounded_by: `每筆 $${config.risk.positionUsd}、每日最多 ${config.auto.maxTradesPerDay} 筆 / $${config.auto.maxSpendPerDayUsd}、單日虧損上限 $${config.risk.maxDailyLossUsd}、淨值停機線 $${config.risk.killSwitchUsd}`,
      arming: `武裝 ${config.auto.armHours} 小時後自動失效，重啟也會解除`
    });
  }

  const store = createStore(STATE_FILE);
  /* 限流封禁跨行程記住：封的是 API Key，重啟不會解除。
     忘記它的話，重啟後第一個請求就會把封禁再延長 5 秒。 */
  const cli = createCli({
    minGapMs: config.timing.minRequestGapMs,
    bucket: createBucket({
      initialBanUntil: store.rateLimitBanUntil(),
      onBan: until => store.setRateLimitBan(until),
    }),
  });
  const bannedMs = cli.bucket.bannedForMs();
  if(bannedMs > 0){
    log.warn("啟動時仍在 GMGN 限流封禁中", {
      secondsLeft: Math.ceil(bannedMs / 1000),
      note: "期間不會送出任何請求；重啟不會縮短它，只會延長"
    });
  }
  /* 本機雷達：設了就由它提供候選，機器人不再自己敲 GMGN 熱門榜。
     連不上不會讓機器人起不來 —— 但也不會默默改用 GMGN（那會把限流問題放回來）。 */
  let radar = null;
  if(config.radar.url){
    radar = createRadar({ url: config.radar.url });
    try {
      await radar.health();
      log.info("已接上本機雷達", { url: radar.url, fallback: config.radar.fallbackToGmgn });
    } catch(e){
      log.warn("雷達連不上（機器人照常啟動）", { url: radar.url, error: e.message });
    }
  }

  const trader = createTrader({ cli, store, radar });
  const botApi = createBot({ cli, store, trader });
  const { say } = botApi;
  const reconciler = createReconciler({ cli, store, trader, say });
  const monitor = createMonitor({ store, trader, say, reconciler });
  const autoTrader = createAutoTrader({ store, trader, say,
    telegramSilentMs: () => botApi.telegramSilentMs() });
  botApi.attachAutoTrader(autoTrader);
  botApi.attachNarrative(createNarrative({ cli }));

  /* 重開機不會自動接續武裝：上次的武裝時效若還沒過，也要你重新確認。
     機器人在你不知情的情況下重啟並繼續花錢，是不能接受的。 */
  if(store.isAutoArmed()){
    store.disarmAuto("機器人重新啟動");
    log.info("啟動時解除舊的自動武裝", {});
  }

  /* 先對帳再開始跑。機器人關著的這段期間，伺服器端的停損可能已經成交了；
     等第一個監控間隔才發現的話，中間任何一次 /status 或自動交易的風控判斷
     都是拿過期的帳本在算。 */
  try {
    const r = await reconciler.run();
    if(r.closed || r.flagged) log.info("啟動對帳", r);
  } catch(e){
    log.warn("啟動對帳失敗，交給監控迴圈重試", { error: e.message });
  }

  const heartbeat = createHeartbeat({ store, say });
  monitor.start();
  heartbeat.start();
  if(config.mode.autoBuy) autoTrader.start();

  log.info("機器人啟動", {
    mode: config.mode.dryRun ? "DRY_RUN" : "LIVE",
    autoBuy: config.mode.autoBuy,
    chain: config.gmgn.chain,
    positionUsd: config.risk.positionUsd,
    openPositions: store.openPositions().length
  });

  await say([
    "🐸 機器人已啟動",
    config.mode.dryRun ? "🧪 模擬模式（不會動到真錢）" : "💸 真錢模式",
    config.mode.autoBuy
      ? "🤖 自動交易：已啟用但待命中（重啟會解除武裝）。用 /auto on 武裝。"
      : "🤖 自動交易：未啟用",
    `持倉 ${store.openPositions().length} 個　今日已實現 $${store.realizedToday().toFixed(2)}`,
    "",
    "/help 看指令。"
  ].join("\n")).catch(e => log.error("送不出啟動訊息", { error: e.message }));

  /* code 0 = 正常關閉，守門員不會再拉起來。
     非 0 = 守門員會重啟，這正是 /restart 用的機制。 */
  const shutdown = (signal, code = 0) => {
    log.info("收到關閉訊號，停止", { signal, code });
    monitor.stop();
    heartbeat.stop();
    autoTrader.stop();
    /* 持倉的停損停利掛在 GMGN 伺服器端，關掉機器人不影響它們 */
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /* Telegram 的 /restart：結束自己，讓守門員把自己拉回來。
     bot.js 那邊已經確認過「真的有守門員在看」才會走到這裡。 */
  botApi.attachRestart((reason, code) => shutdown(reason, code));
  process.on("unhandledRejection", e => log.error("未處理的 rejection", { error: e?.message ?? String(e) }));
}

main().catch(e => {
  log.error("啟動失敗", { error: e.message });
  process.exit(1);
});
