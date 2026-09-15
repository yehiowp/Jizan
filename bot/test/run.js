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
                   vetBatchSize: 8, vetConcurrency: 4, deadManMs: 15 * 60000 };

  function autoSetup(overrides = {}){
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile(overrides) });
    const trader = createTrader({ cli, store, cfg: autoCfg });
    const said = [];
    const auto = createAutoTrader({ store, trader,
      say: m => { said.push(m); return Promise.resolve(); },
      telegramSilentMs: overrides.telegramSilentMs ?? (() => 0),
      cfg: autoCfg });
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

  /* 報價失敗：真錢模式硬擋，模擬模式放行。
     只有讀取權限的 API Key（沒綁交易錢包）本來就拿不到報價，
     模擬模式再擋下去就整個驗證週都跑不起來了。 */
  {
    const planWithQuoteError = { coinScore: 99, quoteError: "timeout",
      gate: { warnings: [], downgrade: [], blocks: [], metrics: { honeypot: false, rugRatio: 0.04 } } };

    const liveCfg = JSON.parse(JSON.stringify(autoCfg));
    liveCfg.mode.dryRun = false;
    const liveAuto = createAutoTrader({ store: freshStore(), trader: null,
      say: () => Promise.resolve(), cfg: liveCfg });
    assert("真錢模式：報價失敗就不買",
      liveAuto.autoGate(planWithQuoteError).some(b => b.includes("報價失敗")),
      JSON.stringify(liveAuto.autoGate(planWithQuoteError)));

    const { auto } = autoSetup();   // autoCfg.mode.dryRun === true
    assert("模擬模式：報價失敗不擋（否則整個模擬週跑不起來）",
      !auto.autoGate(planWithQuoteError).some(b => b.includes("報價失敗")),
      JSON.stringify(auto.autoGate(planWithQuoteError)));
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

/* ═══════════════════════════ 16. 對帳（伺服器端出場同步回帳本） ═══════════════════════════ */
{
  const { createReconciler } = await import("../src/reconcile.js");

  function reconSetup({ openStrategies = [], history = [], balance = null, balanceErr = false } = {}){
    const store = freshStore();
    const said = [];
    const cli = createCli({ execFileImpl: (bin, argv, o, cb) => {
      const join = argv.join(" ");
      if(join.startsWith("order strategy list")){
        const type = argv[argv.indexOf("--type") + 1];
        return cb(null, JSON.stringify({ code: 0, data: type === "history" ? history : openStrategies }), "");
      }
      if(join.startsWith("portfolio token-balance")){
        if(balanceErr) return cb(new Error("boom"), "", "boom");
        return cb(null, JSON.stringify({ code: 0, data: balance ?? {} }), "");
      }
      if(join.startsWith("token info")) return cb(null, JSON.stringify({ code: 0, data: healthyInfo() }), "");
      return cb(null, JSON.stringify({ code: 0, data: {} }), "");
    }});
    const trader = createTrader({ cli, store });
    const rec = createReconciler({ cli, store, trader, say: m => { said.push(m); return Promise.resolve(); } });

    store.addPosition({
      id: "p1", chain: "sol", tokenAddress: "Tok1", symbol: "GDOG",
      openedAt: new Date().toISOString(), costUsd: 20, entryPrice: 1, lastPrice: 0.6,
      stopPrice: 0.65, targetPrice: 1.7, stopPct: 35, targetR: 2, riskUsd: 7,
      strategyOrderId: "strat-1", dryRun: false
    });
    return { store, rec, said };
  }

  /* 兩道證據都成立 → 平倉入帳 */
  {
    const { store, rec, said } = reconSetup({
      openStrategies: [],
      history: [{ order_id: "strat-1", price_usd: "0.64" }],
      balance: { balance: "0" }
    });
    const r = await rec.run();
    assert("兩道證據齊全就平倉", r.closed === 1 && store.openPositions().length === 0, JSON.stringify(r));
    const t = store.closedTrades()[0];
    assert("用策略單的成交價入帳", near(t.exitPrice, 0.64, 1e-9), String(t.exitPrice));
    assert("虧損真的入帳了", t.pnlUsd < 0 && near(t.pnlUsd, 20 * (0.64 - 1), 1e-9), String(t.pnlUsd));
    assert("有通知使用者", said.some(m => m.includes("已由 GMGN 伺服器端出場")), said[0]?.slice(0, 40));
  }

  /* 策略單還掛著、錢包還有幣 → 什麼都不該做 */
  {
    const { store, rec, said } = reconSetup({
      openStrategies: [{ order_id: "strat-1" }],
      balance: { balance: "12345" }
    });
    const r = await rec.run();
    assert("部位還活著時不動帳", r.closed === 0 && store.openPositions().length === 1, JSON.stringify(r));
    assert("部位還活著時不吵人", said.length === 0, JSON.stringify(said));
  }

  /* 只有一道證據 → 示警但不動帳 */
  {
    const { store, rec, said } = reconSetup({
      openStrategies: [],                       // 策略單不見了
      balance: { balance: "5000" }              // 但幣還在
    });
    const r = await rec.run();
    assert("只有一道證據時不自己平倉", r.closed === 0 && store.openPositions().length === 1, JSON.stringify(r));
    assert("只有一道證據時要示警", r.flagged === 1 && said.some(m => m.includes("對不上")), JSON.stringify(said));
    /* 六小時內同一個部位不重複洗版 */
    const again = await rec.run();
    assert("同一個對不上的部位不重複通知", again.flagged === 1 && said.length === 1, String(said.length));
  }

  /* 查詢失敗 = 未知，絕不能當成已出場 */
  {
    const { store, rec } = reconSetup({ openStrategies: [], balanceErr: true });
    const r = await rec.run();
    assert("查餘額失敗時不平倉（未知不等於已出場）",
      r.closed === 0 && store.openPositions().length === 1, JSON.stringify(r));
  }

  /* 餘額欄位整個拿不到 → 一樣算未知 */
  {
    const { store, rec } = reconSetup({ openStrategies: [], balance: {} });
    const r = await rec.run();
    assert("餘額欄位缺失時不平倉", r.closed === 0 && store.openPositions().length === 1, JSON.stringify(r));
  }

  /* 拿不到成交價時退回最後報價，並標示為估算 */
  {
    const { store, rec, said } = reconSetup({
      openStrategies: [], history: [], balance: { balance: "0" }
    });
    await rec.run();
    const t = store.closedTrades()[0];
    assert("沒有成交價就用最後報價", near(t.exitPrice, 0.6, 1e-9), String(t.exitPrice));
    assert("估算要講明", said.some(m => m.includes("估算")), said[0]?.slice(0, 80));
  }

  /* 模擬倉不對帳（它本來就沒有鏈上部位） */
  {
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile() });
    const trader = createTrader({ cli, store });
    const rec = createReconciler({ cli, store, trader, say: () => Promise.resolve() });
    store.addPosition({ id: "d1", chain: "sol", tokenAddress: "T", symbol: "DRY", costUsd: 20,
                        entryPrice: 1, lastPrice: 1, stopPrice: 0.65, targetPrice: 1.7,
                        riskUsd: 7, dryRun: true, openedAt: new Date().toISOString() });
    const r = await rec.run();
    assert("模擬倉不進對帳", r.checked === 0 && store.openPositions().length === 1, JSON.stringify(r));
  }

  /* 對帳造成的虧損要能觸發停機 —— 這正是沒有對帳時失效的那道防線 */
  {
    /* 停損在暴跌中成交在 0.01（進場 1）→ 這一筆就虧掉 $19.8 */
    const { store, rec } = reconSetup({
      openStrategies: [], history: [{ order_id: "strat-1", price_usd: "0.01" }], balance: { balance: "0" }
    });
    store.recordTrade({ id: "old", symbol: "OLD", closedAt: new Date().toISOString(), pnlUsd: -5, r: -1 });
    await rec.run();
    assert("對帳入帳後單日止血線會被觸發",
      store.state.tradingEnabled === false && /單日虧損|停機線/.test(store.state.disabledReason),
      `today=${store.realizedToday()} reason=${store.state.disabledReason}`);
  }
}

