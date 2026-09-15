/* 離線測試：把 gmgn-cli 換成假的，跑完整條買賣流程。
   不需要 API Key、不連網、不會送出任何交易。 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.TELEGRAM_TOKEN = "test:token";
process.env.OWNER_ID = "123456789";
process.env.GMGN_WALLET_ADDRESS = "TestWallet1111111111111111111111111111111";
process.env.DRY_RUN = "true";
process.env.BANKROLL_USD = "100";
process.env.POSITION_USD = "20";
process.env.MAX_OPEN_POSITIONS = "3";
process.env.MAX_DEPLOYED_USD = "60";
process.env.MAX_DAILY_LOSS_USD = "20";
process.env.KILL_SWITCH_USD = "60";
process.env.STOP_PCT = "35";
process.env.TARGET_R = "2";
process.env.SLIPPAGE_PCT = "15";
process.env.MIN_SCORE = "62";
process.env.MIN_DEPTH_USD = "30000";

const { config, buildConditionOrders, validateConfig, CURRENCY } = await import("../src/config.js");
const { evaluate, sanitize } = await import("../src/score.js");
const { evaluateGate, singleSidedDepth, honeypotVerdict } = await import("../src/gate.js");
const { createStore } = await import("../src/store.js");
const { createCli, GmgnCliError } = await import("../src/gmgncli.js");
const { createTrader } = await import("../src/trader.js");
const { stats, realMoneyGate } = await import("../src/stats.js");
const { checkBuy } = await import("../src/risk.js");

let failures = 0;
function assert(name, cond, extra = ""){
  if(cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}  << ${extra}`); failures++; }
}
function near(a, b, tol = 1e-6){ return Math.abs(a - b) <= tol; }

/* ─────────────────────────────────────────────────────────
   假的 gmgn-cli。記錄每次被呼叫的 argv，供斷言檢查。
   ───────────────────────────────────────────────────────── */
const calls = [];
let swapResponse = { order_id: "ord-1", hash: "sig-1" };
let orderStatuses = [];   // 依序回傳

function makeExecFile(overrides = {}){
  return function fakeExecFile(bin, argv, opts, cb){
    calls.push({ bin, argv });
    const join = argv.join(" ");
    let payload;

    if(overrides.throwFor && join.includes(overrides.throwFor)){
      return cb(null, overrides.throwOutput ?? "", overrides.throwStderr ?? "");
    }

    if(join.startsWith("config --check")) payload = { ok: true };
    else if(join.startsWith("market trending")) payload = { code: 0, data: overrides.trending ?? [healthyRow()] };
    else if(join.startsWith("market search")) payload = { code: 0, data: { coins: overrides.coins ?? [] } };
    else if(join.startsWith("token info")) payload = { code: 0, data: overrides.info ?? healthyInfo() };
    else if(join.startsWith("token security")) payload = { code: 0, data: overrides.security ?? healthySecurity() };
    else if(join.startsWith("gas-price")) payload = { code: 0, data: gasResponse() };
    else if(join.startsWith("order quote")) payload = { code: 0, data: { output_amount: "123456789" } };
    else if(join.startsWith("order get")) payload = { code: 0, data: orderStatuses.shift() ?? { status: "confirmed", hash: "sig-1" } };
    else if(join.startsWith("swap")) payload = { code: 0, data: swapResponse };
    else payload = { code: 0, data: {} };

    cb(null, JSON.stringify(payload), "");
  };
}

/* SOL 的 *_prio_fee 三檔恆為 1（佔位值），真實值在 *_prio_fee_mixed —— 照文件實測值造假資料 */
function gasResponse(){
  return {
    native_token_usd_price: "200",
    low: "1", average: "1", high: "1",
    low_prio_fee: 1, average_prio_fee: 1, high_prio_fee: 1,
    low_prio_fee_mixed: 0.001, average_prio_fee_mixed: 0.005, high_prio_fee_mixed: 0.01,
    average_estimate_time: 3
  };
}

