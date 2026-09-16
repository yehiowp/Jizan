import { config } from "./config.js";
import { log } from "./log.js";
import { num } from "./score.js";

/* 對帳：把「GMGN 伺服器端已經幫你賣掉了」這件事同步回本機帳本。

   為什麼非做不可：停損停利是掛在 GMGN 那邊執行的，機器人不會收到通知。
   沒有對帳的話，一個已經停損出場的部位會在 state.json 裡永遠掛著「持倉中」——
   虧損不入帳、單日止血線和停機線永遠不會觸發、/stats 是假的。
   也就是說：整套風控會在你以為它在保護你的時候完全失效。

   判定用兩道獨立證據，避免單一欄位缺失就誤判：
     1. 策略單不在 open 清單裡了（或出現在 history 裡）
     2. 錢包裡這顆幣的餘額歸零
   兩道都指向已出場才平倉；只有一道成立就先示警給人看，不自己動帳。
   「查不到」一律當未知，不當成已出場 —— 誤判平倉會把一個還活著的部位
   從帳本上抹掉，之後就再也不會有人去管它。 */

export function createReconciler({ cli, store, trader, say, cfg = config }){

  async function checkPosition(pos){
    const evidence = { strategyGone: null, balanceZero: null, exitPrice: null, notes: [] };

    /* 證據一：策略單還在不在 */
    if(pos.strategyOrderId && !pos.dryRun){
      try {
        const open = await cli.strategyList({
          chain: pos.chain, from: cfg.gmgn.walletAddress,
          baseToken: pos.tokenAddress, type: "open"
        });
        const stillOpen = open.some(o =>
          String(o?.order_id ?? o?.id ?? o?.strategy_order_id ?? "") === String(pos.strategyOrderId));
        evidence.strategyGone = !stillOpen;

        if(!stillOpen){
          /* 去歷史裡找成交價，找不到也不影響判定 */
          const hist = await cli.strategyList({
            chain: pos.chain, from: cfg.gmgn.walletAddress,
            baseToken: pos.tokenAddress, type: "history"
          }).catch(() => []);
          const rec = hist.find(o =>
            String(o?.order_id ?? o?.id ?? o?.strategy_order_id ?? "") === String(pos.strategyOrderId));
          const p = num(rec?.report?.price_usd ?? rec?.price_usd ?? rec?.trigger_price);
          if(p > 0){
            evidence.exitPrice = p;
            evidence.notes.push(`策略單成交價 ${p}`);
          }
          evidence.notes.push("策略單已不在掛單清單");
        }
      } catch(e){
        if(e.code === "RATE_LIMIT") throw e;
        evidence.notes.push(`查策略單失敗：${e.message}`);
      }
    }

    /* 證據二：錢包裡還有沒有這顆幣 */
    if(!pos.dryRun && cfg.gmgn.walletAddress){
      try {
        const bal = await cli.tokenBalance({
          chain: pos.chain, wallet: cfg.gmgn.walletAddress, token: pos.tokenAddress
        });
        if(bal.amount == null) evidence.notes.push("拿不到代幣餘額");
        else {
          evidence.balanceZero = bal.amount <= 0;
          evidence.notes.push(`餘額 ${bal.amount}（${bal.field}）`);
        }
      } catch(e){
        if(e.code === "RATE_LIMIT") throw e;
        evidence.notes.push(`查餘額失敗：${e.message}`);
      }
    }

    const exited = evidence.strategyGone === true && evidence.balanceZero === true;
    const partial = !exited && (evidence.strategyGone === true || evidence.balanceZero === true);
    return { exited, partial, evidence };
  }

  return {
    checkPosition,

    /* 掃一遍所有真實持倉。回傳這輪做了什麼。 */
    async run(){
      const open = store.openPositions().filter(p => !p.dryRun);
      if(!open.length) return { checked: 0, closed: 0, flagged: 0 };

      let closed = 0, flagged = 0;
      for(const pos of open){
        let r;
        try {
          r = await checkPosition(pos);
        } catch(e){
          if(e.code === "RATE_LIMIT"){
            log.warn("對帳遇到限流，這輪停手", { hint: e.hint });
            break;
          }
          log.warn("對帳失敗", { symbol: pos.symbol, error: e.message });
          continue;
        }

        if(r.exited){
          /* 兩道證據都指向已出場 → 用策略單的成交價入帳；
             沒有成交價就退回最後已知報價，並在訊息裡講明這是估算。 */
          const price = r.evidence.exitPrice ?? pos.lastPrice ?? pos.entryPrice;
          const estimated = r.evidence.exitPrice == null;

          const res = await trader.sellPosition(pos, {
            percent: 100,
            reason: "伺服器端停損停利",
            dryRun: true,              // 只記帳：幣已經賣掉了，不能再送一次賣單
            exitPrice: price
          });
          closed++;

          const t = res.trade;
          await say([
            `📕 對帳：${pos.symbol} 已由 GMGN 伺服器端出場`,
            `${pos.entryPrice} → ${price}${estimated ? "（估算，拿不到策略單成交價）" : ""}`,
            `損益 $${t.pnlUsd.toFixed(2)}（${t.r.toFixed(2)}R）已入帳`,
            r.evidence.notes.join("　"),
            !store.state.tradingEnabled ? `⛔ 交易已自動停用：${store.state.disabledReason}` : ""
          ].filter(Boolean).join("\n"));
        } else if(r.partial){
          /* 只有一道證據成立：可能是部分成交，也可能是查詢失敗。
             不自己動帳，但一定要讓人知道 —— 這種狀態放著不管最危險。 */
          flagged++;
          const key = `recon:${pos.id}`;
          if(!store.wasSeen(key, 6 * 3600 * 1000)){
            store.markSeen(key);
            await say([
              `⚠️ 對帳對不上：${pos.symbol}`,
              r.evidence.strategyGone === true
                ? "策略單不見了，但錢包裡還有幣 —— 可能只賣了一部分"
                : "錢包裡沒幣了，但策略單還掛著 —— 可能是你自己賣掉了",
              r.evidence.notes.join("　"),
              `帳本仍記為持倉中。確認後用 /sell ${pos.id} 平掉，或 /positions 看一下。`
            ].join("\n"));
          }
        }
      }

      return { checked: open.length, closed, flagged };
    }
  };
}
