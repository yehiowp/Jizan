import dotenv from "dotenv";
dotenv.config();

function str(key, fallback){
  const v = process.env[key];
  return v == null || v === "" ? fallback : String(v).trim();
}
function numEnv(key, fallback){
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(key, fallback){
  const v = process.env[key];
  if(v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/* 幣種地址照 gmgn-swap 的 Chain Currencies 表抄，絕不憑記憶打。
   打錯一個字元（…111 vs …112）會得到 "jupiter has no route" 這種看不出原因的錯誤。

   tradable:false 代表「可以掃描分析，但不准下單」—— 官方幣種表沒有列出那條鏈的
   幣種地址，猜一個等於拿你的錢去賭我記錯沒有。 */
export const CURRENCY = {
  sol: {
    native: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
    usdc:   { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    feeStyle: "sol",      // --priority-fee + --tip-fee（掛條件單時兩者必填）
    antiMev: true,
    tradable: true
  },
  bsc: {
    native: { symbol: "BNB", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    usdc:   { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
    feeStyle: "evm",      // --gas-price（gwei，≥0.05）+ --tip-fee（≥0.000001 BNB）
    minGasPriceGwei: 0.05,
    antiMev: true,
    tradable: true
  },
  base: {
    native: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    usdc:   { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    feeStyle: "evm",
    minGasPriceGwei: 0.01,
    antiMev: false,       // 文件明講 base 不支援防夾
    tradable: true
  },
  eth: {
    native: { symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    feeStyle: "evm",
    minGasPriceGwei: 0.01,
    antiMev: true,
    tradable: true
  },
  robinhood: {
    /* 官方 Chain Currencies 表沒有這條鏈的幣種地址。掃描與安全檢查照常，
       但下單需要 --input-token，沒有可靠地址就不下單。 */
    feeStyle: "unknown",
    antiMev: false,
    tradable: false,
    untradableReason: "官方幣種表沒有列 robinhood 的幣種地址，沒有可靠的 --input-token 就不下單"
  }
};

/* 這條鏈能不能下單 */
export function chainTradable(chain){
  const c = CURRENCY[chain];
  if(!c) return { ok: false, reason: `不認得的鏈：${chain}` };
  if(!c.tradable) return { ok: false, reason: c.untradableReason ?? "這條鏈尚未支援下單" };
  return { ok: true };
}

export const config = {
  telegram: {
    token: str("TELEGRAM_TOKEN", ""),
    ownerId: str("OWNER_ID", "")
  },
  gmgn: {
    /* 錢包位址要跟 API Key 綁定的那個一致。私鑰不在這裡 ——
       私鑰由 gmgn-cli 自己從 ~/.config/gmgn/.env 讀，這支程式不讀、不存、不傳。 */
    walletAddress: str("GMGN_WALLET_ADDRESS", ""),
    chain: str("CHAIN", "sol"),
    /* 要掃描的鏈，逗號分隔。留空就只掃 CHAIN 那一條。
       多鏈只影響掃描範圍；風控上限（部位數、在場資金、單日虧損）仍然是全域共用的。 */
    chains: str("CHAINS", "").split(",").map(x => x.trim()).filter(Boolean)
  },
  /* 本機 Meme 雷達（meme-radar）。設了就用它取候選，不再自己敲 GMGN 的熱門榜。
     它只縮小名單，不核可任何一顆幣 —— 買不買仍然由機器人自己 vet() 之後的閘門決定。 */
  radar: {
    url: str("RADAR_URL", ""),
    /* 雷達連不上時要不要改用 GMGN 熱門榜。預設 false：
       接雷達的目的就是不要兩個程式搶同一份額度，自動退回去等於默默把問題放回來。 */
    fallbackToGmgn: bool("RADAR_FALLBACK_TO_GMGN", false)
  },
  mode: {
    dryRun: bool("DRY_RUN", true),
    /* 自動交易：預設關閉。開啟後還要在 Telegram 用 /auto on 武裝，
       而且武裝會自己到期 —— 沒有「設定完就放著跑一個月」這種模式。 */
    autoBuy: bool("AUTO_BUY", false)
  },
  auto: {
    /* 自動模式的門檻一律比手動嚴：它沒有你的判斷力，只能靠更高的標準補 */
    minScore: numEnv("AUTO_MIN_SCORE", 72),
    maxWarnings: Math.round(numEnv("AUTO_MAX_WARNINGS", 2)),
    allowDowngrade: bool("AUTO_ALLOW_DOWNGRADE", false),
    maxTradesPerDay: Math.round(numEnv("AUTO_MAX_TRADES_PER_DAY", 4)),
    maxSpendPerDayUsd: numEnv("AUTO_MAX_SPEND_PER_DAY_USD", 60),
    armHours: numEnv("AUTO_ARM_HOURS", 12),
    /* 一輪驗幾顆、同時驗幾顆。併發數要壓在限流漏桶容量（20）之下：
       每顆 2 個請求，併發 4 就是一次 8 個，還有餘裕給監控和報價。 */
    vetBatchSize: Math.round(numEnv("AUTO_VET_BATCH", 8)),
    vetConcurrency: Math.round(numEnv("AUTO_VET_CONCURRENCY", 4)),
    /* 連不上 Telegram 超過這麼久就自動解除武裝（分鐘）。
       「你叫不停它」和「它在花錢」不該同時成立。 */
    deadManMs: Math.max(60000, numEnv("AUTO_DEADMAN_MINUTES", 15) * 60000)
  },
  risk: {
    bankrollUsd: numEnv("BANKROLL_USD", 100),
    positionUsd: numEnv("POSITION_USD", 20),
    maxOpenPositions: Math.round(numEnv("MAX_OPEN_POSITIONS", 3)),
    maxDeployedUsd: numEnv("MAX_DEPLOYED_USD", 60),
    maxDailyLossUsd: numEnv("MAX_DAILY_LOSS_USD", 20),
    killSwitchUsd: numEnv("KILL_SWITCH_USD", 60),
    stopPct: numEnv("STOP_PCT", 35),
    targetR: numEnv("TARGET_R", 2),
    trailingDrawdownPct: numEnv("TRAILING_DRAWDOWN_PCT", 0)  // >0 就把停利改成移動停利
  },
  exec: {
    slippagePct: Math.round(numEnv("SLIPPAGE_PCT", 15)),   // CLI 要整數 0–100
    gasTier: str("GAS_TIER", "average"),                   // low / average / high
    antiMev: bool("ANTI_MEV", true),
    tipFeeSol: numEnv("TIP_FEE_SOL", 0.001),
    sellRatioType: str("SELL_RATIO_TYPE", "hold_amount")
  },
  filter: {
    minScore: numEnv("MIN_SCORE", 62),
    minDepthUsd: numEnv("MIN_DEPTH_USD", 30000),
    interval: str("TRENDING_INTERVAL", "5m"),
    alertCooldownHours: numEnv("ALERT_COOLDOWN_HOURS", 6)
  },
  timing: {
    scanIntervalSec: Math.max(30, numEnv("SCAN_INTERVAL_SEC", 90)),
    monitorIntervalSec: Math.max(20, numEnv("MONITOR_INTERVAL_SEC", 60)),
    /* 心跳：無人看管時，「沒收到訊息」不該等於「沒事發生」，
       也可能是它早就掛了而你不知道。0 = 關閉。 */
    heartbeatHours: numEnv("HEARTBEAT_HOURS", 12),
    /* 送給 GMGN 的請求之間最少隔多久。GMGN 的違規次數是跨行程累積的，
       所以「不要瞬間爆量」不夠 —— 一直貼著上限跑，累積起來還是會被封。
       程式偵測到限流訊號會自己把這個值加倍，但那只在那個行程裡有效；
       寫在 .env 的才是重啟後還在的。 */
    minRequestGapMs: Math.max(0, numEnv("MIN_REQUEST_GAP_MS", 350))
  }
};

export function validateConfig(cfg = config){
  const errors = [];
  const warnings = [];

  if(!cfg.telegram.token) errors.push("TELEGRAM_TOKEN 沒設");
  if(!/^\d+$/.test(cfg.telegram.ownerId)) errors.push("OWNER_ID 必須是純數字的 Telegram user id");
  if(!cfg.mode.dryRun && !cfg.gmgn.walletAddress) errors.push("DRY_RUN=false 時必須設定 GMGN_WALLET_ADDRESS");

  const scanChains = cfg.gmgn.chains.length ? cfg.gmgn.chains : [cfg.gmgn.chain];
  for(const c of scanChains){
    if(!CURRENCY[c]){ errors.push(`不認得的鏈：${c}（可用：${Object.keys(CURRENCY).join(" / ")}）`); continue; }
    if(!CURRENCY[c].tradable){
      warnings.push(`${c}：${CURRENCY[c].untradableReason} —— 會掃描與通知，但不會下單`);
    }
    if(c !== "sol"){
      warnings.push(`${c} 的欄位語意跟 sol 不同（EVM 看 is_renounced，sol 看 renounced_mint），實際下單前先用 npm run verify 驗過`);
    }
  }

  const r = cfg.risk;
  if(!(r.positionUsd > 0)) errors.push("POSITION_USD 必須大於 0");
  if(r.positionUsd > r.bankrollUsd) errors.push("POSITION_USD 不能大於 BANKROLL_USD");
  if(r.maxDeployedUsd > r.bankrollUsd) errors.push("MAX_DEPLOYED_USD 不能大於 BANKROLL_USD");
  if(r.stopPct <= 0 || r.stopPct >= 95) errors.push("STOP_PCT 必須介於 0 到 95 之間");
  if(r.killSwitchUsd >= r.bankrollUsd) errors.push("KILL_SWITCH_USD 必須小於 BANKROLL_USD，否則一啟動就停機");

  if(r.positionUsd * r.maxOpenPositions > r.maxDeployedUsd){
    warnings.push(`POSITION_USD × MAX_OPEN_POSITIONS (${r.positionUsd * r.maxOpenPositions}) 超過 MAX_DEPLOYED_USD (${r.maxDeployedUsd})，實際會被後者卡住`);
  }
  if(r.maxDailyLossUsd > r.bankrollUsd * 0.5) warnings.push("MAX_DAILY_LOSS_USD 超過本金一半，一天就可能把帳戶打殘");
  if(cfg.exec.slippagePct > 30) warnings.push("SLIPPAGE_PCT 超過 30%，等於告訴機器人「隨便夾我」");
  if(r.positionUsd < 10) warnings.push(`部位只有 $${r.positionUsd}，扣掉手續費與滑價後幾乎不可能賺錢`);
  if(!["low", "average", "high"].includes(cfg.exec.gasTier)) errors.push("GAS_TIER 只能是 low / average / high");

  const a = cfg.auto;
  if(cfg.mode.autoBuy){
    if(a.minScore < cfg.filter.minScore){
      errors.push(`AUTO_MIN_SCORE (${a.minScore}) 不能低於 MIN_SCORE (${cfg.filter.minScore})：自動模式只能比手動嚴`);
    }
    if(a.maxTradesPerDay < 1) errors.push("AUTO_MAX_TRADES_PER_DAY 至少要 1");
    if(a.armHours <= 0 || a.armHours > 72) errors.push("AUTO_ARM_HOURS 必須介於 0 到 72 小時之間");
    if(a.vetConcurrency < 1 || a.vetConcurrency > 8){
      errors.push("AUTO_VET_CONCURRENCY 必須介於 1 到 8：再高會撞 GMGN 的限流漏桶");
    }
    if(a.vetBatchSize < 1) errors.push("AUTO_VET_BATCH 至少要 1");
    if(a.maxSpendPerDayUsd > cfg.risk.maxDeployedUsd){
      warnings.push(`AUTO_MAX_SPEND_PER_DAY_USD ($${a.maxSpendPerDayUsd}) 超過在場資金上限 ($${cfg.risk.maxDeployedUsd})，實際會被後者卡住`);
    }
    if(!cfg.mode.dryRun){
      warnings.push("自動交易 + 真錢模式：機器人會在你沒看螢幕的時候用自己的判斷花錢");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* 停損停利轉成 GMGN 的 condition_orders。
   price_scale 對 loss_stop 是「跌幅 %」，對 profit_stop 是「漲幅 %」。 */
export function buildConditionOrders(cfg = config){
  const { stopPct, targetR, trailingDrawdownPct } = cfg.risk;
  const gainPct = stopPct * targetR;
  const orders = [];

  if(trailingDrawdownPct > 0){
    orders.push({
      order_type: "profit_stop_trace",
      side: "sell",
      price_scale: String(gainPct),
      sell_ratio: "100",
      drawdown_rate: String(trailingDrawdownPct)
    });
  } else {
    orders.push({ order_type: "profit_stop", side: "sell", price_scale: String(gainPct), sell_ratio: "100" });
  }
  orders.push({ order_type: "loss_stop", side: "sell", price_scale: String(stopPct), sell_ratio: "100" });
  return orders;
}