function healthyRow(over = {}){
  return {
    chain: "sol", address: "Tok1111111111111111111111111111111111111111",
    symbol: "GDOG", name: "Good Dog",
    price: 0.0012, liquidity: 360000,           // 單邊 180K
    volume: 900000, swaps: 2400, buys: 1400, sells: 1000,
    holder_count: 1800,
    price_change_percent: 12, price_change_percent1h: 18, price_change_percent5m: 2,
    rug_ratio: 0.04, top_10_holder_rate: 0.18, dev_team_hold_rate: 0.01,
    bundler_rate: 0.05, rat_trader_amount_rate: 0.04, lock_percent: 0,
    burn_status: "burn", sell_tax: "", buy_tax: "",
    is_wash_trading: false, is_honeypot: 0,
    renounced_mint: 1, renounced_freeze_account: 1,
    open_timestamp: Math.floor(Date.now() / 1000) - 6 * 3600,
    ...over
  };
}

function healthyInfo(over = {}){
  const now = Date.now() / 1000;
  return {
    symbol: "GDOG", name: "Good Dog", holder_count: 1800,
    biggest_pool_address: "PoolA", creation_timestamp: Math.floor(now - 6 * 3600),
    pool: { pool_address: "PoolA", exchange: "raydium",
            base_reserve_value: "180000", quote_reserve_value: "185000", liquidity: "365000" },
    price: {
      price: 0.0012, price_5m: 0.00118, price_1h: 0.00102, price_24h: 0.0009,
      volume_24h: 900000, volume_1h: 120000,
      swaps_1h: 320, buys_1h: 190, sells_1h: 130, sells_24h: 1100,
      buy_volume_5m: 9000, sell_volume_5m: 7000,
      buy_volume_1h: 70000, sell_volume_1h: 50000,
      buy_volume_24h: 500000, sell_volume_24h: 400000
    },
    stat: { creator_hold_rate: 0.01, top_rat_trader_percentage: 4,
            top_bundler_trader_percentage: 5, top70_sniper_hold_rate: 8 },
    dev: { creator_token_status: "creator_close", top_10_holder_rate: 0.1 },
    ...over
  };
}

function healthySecurity(over = {}){
  return {
    is_honeypot: 0, honeypot: 0, can_not_sell: 0,
    buy_tax: "", sell_tax: "",
    rug_ratio: 0.04, top_10_holder_rate: 0.18,
    renounced_mint: 1, renounced_freeze_account: 1,
    ...over
  };
}

function freshStore(){
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memebot-")), "state.json");
  return createStore(file);
}

/* ═══════════════════════════ 1. 設定 ═══════════════════════════ */
{
  const v = validateConfig();
  assert("設定檔通過驗證", v.ok, v.errors.join("；"));

  const co = buildConditionOrders();
  const loss = co.find(o => o.order_type === "loss_stop");
  const profit = co.find(o => o.order_type === "profit_stop");
  assert("停損掛 35% 跌幅", loss?.price_scale === "35" && loss.sell_ratio === "100", JSON.stringify(loss));
  assert("停利掛 70% 漲幅（35 × 2R）", profit?.price_scale === "70", JSON.stringify(profit));

  assert("SOL 幣種地址結尾是 112 不是 111",
    CURRENCY.sol.native.address.endsWith("112"), CURRENCY.sol.native.address);

  const bad = JSON.parse(JSON.stringify(config));
  bad.risk.killSwitchUsd = 200;
  assert("停機線高於本金會被擋", !validateConfig(bad).ok);
}

