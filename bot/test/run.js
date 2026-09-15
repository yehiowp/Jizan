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
    smart_degen_count: 6, renowned_count: 3,
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

/* ═══════════════════════════ 11. 自動交易 ═══════════════════════════ */
{
  const { createAutoTrader } = await import("../src/autotrader.js");

  /* 自動模式用的設定：門檻比手動嚴 */
  const autoCfg = JSON.parse(JSON.stringify(config));
  autoCfg.mode.autoBuy = true;
  autoCfg.auto = { minScore: 72, maxWarnings: 2, allowDowngrade: false,
                   maxTradesPerDay: 2, maxSpendPerDayUsd: 40, armHours: 12,
                   vetBatchSize: 8, vetConcurrency: 4 };

  function autoSetup(overrides = {}){
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile(overrides) });
    const trader = createTrader({ cli, store, cfg: autoCfg });
    const said = [];
    const auto = createAutoTrader({ store, trader, say: m => { said.push(m); return Promise.resolve(); }, cfg: autoCfg });
    return { store, trader, auto, said };
  }

  /* 未武裝就什麼都不做 */
  {
    const { auto, store, said } = autoSetup();
    const r = await auto.cycle();
    assert("未武裝時不下單", r.skipped === "未武裝" && store.openPositions().length === 0, JSON.stringify(r));
    assert("未武裝時不吵人", said.length === 0);
  }

  /* 武裝後會自己買 */
  {
    const { auto, store, said } = autoSetup();
    store.armAuto(12);
    const r = await auto.cycle();
    assert("武裝後自動買入", r.ok === true && store.openPositions().length === 1, JSON.stringify(r));
    assert("買完會回報原因", said.some(m => m.includes("為什麼買") && m.includes("自動買入")), said[0]?.slice(0, 60));
    assert("計入當日自動額度", store.autoToday().count === 1 && store.autoToday().spentUsd === 20,
      JSON.stringify(store.autoToday()));
  }

  /* 武裝會過期 */
  {
    const { auto, store, said } = autoSetup();
    store.armAuto(12);
    assert("武裝中", store.isAutoArmed() === true);
    store.armAuto(-1);                       // 讓它變成已過期
    assert("過期後視為未武裝", store.isAutoArmed() === false);
    const r = await auto.cycle();
    assert("過期後不下單", store.openPositions().length === 0, JSON.stringify(r));
    assert("過期會通知一次", said.some(m => m.includes("時效到期")), JSON.stringify(said));
  }

  /* 當日筆數上限 */
  {
    const { auto, store } = autoSetup();
    store.armAuto(12);
    store.recordAutoBuy(20);
    store.recordAutoBuy(20);
    const r = await auto.cycle();
    assert("達當日筆數上限就停手", /上限/.test(r.skipped ?? ""), JSON.stringify(r));
  }

  /* 當日金額上限 */
  {
    const { auto, store } = autoSetup();
    store.armAuto(12);
    store.recordAutoBuy(30);                  // 再買 20 會到 50 > 40
    const r = await auto.cycle();
    assert("超過當日支出上限就停手", /支出/.test(r.skipped ?? ""), JSON.stringify(r));
  }

  /* 分數沒到自動門檻就不買（手動門檻 62，自動 72） */
  {
    const lowScore = healthyRow({ holder_count: 120, swaps: 40, volume: 120000,
                                  price_change_percent1h: 1, price_change_percent5m: 0 });
    const { auto, store } = autoSetup({ trending: [lowScore] });
    store.armAuto(12);
    const r = await auto.cycle();
    assert("分數未達自動門檻不買", store.openPositions().length === 0 && /門檻/.test(r.skipped ?? ""), JSON.stringify(r));
  }

  /* 蜜罐「未測」在自動模式一律不買 —— 人可以自己判斷，機器人不行 */
  {
    const { auto, store } = autoSetup({
      security: { rug_ratio: 0.04, top_10_holder_rate: 0.18, renounced_mint: 1, renounced_freeze_account: 1,
                  buy_tax: "", sell_tax: "" },                        // 四層蜜罐判據全缺
      info: healthyInfo({ price: { ...healthyInfo().price, sells_24h: 0 } })
    });
    store.armAuto(12);
    const r = await auto.cycle();
    assert("蜜罐未測時自動模式不買", store.openPositions().length === 0, JSON.stringify(r));
  }

  /* 執行降級訊號：手動可以買，自動不吃 */
  {
    const downgradeInfo = healthyInfo({
      price: { ...healthyInfo().price, price: 0.00113, price_5m: 0.0012 }   // 5m 回撤 -5.8%
    });
    const { auto, store, trader } = autoSetup({ info: downgradeInfo });
    store.armAuto(12);

    const plan = await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
    assert("降級單在手動模式仍可執行", plan.canExecute, JSON.stringify(plan.gate.blocks));

    plan.coinScore = 99;
    assert("降級單被自動模式擋下",
      auto.autoGate(plan).some(b => b.includes("降級")), JSON.stringify(auto.autoGate(plan)));
  }

  /* 報價失敗 → 自動模式不買 */
  {
    const { auto } = autoSetup();
    assert("報價失敗時自動模式不買",
      auto.autoGate({ coinScore: 99, quoteError: "timeout",
        gate: { warnings: [], downgrade: [], blocks: [], metrics: { honeypot: false, rugRatio: 0.04 } } })
        .some(b => b.includes("報價失敗")));
  }

  /* 注意事項太多 → 不買 */
  {
    const { auto } = autoSetup();
    const many = auto.autoGate({ coinScore: 99,
      gate: { warnings: ["a", "b", "c"], downgrade: [], blocks: [], metrics: { honeypot: false, rugRatio: 0.04 } } });
    assert("注意事項超過上限就不買", many.some(b => b.includes("注意事項")), JSON.stringify(many));
  }

  /* 交易被停用時，自動武裝要一併解除 */
  {
    const { auto, store, said } = autoSetup();
    store.armAuto(12);
    store.setTrading(false, "單日虧損達 $20");
    const r = await auto.cycle();
    assert("交易停用時自動解除武裝", store.isAutoArmed() === false, JSON.stringify(r));
    assert("解除有通知", said.some(m => m.includes("武裝一併解除")), JSON.stringify(said));
    assert("解除原因寫清楚", /停用/.test(store.autoDisarmReason()), store.autoDisarmReason());
  }

  /* 風控上限對自動模式一樣有效：持倉滿了就不買 */
  {
    const { auto, store } = autoSetup();
    store.armAuto(12);
    for(let i = 0; i < 3; i++){
      store.addPosition({ id: `f${i}`, tokenAddress: `X${i}`, symbol: `F${i}`, costUsd: 20,
                          entryPrice: 1, lastPrice: 1, stopPrice: 0.65, targetPrice: 1.7, riskUsd: 7 });
    }
    const before = store.openPositions().length;
    await auto.cycle();
    assert("持倉滿時自動模式不加倉", store.openPositions().length === before, String(store.openPositions().length));
  }

  /* 一輪最多買一筆 */
  {
    const { auto, store } = autoSetup({
      trending: [healthyRow({ address: "T1" }), healthyRow({ address: "T2" }), healthyRow({ address: "T3" })]
    });
    store.armAuto(12);
    await auto.cycle();
    assert("一輪最多買一筆", store.openPositions().length === 1, String(store.openPositions().length));
  }

  /* 設定驗證：自動門檻不得低於手動門檻 */
  {
    const bad = JSON.parse(JSON.stringify(config));
    bad.mode.autoBuy = true;
    bad.auto = { ...autoCfg.auto, minScore: 50 };
    bad.filter.minScore = 62;
    const v = validateConfig(bad);
    assert("自動門檻低於手動門檻會被擋",
      !v.ok && v.errors.some(e => e.includes("AUTO_MIN_SCORE")), JSON.stringify(v.errors));

    const badHours = JSON.parse(JSON.stringify(config));
    badHours.mode.autoBuy = true;
    badHours.auto = { ...autoCfg.auto, armHours: 999 };
    assert("武裝時效超過 72 小時會被擋", !validateConfig(badHours).ok);
  }
}

