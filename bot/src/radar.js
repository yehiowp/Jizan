/* 從本機的 Meme 雷達（meme-radar）取候選名單，取代直接呼叫 GMGN 的熱門榜。

   為什麼要接：發現階段是請求量的大宗 —— 每輪掃描、每條鏈都要 trending + 熱搜。
   雷達已經在做這件事了，兩個程式各自去敲 GMGN 只是在互相搶額度。

   這裡有一條界線，寫在最前面因為它決定了安全性：

     雷達只能「縮小」要檢查的名單，永遠不能「核可」任何一顆幣。

   雷達回來的欄位不含 GMGN 的安全欄位（貔貅、rug_ratio、開發者持倉…），
   而閘門對未知欄位是不扣分的 —— 如果直接拿雷達的資料當閘門輸入，
   等於每顆幣都以「沒有紅旗」的姿態通過。
   所以拿到地址之後，機器人仍然自己跑 vet()（token info + security），
   由 GMGN 的原始欄位決定買不買。雷達影響的只有「先檢查誰」。

   雷達的輸出一律當成不可信資料：它是另一支程式，跑在你的機器上，
   欄位可能改版、可能有 bug、也可能被鏈上的代幣名稱塞進奇怪的字元。 */

import { sanitize } from "./score.js";

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validAddress(addr, chain){
  const a = String(addr ?? "");
  if(chain === "sol") return SOL_ADDR.test(a);
  if(["bsc", "base", "eth", "arbitrum"].includes(chain)) return EVM_ADDR.test(a);
  /* 不認得的鏈就兩種都接受，但長度仍要合理 —— 不能因為沒見過就照單全收 */
  return SOL_ADDR.test(a) || EVM_ADDR.test(a);
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;   // 不是 0 —— 讀不到跟是 0 不一樣
};

/* 雷達自己的判斷只用來排除，不用來核可。
   明確被它拒絕的就不要再花 GMGN 的額度去驗；其他一律往下送。 */
const REJECTED = new Set(["REJECTED", "拒絕", "拒绝"]);

export function normalizeCandidate(row, { chain }){
  if(!row || typeof row !== "object") return null;

  const address = String(row.address ?? "").trim();
  const rowChain = String(row.chain ?? chain).trim().toLowerCase();

  /* 鏈對不上就丟掉。拿別條鏈的地址去下單，最好的情況是失敗。 */
  if(rowChain !== chain) return null;
  if(!validAddress(address, chain)) return null;
  if(REJECTED.has(String(row.status ?? "").toUpperCase())) return null;

  return {
    address,
    chain,
    /* 幣名是鏈上欄位，發幣的人想寫什麼就寫什麼 —— 一律過濾 */
    symbol: sanitize(row.symbol ?? "?", 30),
    name: sanitize(row.name ?? "", 80),

    /* 對得上 GMGN 熱門榜欄位的就對過去，對不上的**留空**。
       補 0 會讓「讀不到」看起來像「真的是 0」，那是最糟的一種假資料。 */
    liquidity: num(row.liquidity),
    volume: num(row.volume1h),
    holder_count: num(row.holders),
    buys: num(row.buys),
    sells: num(row.sells),
    swaps: num(row.buys) !== undefined && num(row.sells) !== undefined
      ? num(row.buys) + num(row.sells) : undefined,
    price: num(row.price),
    market_cap: num(row.marketCap),

    /* 雷達自己的排序依據，只拿來決定「先驗誰」 */
    _radarScore: num(row.discoveryScore) ?? 0,
    _radarStatus: sanitize(row.status ?? "", 32),
    _radarReason: sanitize(row.decisionReason ?? "", 120),
    _source: "radar",
  };
}

export function createRadar({ url, fetchImpl = fetch, timeoutMs = 8000 } = {}){
  const base = String(url ?? "").replace(/\/+$/, "");
  if(!base) throw new Error("RADAR_URL 沒設定");

  async function get(path){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if(!res.ok) throw new Error(`雷達回應 HTTP ${res.status}`);
      return await res.json();
    } catch(e){
      /* 分清楚「雷達沒開」跟「雷達說沒有候選」。
         兩者混為一談的話，雷達掛掉會看起來像「今天沒有機會」，
         而那正是最不該被誤判成平靜的狀況。 */
      if(e.name === "AbortError") throw new Error(`連不上雷達（逾時 ${timeoutMs}ms）：${base}`);
      throw new Error(`連不上雷達 ${base}：${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url: base,

    async health(){
      const h = await get("/health");
      return { ok: true, raw: h };
    },

    /* 某條鏈目前的候選。回傳已經正規化、可以直接進評分的列。 */
    async candidates({ chain, limit = 100 }){
      const data = await get(`/api/status?chain=${encodeURIComponent(chain)}`);

      if(!data || typeof data !== "object") throw new Error("雷達回傳的不是物件");
      if(!Array.isArray(data.candidates)) throw new Error("雷達回傳裡沒有 candidates 陣列");

      const rows = data.candidates
        .slice(0, limit)
        .map(r => normalizeCandidate(r, { chain }))
        .filter(Boolean)
        .sort((a, b) => b._radarScore - a._radarScore);

      return {
        rows,
        /* 雷達自己的限流狀態。它跟機器人共用同一台機器，
           它被冷卻的時候機器人多半也該慢下來。 */
        rateLimits: num(data?.requestMetrics?.rateLimits),
        cooldownUntil: num(data?.requestMetrics?.cooldownUntil),
        scanning: data?.scheduler?.scanningChain ?? "",
        lastSuccessAt: num(data?.scheduler?.lastSuccessAt),
        gmgnConfigured: data?.gmgnConnection?.configured === true,
      };
    },
  };
}
