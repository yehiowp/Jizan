import fs from "node:fs";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  tradingEnabled: true,
  disabledReason: "",
  positions: [],   // 持倉中
  trades: [],      // 已平倉
  seen: {},        // tokenAddress -> 上次通知時間，避免洗版
  daily: {}        // "YYYY-MM-DD" -> 當日已實現損益
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
    }
  };
}
