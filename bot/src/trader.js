import { config, CURRENCY, buildConditionOrders } from "./config.js";
import { evaluate, sanitize, num } from "./score.js";
import { evaluateGate } from "./gate.js";
import { checkBuy } from "./risk.js";
import { log } from "./log.js";

const LAMPORTS = 1e9;

export function createTrader({ cli, store, cfg = config }){
  const chain = cfg.gmgn.chain;
  const native = CURRENCY[chain]?.native ?? CURRENCY.sol.native;

  /* gas-price 同時給優先費三檔與原生幣美元價。
     ⚠️ Solana 的 *_prio_fee 三檔恆為 1（無意義佔位），照它算會變成 1 SOL。
        只能讀 *_prio_fee_mixed。

     快取 30 秒：SOL 價格與優先費在這個尺度內不會有意義的變化，
     但每次下單前多一個往返就是多幾百毫秒 —— 迷因幣的價格在那幾百毫秒裡會動。 */
  let gasCache = null;
  const GAS_TTL_MS = 30000;

  async function gasContext({ force = false } = {}){
    if(!force && gasCache && Date.now() - gasCache.at < GAS_TTL_MS) return gasCache.value;
    const g = await cli.gasPrice({ chain });
    const tier = cfg.exec.gasTier;
    const prio = num(g?.[`${tier}_prio_fee_mixed`]);
    const nativeUsd = num(g?.native_token_usd_price);
    if(!(nativeUsd > 0)) throw new Error("gas-price 沒給 native_token_usd_price，無法把美元換算成 SOL");
    const value = {
      nativeUsd,
      priorityFeeSol: prio > 0 ? prio : 0.001,   // 拿不到就用文件裡 low 檔的實測值
      estimateSec: num(g?.[`${tier}_estimate_time`])
    };
    gasCache = { at: Date.now(), value };
    return value;
  }

  return {
    /* ── 掃描：GMGN trending → 評分 → 過濾 ── */
    async scan({ limit = 100 } = {}){
      const rows = await cli.trending({
        chain,
        interval: cfg.filter.interval,
        limit,
        /* 伺服器端先濾掉一部分，省請求也省得自己判 */
        minLiquidity: cfg.filter.minDepthUsd * 2,   // trending 的 liquidity 是兩側之和
        minSwaps: 10,
        filters: chain === "sol" ? ["renounced", "not_wash_trading"] : ["not_honeypot"]
      });

      const coins = rows
        .map(r => evaluate(r, { minDepthUsd: cfg.filter.minDepthUsd, chain }))
        .sort((a, b) => b.score - a.score);

      const cooldownMs = cfg.filter.alertCooldownHours * 3600 * 1000;
      return {
        all: coins,
        candidates: coins.filter(c =>
          c.flags.length === 0 &&
          c.score >= cfg.filter.minScore &&
          !store.wasSeen(c.address, cooldownMs)
        )
      };
    },

    /* ── 買入前的完整檢查。不動錢，可以隨便跑。 ── */
    async prepareBuy({ address, usdAmount = cfg.risk.positionUsd, coin = null }){
      const [info, security] = await Promise.all([
        cli.tokenInfo({ chain, address }),
        cli.tokenSecurity({ chain, address })
      ]);

      const gate = evaluateGate({
        info, security, chain,
        minDepthUsd: cfg.filter.minDepthUsd,
        positionUsd: usdAmount
      });

      /* 風控閘門（部位上限、單日虧損、停機線）跟幣本身無關，一樣要過 */
      const riskCheck = checkBuy({ store, coin, usdAmount, cfg });

      const gas = await gasContext();
      const amountRaw = Math.round(usdAmount / gas.nativeUsd * LAMPORTS);
      if(!(amountRaw > 0)) throw new Error("換算出來的下單數量是 0");

      let quote = null;
      let quoteError = null;
      if(gate.pass && riskCheck.ok){
        try {
          quote = await cli.quote({
            chain,
            from: cfg.gmgn.walletAddress,
            inputToken: native.address,
            outputToken: address,
            amountRaw,
            slippage: cfg.exec.slippagePct
          });
        } catch(e){
          quoteError = e.message;    // 報價失敗不等於不能買，但要讓人看到
        }
      }

      const price = gate.metrics.price || coin?.price || 0;
      const conditionOrders = buildConditionOrders(cfg);

      return {
        chain,
        address,
        symbol: sanitize(info?.symbol ?? coin?.symbol ?? "?"),
        name: sanitize(info?.name ?? coin?.name ?? ""),
        usdAmount,
        amountRaw,
        solAmount: amountRaw / LAMPORTS,
        nativeUsd: gas.nativeUsd,
        priorityFeeSol: gas.priorityFeeSol,
        tipFeeSol: cfg.exec.tipFeeSol,
        slippagePct: cfg.exec.slippagePct,
        price,
        stopPrice: price * (1 - cfg.risk.stopPct / 100),
        targetPrice: price * (1 + cfg.risk.stopPct * cfg.risk.targetR / 100),
        conditionOrders,
        gate,
        riskCheck,
        quote,
        quoteError,
        canExecute: gate.pass && riskCheck.ok,
        createdAt: Date.now()
      };
    },

    /* ── 真正送出買單。呼叫這個之前，必須已經有人按過確認。 ── */
    async executeBuy(plan, { dryRun = cfg.mode.dryRun } = {}){
      if(!plan.canExecute){
        throw new Error("這張單沒通過閘門，不該走到這裡");
      }

      if(dryRun){
        const pos = recordPosition(plan, {
          orderId: `dry-${Date.now()}`,
          hash: "",
          dryRun: true,
          filledPrice: plan.price
        });
        log.trade("模擬買入", { symbol: plan.symbol, usd: plan.usdAmount });
        return { ok: true, dryRun: true, position: pos };
      }

      const res = await cli.swap({
        chain: plan.chain,
        from: cfg.gmgn.walletAddress,
        inputToken: native.address,
        outputToken: plan.address,
        amountRaw: plan.amountRaw,
        slippage: plan.slippagePct,
        antiMev: cfg.exec.antiMev,
        /* SOL 上掛 condition-orders 時，priority-fee 與 tip-fee 是必填 */
        priorityFeeSol: plan.priorityFeeSol,
        tipFee: plan.tipFeeSol,
        conditionOrders: plan.conditionOrders,
        sellRatioType: cfg.exec.sellRatioType,
        yes: true    // 人工確認發生在 Telegram；CLI 端仍需操作者自行開啟 GMGN_ALLOW_AUTOMATED_TRADES
      });

      const orderId = res?.order_id;
      if(!orderId) return { ok: false, error: "沒拿到 order_id", raw: res };

      /* 文件明講：status 不是 confirmed 就不准回報成功 */
      const settled = await cli.waitForOrder({ chain: plan.chain, orderId });
      if(!settled.ok){
        return {
          ok: false,
          error: settled.timedOut ? "等待確認逾時" : `訂單 ${settled.order?.status ?? "未知"}`,
          detail: settled.order?.error_status ?? "",
          orderId
        };
      }

      const report = settled.order?.report ?? {};
      const filledPrice = num(report.price_usd) || plan.price;
      const pos = recordPosition(plan, {
        orderId,
        hash: settled.order?.hash ?? res?.hash ?? "",
        strategyOrderId: settled.order?.strategy_order_id ?? res?.strategy_order_id ?? "",
        dryRun: false,
        filledPrice,
        report
      });

      if(!pos.strategyOrderId){
        /* condition_orders 是 best-effort：swap 成功但策略單失敗時，swap 結果照樣回來。
           這代表這個部位沒有伺服器端停損，必須讓人知道。 */
        log.warn("停損停利策略單沒有建立成功", { symbol: plan.symbol, orderId });
      }
      return { ok: true, position: pos, strategyMissing: !pos.strategyOrderId };
    },

    /* ── 賣出。percent 是持倉百分比。 ── */
    async sellPosition(position, { percent = 100, reason = "手動", dryRun = cfg.mode.dryRun, exitPrice = null } = {}){
      if(dryRun || position.dryRun){
        const price = exitPrice ?? position.lastPrice ?? position.entryPrice;
        return closeOut(position, { price, percent, reason, hash: "", dryRun: true });
      }

      const res = await cli.swap({
        chain: position.chain,
        from: cfg.gmgn.walletAddress,
        inputToken: position.tokenAddress,
        outputToken: native.address,
        percent,                       // 賣出用 --percent，input_token 不是貨幣才合法
        slippage: cfg.exec.slippagePct,
        antiMev: cfg.exec.antiMev,
        yes: true
      });

      const orderId = res?.order_id;
      if(!orderId) return { ok: false, error: "沒拿到 order_id", raw: res };

      const settled = await cli.waitForOrder({ chain: position.chain, orderId });
      if(!settled.ok){
        return { ok: false, error: settled.timedOut ? "等待確認逾時" : `訂單 ${settled.order?.status ?? "未知"}`, orderId };
      }

      const report = settled.order?.report ?? {};
      const price = num(report.price_usd) || exitPrice || position.lastPrice || position.entryPrice;
      return closeOut(position, {
        price, percent, reason,
        hash: settled.order?.hash ?? "",
        orderId,
        dryRun: false,
        report
      });
    },

    /* ── 更新持倉現價 ── */
    async refreshPositions(){
      const out = [];
      for(const pos of store.openPositions()){
        try {
          const info = await cli.tokenInfo({ chain: pos.chain, address: pos.tokenAddress });
          const price = num(info?.price?.price);
          if(price > 0){
            store.updatePosition(pos.id, { lastPrice: price, lastCheckedAt: Date.now() });
            out.push({ ...pos, lastPrice: price });
          }
        } catch(e){
          if(e.code === "RATE_LIMIT") throw e;     // 限流就整批停手
          log.warn("更新報價失敗", { symbol: pos.symbol, error: e.message });
        }
      }
      return out;
    },

    gasContext
  };

  /* ── 內部：寫入持倉 ── */
  function recordPosition(plan, { orderId, hash, strategyOrderId = "", dryRun, filledPrice, report = {} }){
    return store.addPosition({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chain: plan.chain,
      tokenAddress: plan.address,
      symbol: plan.symbol,
      name: plan.name,
      openedAt: new Date().toISOString(),
      costUsd: plan.usdAmount,
      entryPrice: filledPrice,
      lastPrice: filledPrice,
      stopPrice: filledPrice * (1 - cfg.risk.stopPct / 100),
      targetPrice: filledPrice * (1 + cfg.risk.stopPct * cfg.risk.targetR / 100),
      stopPct: cfg.risk.stopPct,
      targetR: cfg.risk.targetR,
      riskUsd: plan.usdAmount * cfg.risk.stopPct / 100,
      orderId,
      hash,
      strategyOrderId,
      dryRun,
      outputAmountRaw: report.output_amount ?? null,
      outputDecimals: report.output_token_decimals ?? null,
      gasUsd: num(report.gas_usd)
    });
  }

  /* ── 內部：平倉記帳 ── */
  function closeOut(position, { price, percent, reason, hash, orderId = "", dryRun, report = {} }){
    const portion = percent / 100;
    const costPortion = position.costUsd * portion;
    const grossUsd = position.entryPrice > 0 ? costPortion * (price / position.entryPrice) : 0;
    const gasUsd = num(report.gas_usd);
    const pnlUsd = grossUsd - costPortion - gasUsd;

    const trade = {
      id: position.id,
      chain: position.chain,
      symbol: position.symbol,
      tokenAddress: position.tokenAddress,
      openedAt: position.openedAt,
      closedAt: new Date().toISOString(),
      entryPrice: position.entryPrice,
      exitPrice: price,
      costUsd: costPortion,
      pnlUsd,
      r: position.riskUsd > 0 ? pnlUsd / (position.riskUsd * portion) : 0,
      reason,
      percent,
      hash,
      orderId,
      dryRun: !!dryRun,
      gasUsd
    };

    if(percent >= 100) store.removePosition(position.id);
    else store.updatePosition(position.id, { costUsd: position.costUsd - costPortion });

    store.recordTrade(trade);
    log.trade("平倉", { symbol: position.symbol, pnlUsd: pnlUsd.toFixed(2), reason });

    /* 觸發單日止血線就直接關掉交易，不等下一次檢查 */
    if(store.realizedToday() <= -cfg.risk.maxDailyLossUsd){
      store.setTrading(false, `單日虧損達 $${cfg.risk.maxDailyLossUsd}`);
    }
    const equity = cfg.risk.bankrollUsd + store.realizedTotal();
    if(equity < cfg.risk.killSwitchUsd){
      store.setTrading(false, `淨值跌到 $${equity.toFixed(2)}，低於停機線`);
    }

    return { ok: true, trade, dryRun: !!dryRun };
  }
}