/* ═══════════════════════════ 17. 模擬與真錢分開計算 ═══════════════════════════ */
{
  const store = freshStore();
  /* 模擬：3 勝 1 敗，很漂亮。真錢：2 敗，很難看。 */
  const mk = (id, pnl, r, dryRun, day) => ({
    id, symbol: id, closedAt: `2026-01-${day}T00:00:00.000Z`, pnlUsd: pnl, r, dryRun
  });
  [mk("d1", 20, 2, true, "01"), mk("d2", 20, 2, true, "02"),
   mk("d3", 20, 2, true, "03"), mk("d4", -7, -1, true, "04"),
   mk("L1", -7, -1, false, "05"), mk("L2", -7, -1, false, "06")]
    .forEach(t => store.recordTrade(t));

  const all = stats(store, config);
  const dry = stats(store, config, { mode: "dry" });
  const live = stats(store, config, { mode: "live" });

  assert("模擬只算模擬單", dry.n === 4 && dry.wins === 3, JSON.stringify([dry.n, dry.wins]));
  assert("真錢只算真錢單", live.n === 2 && live.wins === 0, JSON.stringify([live.n, live.wins]));
  assert("兩者相加等於全部", dry.n + live.n === all.n, `${dry.n}+${live.n} vs ${all.n}`);

  /* 這正是分開算的理由：混在一起看，真錢全虧卻顯示正期望值 */
  assert("混合統計會粉飾真錢的虧損", all.expectancy > 0, String(all.expectancy));
  assert("真錢單獨看是負期望值", live.expectancy < 0, String(live.expectancy));
  assert("模擬單獨看是正期望值", dry.expectancy > 0, String(dry.expectancy));

  /* 上真錢門檻只看模擬單 —— 拿真錢成績決定要不要上真錢，邏輯是反的 */
  const gate = realMoneyGate(store, config);
  assert("門檻用模擬筆數判斷", gate.checks[0].now === "4 筆", gate.checks[0].now);
  assert("4 筆不夠 30 筆，不通過", gate.pass === false);
}

