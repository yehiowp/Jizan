import { config, CURRENCY, buildConditionOrders, chainTradable } from "./config.js";
import { evaluate, sanitize, num } from "./score.js";
import { evaluateGate } from "./gate.js";
import { checkBuy } from "./risk.js";
import { log } from "./log.js";

export function createTrader({ cli, store, cfg = config, radar = null }){
  /* 預設鏈，以及要掃描的所有鏈 */
  const defaultChain = cfg.gmgn.chain;
  const scanChains = cfg.gmgn.chains.length ? cfg.gmgn.chains : [defaultChain];

  const spec = c => CURRENCY[c] ?? CURRENCY.sol;
  const nativeOf = c => spec(c).native ?? CURRENCY.sol.native;
  /* 最小單位換算依鏈而異：SOL 9 位、BNB/ETH 18 位。
     寫死 1e9 的話，在 BSC 上下單金額會差十億倍。 */
  const unitOf = c => Math.pow(10, nativeOf(c).decimals ?? 9);

  /* gas-price 同時給優先費三檔與原生幣美元價。
     ⚠️ Solana 的 *_prio_fee 三檔恆為 1（無意義佔位），照它算會變成 1 SOL。
        只能讀 *_prio_fee_mixed。

     快取 30 秒：SOL 價格與優先費在這個尺度內不會有意義的變化，
     但每次下單前多一個往返就是多幾百毫秒 —— 迷因幣的價格在那幾百毫秒裡會動。 */
  const gasCache = new Map();          // 依鏈各自快取
  const GAS_TTL_MS = 30000;

  async function gasContext(c = defaultChain, { force = false } = {}){
    const hit = gasCache.get(c);
    if(!force && hit && Date.now() - hit.at < GAS_TTL_MS) return hit.value;

    const g = await cli.gasPrice({ chain: c });
    const tier = cfg.exec.gasTier;
    const nativeUsd = num(g?.native_token_usd_price);
    if(!(nativeUsd > 0)) throw new Error(`gas-price 沒給 native_token_usd_price（${c}），無法把美元換算成原生幣`);

    const value = { nativeUsd, estimateSec: num(g?.[`${tier}_estimate_time`]) };

    if(spec(c).feeStyle === "evm"){
      /* EVM：檔位本身就是權威全額單價（wei），不要拿 base + prio 去拼。
         換成 gwei 給 --gas-price 用，並套用該鏈的最低值。 */
      const wei = num(g?.[tier]);
      const gwei = wei > 0 ? wei / 1e9 : 0;
      value.gasPriceGwei = Math.max(gwei, spec(c).minGasPriceGwei ?? 0.01);
    } else {
      /* Solana：*_prio_fee 三檔恆為佔位值 1，只能讀 *_prio_fee_mixed */
      const prio = num(g?.[`${tier}_prio_fee_mixed`]);
      value.priorityFeeSol = prio > 0 ? prio : 0.001;
    }

    gasCache.set(c, { at: Date.now(), value });
    return value;
  }

  return {
    /* ── 掃描：trending + 熱搜兩個來源 → 評分 → 過濾。
       兩個來源平行抓，其中一個掛掉不影響另一個。 ── */
    async scan({ limit = 100, includeHotSearch = true, chains = scanChains } = {}){
      /* 每條鏈各抓 trending + 熱搜，全部平行。
         其中一條掛掉不影響其他條；任何一條限流就整輪停手。 */
      const perChain = await Promise.all(chains.map(async c => {
        /* 雷達模式：候選由本機雷達提供，這一輪完全不敲 GMGN 的熱門榜。

           注意這裡拿到的列**沒有安全欄位** —— 閘門對未知欄位不扣分，
           所以這些列在評分階段看起來都會是「沒有紅旗」。
           那不代表它們乾淨，只代表還沒驗。真正的判斷在 vet() 之後的閘門，
           那裡讀的是 GMGN 的原始欄位。雷達只決定「先驗誰」。 */
        if(radar){
          try {
            const { rows } = await radar.candidates({ chain: c, limit });
            return rows.map(r => ({ ...r, _scanChain: c }));
          } catch(e){
            if(!cfg.radar.fallbackToGmgn){
              /* 不默默退回去敲 GMGN：那正是我們想避免的「兩邊搶額度」。
                 讓這條鏈這一輪沒有候選，並把原因往上丟。 */
              log.warn("雷達取不到候選，這一輪跳過這條鏈", { chain: c, error: e.message });
              return [];
            }
            log.warn("雷達取不到候選，改用 GMGN 熱門榜", { chain: c, error: e.message });
          }
        }

        const [trendRows, hotRows] = await Promise.all([
          cli.trending({
            chain: c,
            interval: cfg.filter.interval,
            limit,
            /* 伺服器端先濾掉一部分，省請求也省得自己判 */
            minLiquidity: cfg.filter.minDepthUsd * 2,   // trending 的 liquidity 是兩側之和
            minSwaps: 10,
            filters: c === "sol" ? ["renounced", "not_wash_trading"] : ["not_honeypot"]
          }).catch(e => { if(e.code === "RATE_LIMIT") throw e; return []; }),
          includeHotSearch
            ? cli.hotSearches({ chain: c, interval: cfg.filter.interval, limit,
                                minLiquidity: cfg.filter.minDepthUsd * 2 })
                .catch(e => { if(e.code === "RATE_LIMIT") throw e; return []; })
            : Promise.resolve([])
        ]);
        /* 同一顆幣可能同時上兩個榜，用地址去重。跨鏈時要連鏈一起當 key ——
           不同鏈上的地址格式不同，但不保證永遠不會撞。 */
        return [...trendRows, ...hotRows]
          .filter(r => r?.address)
          .map(r => ({ ...r, chain: r.chain ?? c, _scanChain: c }));
      }));

      const rows = [...new Map(perChain.flat()
        .map(r => [`${r._scanChain}:${r.address}`, r])).values()];

      const coins = rows
        .map(r => {
          const c = evaluate(r, { minDepthUsd: cfg.filter.minDepthUsd, chain: r._scanChain });
          /* 標記來源，讓 /scan 的輸出不會把「還沒驗」講成「驗過了」。
             雷達來的列少了安全欄位，分數天生偏低也偏不可靠，
             所以排序改用雷達自己的發現分數。 */
          return r._source === "radar"
            ? { ...c, source: "radar", radarStatus: r._radarStatus, radarReason: r._radarReason,
                radarScore: r._radarScore, unverified: true }
            : c;
        })
        .sort((a, b) => (b.source === "radar" ? b.radarScore : b.score)
                      - (a.source === "radar" ? a.radarScore : a.score));

      const cooldownMs = cfg.filter.alertCooldownHours * 3600 * 1000;
      return {
        all: coins,
        candidates: coins.filter(c =>
          c.flags.length === 0 &&
          /* 雷達來的列沒有安全欄位，分數門檻套在上面沒有意義（分母都不一樣）。
             它們要通過的是 vet() 之後的閘門，那裡標準沒有放寬半點。 */
          (c.source === "radar" || c.score >= cfg.filter.minScore) &&
          !store.wasSeen(c.address, cooldownMs) &&
          !store.wasRejected(c.address)
        )
      };
    },

    /* ── 只驗證、不報價。
       報價（order quote）權重是 2，而且只有真的要買的那一顆才需要，
       放在驗證階段等於每個被刷掉的候選都白付一次往返。 ── */
    async vet({ address, usdAmount = cfg.risk.positionUsd, coin = null, chain: c = coin?.chain ?? defaultChain }){
      const [info, security] = await Promise.all([
        cli.tokenInfo({ chain: c, address }),
        cli.tokenSecurity({ chain: c, address })
      ]);

      const gate = evaluateGate({
        info, security, chain: c,
        minDepthUsd: cfg.filter.minDepthUsd,
        positionUsd: usdAmount
      });
      /* 風控閘門（部位上限、單日虧損、停機線）跟幣本身無關，一樣要過 */
      const riskCheck = checkBuy({ store, coin, usdAmount, cfg });

      /* 沒有可靠幣種地址的鏈：掃描分析照常，但不准下單 */
      const tradable = chainTradable(c);
      const blocks = [...gate.blocks, ...riskCheck.reasons];
      if(!tradable.ok) blocks.push(tradable.reason);

      return {
        address, coin, info, security, gate, riskCheck, chain: c,
        symbol: sanitize(info?.symbol ?? coin?.symbol ?? "?"),
        pass: gate.pass && riskCheck.ok && tradable.ok,
        reasons: blocks
      };
    },

    /* ── 買入前的完整檢查（含報價）。不動錢。
       已經 vet 過的話把結果傳進來，就不會重打 info/security。 ── */
    async prepareBuy({ address, usdAmount = cfg.risk.positionUsd, coin = null, vetted = null,
                       chain: chainArg = coin?.chain ?? defaultChain }){
      const v = vetted ?? await this.vet({ address, usdAmount, coin, chain: chainArg });
      const c = v.chain ?? chainArg;
      const { info, gate, riskCheck } = v;
      const native = nativeOf(c);
      const tradable = chainTradable(c);

      const gas = await gasContext(c);
      /* 依鏈的小數位換算 —— SOL 是 9 位、BNB/ETH 是 18 位 */
      const amountRaw = Math.round(usdAmount / gas.nativeUsd * unitOf(c));
      if(!(amountRaw > 0)) throw new Error("換算出來的下單數量是 0");

      let quote = null;
      let quoteError = null;
      if(gate.pass && riskCheck.ok && tradable.ok){
        try {
          quote = await cli.quote({
            chain: c,
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
        chain: c,
        nativeSymbol: native.symbol,
        tradable,
        address,
        symbol: sanitize(info?.symbol ?? coin?.symbol ?? "?"),
        name: sanitize(info?.name ?? coin?.name ?? ""),
        usdAmount,
        amountRaw,
        nativeAmount: amountRaw / unitOf(c),
        solAmount: amountRaw / unitOf(c),     // 舊名稱，維持相容
        nativeUsd: gas.nativeUsd,
        priorityFeeSol: gas.priorityFeeSol,   // sol 專用，EVM 上是 undefined
        gasPriceGwei: gas.gasPriceGwei,       // EVM 專用
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
        canExecute: gate.pass && riskCheck.ok && tradable.ok,
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
        inputToken: nativeOf(plan.chain).address,
        outputToken: plan.address,
        amountRaw: plan.amountRaw,
        slippage: plan.slippagePct,
        /* base 不支援防夾，傳了會被拒絕 */
        antiMev: cfg.exec.antiMev && spec(plan.chain).antiMev !== false,
        /* 手續費旗標依鏈而異。SOL 上掛 condition-orders 時 priority-fee 與 tip-fee 必填 */
        priorityFeeSol: plan.priorityFeeSol,
        gasPriceGwei: plan.gasPriceGwei,
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

    /* ── 賣出。percent 是持倉百分比。 ──

       出場方式由「部位自己」決定，不是由當下的模式決定。這個分別很要命：
       真錢部位如果因為機器人現在是模擬模式就走記帳出場，帳本會顯示已平倉、
       損益也照算，但鏈上那些幣其實還在你錢包裡 —— 你以為空手，實際滿倉。
       執行期可以 /mode 切換模式之後，這條路就真的走得到了。

       dryRun 這個參數只在呼叫端「明講」時才蓋過部位的旗標。
       對帳（reconcile）需要它：幣已經被伺服器端的停損賣掉了，
       那筆要純記帳，不能再送一次賣單。 */
    async sellPosition(position, { percent = 100, reason = "手動", dryRun = undefined, exitPrice = null } = {}){
      const bookOnly = dryRun === undefined ? !!position.dryRun : !!dryRun;
      if(bookOnly){
        const price = exitPrice ?? position.lastPrice ?? position.entryPrice;
        return closeOut(position, { price, percent, reason, hash: "", dryRun: true });
      }

      const res = await cli.swap({
        chain: position.chain,
        from: cfg.gmgn.walletAddress,
        inputToken: position.tokenAddress,
        outputToken: nativeOf(position.chain).address,
        percent,                       // 賣出用 --percent，input_token 不是貨幣才合法
        slippage: cfg.exec.slippagePct,
        antiMev: cfg.exec.antiMev && spec(position.chain).antiMev !== false,
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
          const info = await cli.tokenInfo({ chain: pos.chain ?? defaultChain, address: pos.tokenAddress });
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
      nativeSymbol: plan.nativeSymbol,
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
