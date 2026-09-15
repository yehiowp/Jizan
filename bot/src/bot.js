import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { log } from "./log.js";
import { sanitize } from "./score.js";
import { stats } from "./stats.js";

const PLAN_TTL_MS = 120000;   // 報價會過期，確認鈕不能無限期有效

const usd = n => `$${Number(n ?? 0).toFixed(2)}`;
const pct = n => `${Number(n ?? 0) >= 0 ? "+" : ""}${Number(n ?? 0).toFixed(1)}%`;

export function createBot({ cli, store, trader, cfg = config }){
  const bot = new TelegramBot(cfg.telegram.token, { polling: true });
  const owner = String(cfg.telegram.ownerId);
  const pendingPlans = new Map();

  const say = (text, extra = {}) =>
    bot.sendMessage(owner, text, { disable_web_page_preview: true, ...extra });

  /* 只認一個人。其他任何 chat 或 user 一律丟掉，不回話也不透露機器人在做什麼。 */
  function isOwner(msg){
    const from = String(msg?.from?.id ?? "");
    const chat = String(msg?.chat?.id ?? msg?.message?.chat?.id ?? "");
    return from === owner && (chat === owner || chat === "");
  }

  function planId(){ return Math.random().toString(36).slice(2, 10); }

  function stashPlan(plan){
    const id = planId();
    pendingPlans.set(id, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
    setTimeout(() => pendingPlans.delete(id), PLAN_TTL_MS + 1000).unref?.();
    return id;
  }

  function modeLine(){
    return cfg.mode.dryRun ? "🧪 模擬模式（不會動到真錢）" : "💸 真錢模式";
  }

  /* ── 訊息組裝 ── */
  function coinSummary(c){
    return [
      `${c.grade} ${c.score}/100  ${c.symbol}`,
      `${c.name || "-"}`,
      `價格 ${c.price} ｜ 深度 ${usd(c.depth)} ｜ 持有人 ${c.holders}`,
      `1h ${pct(c.ch1h)} ｜ 5m ${pct(c.ch5m)} ｜ rug ${c.rugRatio.toFixed(2)}`,
      `${c.address}`
    ].join("\n");
  }

  function planCard(plan){
    const g = plan.gate;
    const lines = [
      `⚠️ 買入確認  ${plan.symbol}`,
      "",
      `模式：${cfg.mode.dryRun ? "模擬" : "真錢"}`,
      `投入：${usd(plan.usdAmount)}（約 ${plan.solAmount.toFixed(4)} SOL @ ${usd(plan.nativeUsd)}/SOL）`,
      `滑價：${plan.slippagePct}%　優先費：${plan.priorityFeeSol} SOL　小費：${plan.tipFeeSol} SOL`,
      `風險等級：${g.risk.emoji} ${g.risk.label}${g.metrics.rugRatio != null ? `（rug_ratio ${g.metrics.rugRatio.toFixed(2)}）` : ""}`,
      "",
      `現價 ${plan.price}`,
      `停損 ${plan.stopPrice.toExponential(4)}（-${cfg.risk.stopPct}%，最多賠 ${usd(plan.usdAmount * cfg.risk.stopPct / 100)}）`,
      `停利 ${plan.targetPrice.toExponential(4)}（+${(cfg.risk.stopPct * cfg.risk.targetR).toFixed(0)}%）`,
      `停損停利會掛在 GMGN 伺服器端，機器人關掉也照樣執行。`
    ];

    if(plan.quote?.output_amount) lines.push("", `預估拿到：${plan.quote.output_amount}（最小單位）`);
    if(plan.quoteError) lines.push("", `⚠️ 報價失敗：${plan.quoteError}`);

    if(g.warnings.length) lines.push("", "注意事項：", ...g.warnings.map(w => `· ${w}`));
    if(g.downgrade.length) lines.push("", "執行降級：", ...g.downgrade.map(d => `· ${d.reason} → ${d.action}`));
    if(!plan.riskCheck.ok) lines.push("", "風控擋下：", ...plan.riskCheck.reasons.map(r => `🚫 ${r}`));
    if(g.blocks.length) lines.push("", "閘門擋下：", ...g.blocks.map(b => `🚫 ${b}`));

    return lines.join("\n");
  }

  /* ── 指令 ── */
  const commands = {
    async start(){
      await say([
        "🐸 GMGN 迷因機器人已上線",
        modeLine(),
        "",
        "/scan 掃描候選",
        "/check <地址> 只做檢查不下單",
        "/buy <地址> [金額] 準備買單（要按確認）",
        "/positions 持倉",
        "/sell <id> [百分比] 賣出",
        "/stats 績效",
        "/status 系統狀態",
        "/config 目前參數",
        "/panic 全部賣光並停止交易",
        "/resume 恢復交易",
        "",
        "所有買入都要你親自按確認鍵，機器人不會自己買。"
      ].join("\n"));
    },

    help(){ return commands.start(); },

    async status(){
      const s = stats(store, cfg);
      const open = store.openPositions();
      const cfgCheck = await cli.configCheck();
      await say([
        `${modeLine()}`,
        `交易開關：${store.state.tradingEnabled ? "開啟" : `停用（${store.state.disabledReason}）`}`,
        `GMGN CLI：${cfgCheck.ok ? "已設定" : `未通過（${cfgCheck.error ?? ""}）`}`,
        "",
        `持倉 ${open.length}/${cfg.risk.maxOpenPositions}　在場資金 ${usd(store.deployedUsd())}/${usd(cfg.risk.maxDeployedUsd)}`,
        `今日已實現 ${usd(store.realizedToday())}　（上限 ${usd(-cfg.risk.maxDailyLossUsd)}）`,
        `累計已實現 ${usd(store.realizedTotal())}　淨值 ${usd(cfg.risk.bankrollUsd + store.realizedTotal())}`,
        s.n ? `已平倉 ${s.n} 筆　勝率 ${(s.winRate * 100).toFixed(0)}%　期望值 ${s.expectancy.toFixed(2)}R` : "尚未平倉任何一筆"
      ].join("\n"));
    },

    async scan(){
      await say("掃描中…");
      try {
        const { all, candidates } = await trader.scan();
        if(!all.length) return say("GMGN 沒回傳任何資料。用 /status 看看 CLI 設定。");
        if(!candidates.length){
          const top = all.slice(0, 3).map(c => `${c.grade} ${c.score} ${c.symbol}｜${c.flags[0] ?? "分數未達門檻"}`);
          return say(`掃了 ${all.length} 顆，沒有一顆通過門檻（分數 ≥ ${cfg.filter.minScore} 且無紅旗）。\n\n最接近的：\n${top.join("\n")}`);
        }
        for(const c of candidates.slice(0, 5)){
          store.markSeen(c.address);
          await say(coinSummary(c), {
            reply_markup: { inline_keyboard: [[
              { text: `檢查並準備買 ${usd(cfg.risk.positionUsd)}`, callback_data: `prep:${c.address.slice(0, 50)}` }
            ]] }
          });
        }
      } catch(e){
        await say(`掃描失敗：${e.message}${e.hint ? `\n${e.hint}` : ""}`);
      }
    },

    async check(address){
      if(!address) return say("用法：/check <代幣地址>");
      await say("檢查中…");
      try {
        const plan = await trader.prepareBuy({ address, usdAmount: cfg.risk.positionUsd });
        await say(planCard(plan));
      } catch(e){
        await say(`檢查失敗：${e.message}${e.hint ? `\n${e.hint}` : ""}`);
      }
    },

    async buy(address, amountStr){
      if(!address) return say("用法：/buy <代幣地址> [美元金額]");
      const usdAmount = amountStr ? parseFloat(amountStr) : cfg.risk.positionUsd;
      if(!(usdAmount > 0)) return say("金額要大於 0");
      await say("準備中…");
      try {
        const plan = await trader.prepareBuy({ address, usdAmount });
        if(!plan.canExecute) return say(planCard(plan));
        const id = stashPlan(plan);
        await say(planCard(plan) + "\n\n這張報價 2 分鐘後失效。", {
          reply_markup: { inline_keyboard: [[
            { text: "✅ 確認買入", callback_data: `buy:${id}` },
            { text: "取消", callback_data: `cancel:${id}` }
          ]] }
        });
      } catch(e){
        await say(`準備失敗：${e.message}${e.hint ? `\n${e.hint}` : ""}`);
      }
    },

    async positions(){
      const open = store.openPositions();
      if(!open.length) return say("沒有持倉。");
      for(const p of open){
        const move = p.entryPrice > 0 ? (p.lastPrice / p.entryPrice - 1) * 100 : 0;
        const unreal = p.costUsd * (move / 100);
        await say([
          `${p.symbol}${p.dryRun ? "（模擬）" : ""}`,
          `成本 ${usd(p.costUsd)}　進場 ${p.entryPrice}`,
          `現價 ${p.lastPrice}　${pct(move)}　未實現 ${usd(unreal)}`,
          `停損 ${p.stopPrice.toExponential(3)}　停利 ${p.targetPrice.toExponential(3)}`,
          p.strategyOrderId ? `伺服器端策略單：${p.strategyOrderId}` : "⚠️ 沒有伺服器端停損，要自己盯",
          `id: ${p.id}`
        ].join("\n"), {
          reply_markup: { inline_keyboard: [[
            { text: "賣 100%", callback_data: `sell:${p.id}:100` },
            { text: "賣 50%", callback_data: `sell:${p.id}:50` }
          ]] }
        });
      }
    },

    async sell(id, percentStr){
      if(!id) return say("用法：/sell <id> [百分比]");
      const position = store.getPosition(id);
      if(!position) return say("找不到這個持倉。");
      const percent = percentStr ? parseFloat(percentStr) : 100;
      await doSell(position, percent, "手動");
    },

    async stats(){
      const s = stats(store, cfg);
      if(!s.n) return say("還沒有平倉紀錄。");
      await say([
        `已平倉 ${s.n} 筆（模擬 ${s.dryRunCount} 筆）`,
        `勝率 ${(s.winRate * 100).toFixed(0)}%　期望值 ${s.expectancy.toFixed(2)}R`,
        `平均賺 ${s.avgWinR.toFixed(2)}R　平均賠 ${s.avgLossR.toFixed(2)}R`,
        `獲利因子 ${s.profitFactor.toFixed(2)}　最大連虧 ${s.worstStreak}`,
        `最大回撤 ${s.maxDD.toFixed(1)}%　淨損益 ${usd(s.netPnl)}`,
        "",
        s.expectancy > 0
          ? "期望值為正 —— 但樣本數不夠多之前不要放大部位。"
          : "期望值為負：這套打法目前每下一注就是在丟錢。"
      ].join("\n"));
    },

    async config(){
      await say([
        modeLine(),
        `鏈 ${cfg.gmgn.chain}　錢包 ${cfg.gmgn.walletAddress || "未設定"}`,
        `本金 ${usd(cfg.risk.bankrollUsd)}　每筆 ${usd(cfg.risk.positionUsd)}`,
        `最多 ${cfg.risk.maxOpenPositions} 個部位　在場上限 ${usd(cfg.risk.maxDeployedUsd)}`,
        `停損 ${cfg.risk.stopPct}%　停利 ${(cfg.risk.stopPct * cfg.risk.targetR).toFixed(0)}%`,
        `單日虧損上限 ${usd(cfg.risk.maxDailyLossUsd)}　停機線 ${usd(cfg.risk.killSwitchUsd)}`,
        `滑價 ${cfg.exec.slippagePct}%　gas 檔位 ${cfg.exec.gasTier}　防夾 ${cfg.exec.antiMev ? "開" : "關"}`,
        `分數門檻 ${cfg.filter.minScore}　深度門檻 ${usd(cfg.filter.minDepthUsd)}`,
        "",
        "參數改 .env 之後重啟機器人。"
      ].join("\n"));
    },

    async panic(){
      store.setTrading(false, "手動 panic");
      const open = store.openPositions();
      await say(`已停止交易。準備賣出 ${open.length} 個部位…`);
      for(const p of [...open]) await doSell(p, 100, "panic");
      await say("完成。用 /resume 恢復交易。");
    },

    async resume(){
      store.setTrading(true, "");
      await say("交易已恢復。");
    }
  };

  async function doSell(position, percent, reason){
    try {
      const res = await trader.sellPosition(position, { percent, reason });
      if(!res.ok) return say(`賣出失敗：${res.error}`);
      const t = res.trade;
      await say([
        `${t.pnlUsd >= 0 ? "✅" : "🔻"} 已平倉 ${t.symbol}${t.dryRun ? "（模擬）" : ""}`,
        `${t.entryPrice} → ${t.exitPrice}`,
        `損益 ${usd(t.pnlUsd)}（${t.r.toFixed(2)}R）　原因：${t.reason}`,
        t.hash ? `tx: ${t.hash}` : ""
      ].filter(Boolean).join("\n"));
      if(!store.state.tradingEnabled) await say(`⛔ 交易已自動停用：${store.state.disabledReason}`);
    } catch(e){
      await say(`賣出出錯：${e.message}${e.hint ? `\n${e.hint}` : ""}`);
    }
  }

  /* ── 路由 ── */
  bot.on("message", async msg => {
    if(!isOwner(msg)) return;
    const text = (msg.text ?? "").trim();
    if(!text.startsWith("/")) return;
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.slice(1).split("@")[0].toLowerCase();
    const fn = commands[cmd];
    if(!fn) return say("不認得這個指令。/help 看清單。");
    try { await fn(...args); }
    catch(e){
      log.error("指令執行失敗", { cmd, error: e.message });
      await say(`出錯了：${e.message}`);
    }
  });

  bot.on("callback_query", async q => {
    if(!isOwner(q)){ return bot.answerCallbackQuery(q.id).catch(() => {}); }
    const [action, a, b] = String(q.data ?? "").split(":");
    await bot.answerCallbackQuery(q.id).catch(() => {});

    try {
      if(action === "cancel"){
        pendingPlans.delete(a);
        return say("已取消。");
      }

      if(action === "prep"){
        return commands.buy(a);
      }

      if(action === "buy"){
        const entry = pendingPlans.get(a);
        if(!entry) return say("這張報價已經失效，請重新 /buy。");
        if(Date.now() > entry.expiresAt){
          pendingPlans.delete(a);
          return say("這張報價已經過期，請重新 /buy。");
        }
        pendingPlans.delete(a);   // 用過即丟，避免重複點兩次買兩次

        await say(`送出中…${cfg.mode.dryRun ? "（模擬）" : ""}`);
        const res = await trader.executeBuy(entry.plan);
        if(!res.ok) return say(`買入失敗：${res.error}${res.detail ? `\n${res.detail}` : ""}`);

        const p = res.position;
        await say([
          `✅ 已買入 ${p.symbol}${p.dryRun ? "（模擬）" : ""}`,
          `成本 ${usd(p.costUsd)}　進場 ${p.entryPrice}`,
          `停損 ${p.stopPrice.toExponential(3)}　停利 ${p.targetPrice.toExponential(3)}`,
          p.hash ? `tx: ${p.hash}` : "",
          res.strategyMissing
            ? "⚠️ 伺服器端停損停利沒建立成功（GMGN 說明這是 best-effort）。這個部位沒有自動出場，請自己盯或手動 /sell。"
            : `策略單 ${p.strategyOrderId}`
        ].filter(Boolean).join("\n"));
        return;
      }

      if(action === "sell"){
        const position = store.getPosition(a);
        if(!position) return say("找不到這個持倉。");
        return doSell(position, parseFloat(b) || 100, "手動");
      }
    } catch(e){
      log.error("按鈕處理失敗", { data: q.data, error: e.message });
      await say(`出錯了：${e.message}`);
    }
  });

  bot.on("polling_error", e => log.warn("Telegram polling 錯誤", { error: e.message }));

  return { bot, say, commands, doSell, pendingPlans };
}
