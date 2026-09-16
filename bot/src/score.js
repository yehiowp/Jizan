/* 對 GMGN `market trending` 回傳的欄位評分。
   門檻數值出自 gmgn-token-buy/references/thresholds.md，改動請一起改那邊的註記。 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const num = v => {
  if(v === "" || v == null) return 0;          // 稅率欄位空字串代表未測，不是 0，另外處理
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/* 三態：true / false / null(未知)。未知不等於不合格 —— Solana 的 is_renounced 恆為 null。 */
function tri(v){
  if(v === 1 || v === true || v === "1" || v === "true") return true;
  if(v === 0 || v === false || v === "0" || v === "false") return false;
  return null;
}

function logScore(v, lo, hi, max){
  if(!(v > 0) || v <= lo) return 0;
  return clamp(Math.log(v / lo) / Math.log(hi / lo), 0, 1) * max;
}
function bandScore(v, lo, best1, best2, hi, max){
  if(!(v > lo) || v >= hi) return 0;
  if(v >= best1 && v <= best2) return max;
  if(v < best1) return (v - lo) / (best1 - lo) * max;
  return (hi - v) / (hi - best2) * max;
}

/* 量/池比的合理區間依池子規模分檔（thresholds.md 一、） */
export function volPoolBand(depthUsd){
  if(depthUsd < 100000) return [0.30, 15];
  if(depthUsd < 1000000) return [0.15, 12];
  return [0.05, 30];
}

export function evaluate(row, { minDepthUsd = 30000, chain = "sol" } = {}){
  /* liquidity 是池子兩側之和，約等於單邊可交易深度的兩倍 */
  const liquidity = num(row.liquidity);
  const depth = liquidity / 2;
  const volume = num(row.volume);
  const price = num(row.price);
  const swaps = num(row.swaps);
  const buys = num(row.buys);
  const sells = num(row.sells);
  const holders = num(row.holder_count);
  const ch1h = num(row.price_change_percent1h);
  const ch5m = num(row.price_change_percent5m);
  const chInterval = num(row.price_change_percent);
  const rugRatio = num(row.rug_ratio);
  const top10 = num(row.top_10_holder_rate);
  const devHold = num(row.dev_team_hold_rate);
  const bundler = num(row.bundler_rate);
  const insider = num(row.rat_trader_amount_rate);
  const lockPct = num(row.lock_percent);
  const sellTax = row.sell_tax === "" || row.sell_tax == null ? null : num(row.sell_tax);
  const buyTax = row.buy_tax === "" || row.buy_tax == null ? null : num(row.buy_tax);
  const washTrading = tri(row.is_wash_trading);
  const honeypot = tri(row.is_honeypot);
  const renouncedMint = tri(row.renounced_mint);
  const renouncedFreeze = tri(row.renounced_freeze_account);
  const burned = typeof row.burn_status === "string" && row.burn_status !== "" && row.burn_status !== "none";
  const created = num(row.open_timestamp) || num(row.creation_timestamp);
  const ageMin = created > 0 ? (Date.now() / 1000 - created) / 60 : null;

  const vpr = depth > 0 ? volume / depth : 0;
  const [vprLo, vprHi] = volPoolBand(depth);
  const buyRatio = (buys + sells) > 0 ? buys / (buys + sells) : 0.5;

  /* 安全結構分：Solana 看 mint/freeze 是否放棄，EVM 看 is_renounced（三態，未知不扣分） */
  let safety = 0;
  if(chain === "sol"){
    if(renouncedMint === true) safety += 4;
    if(renouncedFreeze === true) safety += 3;
  } else {
    if(tri(row.is_renounced) === true) safety += 4;
    if(tri(row.is_open_source) === true) safety += 3;
  }
  if(burned || lockPct >= 50) safety += 3;

  /* 聰明錢與 KOL 的實際持倉。
     這是整張表裡唯一「有紀錄的人拿真錢投票」的訊號，比名字熱度或動能可靠，
     所以給的權重不低。但它也最容易被反向利用（KOL 出貨給你），
     因此只加分、不當作放行條件 —— 紅旗照樣一票否決。 */
  const smartCount = num(row.smart_degen_count);
  const kolCount = num(row.renowned_count ?? row.kol_count);
  const smartScore = clamp(logScore(smartCount, 1, 25, 8) + logScore(kolCount, 1, 12, 6), 0, 12);

  const factors = [
    { k: "單邊深度",   v: `$${Math.round(depth)}`,            s: logScore(depth, 15000, 500000, 15), max: 15 },
    { k: "量/池比",    v: `${vpr.toFixed(2)}x`,               s: bandScore(vpr, vprLo * 0.5, vprLo, vprHi, vprHi * 1.6, 13), max: 13 },
    { k: "買賣壓",     v: `${(buyRatio * 100).toFixed(0)}%`,  s: bandScore(buyRatio, 0.40, 0.55, 0.78, 0.94, 11), max: 11 },
    { k: "動能",       v: `1h ${ch1h.toFixed(1)}% / 5m ${ch5m.toFixed(1)}%`, s: momentum(ch1h, ch5m, chInterval), max: 14 },
    { k: "聰明錢/KOL", v: `${smartCount} / ${kolCount} 人`,   s: smartScore, max: 12 },
    { k: "持有人數",   v: String(holders),                    s: logScore(holders, 80, 4000, 10), max: 10 },
    { k: "成交筆數",   v: String(swaps),                      s: logScore(swaps, 20, 2000, 7), max: 7 },
    { k: "籌碼分散",   v: `前十 ${(top10 * 100).toFixed(0)}%`, s: top10 > 0 ? clamp((0.5 - top10) / 0.35, 0, 1) * 8 : 4, max: 8 },
    { k: "安全結構",   v: safetyLabel({ chain, renouncedMint, renouncedFreeze, burned, lockPct }), s: safety, max: 10 }
  ];

  const metrics = { depth, liquidity, volume, vpr, vprLo, vprHi, holders, swaps, buys, sells,
                    ch1h, ch5m, rugRatio, top10, devHold, bundler, insider, sellTax, buyTax,
                    washTrading, honeypot, renouncedMint, ageMin, price };
  const flags = redFlags(metrics, { minDepthUsd, chain });

  let score = factors.reduce((a, x) => a + x.s, 0);
  if(flags.length) score = Math.min(score, 35);

  return {
    chain: row.chain ?? chain,
    address: row.address ?? "",
    symbol: sanitize(row.symbol) || "?",
    name: sanitize(row.name) || "",
    price, liquidity, depth, volume, holders, swaps, ageMin,
    ch1h, ch5m, rugRatio, top10, smartCount, kolCount,
    score: Math.round(score),
    factors,
    flags,
    grade: flags.length ? "D" : score >= 72 ? "A" : score >= 58 ? "B" : score >= 44 ? "C" : "D",
    raw: row
  };
}