/* ═══════════════════════════ 18. 狀態檔不會無限長大 ═══════════════════════════ */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memebot-prune-"));
  const file = path.join(dir, "state.json");

  const old = Date.now() - 48 * 3600 * 1000;
  const fresh = Date.now() - 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({
    seen: { oldOne: old, freshOne: fresh, brokenOne: "不是數字" },
    positions: [], trades: [], daily: {}
  }));

  const s = createStore(file);
  assert("載入時清掉過期的 seen", s.wasSeen("oldOne", 24 * 3600 * 1000) === false);
  assert("載入時保留還在有效期的", s.wasSeen("freshOne") === true);
  assert("壞掉的值也一併清掉", s.seenCount() === 1, String(s.seenCount()));

  /* 累積過多時會自己清 */
  for(let i = 0; i < 600; i++) s.state.seen[`x${i}`] = old;
  s.markSeen("trigger");
  assert("超過上限時自動清理", s.seenCount() < 600, String(s.seenCount()));
  assert("清理後新的那筆還在", s.wasSeen("trigger") === true);
}

/* ═══════════════════════════ 19. 欄位驗證工具 ═══════════════════════════ */
{
  const { verify } = await import("../src/verify-fields.js");

  const fullGas = { code: 0, data: { native_token_usd_price: "212.4",
    average_prio_fee: 1, average_prio_fee_mixed: 0.005,
    low_prio_fee_mixed: 0.001, high_prio_fee_mixed: 0.01, average_estimate_time: 3 } };
  const g = verify("gas", fullGas);
  assert("欄位齊全時沒有缺失", g.missing === 0 && g.criticalMissing === 0, JSON.stringify([g.missing, g.criticalMissing]));
  assert("認得出佔位值陷阱", g.report.some(r => r[1] === "佔位值陷阱" && r[2].includes("正確")),
    JSON.stringify(g.report.at(-1)));

  const renamed = verify("gas", { code: 0, data: { sol_usd_price: "212.4" } });
  assert("關鍵欄位改名會被抓到", renamed.criticalMissing >= 2, String(renamed.criticalMissing));
  assert("缺失說明講得出後果", renamed.report.some(r => r[2].includes("下單數量直接錯")));

  /* trending 是陣列，要能從各種包裝裡找出第一筆 */
  const row = { address: "A", symbol: "S", liquidity: 1, volume: 1, price: 1, swaps: 1,
    buys: 1, sells: 1, holder_count: 1, price_change_percent1h: 1, price_change_percent5m: 1,
    rug_ratio: 0.1, top_10_holder_rate: 0.1, is_wash_trading: false, is_honeypot: 0,
    renounced_mint: 1, renounced_freeze_account: 1, dev_team_hold_rate: 0, bundler_rate: 0,
    rat_trader_amount_rate: 0, smart_degen_count: 1, renowned_count: 1, burn_status: "burn",
    lock_percent: 0, open_timestamp: 1, sell_tax: "", buy_tax: "" };
  for(const wrap of [[row], { rank: [row] }, { list: [row] }, { data: [row] }]){
    const r = verify("trending", wrap.code !== undefined ? wrap : { code: 0, data: wrap });
    assert(`trending 從 ${Array.isArray(wrap) ? "陣列" : Object.keys(wrap)[0]} 取得資料`,
      r.criticalMissing === 0, JSON.stringify(r.report.filter(x => x[0] === "critical")));
  }
  const empty = verify("trending", { code: 0, data: [] });
  assert("空清單被當成問題回報", empty.missing === 1 && empty.report[0][0] === "critical");

  /* 巢狀路徑 */
  const info = verify("info", { code: 0, data: { price: { price: 1 }, pool: {}, stat: {} } });
  assert("巢狀欄位找得到", info.report.some(r => r[1] === "price.price" && r[0] === "ok"));
  assert("巢狀欄位缺失也抓得到",
    info.report.some(r => r[1] === "stat.creator_hold_rate" && r[0] === "critical"));

  /* null 不等於缺失 —— Solana 上很多欄位本來就是 null */
  const nulls = verify("security", { code: 0, data: { is_honeypot: null, rug_ratio: 0.1,
    top_10_holder_rate: 0.1, sell_tax: "", renounced_mint: 1 } });
  assert("null 值不算缺失", nulls.report.some(r => r[1] === "is_honeypot" && r[0] === "info"),
    JSON.stringify(nulls.report[0]));
  assert("空字串稅率標示為未測", nulls.report.some(r => r[1] === "sell_tax" && r[2].includes("未測")));

  let threw = false;
  try { verify("不存在的種類", {}); } catch { threw = true; }
  assert("不認得的種類會報錯", threw);
}