/* ═══════════════════════════ 12. 熱門題材（IP）聚類 ═══════════════════════════ */
{
  const { keywords, clusterIps, createNarrative } = await import("../src/narrative.js");

  assert("關鍵字濾掉結構字保留主題字",
    keywords("PENGU", "Pudgy Penguin Coin").includes("penguin") &&
    !keywords("PENGU", "Pudgy Penguin Coin").includes("coin"),
    JSON.stringify(keywords("PENGU", "Pudgy Penguin Coin")));
  assert("抓得到中日韓詞", keywords("企鵝幣").includes("企鵝"), JSON.stringify(keywords("企鵝幣")));
  assert("純數字與過短的字不算關鍵字",
    !keywords("42 AB").length, JSON.stringify(keywords("42 AB")));

  const ipTokens = [
    { address: "A", symbol: "PENGU", name: "Pudgy Penguin", liquidity: 900000, volume: 2000000,
      holder_count: 5000, smart_degen_count: 9, renowned_count: 4, rug_ratio: 0.03,
      open_timestamp: Math.floor(Date.now() / 1000) - 7200 },
    { address: "B", symbol: "PENGUIN2", name: "Penguin Two", liquidity: 90000, volume: 200000,
      holder_count: 400, rug_ratio: 0.1, open_timestamp: Math.floor(Date.now() / 1000) - 600 },
    { address: "C", symbol: "BABYPENGUIN", name: "Baby Penguin", liquidity: 40000, volume: 80000,
      holder_count: 200, rug_ratio: 0.2, open_timestamp: Math.floor(Date.now() / 1000) - 300 },
    { address: "D", symbol: "LONER", name: "Solo Coin", liquidity: 500000, volume: 900000, holder_count: 900 }
  ];

  const ips = clusterIps(ipTokens, { minTokens: 2 });
  const penguin = ips.find(i => i.keyword === "penguin");
  assert("同題材多顆幣被聚成一個 IP", penguin?.tokenCount === 3, JSON.stringify(ips.map(i => [i.keyword, i.tokenCount])));
  assert("領頭取流動性最深的那顆", penguin?.leader.address === "A", penguin?.leader.address);
  assert("其餘的被標成仿盤", penguin?.copycats.length === 2);
  assert("只出現一次的幣不算 IP", !ips.some(i => i.keyword === "loner"), JSON.stringify(ips.map(i => i.keyword)));
  assert("熱度把幣的顆數與成交量都算進去", penguin.heat > 0 && penguin.totalVolume === 2280000, String(penguin.totalVolume));

  /* 同一顆幣同時出現在熱搜和成交榜不能重複計算 */
  const dupes = clusterIps([...ipTokens, { ...ipTokens[0] }, { ...ipTokens[1] }], { minTokens: 2 });
  assert("重複來源的同一顆幣只算一次",
    dupes.find(i => i.keyword === "penguin")?.tokenCount === 3,
    String(dupes.find(i => i.keyword === "penguin")?.tokenCount));

  /* 仿盤風險判讀 */
  const narrative = createNarrative({ cli: createCli({ execFileImpl: makeExecFile() }) });
  const risks = narrative.copycatRisk(penguin);
  assert("剛開的仿盤會被點出來", risks.some(r => r.includes("仿盤還在增加")), JSON.stringify(risks));

  const contested = narrative.copycatRisk({
    tokenCount: 2, leader: { liquidity: 100000 }, copycats: [{ liquidity: 80000 }], newestAgeMin: 5000
  });
  assert("正主未定會被點出來", contested.some(r => r.includes("誰是正主")), JSON.stringify(contested));

  /* 沒設定付費社群 API 時要老實說，不能假裝知道推特在紅什麼 */
  delete process.env.SOCIAL_SEARCH_PROVIDER;
  delete process.env.SOCIAL_SEARCH_API_KEY;
  const note = narrative.socialNote();
  assert("沒有社群 API 時明講沒抓推特",
    note.configured === false && note.note.includes("沒有設定"), JSON.stringify(note));

  process.env.SOCIAL_SEARCH_PROVIDER = "x_api";
  process.env.SOCIAL_SEARCH_API_KEY = "k";
  assert("有設定就回報供應商", narrative.socialNote().configured === true);
  delete process.env.SOCIAL_SEARCH_PROVIDER;
  delete process.env.SOCIAL_SEARCH_API_KEY;
}

