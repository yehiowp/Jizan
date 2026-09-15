/* 欄位驗證：把真實 API 回傳餵進來，檢查這支程式依賴的每個欄位是不是真的存在。

   為什麼需要這個：整支程式的欄位名稱都是照 GMGN 官方 skills 的文件寫的，
   但開發環境連不到 gmgn.ai，一行都沒對過真資料。第三方 API 隨時會改欄位，
   而欄位改名的失敗方式通常不是報錯，是「算出一個看起來正常的錯誤數字」——
   例如 native_token_usd_price 沒了，換算出來的下單數量就是 0 或 NaN。

   用法（在你自己設定好 API Key 的機器上）：
     gmgn-cli gas-price --chain sol --raw            | node src/verify-fields.js gas
     gmgn-cli market trending --chain sol --interval 5m --limit 3 --raw | node src/verify-fields.js trending
     gmgn-cli token info --chain sol --address <CA> --raw     | node src/verify-fields.js info
     gmgn-cli token security --chain sol --address <CA> --raw | node src/verify-fields.js security

   或一次全部（會自己去打那四個指令）：
     npm run verify
*/

import { execFile } from "node:child_process";
import { resolveCli } from "./resolve-cli.js";

/* [路徑, 嚴重性, 這個欄位壞掉會怎樣] */
const SPECS = {
  gas: {
    label: "gas-price",
    fields: [
      ["native_token_usd_price", "critical", "美元換算 SOL 會變成 0 或 NaN，下單數量直接錯"],
      ["average_prio_fee_mixed", "critical", "優先費讀不到就退回 0.001；若誤讀 average_prio_fee（佔位值 1）會變成 1 SOL"],
      ["low_prio_fee_mixed", "info", "GAS_TIER=low 時才用到"],
      ["high_prio_fee_mixed", "info", "GAS_TIER=high 時才用到"],
      ["average_estimate_time", "info", "只拿來顯示"]
    ],
    /* 這個不是「有沒有」，是「值對不對」—— 文件說 sol 的 *_prio_fee 恆為佔位值 1 */
    extra(data, report){
      const plain = parseFloat(data?.average_prio_fee);
      const mixed = parseFloat(data?.average_prio_fee_mixed);
      if(plain === 1 && mixed > 0 && mixed !== 1){
        report.push(["ok", "佔位值陷阱", `average_prio_fee=${plain}（佔位）vs _mixed=${mixed}（真值）—— 程式讀的是 _mixed，正確`]);
      } else if(Number.isFinite(plain) && Number.isFinite(mixed) && plain === mixed){
        report.push(["info", "佔位值陷阱", "兩個欄位值相同，這條鏈上沒有這個陷阱"]);
      }
    }
  },

  trending: {
    label: "market trending",
    array: true,
    fields: [
      ["address", "critical", "沒有地址就無法下單"],
      ["symbol", "critical", "顯示與記錄都會變成 ?"],
      ["liquidity", "critical", "深度門檻失效，什麼爛池子都會過"],
      ["volume", "critical", "量/池比算不出來"],
      ["price", "critical", "停損停利價算不出來"],
      ["swaps", "high", "成交筆數紅旗失效"],
      ["buys", "high", "買賣壓因子變成中性 0.5"],
      ["sells", "high", "同上"],
      ["holder_count", "high", "持有人因子歸零，刷量判定也會失準"],
      ["price_change_percent1h", "high", "動能因子歸零"],
      ["price_change_percent5m", "critical", "5 分鐘暴跌紅旗失效 —— 會在下落的刀口上進場"],
      ["rug_ratio", "critical", "rug 紅旗失效，自動模式會拒絕所有幣（拿不到就不買）"],
      ["top_10_holder_rate", "critical", "籌碼集中紅旗失效"],
      ["is_wash_trading", "high", "刷量標記失效"],
      ["is_honeypot", "high", "蜜罐初篩失效（權威判定仍走 token security）"],
      ["renounced_mint", "critical", "增發權限紅旗失效（Solana）"],
      ["renounced_freeze_account", "high", "凍結權限提示失效（Solana）"],
      ["dev_team_hold_rate", "high", "開發者持倉紅旗失效"],
      ["bundler_rate", "high", "捆綁機器人紅旗失效"],
      ["rat_trader_amount_rate", "high", "老鼠倉紅旗失效"],
      ["smart_degen_count", "high", "聰明錢因子歸零 —— 這是權重最高的因子"],
      ["renowned_count", "high", "KOL 因子歸零"],
      ["burn_status", "info", "安全結構分少一點"],
      ["lock_percent", "info", "同上"],
      ["open_timestamp", "info", "存續時間算不出來"],
      ["sell_tax", "info", "空字串代表未測，不是 0"],
      ["buy_tax", "info", "同上"]
    ]
  },

  info: {
    label: "token info",
    fields: [
      ["price.price", "critical", "現價拿不到，停損停利價算不出來"],
      ["price.price_5m", "critical", "5 分鐘回撤硬停失效"],
      ["price.volume_24h", "critical", "成交量硬閘失效"],
      ["price.swaps_1h", "high", "成交筆數硬閘失效"],
      ["price.sells_24h", "high", "蜜罐第四層判據失效"],
      ["price.buy_volume_5m", "high", "淨流向降級判定失效"],
      ["price.sell_volume_5m", "high", "同上"],
      ["price.buy_volume_1h", "high", "同上"],
      ["price.sell_volume_1h", "high", "同上"],
      ["price.buy_volume_24h", "high", "同上"],
      ["price.sell_volume_24h", "high", "同上"],
      ["pool.liquidity", "critical", "深度退路也沒了，會判成 0 深度全部擋掉"],
      ["pool.base_reserve_value", "high", "單邊深度會退回 liquidity/2"],
      ["pool.quote_reserve_value", "high", "同上"],
      ["pool.pool_address", "info", "多池判定失效，深度會被當成確值而非下限"],
      ["biggest_pool_address", "info", "同上"],
      ["holder_count", "high", "刷量判定的持有人例外失效"],
      ["stat.creator_hold_rate", "critical", "開發者持倉硬閘失效（注意不是 dev.top_10_holder_rate）"],
      ["dev.creator_token_status", "info", "只是提示"]
    ]
  },

  security: {
    label: "token security",
    fields: [
      ["is_honeypot", "critical", "蜜罐第一層；四層全缺時自動模式會拒買所有幣"],
      ["rug_ratio", "critical", "風險等級與硬閘都靠它"],
      ["top_10_holder_rate", "critical", "籌碼集中硬閘失效"],
      ["sell_tax", "critical", "賣出稅硬閘失效（空字串=未測，不是 0）"],
      ["buy_tax", "info", "只是警告項"],
      ["renounced_mint", "critical", "增發權限硬閘失效（Solana）"],
      ["renounced_freeze_account", "high", "凍結權限警告失效（Solana）"],
      ["honeypot", "info", "蜜罐第二層"],
      ["can_not_sell", "info", "蜜罐第三層"]
    ]
  }
};