/* ═══════════════════════════ 20. Windows 的 .cmd 包裝 ═══════════════════════════ */
{
  const { resolveCli } = await import("../src/resolve-cli.js");

  /* 非 Windows：直接執行，不繞路 */
  const nix = resolveCli("gmgn-cli", { win: false });
  assert("非 Windows 直接執行", nix.cmd === "gmgn-cli" && nix.prefixArgs.length === 0 && !nix.needsShell,
    JSON.stringify(nix));

  /* Windows：找得到 JS 進入點時，改用 node 去跑它 ——
     這是 spawn EINVAL 的正解，不是開 shell */
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memebot-win-"));
  const pkgDir = path.join(fakeRoot, "gmgn-cli");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "cli.js"), "// entry");
  fs.writeFileSync(path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "gmgn-cli", bin: { "gmgn-cli": "cli.js" } }));

  const win = resolveCli("gmgn-cli", { win: true, roots: [fakeRoot] });
  assert("Windows 改用 node 執行", win.cmd === process.execPath, win.cmd);
  assert("Windows 把 JS 進入點放在參數最前面",
    win.prefixArgs.length === 1 && win.prefixArgs[0].endsWith("cli.js"), JSON.stringify(win.prefixArgs));
  assert("Windows 正解不需要 shell", !win.needsShell && win.via === "node-entry", win.via);

  /* bin 是字串形式的 package.json 也要支援 */
  const pkgDir2 = path.join(fakeRoot, "other-cli");
  fs.mkdirSync(pkgDir2, { recursive: true });
  fs.writeFileSync(path.join(pkgDir2, "main.js"), "// entry");
  fs.writeFileSync(path.join(pkgDir2, "package.json"),
    JSON.stringify({ name: "other-cli", bin: "main.js" }));
  const win2 = resolveCli("other-cli", { win: true, roots: [fakeRoot] });
  assert("bin 是字串也解析得出來", win2.prefixArgs[0]?.endsWith("main.js"), JSON.stringify(win2));

  /* 找不到時才退回 .cmd + shell，而且要標示出來讓呼叫端知道 */
  const fallback = resolveCli("gmgn-cli", { win: true, roots: [path.join(fakeRoot, "nope")] });
  assert("找不到才退回 .cmd", fallback.cmd === "gmgn-cli.cmd" && fallback.needsShell === true,
    JSON.stringify(fallback));
  assert("退回路徑有標記", fallback.via === "cmd-shell");

  /* 實際傳給 execFile 的參數：node 進入點要在最前面，原本的參數順序不變 */
  {
    let seen = null;
    const cli = createCli({
      resolved: { cmd: "NODE", prefixArgs: ["/x/cli.js"], via: "node-entry" },
      execFileImpl: (cmd, argv, o, cb) => { seen = { cmd, argv, shell: o.shell };
        cb(null, JSON.stringify({ code: 0, data: {} }), ""); }
    });
    await cli.gasPrice({ chain: "sol" });
    assert("Windows 路徑下執行的是 node", seen.cmd === "NODE", seen.cmd);
    assert("進入點在參數最前面，原參數順序不變",
      seen.argv[0] === "/x/cli.js" && seen.argv[1] === "gas-price" && seen.argv.at(-1) === "--raw",
      JSON.stringify(seen.argv));
    assert("node-entry 路徑不開 shell", seen.shell === false, String(seen.shell));
  }

  /* 帶引號的 JSON 參數必須原封不動 —— 這正是不能用 shell:true 的理由 */
  {
    let seen = null;
    const cli = createCli({
      resolved: { cmd: "NODE", prefixArgs: ["/x/cli.js"], via: "node-entry" },
      execFileImpl: (cmd, argv, o, cb) => { seen = argv; cb(null, JSON.stringify({ code: 0, data: { order_id: "1" } }), ""); }
    });
    const orders = [{ order_type: "loss_stop", side: "sell", price_scale: "35", sell_ratio: "100" }];
    await cli.swap({ chain: "sol", from: "W", inputToken: "A", outputToken: "B",
                     amountRaw: 1, slippage: 15, conditionOrders: orders });
    const json = seen[seen.indexOf("--condition-orders") + 1];
    assert("condition-orders 的 JSON 完整保留",
      JSON.parse(json)[0].order_type === "loss_stop", json);
  }
}