/* ═══════════════════════════ 2. 評分 ═══════════════════════════ */
{
  const good = evaluate(healthyRow(), { minDepthUsd: 30000, chain: "sol" });
  assert("健康的幣拿到 A/B", ["A", "B"].includes(good.grade), `${good.grade} ${good.score}`);
  assert("健康的幣沒有紅旗", good.flags.length === 0, JSON.stringify(good.flags));
  assert("因子分數在 0..max 之間",
    good.factors.every(f => f.s >= -1e-9 && f.s <= f.max + 1e-9), JSON.stringify(good.factors));

  const traps = {
    "蜜罐": { is_honeypot: 1 },
    "高賣出稅": { sell_tax: "25" },
    "rug_ratio 過高": { rug_ratio: 0.55 },
    "刷量標記": { is_wash_trading: true },
    "深度不足": { liquidity: 20000 },
    "成交額太小": { volume: 10000 },
    "籌碼過度集中": { top_10_holder_rate: 0.7 },
    "開發者仍持有": { dev_team_hold_rate: 0.4 },
    "捆綁機器人": { bundler_rate: 0.5 },
    "老鼠倉": { rat_trader_amount_rate: 0.5 },
    "五分鐘暴跌": { price_change_percent5m: -18 },
    "增發權限未棄": { renounced_mint: 0 }
  };
  for(const [name, over] of Object.entries(traps)){
    const r = evaluate(healthyRow(over), { minDepthUsd: 30000, chain: "sol" });
    assert(`攔下 ${name}`, r.flags.length > 0 && r.grade === "D", `flags=${r.flags.length} grade=${r.grade}`);
  }

  /* 量/池比超上限：持有人多 = 爆拉放行；持有人少 = 刷量攔下 */
  const pump = evaluate(healthyRow({ volume: 5000000, holder_count: 1600 }), { chain: "sol" });
  const wash = evaluate(healthyRow({ volume: 5000000, holder_count: 40 }), { chain: "sol" });
  assert("高換手 + 多持有人判爆拉不攔", !pump.flags.some(f => f.includes("刷量")), JSON.stringify(pump.flags));
  assert("高換手 + 少持有人判刷量攔下", wash.flags.some(f => f.includes("刷量")), JSON.stringify(wash.flags));

  /* 稅率空字串是「未測」不是 0 */
  const untaxed = evaluate(healthyRow({ sell_tax: "" }), { chain: "sol" });
  assert("空字串稅率不會被當成高稅攔下", !untaxed.flags.some(f => f.includes("賣出稅")));

  /* 代幣名稱是鏈上任意欄位，要能清掉注入內容 */
  assert("清掉控制字元與標記", sanitize("AB C<script>​") === "ABCscript",
    JSON.stringify(sanitize("AB C<script>​")));
  assert("名稱長度設上限", sanitize("x".repeat(200)).length <= 40);
}

