/* 下單前的權威閘門：用 `token info` + `token security` 的欄位做判定。
   欄位路徑與門檻完全照 gmgn-token-buy/references/{fields,thresholds}.md，
   不在那兩份清單裡的欄位一律當作不存在，不自己發明判準。

   三態原則：拿不到資料 = 未知 ≠ 不合格。只有明確為真的風險才擋。 */

import { num, volPoolBand } from "./score.js";

function tri(v){
  if(v === 1 || v === true || v === "1" || v === "true") return true;
  if(v === 0 || v === false || v === "0" || v === "false") return false;
  return null;
}
/* 稅率空字串 = 未測，不能當成 0 */
function taxOf(v){ return v === "" || v == null ? null : num(v); }

/* 單邊可交易深度。
   兩側都 > 0 取較小值；任一側為 0 或缺失時退回 liquidity/2 ——
   上游對某一側沒定價是資料缺失，不是「池子裡沒幣」。 */
export function singleSidedDepth(pool){
  if(!pool) return { depth: 0, basis: "無池子資料", known: false };
  const base = num(pool.base_reserve_value);
  const quote = num(pool.quote_reserve_value);
  if(base > 0 && quote > 0) return { depth: Math.min(base, quote), basis: "兩側取小", known: true };
  const liq = num(pool.liquidity);
  if(liq > 0) return { depth: liq / 2, basis: "liquidity/2（某一側無報價）", known: true };
  return { depth: 0, basis: "拿不到深度", known: false };
}

/* 蜜罐四層，任一層有值就採用（fields.md） */
export function honeypotVerdict(security, info){
  const a = tri(security?.is_honeypot);
  if(a !== null) return { honeypot: a, basis: "is_honeypot" };
  const h = security?.honeypot;
  if(h === 1 || h === "1") return { honeypot: true, basis: "honeypot=1" };
  if(h === 0 || h === "0") return { honeypot: false, basis: "honeypot=0" };
  if(tri(security?.can_not_sell) === true) return { honeypot: true, basis: "can_not_sell=1" };
  const sells24 = num(info?.price?.sells_24h);
  if(sells24 > 0) return { honeypot: false, basis: "24h 有真實賣出" };
  return { honeypot: null, basis: "未測" };
}

export function riskLevelOf(rugRatio){
  if(rugRatio == null) return { level: "unknown", emoji: "⚪", label: "未知" };
  if(rugRatio < 0.1) return { level: "low", emoji: "🟢", label: "低" };
  if(rugRatio <= 0.3) return { level: "medium", emoji: "🟡", label: "中" };
  return { level: "high", emoji: "🔴", label: "高" };
}

/* 回傳 { pass, blocks, warnings, downgrade, metrics }
   blocks 非空就不下單。downgrade 代表可以下單但要改執行方式。 */
