import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";

const DEFAULT_STATE = {
  version: 1,
  tradingEnabled: true,
  disabledReason: "",
  positions: [],   // 持倉中
  trades: [],      // 已平倉
  seen: {},        // tokenAddress -> 上次通知時間，避免洗版
  daily: {},       // "YYYY-MM-DD" -> 當日已實現損益
  /* 自動交易的武裝狀態。armedUntil 是時間戳，過期自動解除 ——
     不讓「設定完放著跑一個月」這種狀態存在。 */
  auto: { armedUntil: 0, armedAt: 0, disarmReason: "" },
  autoBuys: {}     // "YYYY-MM-DD" -> { count, spentUsd }
};

/* shared: true 時，每次寫入都會「拿鎖 → 重讀 → 改 → 寫回」。

   為什麼非這樣不可：一條鏈一個機器人的話，好幾個行程共用同一個 state.json。
   各自把記憶體裡的 state 整份寫回去，就是典型的讀-改-寫競態 ——
   A 讀到 2 個部位、B 也讀到 2 個，兩邊各加一筆再寫回，
   最後檔案裡只有 3 筆，有一筆憑空消失。
   消失的那筆是真的買了的幣：鏈上有、帳本沒有，風控看不到它，
   監控也不會去管它的停損停利。

   代價是每次寫入多一次磁碟往返。交易事件本來就不密集，這個代價可以忽略。 */