/* ═══════════════════════════ 21. Telegram 斷線保險 ═══════════════════════════ */
{
  const { createAutoTrader } = await import("../src/autotrader.js");
  const autoCfg2 = JSON.parse(JSON.stringify(config));
  autoCfg2.mode.autoBuy = true;
  autoCfg2.auto = { minScore: 72, maxWarnings: 2, allowDowngrade: false,
                    maxTradesPerDay: 4, maxSpendPerDayUsd: 60, armHours: 12,
                    vetBatchSize: 8, vetConcurrency: 4, deadManMs: 15 * 60000 };

  function deadManSetup(silentMs){
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile() });
    const trader = createTrader({ cli, store, cfg: autoCfg2 });
    const said = [];
    const auto = createAutoTrader({ store, trader,
      say: m => { said.push(m); return Promise.resolve(); },
      telegramSilentMs: () => silentMs, cfg: autoCfg2 });
    store.armAuto(12);
    return { store, auto, said };
  }

  /* 還連得上 → 照常交易 */
  {
    const { store, auto } = deadManSetup(60 * 1000);
    const r = await auto.cycle();
    assert("Telegram 正常時照常運作", r.skipped !== "Telegram 失聯" && store.isAutoArmed(), JSON.stringify(r));
  }

  /* 失聯超過門檻 → 自己解除武裝，不再下單 */
  {
    const { store, auto, said } = deadManSetup(20 * 60 * 1000);
    const before = store.openPositions().length;
    const r = await auto.cycle();
    assert("失聯超過門檻就停手", r.skipped === "Telegram 失聯", JSON.stringify(r));
    assert("失聯時自動解除武裝", store.isAutoArmed() === false);
    assert("不會在失聯期間開新倉", store.openPositions().length === before);
    assert("解除原因寫清楚", /連不上 Telegram/.test(store.autoDisarmReason()), store.autoDisarmReason());
    assert("有留下通知（等連線恢復會補送）",
      said.some(m => m.includes("自動解除武裝")), JSON.stringify(said));
  }

  /* 剛好在門檻內 → 還不該停 */
  {
    const { store, auto } = deadManSetup(14 * 60 * 1000);
    const r = await auto.cycle();
    assert("門檻內不誤判", r.skipped !== "Telegram 失聯" && store.isAutoArmed(), JSON.stringify(r));
  }

  /* 沒接這個偵測器時不該爆掉（向後相容） */
  {
    const store = freshStore();
    const cli = createCli({ execFileImpl: makeExecFile() });
    const trader = createTrader({ cli, store, cfg: autoCfg2 });
    const auto = createAutoTrader({ store, trader, say: () => Promise.resolve(), cfg: autoCfg2 });
    store.armAuto(12);
    let ok = true;
    try { await auto.cycle(); } catch { ok = false; }
    assert("沒提供偵測器也能跑", ok);
  }
}

