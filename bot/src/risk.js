import { config } from "./config.js";

/* 所有「能不能開這一單」的判斷都集中在這裡。
   trader 只負責執行，任何拒絕理由都必須從這個函式出來。 */
export function checkBuy({ store, coin, usdAmount, cfg = config, equityUsd = null }){
  const reasons = [];
  const r = cfg.risk;
  const s = store.state;

  if(!s.tradingEnabled) reasons.push(`交易已停用${s.disabledReason ? "：" + s.disabledReason : ""}`);

  if(coin?.flags?.length) reasons.push(`紅旗 ${coin.flags.length} 面：${coin.flags[0]}`);
  if(coin && coin.score < cfg.filter.minScore) reasons.push(`分數 ${coin.score} 低於門檻 ${cfg.filter.minScore}`);

  if(!(usdAmount > 0)) reasons.push("下單金額必須大於 0");
  if(usdAmount > r.positionUsd) reasons.push(`單筆上限 $${r.positionUsd}，你要求 $${usdAmount}`);

  const open = store.openPositions();
  if(open.length >= r.maxOpenPositions) reasons.push(`持倉已達上限 ${r.maxOpenPositions}`);

  const addr = coin?.address;
  if(addr && open.some(p => p.tokenAddress === addr)) reasons.push(`${coin.symbol} 已經有部位了`);

  const deployed = store.deployedUsd();
  if(deployed + usdAmount > r.maxDeployedUsd){
    reasons.push(`在場資金會到 $${(deployed + usdAmount).toFixed(2)}，超過上限 $${r.maxDeployedUsd}`);
  }

  const today = store.realizedToday();
  if(today <= -r.maxDailyLossUsd) reasons.push(`今日已虧 $${Math.abs(today).toFixed(2)}，達單日上限`);

  const equity = equityUsd ?? (r.bankrollUsd + store.realizedTotal());
  if(equity < r.killSwitchUsd) reasons.push(`淨值 $${equity.toFixed(2)} 低於停機線 $${r.killSwitchUsd}`);

  return { ok: reasons.length === 0, reasons };
}

/* 停損 / 停利只用來「提醒」—— 真正的出場掛在 GMGN 伺服器端。
   這裡回報的是「照理說該出場了」，用來偵測策略單沒生效的情況。 */
export function exitSignal(position, lastPrice, cfg = config){
  if(!(lastPrice > 0)) return null;
  if(lastPrice <= position.stopPrice) return { reason: "停損", urgent: true };
  if(lastPrice >= position.targetPrice) return { reason: "停利", urgent: false };
  return null;
}