export function createStore(filePath, { shared = false, lockDir = `${filePath}.lock` } = {}){
  const dir = path.dirname(filePath);
  let state;

  /* seen 每掃到一顆幣就寫一筆，不清理的話 state.json 會一路長大，
     load/save 越來越慢，最後每次通知都要重寫一個幾 MB 的檔案。
     所有 cooldown 最長是 6 小時，24 小時以外的一律沒有意義。 */
  const SEEN_TTL_MS = 24 * 3600 * 1000;
  function pruneSeen(st){
    const cutoff = Date.now() - SEEN_TTL_MS;
    let removed = 0;
    for(const [k, t] of Object.entries(st.seen ?? {})){
      if(typeof t !== "number" || t < cutoff){ delete st.seen[k]; removed++; }
    }
    return removed;
  }

  function load(){
    try {
      if(fs.existsSync(filePath)){
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const merged = { ...structuredClone(DEFAULT_STATE), ...parsed };
        pruneSeen(merged);
        return merged;
      }
    } catch(e){
      /* 檔案壞了就備份起來重來，不要直接吃掉使用者的紀錄 */
      try { fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch(_){}
    }
    return structuredClone(DEFAULT_STATE);
  }

  function save(){
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);   // 原子寫入，避免斷電留下半個檔案
  }

  /* 共用模式下的寫入：拿鎖 → 重讀（吃進別的機器人剛寫的東西）→ 改 → 寫回。
     fn 收到的是剛從磁碟讀回來的 state，所以它看到的一定是最新的。 */
  function mutate(fn){
    if(!shared){
      const r = fn(state);
      save();
      return r;
    }
    return withLock(lockDir, () => {
      state = load();
      const r = fn(state);
      save();
      return r;
    });
  }

  /* 共用模式下的讀取：檔案變了就重讀。
     不重讀的話，這個機器人會拿別人五分鐘前的帳本在算風控。 */
  let lastMtimeMs = 0;
  function fresh(){
    if(!shared) return state;
    try {
      const m = fs.statSync(filePath).mtimeMs;
      if(m !== lastMtimeMs){ state = load(); lastMtimeMs = m; }
    } catch { /* 檔案還不存在，用記憶體裡的 */ }
    return state;
  }

  state = load();

  return {
    get state(){ return fresh(); },
    save,
    reload(){ state = load(); return state; },
    shared,

    openPositions(){ return fresh().positions; },
    closedTrades(){ return fresh().trades; },

    addPosition(pos){ return mutate(st => { st.positions.unshift(pos); return pos; }); },
    getPosition(id){ return fresh().positions.find(p => p.id === id); },
    removePosition(id){
      mutate(st => {
        const i = st.positions.findIndex(p => p.id === id);
        if(i >= 0) st.positions.splice(i, 1);
      });
    },
    updatePosition(id, patch){
      return mutate(st => {
        const p = st.positions.find(x => x.id === id);
        if(p) Object.assign(p, patch);
        return p;
      });
    },

    recordTrade(trade){
      return mutate(st => {
        st.trades.unshift(trade);
        const day = trade.closedAt.slice(0, 10);
        st.daily[day] = (st.daily[day] || 0) + (trade.pnlUsd || 0);
        return trade;
      });
    },

    /* 這三個是風控的輸入。共用模式下一定要讀磁碟上的最新值 ——
       拿自己記憶體裡那份算，等於每個機器人都以為自己是唯一在花錢的。 */
    realizedToday(today = new Date().toISOString().slice(0, 10)){
      return fresh().daily[today] || 0;
    },
    realizedTotal(){
      return fresh().trades.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    },
    deployedUsd(){
      return fresh().positions.reduce((s, p) => s + (p.costUsd || 0), 0);
    },

    pruneSeen: () => pruneSeen(state),
    seenCount: () => Object.keys(state.seen ?? {}).length,

    markSeen(addr){
      mutate(st => {
        st.seen[addr] = Date.now();
        /* 順手清一次，不讓它累積到下次啟動 */
        if(Object.keys(st.seen).length > 500) pruneSeen(st);
      });
    },

    /* 驗過但沒過閘的幣，短時間內不要重驗 —— 省往返也省限流額度。
       冷卻比通知冷卻短很多，因為盤況真的會在十幾分鐘內改變。 */
    markRejected(addr){ mutate(st => { st.seen[`rej:${addr}`] = Date.now(); }); },
    wasRejected(addr, withinMs = 15 * 60 * 1000){
      const t = fresh().seen[`rej:${addr}`];
      return t != null && Date.now() - t < withinMs;
    },
    wasSeen(addr, withinMs = 6 * 3600 * 1000){
      const t = fresh().seen[addr];
      return t != null && Date.now() - t < withinMs;
    },

    setTrading(enabled, reason = ""){
      state.tradingEnabled = enabled;
      state.disabledReason = reason;
      save();
    },

    /* ── 自動交易武裝狀態 ── */
    armAuto(hours, now = Date.now()){
      state.auto = { armedUntil: now + hours * 3600 * 1000, armedAt: now, disarmReason: "" };
      save();
      return state.auto;
    },
    disarmAuto(reason = "手動解除"){
      state.auto = { armedUntil: 0, armedAt: state.auto?.armedAt ?? 0, disarmReason: reason };
      save();
    },
    isAutoArmed(now = Date.now()){
      return (state.auto?.armedUntil ?? 0) > now;
    },
    autoArmedUntil(){ return state.auto?.armedUntil ?? 0; },
    autoDisarmReason(){ return state.auto?.disarmReason ?? ""; },

    autoToday(today = new Date().toISOString().slice(0, 10)){
      return state.autoBuys[today] ?? { count: 0, spentUsd: 0 };
    },
    recordAutoBuy(usdAmount, today = new Date().toISOString().slice(0, 10)){
      const cur = state.autoBuys[today] ?? { count: 0, spentUsd: 0 };
      state.autoBuys[today] = { count: cur.count + 1, spentUsd: cur.spentUsd + usdAmount };
      save();
      return state.autoBuys[today];
    },

    /* GMGN 的限流封禁要跨行程記住。

       封禁是綁 API Key 的，不是綁行程的 —— 重啟之後它還在。
       但漏桶只活在記憶體裡，重啟等於忘記自己被封了，第一個請求就打出去，
       而文件寫明冷卻期內每送一次請求封禁就延長 5 秒。
       「卡住了就重啟」是人最直覺的反應，也正好是把封禁越拖越長的那個動作。 */
    rateLimitBanUntil(){ return state.rateLimitBanUntil ?? 0; },
    setRateLimitBan(untilMs){
      const cur = state.rateLimitBanUntil ?? 0;
      if(untilMs <= cur) return cur;          // 只往後延，不會被較早的時間洗掉
      state.rateLimitBanUntil = untilMs;
      save();
      return untilMs;
    }
  };
}
