import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, validateConfig } from "./config.js";
import { log } from "./log.js";
import { createStore } from "./store.js";
import { createCli } from "./gmgncli.js";
import { createTrader } from "./trader.js";
import { createBot } from "./bot.js";
import { createMonitor } from "./monitor.js";

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

  const store = createStore(STATE_FILE);
  const cli = createCli();
  const trader = createTrader({ cli, store });
  const { say } = createBot({ cli, store, trader });
  const monitor = createMonitor({ store, trader, say });

  monitor.start();

  log.info("機器人啟動", {
    mode: config.mode.dryRun ? "DRY_RUN" : "LIVE",
    chain: config.gmgn.chain,
    positionUsd: config.risk.positionUsd,
    openPositions: store.openPositions().length
  });

  await say([
    "🐸 機器人已啟動",
    config.mode.dryRun ? "🧪 模擬模式（不會動到真錢）" : "💸 真錢模式",
    `持倉 ${store.openPositions().length} 個　今日已實現 $${store.realizedToday().toFixed(2)}`,
    "",
    "/help 看指令。買入一律要你按確認鍵。"
  ].join("\n")).catch(e => log.error("送不出啟動訊息", { error: e.message }));

  const shutdown = signal => {
    log.info("收到關閉訊號，停止監控", { signal });
    monitor.stop();
    /* 持倉的停損停利掛在 GMGN 伺服器端，關掉機器人不影響它們 */
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", e => log.error("未處理的 rejection", { error: e?.message ?? String(e) }));
}

main().catch(e => {
  log.error("啟動失敗", { error: e.message });
  process.exit(1);
});
