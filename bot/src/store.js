import fs from "node:fs";
import path from "node:path";

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

export function createStore(filePath){
  const dir = path.dirname(filePath);
  let state;

  function load(){
    try {
      if(fs.existsSync(filePath)){
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return { ...structuredClone(DEFAULT_STATE), ...parsed };
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

  state = load();

  return {
    get state(){ return state; },
    save,
    reload(){ state = load(); return state; },

    openPositions(){ return state.positions; },
    closedTrades(){ return state.trades; },

    addPosition(pos){ state.positions.unshift(pos); save(); return pos; },
    getPosition(id){ return state.positions.find(p => p.id === id); },
    removePosition(id){
      const i = state.positions.findIndex(p => p.id === id);
      if(i >= 0) state.positions.splice(i, 1);
      save();
    },
    updatePosition(id, patch){
      const p = state.positions.find(x => x.id === id);
      if(p){ Object.assign(p, patch); save(); }
      return p;
    },

    recordTrade(trade){
      state.trades.unshift(trade);
      const day = trade.closedAt.slice(0, 10);
      state.daily[day] = (state.daily[day] || 0) + (trade.pnlUsd || 0);
      save();
      return trade;
    },

    realizedToday(today = new Date().toISOString().slice(0, 10)){
      return state.daily[today] || 0;
    },
    realizedTotal(){
      return state.trades.reduce((s, t) => s + (t.pnlUsd || 0), 0);
    },
    deployedUsd(){
      return state.positions.reduce((s, p) => s + (p.costUsd || 0), 0);
    },

    markSeen(addr){ state.seen[addr] = Date.now(); save(); },
    wasSeen(addr, withinMs = 6 * 3600 * 1000){
      const t = state.seen[addr];
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
    }
  };
}
