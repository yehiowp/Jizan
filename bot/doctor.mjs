/* 診斷：一個指令檢查每一步，告訴你卡在哪、怎麼修。

   用法（在 bot 資料夾裡）：
     node doctor.mjs

   刻意做成零依賴 —— 不用先跑 npm install 就能執行。
   如果你卡在最前面幾步，這支程式本身就是唯一能跑起來的東西。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const rows = [];
const add = (status, name, detail, fix) => rows.push({ status, name, detail, fix });

function run(cmd, args, timeout = 20000){
  return new Promise(res => {
    execFile(cmd, args, { timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      (err, stdout, stderr) => res({ err, out: String(stdout ?? ""), errOut: String(stderr ?? "") }));
  });
}

/* ── 1. Node ── */
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if(major >= 20) add("ok", "Node.js", `v${process.versions.node}`);
  else add("fail", "Node.js", `v${process.versions.node} 太舊`, "裝 Node 20 以上：https://nodejs.org");
}

add("info", "作業系統", `${process.platform} ${os.arch()}`,
  WIN ? "注意：Windows 的 shell 指令跟教學裡的 Unix 寫法不同，下面會另外標出來" : null);

/* ── 2. 相依套件裝了沒 ── */
{
  /* 一定要用 fileURLToPath —— 直接取 .pathname 在 Windows 上會拿到 /C:/... 這種爛路徑 */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const nm = path.join(here, "node_modules");
  if(fs.existsSync(nm)) add("ok", "npm install", "node_modules 存在");
  else add("fail", "npm install", "還沒安裝相依套件", "在 bot 資料夾執行：npm install");
}

/* ── 3. gmgn-cli ── */
{
  const r = await run(WIN ? "gmgn-cli.cmd" : "gmgn-cli", ["--version"]);
  if(r.err && /ENOENT/.test(String(r.err))){
    add("fail", "gmgn-cli", "找不到這個指令", "npm install -g gmgn-cli");
  } else if(r.err){
    add("warn", "gmgn-cli", `執行有問題：${(r.errOut || r.out).trim().slice(0, 80)}`, "試試 npm install -g gmgn-cli 重裝");
  } else {
    add("ok", "gmgn-cli", `v${r.out.trim()}`);
  }
}

/* ── 4. GMGN 憑證 ── */
{
  const cfgPath = path.join(os.homedir(), ".config", "gmgn", ".env");
  if(!fs.existsSync(cfgPath)){
    add("fail", "GMGN API Key", "還沒設定（找不到 ~/.config/gmgn/.env）",
      "1) gmgn-cli config  2) 開它給的連結建立 Key  3) gmgn-cli config --apply <KEY>\n     ⚠️ 拿到連結後不要再跑一次 config，會換掉金鑰");
  } else {
    const txt = fs.readFileSync(cfgPath, "utf8");
    const hasApi = /GMGN_API_KEY\s*=\s*\S/.test(txt);
    const hasPk = /GMGN_PRIVATE_KEY\s*=\s*\S/.test(txt);
    if(hasApi && hasPk) add("ok", "GMGN 憑證", "API Key 與錢包私鑰都在");
    else add("fail", "GMGN 憑證", `檔案在，但 ${!hasApi ? "缺 API Key" : "缺私鑰"}`,
      "重跑一次 gmgn-cli config --apply <KEY>");
  }
}

/* ── 5. 網路（最常見的卡點） ── */
{
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch("https://gmgn.ai/", { signal: ctrl.signal }).catch(e => ({ error: e }));
    clearTimeout(timer);
    if(res?.error){
      add("fail", "連到 GMGN", `連不上：${res.error.message}`,
        "檢查網路／VPN／防火牆");
    } else if(res.status === 403 || res.status === 503){
      /* 連得上但被擋，跟連不上一樣不能用 —— 這是機房／VPS IP 最常見的死法 */
      add("fail", "連到 GMGN", `HTTP ${res.status}（被 Cloudflare 擋下）`,
        "這個 IP 進不去 GMGN。不要用機房／VPS／雲主機的 IP，換家用網路或住宅 IP");
    } else {
      add("ok", "連到 GMGN", `HTTP ${res.status}`);
    }
  } catch(e){
    add("fail", "連到 GMGN", e.message, "檢查網路");
  }
}

/* ── 6. IPv6（官方文件說 gmgn-cli 只走 IPv4） ── */
{
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://ipv6.icanhazip.com", { signal: ctrl.signal }).catch(() => null);
    clearTimeout(timer);
    if(res?.ok){
      const ip = (await res.text()).trim();
      if(ip.includes(":")) add("warn", "IPv6", `你的對外流量走 IPv6（${ip}）`,
        "gmgn-cli 只支援 IPv4。出現 401/403 時先把 IPv6 關掉");
      else add("ok", "IPv6", "走 IPv4");
    } else add("ok", "IPv6", "沒有 IPv6 對外位址");
  } catch { add("info", "IPv6", "檢查不了，先略過"); }
}

