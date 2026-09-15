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
  let autoTrader = null;   // 由 index.js 在建立後掛上來（它需要 say，而 say 來自這裡）
  let narrative = null;

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

  function autoLine(){
    if(!cfg.mode.autoBuy) return "🤖 自動交易：未啟用（.env 的 AUTO_BUY=false）";
    if(!store.isAutoArmed()){
      const why = store.autoDisarmReason();
      return `🤖 自動交易：待命中${why ? `（上次解除：${why}）` : ""}　用 /auto on 武裝`;
    }
    const hoursLeft = (store.autoArmedUntil() - Date.now()) / 3600000;
    const t = store.autoToday();
    return `🤖 自動交易：武裝中，剩 ${hoursLeft.toFixed(1)} 小時`
      + `　今日 ${t.count}/${cfg.auto.maxTradesPerDay} 筆　$${t.spentUsd.toFixed(0)}/$${cfg.auto.maxSpendPerDayUsd}`;
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
        autoLine(),
        "",
        "/hot [1h] 現在最熱的題材（IP）",
        "/auto on 武裝自動交易　/auto off 解除",
        "/why 它現在會買什麼、為什麼不買",
        "/scan 掃描候選",
        "/check <地址> 只做檢查不下單",
        "/buy <地址> [金額] 手動買單（要按確認）",
        "/positions 持倉",
        "/sell <id> [百分比] 賣出",
        "/stats 績效",
        "/status 系統狀態",
        "/config 目前參數",
        "/panic 全部賣光並停止交易",
        "/resume 恢復交易",
        "",
        "武裝後它會自己買；沒武裝時所有買入都要你按確認鍵。"
      ].join("\n"));
    },

    help(){ return commands.start(); },

    async status(){
      const s = stats(store, cfg);
      const open = store.openPositions();
      const cfgCheck = await cli.configCheck();
      await say([
        `${modeLine()}`,
        autoLine(),
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
    },

    /* /auto            看狀態
       /auto on         武裝（要再按一次確認鍵）
       /auto off        解除 */
    async auto(sub){
      if(!cfg.mode.autoBuy && sub === "on"){
        return say("自動交易在 .env 裡是關的。要開的話設定 AUTO_BUY=true 再重啟機器人。");
      }

      if(sub === "off"){
        store.disarmAuto("手動解除");
        return say("🤖 自動交易已解除武裝。持倉的停損停利不受影響，照樣掛在 GMGN 那邊。");
      }

      if(sub === "on"){
        const a = cfg.auto;
        return say([
          "⚠️ 武裝自動交易",
          "",
          `武裝後 ${a.armHours} 小時內，機器人會自己掃描、自己選幣、自己下單，不再問你。`,
          "",
          "它會受到的限制：",
          `· 分數要 ≥ ${a.minScore}（手動模式只要 ${cfg.filter.minScore}）`,
          `· 量／深度／安全三道閘門全過，且注意事項不超過 ${a.maxWarnings} 條`,
          `· ${a.allowDowngrade ? "接受" : "不接受"}執行降級訊號`,
          "· 蜜罐檢測必須明確安全，「未測」一律不買",
          `· 每天最多 ${a.maxTradesPerDay} 筆、最多花 $${a.maxSpendPerDayUsd}`,
          `· 每筆 $${cfg.risk.positionUsd}，停損 -${cfg.risk.stopPct}%（掛在 GMGN 伺服器端）`,
          `· 單日虧損到 $${cfg.risk.maxDailyLossUsd} 或淨值跌破 $${cfg.risk.killSwitchUsd} 就全部停掉`,
          "",
          cfg.mode.dryRun
            ? "🧪 目前是模擬模式，它只會記帳不會花錢。"
            : "💸 目前是真錢模式。按下去之後它會在你沒看螢幕的時候花你的錢。",
          "",
          `${a.armHours} 小時後武裝自動失效，要繼續得再按一次。`
        ].join("\n"), {
          reply_markup: { inline_keyboard: [[
            { text: `✅ 武裝 ${a.armHours} 小時`, callback_data: "arm:confirm" },
            { text: "取消", callback_data: "arm:cancel" }
          ]] }
        });
      }

      /* 沒帶參數：顯示狀態 */
      const budget = autoTrader?.dailyBudget?.();
      return say([
        autoLine(),
        modeLine(),
        `交易開關：${store.state.tradingEnabled ? "開啟" : `停用（${store.state.disabledReason}）`}`,
        budget && !budget.ok ? `今日額度：${budget.reasons[0]}` : "",
        "",
        "/auto on 武裝　/auto off 解除"
      ].filter(Boolean).join("\n"));
    },

    /* 熱門 IP（題材）：從熱搜 + 成交榜的代幣名稱裡把重複的關鍵字聚類出來。
       一個 IP 熱起來的特徵是「同題材一次冒出一堆幣」，不是單一顆幣在漲。 */
    async hot(intervalArg){
      if(!narrative) return say("題材模組沒載入。");
      const interval = ["1m", "5m", "1h", "6h", "24h"].includes(intervalArg) ? intervalArg : "1h";
      await say(`找 ${interval} 內的熱門題材…`);

      try {
        const { ips, scanned, hotSearchCount, trendingCount } = await narrative.hotIps({ interval });
        const social = narrative.socialNote();

        if(!ips.length){
          return say([
            `掃了 ${scanned} 顆（熱搜 ${hotSearchCount} + 成交 ${trendingCount}），沒有出現重複題材。`,
            "這通常代表現在沒有明顯的 IP 浪潮，各紅各的。",
            social.configured ? "" : social.note
          ].filter(Boolean).join("\n"));
        }

        await say([
          `${interval} 熱門題材（掃了 ${scanned} 顆，找到 ${ips.length} 個重複題材）`,
          social.configured ? `社群資料來源：${social.provider}` : social.note
        ].join("\n\n"));

        for(const ip of ips.slice(0, 5)){
          const risks = narrative.copycatRisk(ip);
          const leader = ip.leader;
          await say([
            `🔥 ${ip.keyword.toUpperCase()}　熱度 ${ip.heat}`,
            `同題材 ${ip.tokenCount} 顆　合計成交 ${usd(ip.totalVolume)}　持有人 ${ip.holders}`,
            ip.kolCount ? `KOL 持有 ${ip.kolCount} 人次　聰明錢 ${ip.smartCount} 人次` : "",
            "",
            `領頭：${sanitize(leader.symbol)}　流動性 ${usd(leader.liquidity)}`,
            `${leader.address}`,
            ip.copycats.length
              ? `其餘 ${ip.copycats.length} 顆：${ip.copycats.slice(0, 4).map(c => sanitize(c.symbol)).join(" / ")}`
              : "",
            risks.length ? "\n⚠️ " + risks.join("\n⚠️ ") : "",
            "",
            "熱度高只代表「現在很多人在搶這個題材」，不代表領頭那顆會漲。"
          ].filter(Boolean).join("\n"), {
            reply_markup: { inline_keyboard: [[
              { text: `檢查領頭的 ${sanitize(leader.symbol).slice(0, 10)}`, callback_data: `prep:${leader.address.slice(0, 50)}` }
            ]] }
          });
        }

        await say("⚠️ 熱門題材最大的坑是買錯合約。上面的「領頭」只是流動性最深的那顆，"
                + "不等於官方正主。按檢查鍵會跑完整的量／深度／安全三道閘門，別跳過。");
      } catch(e){
        await say(`找題材失敗：${e.message}${e.hint ? `\n${e.hint}` : ""}`);
      }
    },

    /* 讓你隨時能看它「現在會不會買、為什麼不買」 */
    async why(){
      if(!autoTrader) return say("自動交易模組沒載入。");
      await say("跑一輪自動判斷（不下單）…");
      const budget = autoTrader.dailyBudget();
      const lines = [
        autoLine(),
        `今日額度：${budget.ok ? "還有" : budget.reasons[0]}`
      ];
      try {
        const { all, candidates } = await trader.scan();
        const pool = candidates.filter(c => c.score >= cfg.auto.minScore);
        lines.push(`掃到 ${all.length} 顆，通過手動門檻 ${candidates.length} 顆，通過自動門檻 ${pool.length} 顆`);
        for(const coin of pool.slice(0, 3)){
          const plan = await trader.prepareBuy({ address: coin.address, coin, usdAmount: cfg.risk.positionUsd });
          plan.coinScore = coin.score;
          const extra = autoTrader.autoGate(plan);
          const reasons = [...plan.gate.blocks, ...plan.riskCheck.reasons, ...extra];
          lines.push("", `${coin.symbol}（${coin.score}）：${reasons.length ? reasons[0] : "全部條件通過，武裝時會買這顆"}`);
        }
      } catch(e){
        lines.push(`掃描失敗：${e.message}`);
      }
      await say(lines.join("\n"));
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

      if(action === "arm"){
        if(a === "cancel") return say("已取消，維持待命。");
        if(a === "confirm"){
          if(!cfg.mode.autoBuy) return say("自動交易在 .env 裡是關的。");
          if(!store.state.tradingEnabled){
            return say(`交易目前是停用狀態（${store.state.disabledReason}），先 /resume 再武裝。`);
          }
          const armed = store.armAuto(cfg.auto.armHours);
          return say([
            `🤖 自動交易已武裝${cfg.mode.dryRun ? "（模擬模式）" : ""}`,
            `到期時間：${new Date(armed.armedUntil).toLocaleString("zh-TW")}`,
            `每 ${Math.round(cfg.timing.scanIntervalSec / 60)} 分鐘掃一次，一輪最多買一筆。`,
            "",
            "隨時可以 /auto off 停掉，/why 看它現在為什麼買或不買。"
          ].join("\n"));
        }
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

  return {
    bot, say, commands, doSell, pendingPlans,
    attachAutoTrader(at){ autoTrader = at; },
    attachNarrative(n){ narrative = n; }
  };
}