export function evaluateGate({ info, security, chain = "sol", minDepthUsd = 30000, positionUsd = 20 }){
  const blocks = [];
  const warnings = [];
  const downgrade = [];

  const price = info?.price ?? {};
  const pool = info?.pool ?? {};
  const stat = info?.stat ?? {};
  const dev = info?.dev ?? {};

  /* ── 一、量 ───────────────────────────────── */
  const vol24 = num(price.volume_24h);
  const swaps1h = num(price.swaps_1h);
  if(vol24 > 0 && vol24 < 50000) blocks.push(`24h 成交額 $${Math.round(vol24).toLocaleString()} 低於 $50,000`);
  if(swaps1h > 0 && swaps1h < 10) blocks.push(`1h 成交筆數 ${swaps1h} 低於 10`);
  if(vol24 === 0 && swaps1h === 0) warnings.push("拿不到成交量資料");

  /* ── 二、深度 ─────────────────────────────── */
  const { depth, basis, known } = singleSidedDepth(pool);
  const holders = num(info?.holder_count);
  /* pool 回的不一定是最深的池，深度只是下限 */
  const multiPool = pool.pool_address && info?.biggest_pool_address &&
                    pool.pool_address !== info.biggest_pool_address;

  if(!known){
    warnings.push("拿不到池子深度，無法確認出場滑價");
  } else if(depth < minDepthUsd){
    if(multiPool && vol24 >= depth * 10){
      warnings.push(`主池深度 $${Math.round(depth).toLocaleString()} 未達門檻，但這只是下限（還有別的池），24h 成交額是它的 ${(vol24 / depth).toFixed(0)} 倍，放行`);
    } else {
      blocks.push(`單邊深度 $${Math.round(depth).toLocaleString()} 低於 $${minDepthUsd.toLocaleString()}（${basis}）`);
    }
  }
  /* 你這筆單相對於深度的佔比，是滑價的直接來源 */
  if(depth > 0){
    const impactProxy = positionUsd / depth * 100;
    if(impactProxy > 3) warnings.push(`下單金額佔單邊深度 ${impactProxy.toFixed(1)}%，滑價會很痛，建議減碼或分批`);
  }

  /* 量/池比 */
  if(depth > 0 && vol24 > 0){
    const vpr = vol24 / depth;
    const [lo, hi] = volPoolBand(depth);
    if(vpr < lo){
      blocks.push(`量/池比 ${vpr.toFixed(2)}x 低於下限 ${lo}，死盤`);
    } else if(vpr > hi){
      /* 超上限不等於刷量：持有人多就是爆拉；多池的幣本來就會偏高 */
      if(multiPool) warnings.push(`量/池比 ${vpr.toFixed(1)}x 偏高，但這個幣有多個池，屬正常`);
      else if(holders >= 150) warnings.push(`量/池比 ${vpr.toFixed(1)}x 超出區間，${holders} 個持有人在搶，判爆拉（高波動）`);
      else blocks.push(`量/池比 ${vpr.toFixed(1)}x 超出區間且持有人只有 ${holders}，像刷量`);
    }
  }

  /* ── 三、安全 ─────────────────────────────── */
  const hp = honeypotVerdict(security, info);
  if(hp.honeypot === true) blocks.push(`蜜罐（依據 ${hp.basis}）：買得進賣不掉`);
  if(hp.honeypot === null) warnings.push("蜜罐檢測未測，無法確認賣得掉");

  const sellTax = taxOf(security?.sell_tax);
  const buyTax = taxOf(security?.buy_tax);
  if(sellTax != null && sellTax > 10) blocks.push(`賣出稅 ${sellTax}%`);
  else if(sellTax == null) warnings.push("稅率未測");
  if(buyTax != null && buyTax > 10) warnings.push(`買入稅 ${buyTax}%`);

  const rugRatio = security?.rug_ratio == null ? null : num(security.rug_ratio);
  const risk = riskLevelOf(rugRatio);
  if(rugRatio != null && rugRatio > 0.3) blocks.push(`rug_ratio ${rugRatio.toFixed(2)}，屬高風險`);

  const top10 = num(security?.top_10_holder_rate ?? stat.top_10_holder_rate);
  if(top10 > 0.5) blocks.push(`前十持有 ${(top10 * 100).toFixed(0)}%，一個地址就能砸穿`);
  else if(top10 > 0.3) warnings.push(`前十持有 ${(top10 * 100).toFixed(0)}%，籌碼偏集中`);

  /* Solana 看增發/凍結權限；EVM 看 is_renounced（另一邊恆為 null 或 false，不能互用） */
  if(chain === "sol"){
    if(tri(security?.renounced_mint) === false) blocks.push("增發權限沒放棄，對方可以隨時印鈔");
    if(tri(security?.renounced_freeze_account) === false) warnings.push("凍結權限沒放棄，你的代幣可能被凍結");
  } else {
    if(tri(security?.is_renounced ?? security?.renounced) === false) warnings.push("合約權限未放棄");
    if(tri(security?.is_open_source) === false) warnings.push("合約未開源");
  }

  /* 開發者現在還握著多少 —— 用 stat.creator_hold_rate，不是 dev.top_10_holder_rate */
  const creatorHold = num(stat.creator_hold_rate);
  if(creatorHold > 0.15) blocks.push(`開發者還握著 ${(creatorHold * 100).toFixed(0)}%`);
  else if(creatorHold > 0.05) warnings.push(`開發者持有 ${(creatorHold * 100).toFixed(0)}%`);
  if(dev.creator_token_status === "creator_close") warnings.push("開發者已清倉");
  if(num(dev.twitter_name_change_history?.length) > 0) warnings.push("專案推特改過名，仿盤/跑路訊號");

  const ratTrader = num(stat.top_rat_trader_percentage);
  const bundler = num(stat.top_bundler_trader_percentage);
  const sniper = num(stat.top70_sniper_hold_rate);
  if(ratTrader > 30) warnings.push(`老鼠倉佔比 ${ratTrader.toFixed(0)}%`);
  if(bundler > 30) warnings.push(`捆綁錢包佔比 ${bundler.toFixed(0)}%`);
  if(sniper > 30) warnings.push(`狙擊者還握著 ${sniper.toFixed(0)}%`);

  /* ── 四、方向與波動：只決定執行方式，唯一硬停是 5m 回撤 ≥10% ── */
  const now = num(price.price);
  const p5m = num(price.price_5m);
  let drawdown5m = null;
  if(now > 0 && p5m > 0){
    drawdown5m = (now - p5m) / p5m * 100;
    if(drawdown5m <= -10){
      blocks.push(`5 分鐘跌 ${drawdown5m.toFixed(1)}%，市價單會成交在下落的刀口上`);
    } else if(drawdown5m <= -5){
      downgrade.push({
        reason: `5 分鐘回撤 ${drawdown5m.toFixed(1)}%`,
        action: "建議改掛限價單",
        limitPrice: now * (1 - Math.abs(drawdown5m) / 100)
      });
    }
  }

  /* 逐窗口淨流向：三個窗口全部賣 > 買才算持續賣壓 */
  const windows = ["5m", "1h", "24h"];
  const netFlows = windows.map(w => ({
    w,
    net: num(price[`buy_volume_${w}`]) - num(price[`sell_volume_${w}`]),
    has: price[`buy_volume_${w}`] != null || price[`sell_volume_${w}`] != null
  }));
  const measured = netFlows.filter(f => f.has);
  if(measured.length === windows.length && measured.every(f => f.net < 0)){
    downgrade.push({
      reason: "5m / 1h / 24h 三個窗口淨流向全為賣超",
      action: drawdown5m != null && drawdown5m <= -5 ? "強制改限價單" : "建議改限價單",
      forced: drawdown5m != null && drawdown5m <= -5
    });
  }
  if(measured.length === 0) downgrade.push({ reason: "拿不到方向資料", action: "不建議市價單" });

  /* 暴漲後接賣壓：不上調滑點，改提示減碼 */
  const p24 = num(price.price_24h);
  const net24 = netFlows.find(f => f.w === "24h")?.net ?? 0;
  if(p24 > 0 && now / p24 >= 100 && net24 < 0){
    warnings.push("24h 漲超過 100 倍且淨流向為負 —— 不要為了成交而放大滑點，該減碼或不買");
  }

  return {
    pass: blocks.length === 0,
    blocks,
    warnings,
    downgrade,
    risk,
    metrics: {
      depth, depthBasis: basis, depthIsLowerBound: !!multiPool,
      vol24, swaps1h, holders, top10, rugRatio, sellTax, buyTax,
      creatorHold, drawdown5m, price: now,
      honeypot: hp.honeypot, honeypotBasis: hp.basis
    }
  };
}