/* ═══════════════════════════ 3. 閘門 ═══════════════════════════ */
{
  const pass = evaluateGate({ info: healthyInfo(), security: healthySecurity(), chain: "sol", positionUsd: 20 });
  assert("健康的幣通過閘門", pass.pass, JSON.stringify(pass.blocks));
  assert("風險等級為低", pass.risk.level === "low", pass.risk.level);

  /* 深度：某一側為 0 時退回 liquidity/2，不能判成 0 深度 */
  const oneSided = singleSidedDepth({ base_reserve_value: "0", quote_reserve_value: "41687", liquidity: "83374" });
  assert("單側無報價時用 liquidity/2", near(oneSided.depth, 41687, 1), JSON.stringify(oneSided));
  const bothSides = singleSidedDepth({ base_reserve_value: "180000", quote_reserve_value: "185000", liquidity: "365000" });
  assert("兩側都有值時取較小者", near(bothSides.depth, 180000), JSON.stringify(bothSides));

  const bonkLike = evaluateGate({
    info: healthyInfo({
      biggest_pool_address: "PoolBiggest",
      pool: { pool_address: "PoolSmall", base_reserve_value: "0", quote_reserve_value: "0", liquidity: "41687" },
      price: { ...healthyInfo().price, volume_24h: 507000 }
    }),
    security: healthySecurity(), chain: "sol", positionUsd: 20
  });
  assert("多池的幣深度算下限、不判死", bonkLike.pass, JSON.stringify(bonkLike.blocks));

  /* 蜜罐四層 */
  assert("第一層 is_honeypot",
    honeypotVerdict({ is_honeypot: 1 }, {}).honeypot === true);
  assert("第二層 honeypot=1",
    honeypotVerdict({ honeypot: 1 }, {}).honeypot === true);
  assert("第三層 can_not_sell",
    honeypotVerdict({ can_not_sell: 1 }, {}).honeypot === true);
  assert("第四層 24h 有賣出即非蜜罐",
    honeypotVerdict({}, { price: { sells_24h: 5 } }).honeypot === false);
  assert("四層都沒資料回傳未知（不等於不合格）",
    honeypotVerdict({}, {}).honeypot === null);

  const hp = evaluateGate({ info: healthyInfo(), security: healthySecurity({ is_honeypot: 1 }), chain: "sol" });
  assert("蜜罐擋下", !hp.pass && hp.blocks.some(b => b.includes("蜜罐")), JSON.stringify(hp.blocks));

  /* 5 分鐘回撤 ≥10% 是這一節唯一的硬停 */
  const knife = evaluateGate({
    info: healthyInfo({ price: { ...healthyInfo().price, price: 0.0924, price_5m: 0.1107 } }),
    security: healthySecurity(), chain: "sol"
  });
  assert("5 分鐘跌超過 10% 硬停", !knife.pass && knife.blocks.some(b => b.includes("刀口")), JSON.stringify(knife.blocks));

  /* 跌 5~10% 只降級，不否決 */
  const soft = evaluateGate({
    info: healthyInfo({ price: { ...healthyInfo().price, price: 0.00113, price_5m: 0.0012 } }),
    security: healthySecurity(), chain: "sol"
  });
  assert("跌 5~10% 只降級不擋單", soft.pass && soft.downgrade.length > 0, JSON.stringify(soft));

  /* 三窗口全賣超 → 降級 */
  const outflow = evaluateGate({
    info: healthyInfo({ price: { ...healthyInfo().price,
      buy_volume_5m: 1000, sell_volume_5m: 5000,
      buy_volume_1h: 10000, sell_volume_1h: 50000,
      buy_volume_24h: 100000, sell_volume_24h: 500000 } }),
    security: healthySecurity(), chain: "sol"
  });
  assert("三窗口全賣超 → 執行降級", outflow.downgrade.some(d => d.reason.includes("賣超")), JSON.stringify(outflow.downgrade));

  /* 開發者持倉要讀 stat.creator_hold_rate，不是 dev.top_10_holder_rate */
  const devHold = evaluateGate({
    info: healthyInfo({ stat: { creator_hold_rate: 0.4 }, dev: { top_10_holder_rate: 0.01 } }),
    security: healthySecurity(), chain: "sol"
  });
  assert("開發者持倉過高擋下", devHold.blocks.some(b => b.includes("開發者")), JSON.stringify(devHold.blocks));
  const devOk = evaluateGate({
    info: healthyInfo({ stat: { creator_hold_rate: 0.01 }, dev: { top_10_holder_rate: 0.45 } }),
    security: healthySecurity(), chain: "sol"
  });
  assert("dev.top_10_holder_rate 高但開發者本身沒持倉 → 不擋", devOk.pass, JSON.stringify(devOk.blocks));

  /* 高 rug_ratio */
  const rug = evaluateGate({ info: healthyInfo(), security: healthySecurity({ rug_ratio: 0.45 }), chain: "sol" });
  assert("rug_ratio > 0.3 擋下", !rug.pass && rug.risk.level === "high");

  /* 下單金額佔深度太大要警告 */
  const heavy = evaluateGate({ info: healthyInfo(), security: healthySecurity(), chain: "sol", positionUsd: 20000 });
  assert("大單相對深度過大會警告", heavy.warnings.some(w => w.includes("滑價")), JSON.stringify(heavy.warnings));
}