/* ═══════════════════════════ 13. 聰明錢加權 ═══════════════════════════ */
{
  const withSmart = evaluate(healthyRow({ smart_degen_count: 20, renowned_count: 10 }), { chain: "sol" });
  const without = evaluate(healthyRow({ smart_degen_count: 0, renowned_count: 0 }), { chain: "sol" });
  assert("聰明錢多的加分比較高", withSmart.score > without.score, `${withSmart.score} vs ${without.score}`);

  const smartFactor = withSmart.factors.find(f => f.k === "聰明錢/KOL");
  assert("聰明錢因子存在且有上限", smartFactor && smartFactor.s <= smartFactor.max, JSON.stringify(smartFactor));

  /* 但聰明錢救不了紅旗幣 —— 加分不能變成放行 */
  const smartHoneypot = evaluate(healthyRow({ smart_degen_count: 50, renowned_count: 30, is_honeypot: 1 }), { chain: "sol" });
  assert("聰明錢再多也救不了蜜罐", smartHoneypot.grade === "D" && smartHoneypot.flags.length > 0,
    `${smartHoneypot.grade} ${smartHoneypot.score}`);

  assert("因子上限總和是 100",
    withSmart.factors.reduce((s, f) => s + f.max, 0) === 100,
    String(withSmart.factors.reduce((s, f) => s + f.max, 0)));
}

