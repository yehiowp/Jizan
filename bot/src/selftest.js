/* 不花一毛錢的自檢。關掉 DRY_RUN 之前先跑這個：npm run selftest
   每一項都只讀不寫，唯一會碰到錢的 swap 指令在這裡永遠不會被呼叫。 */

import { execFile } from "node:child_process";
import { config, validateConfig, CURRENCY, buildConditionOrders } from "./config.js";
import { createCli } from "./gmgncli.js";
import { evaluate } from "./score.js";
import { evaluateGate } from "./gate.js";

const results = [];
function ok(name, detail = ""){ results.push({ status: "PASS", name, detail }); }
function warn(name, detail = ""){ results.push({ status: "WARN", name, detail }); }
function fail(name, detail = ""){ results.push({ status: "FAIL", name, detail }); }

async function main(){
  const cli = createCli();
  const chain = config.gmgn.chain;

  /* 1. 設定檔 */
  const v = validateConfig();
  if(v.ok) ok("設定檔", "必填欄位齊全");
  else fail("設定檔", v.errors.join("；"));
  for(const w of v.warnings) warn("設定提醒", w);

  /* 2. 模式 */
  if(config.mode.dryRun) ok("模式", "DRY_RUN=true，不會送出真實交易");
  else warn("模式", "DRY_RUN=false —— 確認後的買單會真的花錢");

  const automationOptIn = process.env.GMGN_ALLOW_AUTOMATED_TRADES === "1";
  if(config.mode.dryRun){
    ok("自動下單開關", automationOptIn ? "已開啟（目前是模擬模式，用不到）" : "未開啟");
  } else if(automationOptIn){
    warn("自動下單開關", "GMGN_ALLOW_AUTOMATED_TRADES=1 已由你設定，機器人可以代送交易");
  } else {
    fail("自動下單開關", "真錢模式下必須由你本人在 shell 裡設定 GMGN_ALLOW_AUTOMATED_TRADES=1，否則 CLI 會拒絕下單");
  }

  /* 3. CLI 在不在、API Key 設了沒 */
  const cfgCheck = await cli.configCheck();
  if(cfgCheck.ok) ok("gmgn-cli", "已安裝且 API Key 已設定");
  else fail("gmgn-cli", `${cfgCheck.error ?? ""} ${cfgCheck.hint ?? ""}`.trim());

  /* 4. IPv6：官方文件說 gmgn-cli 只走 IPv4，主機開著 IPv6 會拿到 401/403 */
  try {
    const hasV6 = await new Promise(resolve => {
      execFile("sh", ["-c", "ip -6 addr show scope global 2>/dev/null | grep -c inet6 || true"], (e, out) => {
        resolve(parseInt(String(out).trim(), 10) > 0);
      });
    });
    if(hasV6) warn("IPv6", "偵測到全域 IPv6 位址。出現 401/403 時先把 IPv6 關掉再試。");
    else ok("IPv6", "沒有全域 IPv6 位址");
  } catch { warn("IPv6", "檢查不了"); }

  /* 5. gas-price：換算美元用的原生幣價，以及優先費三檔 */
  let gas = null;
  try {
    gas = await cli.gasPrice({ chain });
    const nativeUsd = parseFloat(gas?.native_token_usd_price);
    const tier = config.exec.gasTier;
    const mixed = parseFloat(gas?.[`${tier}_prio_fee_mixed`]);
    const plain = parseFloat(gas?.[`${tier}_prio_fee`]);

    if(nativeUsd > 0) ok("原生幣價", `1 ${CURRENCY[chain]?.native.symbol ?? "SOL"} = $${nativeUsd}`);
    else fail("原生幣價", "拿不到 native_token_usd_price，美元換算會失敗");

    if(mixed > 0) ok("優先費", `${tier} 檔 = ${mixed} SOL（讀 *_prio_fee_mixed）`);
    else fail("優先費", `${tier}_prio_fee_mixed 讀不到`);

    if(plain === 1 && chain === "sol"){
      ok("優先費陷阱", "確認 *_prio_fee 是佔位值 1，程式沒有讀它（讀了會變成 1 SOL）");
    }
  } catch(e){
    fail("gas-price", `${e.message} ${e.hint ?? ""}`.trim());
  }

  /* 6. trending：掃描資料源 */
  let top = null;
  try {
    const rows = await cli.trending({
      chain, interval: config.filter.interval, limit: 30,
      minLiquidity: config.filter.minDepthUsd * 2, minSwaps: 10
    });
    if(rows.length){
      const scored = rows.map(r => evaluate(r, { minDepthUsd: config.filter.minDepthUsd, chain }))
                         .sort((a, b) => b.score - a.score);
      top = scored[0];
      const passing = scored.filter(c => !c.flags.length && c.score >= config.filter.minScore);
      ok("trending", `拿到 ${rows.length} 筆，最高分 ${top.score}（${top.symbol}），通過門檻 ${passing.length} 顆`);
    } else {
      warn("trending", "回傳 0 筆。可能是篩選條件太嚴，或這條鏈目前沒資料。");
    }
  } catch(e){
    fail("trending", `${e.message} ${e.hint ?? ""}`.trim());
  }

  /* 7. token info + security + 閘門：拿剛剛分數最高的那顆來實測 */
  if(top?.address){
    try {
      const [info, security] = await Promise.all([
        cli.tokenInfo({ chain, address: top.address }),
        cli.tokenSecurity({ chain, address: top.address })
      ]);
      const gate = evaluateGate({ info, security, chain,
        minDepthUsd: config.filter.minDepthUsd, positionUsd: config.risk.positionUsd });
      ok("token info / security", `${top.symbol} 閘門：${gate.pass ? "通過" : "擋下"}`
        + (gate.blocks.length ? `（${gate.blocks[0]}）` : "")
        + `，單邊深度 $${Math.round(gate.metrics.depth)}（${gate.metrics.depthBasis}）`);
      if(gate.metrics.honeypot === null) warn("蜜罐檢測", "這顆未測，正式下單時會被標為注意事項");
    } catch(e){
      fail("token info / security", `${e.message} ${e.hint ?? ""}`.trim());
    }
  }

  /* 8. 報價：只問價，不送單 */
  if(top?.address && gas && config.gmgn.walletAddress){
    try {
      const nativeUsd = parseFloat(gas.native_token_usd_price);
      const amountRaw = Math.round(config.risk.positionUsd / nativeUsd * 1e9);
      const q = await cli.quote({
        chain,
        from: config.gmgn.walletAddress,
        inputToken: CURRENCY[chain].native.address,
        outputToken: top.address,
        amountRaw,
        slippage: config.exec.slippagePct
      });
      ok("order quote", `用 $${config.risk.positionUsd}（${(amountRaw / 1e9).toFixed(4)} SOL）試算 ${top.symbol}：`
        + `預估拿到 ${q?.output_amount ?? "?"}（最小單位）`);
    } catch(e){
      warn("order quote", `${e.message} ${e.hint ?? ""}`.trim());
    }
  } else if(!config.gmgn.walletAddress){
    warn("order quote", "沒設 GMGN_WALLET_ADDRESS，跳過");
  }

  /* 9. 停損停利參數長什麼樣 */
  const co = buildConditionOrders();
  ok("停損停利", JSON.stringify(co));

  /* 10. Telegram */
  if(config.telegram.token){
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/getMe`);
      const j = await res.json();
      if(j?.ok) ok("Telegram", `@${j.result.username}`);
      else fail("Telegram", j?.description ?? "getMe 失敗");
    } catch(e){
      fail("Telegram", e.message);
    }
  }

  /* 輸出 */
  console.log("");
  for(const r of results){
    const icon = r.status === "PASS" ? "✅" : r.status === "WARN" ? "⚠️ " : "❌";
    console.log(`${icon} ${r.name}${r.detail ? "：" + r.detail : ""}`);
  }
  const fails = results.filter(r => r.status === "FAIL").length;
  const warns = results.filter(r => r.status === "WARN").length;
  console.log(`\n${fails ? `${fails} 項失敗` : "沒有失敗項"}${warns ? `，${warns} 項提醒` : ""}`);
  if(fails) console.log("先把失敗項修好，再考慮把 DRY_RUN 關掉。");
  process.exit(fails ? 1 : 0);
}

main().catch(e => {
  console.error("自檢本身出錯：", e.message);
  process.exit(1);
});