/* ═══════════════════════════ 4. CLI 封裝 ═══════════════════════════ */
{
  calls.length = 0;
  const cli = createCli({ execFileImpl: makeExecFile() });

  await cli.trending({ chain: "sol", interval: "1h", limit: 50, minLiquidity: 60000, minSwaps: 10, filters: ["renounced"] });
  const t = calls.at(-1);
  assert("trending 帶 --raw", t.argv.includes("--raw"));
  assert("trending 帶上篩選條件", t.argv.includes("--min-liquidity") && t.argv.includes("--filter"));
  assert("參數以陣列傳遞，沒有經過 shell", Array.isArray(t.argv) && t.argv.every(a => typeof a === "string"));

  await cli.swap({ chain: "sol", from: "W", inputToken: "A", outputToken: "B",
                   amountRaw: 1000, slippage: 15, antiMev: true,
                   priorityFeeSol: 0.005, tipFee: 0.001,
                   conditionOrders: buildConditionOrders(), sellRatioType: "hold_amount", yes: true });
  const s = calls.at(-1).argv;
  assert("swap 帶防夾", s.includes("--anti-mev"));
  assert("swap 帶優先費與小費（掛條件單時必填）",
    s.includes("--priority-fee") && s.includes("--tip-fee"));
  assert("swap 帶 condition-orders JSON",
    s.includes("--condition-orders") && s[s.indexOf("--condition-orders") + 1].includes("loss_stop"));
  assert("swap 帶 --yes", s.includes("--yes"));

  /* 惡意代幣名稱不會變成額外參數 */
  await cli.swap({ chain: "sol", from: "W", inputToken: "A",
                   outputToken: "B; rm -rf /", amountRaw: 1, slippage: 1 });
  const evil = calls.at(-1).argv;
  assert("惡意字串只是一個參數值，不會被拆開",
    evil[evil.indexOf("--output-token") + 1] === "B; rm -rf /");

  /* 限流：只回報不重試 */
  const rateLimited = createCli({ execFileImpl: (bin, argv, opts, cb) =>
    cb(new Error("x"), "", '{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1775184222}') });
  try {
    await rateLimited.gasPrice({ chain: "sol" });
    assert("限流要丟出錯誤", false);
  } catch(e){
    assert("限流被辨識出來", e.code === "RATE_LIMIT", e.message);
    assert("限流帶解封時間", e.resetAt === 1775184222, String(e.resetAt));
  }

  /* 401/403 要提示 IPv6 */
  const authErr = createCli({ execFileImpl: (bin, argv, opts, cb) => cb(new Error("x"), "", "request failed 403") });
  try { await authErr.gasPrice({ chain: "sol" }); assert("401/403 要丟錯", false); }
  catch(e){ assert("401/403 提示 API Key 與 IPv6", e.code === "AUTH" && e.hint.includes("IPv4"), e.hint); }

  /* CLI 拒絕自動下單時，要給出正確的解法 */
  const needOptIn = createCli({ execFileImpl: (bin, argv, opts, cb) =>
    cb(new Error("x"), "", "--yes requires GMGN_ALLOW_AUTOMATED_TRADES=1") });
  try { await needOptIn.gasPrice({ chain: "sol" }); assert("拒絕自動下單要丟錯", false); }
  catch(e){ assert("拒絕自動下單時說明由本人開啟",
    e.code === "NEEDS_AUTOMATION_OPT_IN" && e.hint.includes("你本人"), e.hint); }

  /* CLI 不存在 */
  const missing = createCli({ execFileImpl: (bin, argv, opts, cb) => {
    const err = new Error("spawn ENOENT"); err.code = "ENOENT"; cb(err, "", "");
  }});
  try { await missing.gasPrice({ chain: "sol" }); assert("找不到 CLI 要丟錯", false); }
  catch(e){ assert("找不到 CLI 時提示安裝方式", e.hint.includes("npm install -g gmgn-cli"), e.hint); }

  /* 輸出混入雜訊時仍能取出 JSON */
  const noisy = createCli({ execFileImpl: (bin, argv, opts, cb) =>
    cb(null, 'warning: something\n{"code":0,"data":{"native_token_usd_price":"200"}}\n', "") });
  const g = await noisy.gasPrice({ chain: "sol" });
  assert("能從雜訊中取出 JSON", g.native_token_usd_price === "200", JSON.stringify(g));

  /* 訂單輪詢：pending → confirmed */
  orderStatuses = [{ status: "pending" }, { status: "processed" }, { status: "confirmed", hash: "sig-1" }];
  const poller = createCli({ execFileImpl: makeExecFile() });
  const settled = await poller.waitForOrder({ chain: "sol", orderId: "ord-1", intervalMs: 1, sleep: () => Promise.resolve() });
  assert("輪詢到 confirmed 才算成功", settled.ok === true, JSON.stringify(settled));

  orderStatuses = [{ status: "failed", error_status: "insufficient balance" }];
  const failed = await poller.waitForOrder({ chain: "sol", orderId: "ord-2", intervalMs: 1, sleep: () => Promise.resolve() });
  assert("failed 不算成功", failed.ok === false && failed.done === true);
}