/* ── 7. 讀 .env（自己解析，不依賴 dotenv） ── */
const env = {};
{
  const p = ".env";
  if(!fs.existsSync(p)){
    add("fail", ".env", "還沒建立", WIN ? "copy .env.example .env" : "cp .env.example .env");
  } else {
    for(const line of fs.readFileSync(p, "utf8").split("\n")){
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if(m) env[m[1]] = m[2].trim();
    }
    add("ok", ".env", `讀到 ${Object.keys(env).length} 個設定`);

    if(!env.TELEGRAM_TOKEN) add("fail", "TELEGRAM_TOKEN", "沒填", "跟 @BotFather 說 /newbot 拿 token");
    if(!/^\d+$/.test(env.OWNER_ID ?? "")) add("fail", "OWNER_ID", `「${env.OWNER_ID ?? ""}」不是純數字`,
      "跟 @userinfobot 說句話，它會回你一串數字");
    if(!env.GMGN_WALLET_ADDRESS) add("warn", "GMGN_WALLET_ADDRESS", "沒填",
      "執行 gmgn-cli portfolio info --raw，把裡面的錢包地址填進來");

    if(env.DRY_RUN === "false"){
      add("warn", "DRY_RUN", "已關閉 —— 會用真錢下單", "還沒跑滿一週模擬的話，改回 true");
      if(process.env.GMGN_ALLOW_AUTOMATED_TRADES !== "1"){
        add("fail", "自動下單開關", "真錢模式下沒開，機器人會拒絕啟動",
          WIN ? '在同一個視窗執行：$env:GMGN_ALLOW_AUTOMATED_TRADES="1"'
              : "在同一個終端機執行：export GMGN_ALLOW_AUTOMATED_TRADES=1");
      }
    } else {
      add("ok", "DRY_RUN", "開著 —— 不會花到真錢");
    }
  }
}

/* ── 8. Telegram token 是不是真的有效 ── */
if(env.TELEGRAM_TOKEN){
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getMe`).catch(e => ({ error: e }));
    if(res?.error) add("fail", "Telegram", `連不上：${res.error.message}`, "檢查網路");
    else {
      const j = await res.json();
      if(j?.ok) add("ok", "Telegram", `@${j.result.username}`);
      else add("fail", "Telegram", j?.description ?? "token 無效", "token 抄錯了，回 @BotFather 重拿");
    }
  } catch(e){ add("fail", "Telegram", e.message); }
}

/* ── 9. 錢包裡有沒有錢 ── */
{
  const bin = WIN ? "gmgn-cli.cmd" : "gmgn-cli";
  const r = await run(bin, ["portfolio", "info", "--raw"], 30000);
  if(r.err){
    const msg = (r.errOut || r.out).trim().slice(0, 120);
    if(/API_KEY/i.test(msg)) add("skip", "錢包餘額", "API Key 還沒設定，跳過");
    else add("warn", "錢包餘額", msg || "查詢失敗", "確認 API Key 與網路");
  } else {
    try {
      const j = JSON.parse(r.out);
      const data = j?.data ?? j;
      const txt = JSON.stringify(data);
      const addrs = [...txt.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map(m => m[1]);
      const bal = parseFloat(String(txt.match(/"balance"\s*:\s*"?([\d.]+)/)?.[1] ?? "NaN"));

      if(addrs.length){
        const a = addrs[0];
        add("ok", "綁定錢包", a);
        if(env.GMGN_WALLET_ADDRESS && env.GMGN_WALLET_ADDRESS !== a){
          add("fail", "錢包地址不符", `.env 填的是 ${env.GMGN_WALLET_ADDRESS}`,
            `改成 ${a} —— 下單的 --from 必須跟 API Key 綁定的錢包一致`);
        }
      }
      if(Number.isFinite(bal)){
        if(bal > 0) add("ok", "錢包餘額", String(bal));
        else add("warn", "錢包餘額", "是 0",
          "這是 gmgn-cli 新開的錢包，要自己匯 SOL 進去。留約 $3 當手續費");
      } else {
        add("info", "錢包餘額", "解析不出餘額欄位，用 gmgn-cli portfolio info 自己看一下");
      }
    } catch {
      add("warn", "錢包餘額", "回傳不是 JSON", "直接跑 gmgn-cli portfolio info 看訊息");
    }
  }
}

/* ── 輸出 ── */
const icon = { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ ", skip: "⏭️ " };
console.log("\n════ 診斷結果 ════\n");
for(const r of rows){
  console.log(`${icon[r.status]} ${r.name.padEnd(22)} ${r.detail}`);
  if(r.fix) console.log(`     → ${r.fix}`);
}

const fails = rows.filter(r => r.status === "fail");
console.log("\n════════════════\n");
if(!fails.length){
  console.log("沒有阻斷性問題。下一步：");
  console.log("  npm run verify -- <任一顆幣的合約地址>");
  console.log("  npm run selftest");
  console.log("  npm start");
} else {
  console.log(`${fails.length} 個問題要先解決，照上面的 → 做。第一個是：\n`);
  console.log(`  ${fails[0].name}：${fails[0].detail}`);
  if(fails[0].fix) console.log(`  → ${fails[0].fix}`);
}
console.log("");
process.exit(fails.length ? 1 : 0);
