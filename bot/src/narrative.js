import { config } from "./config.js";
import { sanitize, num } from "./score.js";

/* 熱門 IP（題材）偵測。

   一個迷因 IP 真正熱起來的特徵，不是某一顆幣在漲，而是
   「同一個題材同時冒出一堆同名／近名的幣」。所以這裡不是排序熱門幣，
   而是把熱榜上的代幣名稱拆成關鍵字，找出重複出現的那個字 —— 那個字就是 IP。

   資料來源全部是 GMGN（hot-searches = 最多人搜尋，是注意力的直接代理；
   trending = 成交熱度）。推特原文需要付費的 X API / Grok API，
   沒設定就不抓，也不會拿舊知識瞎掰 —— 見 socialNote()。 */

/* 只濾掉結構性的字，不濾主題字。
   pepe / dog / cat / penguin 這些本身就可能是 IP，濾掉就什麼都找不到了。 */
const STOPWORDS = new Set([
  "coin", "token", "official", "the", "a", "an", "of", "and", "on", "in", "for",
  "my", "is", "it", "to", "by", "with", "finance", "protocol", "network", "labs",
  "lab", "dao", "io", "app", "fun", "meme", "memecoin", "crypto",
  "sol", "solana", "eth", "ethereum", "bsc", "bnb", "base", "usd", "usdt", "usdc",
  "inu", "swap", "pump", "moon", "safe", "baby", "mini", "wrapped", "new", "v2", "v3"
]);

export function keywords(...texts){
  const out = new Set();
  for(const text of texts){
    if(typeof text !== "string") continue;
    /* 用非字母數字切開，中日韓字元另外處理（它們不用空白分詞） */
    const latin = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for(const w of latin){
      if(w.length < 3) continue;           // 太短的字噪音大
      if(/^\d+$/.test(w)) continue;
      if(STOPWORDS.has(w)) continue;
      out.add(w);
    }
    /* CJK：連續兩個字為一組，抓得到「企鵝」「柴犬」這種詞 */
    const cjk = text.match(/[一-鿿぀-ヿ]{2,}/g) ?? [];
    for(const chunk of cjk){
      for(let i = 0; i + 2 <= chunk.length; i++) out.add(chunk.slice(i, i + 2));
    }
  }
  return [...out];
}

/* 把一批代幣分群成 IP。同一個關鍵字底下出現越多不同的幣，代表這個題材越熱。 */
export function clusterIps(tokens, { minTokens = 2 } = {}){
  const byKeyword = new Map();

  for(const t of tokens){
    const symbol = sanitize(t.symbol ?? "");
    const name = sanitize(t.name ?? "");
    for(const kw of keywords(symbol, name)){
      if(!byKeyword.has(kw)) byKeyword.set(kw, []);
      byKeyword.get(kw).push(t);
    }
  }

  const ips = [];
  for(const [kw, members] of byKeyword){
    /* 同一顆幣可能在熱搜和成交榜都出現，先去重 */
    const unique = [...new Map(members.map(m => [m.address, m])).values()];
    if(unique.length < minTokens) continue;

    const totalVolume = unique.reduce((s, m) => s + num(m.volume), 0);
    const totalLiq = unique.reduce((s, m) => s + num(m.liquidity), 0);
    const kolCount = unique.reduce((s, m) => s + num(m.renowned_count ?? m.kol_count), 0);
    const smartCount = unique.reduce((s, m) => s + num(m.smart_degen_count), 0);
    const holders = unique.reduce((s, m) => s + num(m.holder_count), 0);

    /* 領頭羊：流動性最深的那顆。仿盤幾乎一定比正主淺。 */
    const sorted = unique.slice().sort((a, b) => num(b.liquidity) - num(a.liquidity));
    const leader = sorted[0];
    const copycats = sorted.slice(1);

    /* 最新出現的時間，用來判斷這波是正在發生還是已經過去 */
    const newest = Math.max(...unique.map(m => num(m.open_timestamp) || num(m.creation_timestamp) || 0));
    const ageMin = newest > 0 ? (Date.now() / 1000 - newest) / 60 : null;

    ips.push({
      keyword: kw,
      tokenCount: unique.length,
      tokens: sorted,
      leader,
      copycats,
      totalVolume,
      totalLiq,
      kolCount,
      smartCount,
      holders,
      newestAgeMin: ageMin,
      /* 熱度 = 幾顆幣在搶這個題材 × 成交量級 × KOL 參與。
         用幣的「顆數」當主軸，因為那才是 IP 熱度的特徵訊號。 */
      heat: Math.round(
        unique.length * 10 +
        Math.log10(Math.max(totalVolume, 1)) * 6 +
        Math.min(kolCount, 20) * 1.5 +
        Math.min(smartCount, 20) * 1.0
      )
    });
  }

  return ips.sort((a, b) => b.heat - a.heat);
}