/* ═══════════════════════════ 5. 下單前準備 ═══════════════════════════ */
{
  const store = freshStore();
  const cli = createCli({ execFileImpl: makeExecFile() });
  const trader = createTrader({ cli, store });

  const plan = await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
  assert("閘門通過就可以執行", plan.canExecute, JSON.stringify(plan.gate.blocks.concat(plan.riskCheck.reasons)));

  /* $20 ÷ $200/SOL = 0.1 SOL = 1e8 lamports */
  assert("美元正確換算成 lamports", plan.amountRaw === 100000000, String(plan.amountRaw));
  assert("優先費讀 *_prio_fee_mixed 而不是佔位的 1",
    plan.priorityFeeSol === 0.005, `拿到 ${plan.priorityFeeSol}（讀錯欄位會變成 1 SOL）`);
  assert("停損價 = 進場 -35%", near(plan.stopPrice, plan.price * 0.65, 1e-12));
  assert("停利價 = 進場 +70%", near(plan.targetPrice, plan.price * 1.7, 1e-12));
  assert("帶著要掛的條件單", plan.conditionOrders.length === 2);

  /* 閘門沒過就不能執行 */
  const badCli = createCli({ execFileImpl: makeExecFile({ security: healthySecurity({ is_honeypot: 1 }) }) });
  const badTrader = createTrader({ cli: badCli, store });
  const badPlan = await badTrader.prepareBuy({ address: "Tok2" });
  assert("蜜罐的計畫不可執行", !badPlan.canExecute);
  let threw = false;
  try { await badTrader.executeBuy(badPlan); } catch { threw = true; }
  assert("不可執行的計畫送不出去", threw);
}

/* ═══════════════════════════ 6. 模擬買賣與記帳 ═══════════════════════════ */
{
  const store = freshStore();
  const cli = createCli({ execFileImpl: makeExecFile() });
  const trader = createTrader({ cli, store });

  const plan = await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
  const buy = await trader.executeBuy(plan, { dryRun: true });
  assert("模擬買入建立部位", buy.ok && store.openPositions().length === 1);

  const pos = store.openPositions()[0];
  assert("部位標記為模擬", pos.dryRun === true);
  assert("部位記錄風險金額 $7（20 × 35%）", near(pos.riskUsd, 7, 1e-9), String(pos.riskUsd));

  /* 在停損價出場 → 大約 -1R */
  const sell = await trader.sellPosition(pos, { percent: 100, reason: "停損", dryRun: true, exitPrice: pos.stopPrice });
  assert("平倉成功", sell.ok);
  assert("停損出場約等於 -1R", near(sell.trade.r, -1, 0.02), String(sell.trade.r));
  assert("部位已移除", store.openPositions().length === 0);
  assert("平倉紀錄寫入", store.closedTrades().length === 1);

  const s = stats(store);
  assert("統計算得出來", s.n === 1 && s.wins === 0, JSON.stringify(s));
  assert("30 筆以下不得通過上真錢門檻", realMoneyGate(store).pass === false);
}