function momentum(ch1h, ch5m, chInterval){
  if(ch5m <= -10) return 0;                   // 正在垂直下砸，市價單會成交在刀口上
  if(ch1h > 900) return 0;                    // 已經噴完
  let s = 0;
  if(ch1h > 0) s += clamp(ch1h / 30, 0, 1) * 8;
  if(ch5m > 0) s += clamp(ch5m / 8, 0, 1) * 4;
  if(chInterval > 0) s += 2;
  return clamp(s, 0, 14);
}

function safetyLabel({ chain, renouncedMint, renouncedFreeze, burned, lockPct }){
  const bits = [];
  if(chain === "sol"){
    bits.push(renouncedMint === true ? "已棄增發" : renouncedMint === false ? "可增發" : "增發未知");
    bits.push(renouncedFreeze === true ? "已棄凍結" : renouncedFreeze === false ? "可凍結" : "凍結未知");
  }
  bits.push(burned ? "池已燒" : lockPct >= 50 ? `鎖${lockPct}%` : "未鎖未燒");
  return bits.join("/");
}

/* 紅旗 = 一律不進場。這裡只用 thresholds.md 列出的欄位，不自己發明判準。 */
export function redFlags(m, { minDepthUsd = 30000, chain = "sol" } = {}){
  const out = [];

  if(m.honeypot === true) out.push("蜜罐：買得進賣不掉");
  if(m.sellTax != null && m.sellTax > 10) out.push(`賣出稅 ${m.sellTax}%`);
  if(m.rugRatio > 0.3) out.push(`rug_ratio ${m.rugRatio.toFixed(2)}，高風險`);
  if(m.washTrading === true) out.push("GMGN 標記為刷量");
  if(m.depth < minDepthUsd) out.push(`單邊深度 $${Math.round(m.depth)} 低於門檻 $${minDepthUsd}`);
  if(m.volume < 50000) out.push(`24h 量 $${Math.round(m.volume)} 低於 $50,000`);
  if(m.swaps < 10) out.push("成交筆數過少");
  if(m.top10 > 0.5) out.push(`前十持有 ${(m.top10 * 100).toFixed(0)}%，一個人就能砸穿`);
  if(m.devHold > 0.15) out.push(`開發者還握著 ${(m.devHold * 100).toFixed(0)}%`);
  if(m.bundler > 0.3) out.push(`捆綁機器人佔量 ${(m.bundler * 100).toFixed(0)}%`);
  if(m.insider > 0.3) out.push(`老鼠倉佔量 ${(m.insider * 100).toFixed(0)}%`);
  if(m.ch5m <= -10) out.push(`5 分鐘跌 ${m.ch5m.toFixed(1)}%，這單會成交在刀口上`);
  if(chain === "sol" && m.renouncedMint === false) out.push("增發權限沒放棄，對方可以隨時印鈔");

  /* 量/池比：超上限且持有人少 = 刷量；低於下限 = 死盤（thresholds.md 一、） */
  if(m.vpr > m.vprHi && m.holders < 150) out.push(`量/池比 ${m.vpr.toFixed(1)}x 超出區間且持有人只有 ${m.holders}，像刷量`);
  if(m.vpr > 0 && m.vpr < m.vprLo) out.push(`量/池比 ${m.vpr.toFixed(2)}x 低於下限，是個死盤`);

  return out;
}

/* 代幣名稱是鏈上任何人都能填的欄位，顯示前先清掉控制字元與過長內容。
   用 code point 逐字檢查，避免在原始碼裡直接寫控制字元。 */
export function sanitize(s, maxLen = 40){
  if(typeof s !== "string") return "";
  let out = "";
  for(const chr of s){
    const cp = chr.codePointAt(0);
    const isControl = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    /* 雙向文字覆寫字元（0x202a-0x202e、0x2066-0x2069、0x061c）也要濾掉。
       它們不是隱形的，是會「重排後面的字」—— 一個幣名可以靠它在 Telegram 上
       把地址或數字顯示成相反的順序，你看到的跟實際送出去的不是同一個東西。
       0x200b-0x200f 只擋到零寬字元和前兩個方向標記，擋不到覆寫那一段。 */
    const isInvisible = (cp >= 0x200b && cp <= 0x200f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff;
    const isBidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x061c;
    const isMarkup = chr === "<" || chr === ">" || chr === "&";
    if(isControl || isInvisible || isBidi || isMarkup) continue;
    out += chr;
    if(out.length >= maxLen) break;
  }
  return out.trim();
}