/* ═══════════════════════════ 22. 限流：不要自己去撞 ═══════════════════════════ */
{
  const { createBucket } = await import("../src/gmgncli.js");

  let clock = 0;
  const b = createBucket({ capacity: 20, refillPerSec: 20, now: () => clock });

  assert("一開始是滿的", b.level === 20, String(b.level));
  assert("有額度時不用等", b.waitMs(5) === 0);

  b.take(20);
  assert("用完之後要等", b.waitMs(1) > 0, String(b.waitMs(1)));
  clock += 1000;                       // 過一秒補滿
  assert("時間過了就補回來", b.waitMs(20) === 0, String(b.waitMs(20)));

  /* 權重：swap 是 5，讀取類是 1 */
  const heavy = createBucket({ capacity: 6, refillPerSec: 1, now: () => clock });
  heavy.take(5);
  assert("重指令吃掉大部分額度", heavy.level <= 1.01, String(heavy.level));

  /* 被封鎖期間一律不送 */
  const banned = createBucket({ now: () => clock });
  banned.ban(clock + 300000);
  assert("封鎖期間要等", banned.waitMs(1) === 300000, String(banned.waitMs(1)));
  assert("回報剩餘封鎖時間", banned.bannedForMs() === 300000);
  clock += 300000;
  assert("封鎖過期後恢復", banned.bannedForMs() === 0);

  /* CLI 層：限流回應要讓後續請求在本地就被擋下，不再送出去 */
  {
    let calls = 0;
    const cli = createCli({
      sleep: () => Promise.resolve(),
      execFileImpl: (cmd, argv, o, cb) => {
        calls++;
        cb(new Error("x"), "", '{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":' +
          Math.floor((Date.now() + 120000) / 1000) + '}');
      }
    });

    let first = null;
    try { await cli.gasPrice({ chain: "sol" }); } catch(e){ first = e; }
    assert("第一次撞到限流會回報", first?.code === "RATE_LIMIT", first?.message);
    assert("第一次有真的送出去", calls === 1, String(calls));

    let second = null;
    try { await cli.trending({ chain: "sol" }); } catch(e){ second = e; }
    assert("第二次直接在本地擋下，不再送出", calls === 1, String(calls));
    assert("擋下時說明還要等多久", second?.code === "RATE_LIMIT" && /秒/.test(second.hint), second?.hint);
  }

  /* 額度不足時會等待而不是失敗 */
  {
    let slept = 0;
    const tiny = createBucket({ capacity: 2, refillPerSec: 2 });
    const cli = createCli({
      bucket: tiny,
      sleep: ms => { slept += ms; return Promise.resolve(); },
      execFileImpl: (cmd, argv, o, cb) => cb(null, JSON.stringify({ code: 0, data: {} }), "")
    });
    await cli.gasPrice({ chain: "sol" });   // 權重 1
    await cli.gasPrice({ chain: "sol" });   // 權重 1，剛好用完
    await cli.gasPrice({ chain: "sol" });   // 要等補充
    assert("額度不足時是等待而不是報錯", slept > 0, String(slept));
  }
}