/* ═══════════════════════════ 7. 真錢路徑（全程用假 CLI） ═══════════════════════════ */
{
  const store = freshStore();
  orderStatuses = [{ status: "confirmed", hash: "sig-real",
                     strategy_order_id: "strat-9",
                     report: { price_usd: "0.0013", gas_usd: "0.12",
                               output_amount: "999", output_token_decimals: 6 } }];
  swapResponse = { order_id: "ord-real" };
  const cli = createCli({ execFileImpl: makeExecFile() });
  const trader = createTrader({ cli, store });

  const plan = await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
  const res = await trader.executeBuy(plan, { dryRun: false });
  assert("真錢買入走到 confirmed", res.ok, JSON.stringify(res));
  assert("成交價取自 report.price_usd", near(res.position.entryPrice, 0.0013), String(res.position.entryPrice));
  assert("記下伺服器端策略單 id", res.position.strategyOrderId === "strat-9");
  assert("沒有 strategyMissing 警告", !res.strategyMissing);

  /* 策略單建立失敗（best-effort）要被抓出來 */
  const store2 = freshStore();
  orderStatuses = [{ status: "confirmed", hash: "sig-2", report: { price_usd: "0.001" } }];
  const trader2 = createTrader({ cli: createCli({ execFileImpl: makeExecFile() }), store: store2 });
  const plan2 = await trader2.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
  const res2 = await trader2.executeBuy(plan2, { dryRun: false });
  assert("策略單沒建成要示警", res2.ok && res2.strategyMissing === true, JSON.stringify(res2));

  /* 訂單失敗不可以被當成買入成功 */
  const store3 = freshStore();
  orderStatuses = [{ status: "failed", error_status: "slippage exceeded" }];
  const trader3 = createTrader({ cli: createCli({ execFileImpl: makeExecFile() }), store: store3 });
  const plan3 = await trader3.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
  const res3 = await trader3.executeBuy(plan3, { dryRun: false });
  assert("訂單 failed 不建立部位", !res3.ok && store3.openPositions().length === 0, JSON.stringify(res3));
}

/* ═══════════════════════════ 8. 風控上限 ═══════════════════════════ */
{
  const store = freshStore();
  const coin = evaluate(healthyRow(), { chain: "sol" });

  assert("正常情況可以買", checkBuy({ store, coin, usdAmount: 20 }).ok);
  assert("超過單筆上限被擋",
    checkBuy({ store, coin, usdAmount: 50 }).reasons.some(r => r.includes("單筆上限")));

  /* 塞滿持倉 */
  for(let i = 0; i < 3; i++){
    store.addPosition({ id: `p${i}`, tokenAddress: `T${i}`, symbol: `S${i}`, costUsd: 20,
                        entryPrice: 1, lastPrice: 1, stopPrice: 0.65, targetPrice: 1.7, riskUsd: 7 });
  }
  const full = checkBuy({ store, coin, usdAmount: 20 });
  assert("持倉達上限被擋", full.reasons.some(r => r.includes("持倉已達上限")), JSON.stringify(full.reasons));
  assert("在場資金達上限被擋", full.reasons.some(r => r.includes("在場資金")), JSON.stringify(full.reasons));

  /* 同一顆幣不重複買 */
  const store2 = freshStore();
  store2.addPosition({ id: "x", tokenAddress: coin.address, symbol: coin.symbol, costUsd: 20,
                       entryPrice: 1, lastPrice: 1, stopPrice: 0.65, targetPrice: 1.7, riskUsd: 7 });
  assert("同一顆幣不重複買",
    checkBuy({ store: store2, coin, usdAmount: 20 }).reasons.some(r => r.includes("已經有部位")));

  /* 紅旗幣一律擋 */
  const flagged = evaluate(healthyRow({ is_honeypot: 1 }), { chain: "sol" });
  assert("紅旗幣被擋", !checkBuy({ store: freshStore(), coin: flagged, usdAmount: 20 }).ok);

  /* 單日虧損上限 */
  const store3 = freshStore();
  store3.recordTrade({ id: "t1", symbol: "L", closedAt: new Date().toISOString(), pnlUsd: -21, r: -3 });
  assert("觸及單日虧損上限被擋",
    checkBuy({ store: store3, coin, usdAmount: 20 }).reasons.some(r => r.includes("單日上限")));

  /* 停機線 */
  const store4 = freshStore();
  store4.recordTrade({ id: "t2", symbol: "L", closedAt: "2020-01-01T00:00:00.000Z", pnlUsd: -45, r: -6 });
  assert("淨值低於停機線被擋",
    checkBuy({ store: store4, coin, usdAmount: 20 }).reasons.some(r => r.includes("停機線")));
}