export function createNarrative({ cli, cfg = config }){
  const chain = cfg.gmgn.chain;

  /* 沒有付費的社群搜尋供應商就老實說沒有，不要用舊知識假裝知道推特在紅什麼。 */
  function socialNote(){
    const provider = process.env.SOCIAL_SEARCH_PROVIDER;
    const key = process.env.SOCIAL_SEARCH_API_KEY;
    if(provider && key) return { configured: true, provider };
    return {
      configured: false,
      note: "沒有設定 X API / Grok API，推特原文沒有納入。以下只根據 GMGN 的搜尋熱度與成交資料，"
          + "也就是「已經有人在鏈上動作」的題材 —— 會比推特慢半步，但不用付月費，也不是我瞎掰的。"
    };
  }

  return {
    socialNote,

    /* 抓熱搜 + 成交榜，合併後分群 */
    async hotIps({ interval = "1h", limit = 100, minTokens = 2 } = {}){
      const [hotSearch, trending] = await Promise.all([
        cli.run(["market", "hot-searches", "--chain", chain, "--interval", interval,
                 "--limit", String(limit), "--raw"]).then(unwrapList).catch(() => []),
        cli.trending({ chain, interval, limit }).catch(() => [])
      ]);

      /* 標記來源，之後要顯示「這個題材是在熱搜還是在成交榜上熱」 */
      const pool = [
        ...hotSearch.map(t => ({ ...t, _src: "熱搜" })),
        ...trending.map(t => ({ ...t, _src: "成交" }))
      ].filter(t => t?.address);

      const ips = clusterIps(pool, { minTokens });
      return { ips, scanned: pool.length, hotSearchCount: hotSearch.length, trendingCount: trending.length };
    },

    /* 對單一 IP 做仿盤風險判讀 —— 這是「熱門 IP」最大的坑 */
    copycatRisk(ip){
      const notes = [];
      const leaderLiq = num(ip.leader?.liquidity);
      const runnerLiq = num(ip.copycats[0]?.liquidity);

      if(ip.tokenCount >= 5){
        notes.push(`同題材有 ${ip.tokenCount} 顆幣在搶，買錯合約等於全損`);
      }
      if(leaderLiq > 0 && runnerLiq > 0 && runnerLiq / leaderLiq > 0.5){
        notes.push("第二名的流動性跟第一名很接近，誰是正主還沒分出來，這種時候進場等於猜");
      }
      if(ip.newestAgeMin != null && ip.newestAgeMin < 60){
        notes.push(`最新一顆是 ${Math.round(ip.newestAgeMin)} 分鐘前開的，仿盤還在增加中`);
      }
      if(num(ip.leader?.rug_ratio) > 0.3){
        notes.push("連領頭的那顆 rug_ratio 都偏高");
      }
      return notes;
    }
  };
}

function unwrapList(res){
  const data = res && typeof res === "object" && "data" in res && res.code !== undefined ? res.data : res;
  if(Array.isArray(data)) return data;
  /* hot-searches 可以一次查多條鏈，回傳會依鏈分組 */
  if(data && typeof data === "object"){
    for(const key of ["rank", "list", "tokens", "coins"]){
      if(Array.isArray(data[key])) return data[key];
    }
    const groups = Object.values(data).filter(Array.isArray);
    if(groups.length) return groups.flat();
  }
  return [];
}