/* ═══════════════════════════ 23. 心跳 ═══════════════════════════ */
{
  const { createHeartbeat } = await import("../src/heartbeat.js");

  const store = freshStore();
  const said = [];
  const hb = createHeartbeat({ store, say: m => { said.push(m); return Promise.resolve(); }, cfg: config });

  await hb.beat();
  assert("心跳說得出自己還在跑", said[0]?.includes("還在跑"), said[0]?.slice(0, 30));
  assert("心跳帶上持倉與損益", /持倉 0/.test(said[0]) && /今日已實現/.test(said[0]), said[0]);

  /* 交易被停用時，心跳一定要講出來 —— 這是最需要你知道的狀態 */
  store.setTrading(false, "單日虧損達 $20");
  await hb.beat();
  assert("停用狀態會出現在心跳裡", said[1]?.includes("交易已停用"), said[1]);

  /* 關閉時不排程 */
  const offCfg = JSON.parse(JSON.stringify(config));
  offCfg.timing.heartbeatHours = 0;
  const off = createHeartbeat({ store, say: () => Promise.resolve(), cfg: offCfg });
  off.start();
  let ok = true;
  try { off.stop(); } catch { ok = false; }
  assert("設 0 就不啟動也不報錯", ok);
}

/* ═══ 設定精靈 ═══
   這支的價值全在「不要把使用者既有的設定弄壞」，所以測的是合併行為，
   不是問答流程（問答要 TTY，測不了，程式本身也擋掉了管線輸入）。 */
{
  const { applyEnv, parseEnv, cleanInput, mask, QUESTIONS } =
    await import("../setup.mjs");

  const base = [
    "# 註解要留著",
    "TELEGRAM_TOKEN=舊的",
    "OWNER_ID=111",
    "",
    "# 使用者自己調過的參數",
    "POSITION_USD=7",
    "DRY_RUN=true"
  ].join("\n");

  const out = applyEnv(base, { TELEGRAM_TOKEN: "新的", OWNER_ID: "222" });

  assert("替換問到的欄位", out.includes("TELEGRAM_TOKEN=新的") && out.includes("OWNER_ID=222"));
  assert("註解原樣保留", out.includes("# 註解要留著") && out.includes("# 使用者自己調過的參數"));
  assert("沒問到的設定不動", out.includes("POSITION_USD=7") && out.includes("DRY_RUN=true"), out);
  assert("不留下舊值", !out.includes("TELEGRAM_TOKEN=舊的"));

  /* 骨架裡沒有這個鍵時要補在後面，不能默默丟掉 */
  const added = applyEnv("DRY_RUN=true", { OWNER_ID: "333" });
  assert("骨架缺的鍵會補上", added.includes("OWNER_ID=333"), added);

  assert("讀得回既有值", parseEnv("A=1\n# x\nB = 2 ").B === "2");

  /* 手機貼上常常連鍵名、引號一起貼進來 */
  assert("貼到 KEY= 也吃得下", cleanInput("OWNER_ID=12345", "OWNER_ID") === "12345");
  assert("引號會被剝掉", cleanInput('"12345"', "OWNER_ID") === "12345");

  const tok = QUESTIONS.find(q => q.key === "TELEGRAM_TOKEN");
  const own = QUESTIONS.find(q => q.key === "OWNER_ID");
  const wal = QUESTIONS.find(q => q.key === "GMGN_WALLET_ADDRESS");
  assert("擋掉不是 token 的字串", tok.validate("abc") !== null);
  assert("放行正常的 token", tok.validate("123456:AAHKlV2ccp62jjcPtMieMCHiEJV9FV14zdE") === null);
  assert("OWNER_ID 不收 @ 開頭", own.validate("@someone") !== null);
  assert("錢包可以留空", wal.validate("") === null);
  assert("錢包擋掉亂填", wal.validate("not-an-address") !== null);
  assert("EVM 位址可用", wal.validate("0x" + "a".repeat(40)) === null);

  /* 憑證印回終端機等於幫截圖外洩它 */
  const secret = "123456:AAHKlV2ccp62jjcPtMieMCHiEJV9FV14zdE";
  assert("遮罩不會露出中段", !mask(secret).includes("MtieMC"), mask(secret));
}