/* ═══════════════════════════ 14. 併發與兩階段驗證 ═══════════════════════════ */
{
  const { mapLimit } = await import("../src/autotrader.js");

  const order = [];
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async n => { order.push(n); return n * 2; });
  assert("mapLimit 結果完整且順序對應", JSON.stringify(out) === "[2,4,6,8,10]", JSON.stringify(out));
  assert("mapLimit 每一項都跑到", order.length === 5, JSON.stringify(order));

  /* 這是上面真的抓到的 bug：併發數壞掉時會靜默回傳全是空洞的陣列 */
  for(const badLimit of [undefined, NaN, 0, -3, "x"]){
    const r = await mapLimit([1, 2, 3], badLimit, async n => n);
    assert(`併發數為 ${String(badLimit)} 時仍跑完全部而不是靜默跳過`,
      r.length === 3 && r.every(x => x !== undefined), JSON.stringify(r));
  }
  assert("空陣列回空陣列", JSON.stringify(await mapLimit([], 4, async n => n)) === "[]");

  /* 任何一個丟出例外要整批中止（限流時必須停手） */
  let threw = false;
  try {
    await mapLimit([1, 2, 3], 2, async n => { if(n === 2){ const e = new Error("rl"); e.code = "RATE_LIMIT"; throw e; } return n; });
  } catch(e){ threw = e.code === "RATE_LIMIT"; }
  assert("批次中有人限流就整批丟出", threw);

  /* vet 不報價，prepareBuy 才報價 */
  {
    calls.length = 0;
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile() });
    const trader = createTrader({ cli, store });

    const v = await trader.vet({ address: "Tok1111111111111111111111111111111111111111" });
    assert("vet 會判定通過", v.pass === true, JSON.stringify(v.reasons));
    assert("vet 不打報價", !calls.some(c => c.argv.join(" ").startsWith("order quote")),
      JSON.stringify(calls.map(c => c.argv.slice(0, 2).join(" "))));

    calls.length = 0;
    const plan = await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111", vetted: v });
    assert("帶著 vet 結果就不重打 info/security",
      !calls.some(c => c.argv.join(" ").startsWith("token info")),
      JSON.stringify(calls.map(c => c.argv.slice(0, 2).join(" "))));
    assert("prepareBuy 才打報價", calls.some(c => c.argv.join(" ").startsWith("order quote")));
    assert("沿用 vet 的結果仍可執行", plan.canExecute === true);
  }

  /* 掃描合併兩個來源並去重 */
  {
    const store = freshStore();
    const dup = { ...healthyRow(), address: "SAME" };
    const cli = createCli({ execFileImpl: (bin, argv, opts, cb) => {
      const join = argv.join(" ");
      if(join.startsWith("market trending")) return cb(null, JSON.stringify({ code: 0, data: [dup, healthyRow({ address: "ONLY_TREND" })] }), "");
      if(join.startsWith("market hot-searches")) return cb(null, JSON.stringify({ code: 0, data: [dup, healthyRow({ address: "ONLY_HOT" })] }), "");
      return cb(null, JSON.stringify({ code: 0, data: {} }), "");
    }});
    const trader = createTrader({ cli, store });
    const { all } = await trader.scan();
    assert("兩個來源合併後去重", all.length === 3, JSON.stringify(all.map(c => c.address)));
    assert("熱搜獨有的幣有被納入", all.some(c => c.address === "ONLY_HOT"));

    /* 其中一個來源掛掉不影響另一個 */
    const halfCli = createCli({ execFileImpl: (bin, argv, opts, cb) => {
      const join = argv.join(" ");
      if(join.startsWith("market hot-searches")) return cb(new Error("boom"), "", "boom");
      if(join.startsWith("market trending")) return cb(null, JSON.stringify({ code: 0, data: [healthyRow()] }), "");
      return cb(null, JSON.stringify({ code: 0, data: {} }), "");
    }});
    const halfTrader = createTrader({ cli: halfCli, store: freshStore() });
    const half = await halfTrader.scan();
    assert("熱搜掛掉仍拿得到 trending 的結果", half.all.length === 1, String(half.all.length));
  }

  /* 驗過沒過的幣進冷卻，不再重複驗 */
  {
    const store = freshStore();
    store.markRejected("Tok1111111111111111111111111111111111111111");
    assert("剛拒絕的幣在冷卻中", store.wasRejected("Tok1111111111111111111111111111111111111111") === true);
    assert("沒拒絕過的不在冷卻", store.wasRejected("Other") === false);
    assert("冷卻窗外就可以重驗",
      store.wasRejected("Tok1111111111111111111111111111111111111111", 0) === false);

    const cli = createCli({ execFileImpl: makeExecFile() });
    const trader = createTrader({ cli, store });
    const { candidates } = await trader.scan();
    assert("冷卻中的幣不會進候選", !candidates.some(c => c.address.startsWith("Tok1")),
      JSON.stringify(candidates.map(c => c.address)));
  }

  /* gas-price 在 TTL 內只打一次 */
  {
    calls.length = 0;
    const store = freshStore();
    const trader = createTrader({ cli: createCli({ execFileImpl: makeExecFile() }), store });
    await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
    await trader.prepareBuy({ address: "Tok1111111111111111111111111111111111111111" });
    const gasCalls = calls.filter(c => c.argv[0] === "gas-price").length;
    assert("gas-price 在快取期內只打一次", gasCalls === 1, String(gasCalls));
  }
}

