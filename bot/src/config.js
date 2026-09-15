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
   打錯一個字元（…111 vs …112）會得到 "jupiter has no route" 這種看不出原因的錯誤。 */
export const CURRENCY = {
  sol: {
    native: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
    usdc:   { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }
  }
};

export const config = {
  telegram: {
    token: str("TELEGRAM_TOKEN", ""),
    ownerId: str("OWNER_ID", "")
  },
  gmgn: {
    /* 錢包位址要跟 API Key 綁定的那個一致。私鑰不在這裡 ——
       私鑰由 gmgn-cli 自己從 ~/.config/gmgn/.env 讀，這支程式不讀、不存、不傳。 */
    walletAddress: str("GMGN_WALLET_ADDRESS", ""),
    chain: str("CHAIN", "sol")
  },
  mode: {
    dryRun: bool("DRY_RUN", true)
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
    interval: str("TRENDING_INTERVAL", "1h"),
    alertCooldownHours: numEnv("ALERT_COOLDOWN_HOURS", 6)
  },
  timing: {
    scanIntervalSec: Math.max(60, numEnv("SCAN_INTERVAL_SEC", 300)),
    monitorIntervalSec: Math.max(30, numEnv("MONITOR_INTERVAL_SEC", 120))
  }
};

export function validateConfig(cfg = config){
  const errors = [];
  const warnings = [];

  if(!cfg.telegram.token) errors.push("TELEGRAM_TOKEN 沒設");
  if(!/^\d+$/.test(cfg.telegram.ownerId)) errors.push("OWNER_ID 必須是純數字的 Telegram user id");
  if(!cfg.mode.dryRun && !cfg.gmgn.walletAddress) errors.push("DRY_RUN=false 時必須設定 GMGN_WALLET_ADDRESS");

  if(cfg.gmgn.chain !== "sol"){
    warnings.push(`目前只在 sol 上完整測過。CHAIN=${cfg.gmgn.chain} 的稅率／權限欄位語意不同，風險自負`);
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