/* ═══ Windows 睡眠設定的解析 ═══
   這段只有在 Windows 上才跑得到，所以在這裡用真實格式的輸出餵它。
   關鍵是中文版 Windows 的 powercfg 輸出是 CP950，Node 會解成亂碼 ——
   解析器必須完全不依賴任何一個中文字。 */
{
  const { parseSleepTimeouts, readAcSeconds, SLEEP_AFTER_GUID } =
    await import("../src/powercfg.js");

  const EN = [
    "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)",
    "  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)",
    "    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)",
    "      Minimum Possible Setting: 0x00000000",
    "      Maximum Possible Setting: 0xffffffff",
    "      Possible Settings increment: 0x00000001",
    "      Possible Settings units: Seconds",
    "    Current AC Power Setting Index: 0x00000708",
    "    Current DC Power Setting Index: 0x00000384",
    "",
    "    Power Setting GUID: 94ac6d29-73ce-41a6-809f-6363ba21b47e  (Allow hybrid sleep)",
    "    Current AC Power Setting Index: 0x00000001",
    "    Current DC Power Setting Index: 0x00000001",
    "",
    "    Power Setting GUID: 9d7815a6-7ee4-497e-8888-515a05f02364  (Hibernate after)",
    "      Possible Settings units: Seconds",
    "    Current AC Power Setting Index: 0x00000000",
    "    Current DC Power Setting Index: 0x00000e10",
  ].join("\n");

  const en = parseSleepTimeouts(EN);
  assert("讀到睡眠等待秒數", en.sleepSec === 1800, String(en.sleepSec));
  assert("讀到休眠等待秒數（0=永不）", en.hibernateSec === 0, String(en.hibernateSec));

  /* 中文版：GUID、AC/DC、0x 都還是 ASCII，中文那段就算變亂碼也不影響。
     這裡刻意把說明文字換成亂碼，確認解析器沒有偷偷依賴它。 */
  const CJK = EN
    .replace(/\(Sleep after\)/, "(���ߦ��)")
    .replace(/\(Hibernate after\)/, "(���~�ɶ�)")
    .replace(/Current AC Power Setting Index/g, "�ثe�� AC �q�]�w����")
    .replace(/Current DC Power Setting Index/g, "�ثe�� DC �q�]�w����");
  const cjk = parseSleepTimeouts(CJK);
  assert("亂碼輸出照樣讀得到睡眠秒數", cjk.sleepSec === 1800, String(cjk.sleepSec));
  assert("亂碼輸出照樣讀得到休眠秒數", cjk.hibernateSec === 0, String(cjk.hibernateSec));

  /* 找不到不等於 0 —— 回 0 會讓診斷報「已設為永不」，是最糟的錯法 */
  assert("找不到設定項回 null", parseSleepTimeouts("完全無關的輸出").sleepSec === null);
  assert("有 GUID 但沒有 AC 那行也回 null",
    readAcSeconds(`Power Setting GUID: ${SLEEP_AFTER_GUID}  (x)`, SLEEP_AFTER_GUID) === null);

  /* 取的必須是 AC（插電）那一行，不是 DC（電池） */
  assert("拿的是 AC 不是 DC", en.sleepSec !== 900, String(en.sleepSec));

  /* GUID 裡的小寫 ac（94ac6d29）不能被當成 AC 欄位 */
  assert("不會誤中 GUID 裡的小寫 ac",
    readAcSeconds(EN, "94ac6d29-73ce-41a6-809f-6363ba21b47e") === 1, String(readAcSeconds(EN, "94ac6d29-73ce-41a6-809f-6363ba21b47e")));
}

console.log("");
if(failures){
  console.log(`${failures} 項測試失敗`);
  process.exit(1);
} else {
  console.log("全部通過");
}