/* ═══════════════════════════ 15. 不會卡住、不會謊報成功 ═══════════════════════════ */
{
  /* stdin 必須關掉。gmgn-cli 的互動確認會從 tty 讀輸入，
     繼承 stdin 的話會一路等到逾時，外面看起來就是整支程式死掉。 */
  {
    let opts = null;
    const cli = createCli({ execFileImpl: (bin, argv, o, cb) => {
      opts = o;
      cb(null, JSON.stringify({ code: 0, data: {} }), "");
    }});
    await cli.gasPrice({ chain: "sol" });
    assert("子程序的 stdin 被關掉（不會卡在互動提示）",
      Array.isArray(opts?.stdio) && opts.stdio[0] === "ignore", JSON.stringify(opts?.stdio));
    assert("每個呼叫都有逾時上限", typeof opts?.timeout === "number" && opts.timeout > 0, String(opts?.timeout));
  }

  /* config --check 的離開碼就是答案：0 = 已設定，1 = 沒設定。
     這是實際踩到的 bug —— 舊寫法用 allowNonZero 把非零碼吞掉，
     結果沒有 API Key 也回報「已設定」，/status 和 selftest 都會騙人。 */
  {
    const okCli = createCli({ execFileImpl: (bin, argv, o, cb) => cb(null, "", "") });
    assert("離開碼 0 → 已設定", (await okCli.configCheck()).ok === true);

    const failCli = createCli({ execFileImpl: (bin, argv, o, cb) => {
      const err = new Error("Command failed"); err.code = 1;
      cb(err, "", "API key not configured");
    }});
    const r = await failCli.configCheck();
    assert("離開碼 1 → 回報未設定，不是謊報成功", r.ok === false, JSON.stringify(r));
    assert("未設定時給得出解法", (r.hint ?? "").includes("config --apply"), r.hint);
    assert("未設定時帶出 CLI 自己的訊息", (r.error ?? "").includes("API key"), r.error);
  }

  /* 逾時要回報成逾時，不是無限等待 */
  {
    const hang = createCli({ execFileImpl: (bin, argv, o, cb) => {
      const err = new Error("timeout"); err.killed = true;
      cb(err, "", "");
    }});
    let msg = "";
    try { await hang.gasPrice({ chain: "sol" }); } catch(e){ msg = e.message; }
    assert("逾時明確回報而不是卡住", msg.includes("逾時"), msg);
  }
}

console.log("");
if(failures){
  console.log(`${failures} 項測試失敗`);
  process.exit(1);
} else {
  console.log("全部通過");
}