function dig(obj, path){
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function unwrap(parsed){
  if(parsed && typeof parsed === "object" && "data" in parsed && parsed.code !== undefined) return parsed.data;
  return parsed;
}

export function verify(kind, parsed){
  const spec = SPECS[kind];
  if(!spec) throw new Error(`不認得的種類：${kind}（可用：${Object.keys(SPECS).join(" / ")}）`);

  let data = unwrap(parsed);
  if(spec.array){
    const list = Array.isArray(data) ? data
      : ["rank", "list", "tokens", "coins"].map(k => data?.[k]).find(Array.isArray)
        ?? Object.values(data ?? {}).filter(Array.isArray).flat();
    if(!list?.length) return { label: spec.label, report: [["critical", "整包資料", "回傳裡找不到任何一筆代幣"]], missing: 1 };
    data = list[0];
  }

  const report = [];
  let missing = 0, criticalMissing = 0;

  for(const [path, severity, impact] of spec.fields){
    const v = dig(data, path);
    if(v === undefined){
      report.push([severity, path, `缺少 → ${impact}`]);
      missing++;
      if(severity === "critical") criticalMissing++;
    } else if(v === null){
      report.push(["info", path, "值是 null（可能是這條鏈沒有這個概念，未必是問題）"]);
    } else {
      const shown = typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40);
      report.push(["ok", path, shown === "" ? '""（空字串，代表未測）' : shown]);
    }
  }

  spec.extra?.(data, report);
  return { label: spec.label, report, missing, criticalMissing };
}