/* ═══════════════════════════ 9. 自動停機 ═══════════════════════════ */
{
  const store = freshStore();
  const cli = createCli({ execFileImpl: makeExecFile() });
  const trader = createTrader({ cli, store });

  /* 虧損還沒到上限時不該停機 */
  store.addPosition({ id: "small", chain: "sol", tokenAddress: "T1", symbol: "SMALL", costUsd: 20,
                      entryPrice: 1, lastPrice: 0.05, stopPrice: 0.65, targetPrice: 1.7,
                      riskUsd: 7, dryRun: true, openedAt: new Date().toISOString() });
  const small = await trader.sellPosition(store.getPosition("small"), { percent: 100, reason: "停損", dryRun: true, exitPrice: 0.05 });
  assert("單筆虧 $19 未達 $20 上限 → 不停機",
    near(small.trade.pnlUsd, -19, 1e-9) && store.state.tradingEnabled === true, String(small.trade.pnlUsd));

  /* 歸零：虧滿 $20，剛好觸及單日止血線 */
  store.addPosition({ id: "rug", chain: "sol", tokenAddress: "T2", symbol: "RUG", costUsd: 20,
                      entryPrice: 1, lastPrice: 0, stopPrice: 0.65, targetPrice: 1.7,
                      riskUsd: 7, dryRun: true, openedAt: new Date().toISOString() });
  const rugged = await trader.sellPosition(store.getPosition("rug"), { percent: 100, reason: "歸零", dryRun: true, exitPrice: 0 });
  assert("歸零認列 -$20", near(rugged.trade.pnlUsd, -20, 1e-9), String(rugged.trade.pnlUsd));
  assert("觸及單日止血線後自動停用交易", store.state.tradingEnabled === false, store.state.disabledReason);
  assert("停用原因有寫清楚", /單日虧損/.test(store.state.disabledReason), store.state.disabledReason);

  /* 停機線：淨值跌破 $60 */
  const store5 = freshStore();
  const trader5 = createTrader({ cli, store: store5 });
  store5.recordTrade({ id: "old", symbol: "OLD", closedAt: "2020-01-01T00:00:00.000Z", pnlUsd: -25, r: -3 });
  store5.addPosition({ id: "last", chain: "sol", tokenAddress: "T3", symbol: "LAST", costUsd: 20,
                       entryPrice: 1, lastPrice: 0, stopPrice: 0.65, targetPrice: 1.7,
                       riskUsd: 7, dryRun: true, openedAt: new Date().toISOString() });
  await trader5.sellPosition(store5.getPosition("last"), { percent: 100, reason: "歸零", dryRun: true, exitPrice: 0 });
  assert("淨值跌破停機線後停用交易",
    store5.state.tradingEnabled === false && /停機線/.test(store5.state.disabledReason),
    `equity=${100 + store5.realizedTotal()} reason=${store5.state.disabledReason}`);
}

/* ═══════════════════════════ 10. 儲存 ═══════════════════════════ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memebot-store-"));
  const file = path.join(dir, "state.json");
  const a = createStore(file);
  a.addPosition({ id: "keep", symbol: "KEEP", costUsd: 20, tokenAddress: "T", entryPrice: 1, riskUsd: 7 });
  a.markSeen("Tok1");

  const b = createStore(file);
  assert("重新載入後持倉還在", b.openPositions().length === 1 && b.openPositions()[0].id === "keep");
  assert("重新載入後 seen 還在", b.wasSeen("Tok1") === true);
  assert("沒看過的幣回 false", b.wasSeen("NeverSeen") === false);

  /* 壞掉的檔案要備份重來，不能整個炸掉 */
  fs.writeFileSync(file, "{ 這不是 JSON");
  const c = createStore(file);
  assert("壞檔不會讓程式崩潰", Array.isArray(c.openPositions()) && c.openPositions().length === 0);
  assert("壞檔有被備份起來",
    fs.readdirSync(dir).some(f => f.includes("corrupt")), fs.readdirSync(dir).join(","));
}

console.log("");
if(failures){
  console.log(`${failures} 項測試失敗`);
  process.exit(1);
} else {
  console.log("全部通過");
}