function print(result){
  const icon = { ok: "✅", info: "ℹ️ ", high: "⚠️ ", critical: "❌" };
  console.log(`\n── ${result.label} ──`);
  for(const [sev, field, note] of result.report){
    console.log(`${icon[sev] ?? "  "} ${field.padEnd(30)} ${note}`);
  }
  if(result.criticalMissing) console.log(`\n❌ ${result.criticalMissing} 個關鍵欄位對不上 —— 程式會算出錯誤的數字而不是報錯，先別下真錢。`);
  else if(result.missing) console.log(`\n⚠️  ${result.missing} 個欄位缺失，但沒有關鍵的。程式會退化但不會算錯。`);
  else console.log("\n✅ 全部對得上。");
}

/* ── CLI ── */
const isMain = process.argv[1]?.endsWith("verify-fields.js");
if(isMain){
  const kind = process.argv[2];

  if(kind === "all"){
    const chain = process.env.CHAIN || "sol";
    /* Windows 上 gmgn-cli 是 .cmd 包裝，直接 spawn 會 EINVAL */
    const CLI = resolveCli("gmgn-cli");
    const run = args => new Promise(res => execFile(CLI.cmd, [...CLI.prefixArgs, ...args],
      { timeout: 45000, maxBuffer: 8e6, shell: !!CLI.needsShell, stdio: ["ignore", "pipe", "pipe"] },
      (e, out) => res(e ? null : out)));

    /* 沒給地址就自己去熱榜抓一顆 —— 少一個手動複製貼上的步驟，
       也確保驗到的是一顆真的在交易的幣。 */
    let addr = process.argv[3];
    if(!addr){
      const out = await run(["market", "trending", "--chain", chain, "--limit", "1", "--raw"]);
      try {
        const d = JSON.parse(out ?? "null");
        const data = d?.data ?? d;
        const list = Array.isArray(data) ? data
          : ["rank", "list", "tokens", "coins"].map(k => data?.[k]).find(Array.isArray)
            ?? Object.values(data ?? {}).filter(Array.isArray).flat();
        addr = list?.[0]?.address;
        if(addr) console.log(`（沒給地址，自動用熱榜第一名：${list[0].symbol ?? "?"} ${addr}）`);
      } catch {}
    }

    const jobs = [
      ["gas", ["gas-price", "--chain", chain, "--raw"]],
      ["trending", ["market", "trending", "--chain", chain, "--interval", "5m", "--limit", "3", "--raw"]]
    ];
    if(addr){
      jobs.push(["info", ["token", "info", "--chain", chain, "--address", addr, "--raw"]]);
      jobs.push(["security", ["token", "security", "--chain", chain, "--address", addr, "--raw"]]);
    }

    let worst = 0;
    for(const [k, args] of jobs){
      const out = await run(args);
      if(!out){ console.log(`\n── ${SPECS[k].label} ──\n❌ 指令執行失敗（API Key 設了嗎？IPv6 關了嗎？）`); worst = 1; continue; }
      try {
        const r = verify(k, JSON.parse(out));
        print(r);
        if(r.criticalMissing) worst = 1;
      } catch(e){ console.log(`\n── ${SPECS[k].label} ──\n❌ 解析失敗：${e.message}`); worst = 1; }
    }
    if(!addr) console.log("\nℹ️  抓不到代幣地址，跳過 token info / security。可以手動給：npm run verify -- <代幣地址>");
    process.exit(worst);
  }

  if(!SPECS[kind]){
    console.log(`用法：<指令> --raw | node src/verify-fields.js <${Object.keys(SPECS).join("|")}>`);
    console.log(`  或：node src/verify-fields.js all [代幣地址]`);
    process.exit(1);
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if(!input.trim()){ console.log("沒有讀到輸入。記得用管線把 --raw 的輸出餵進來。"); process.exit(1); }

  try {
    const r = verify(kind, JSON.parse(input));
    print(r);
    process.exit(r.criticalMissing ? 1 : 0);
  } catch(e){
    console.log(`解析失敗：${e.message}`);
    process.exit(1);
  }
}
