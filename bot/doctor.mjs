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
import { resolveCli } from "./src/resolve-cli.js";

const WIN = process.platform === "win32";
const rows = [];
const add = (status, name, detail, fix) => rows.push({ status, name, detail, fix });

/* Windows 上 gmgn-cli 是 .cmd 包裝，直接 spawn 會拿到 spawn EINVAL。
   resolveCli 會改用 node 去跑它背後的 JS。 */
const CLI = resolveCli("gmgn-cli");

function runCli(args, timeout = 20000){
  return new Promise(res => {
    execFile(CLI.cmd, [...CLI.prefixArgs, ...args], {
      timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: !!CLI.needsShell
    }, (err, stdout, stderr) => res({ err, out: String(stdout ?? ""), errOut: String(stderr ?? "") }));
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
let cliOk = false;
{
  const r = await runCli(["--version"]);
  /* resolveCli 找不到套件時才會退回 cmd-shell，所以「退回了而且還失敗」
     幾乎一定就是根本沒安裝。用這個判斷比去比對錯誤訊息可靠 ——
     Windows 的中文錯誤訊息是 CP950 編碼，直接印出來是一堆亂碼。 */
  const notInstalled = (r.err && /ENOENT/.test(String(r.err))) || (r.err && CLI.via === "cmd-shell");
  if(notInstalled){
    add("fail", "gmgn-cli", "沒有安裝", "npm install -g gmgn-cli");
  } else if(r.err){
    add("warn", "gmgn-cli", "裝了但執行失敗", "試試 npm install -g gmgn-cli 重裝");
  } else {
    cliOk = true;
    add("ok", "gmgn-cli", `v${r.out.trim()}${CLI.via === "node-entry" ? "（Windows：用 node 直接跑，繞過 .cmd）" : ""}`);
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
    /* 帶瀏覽器標頭。沒帶的話 Cloudflare 一律回 403，
       那是擋機器人，不代表這台機器連不到 GMGN —— 之前這裡會誤報成網路問題，
       害人去查一個根本不存在的故障。 */
    const res = await fetch("https://gmgn.ai/", {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      }
    }).catch(e => ({ error: e }));
    clearTimeout(timer);

    if(res?.error){
      add("fail", "連到 GMGN", `連不上：${res.error.message}`, "檢查網路／VPN／防火牆");
    } else if(res.status === 403 || res.status === 503){
      /* 真正能判斷「這個 IP 能不能用」的是 gmgn-cli 自己跑得起來，
         網頁被 Cloudflare 擋只是參考，所以這裡只給提醒不擋路。 */
      add("warn", "連到 GMGN", `網頁回 HTTP ${res.status}（Cloudflare 機器人防護）`,
        "這不一定是問題。真正的判準是下面 gmgn-cli 的指令跑不跑得動；如果連 API 都失敗，才考慮換網路（機房／VPS IP 常被擋）");
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
  if(!cliOk){
    add("skip", "錢包餘額", "gmgn-cli 還沒安裝，跳過");
  } else {
  const r = await runCli(["portfolio", "info", "--raw"], 30000);
  if(r.err){
    const msg = (r.errOut || r.out).trim();
    const short = msg.slice(0, 120);

    if(/API_KEY/i.test(msg)){
      add("skip", "錢包餘額", "API Key 還沒設定，跳過");
    } else if(/RATE_LIMIT|429/i.test(msg)){
      /* 限流時最不能做的事就是再試一次 —— GMGN 文件寫明每重試一次封禁延長 5 秒，
         最多到 5 分鐘。舊版這裡寫「確認 API Key 與網路」，等於在叫人重跑，
         會把自己越關越久。 */
      const reset = msg.match(/reset_at"?\s*[:=]\s*"?(\d{9,})/)?.[1];
      const when = reset ? new Date(parseInt(reset, 10) * 1000).toLocaleString() : null;
      add("warn", "錢包餘額", "IP 被 GMGN 限流暫時封鎖（HTTP 429）",
        `${when ? `等到 ${when} 再試。` : "等 5 分鐘再試。"}` +
        "\n     ⚠️ 這段期間不要重跑任何 gmgn-cli 指令，包括這個診斷 ——" +
        "\n        每重試一次封禁就延長 5 秒（最多 5 分鐘）。" +
        "\n     ✅ 但這代表你的 API Key 是有效的：能拿到 429 就表示請求有通過認證。");
    } else if(/401|403|UNAUTHORIZED/i.test(msg)){
      add("fail", "錢包餘額", "GMGN 認證失敗", "確認 API Key；另外 gmgn-cli 只走 IPv4，開著 IPv6 會出現這個錯");
    } else {
      add("warn", "錢包餘額", short || "查詢失敗", "把這段訊息貼出來看");
    }
  } else {
    try {
      const j = JSON.parse(r.out);
      const data = j?.data ?? j;
      const txt = JSON.stringify(data);
      const addrs = [...txt.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map(m => m[1]);
      const bal = parseFloat(String(txt.match(/"balance"\s*:\s*"?([\d.]+)/)?.[1] ?? "NaN"));

      /* 只有讀取權限的 API Key 不會綁交易錢包，回傳就是 {"wallets":[]}。
         那是正常狀態，不是解析失敗 —— 講清楚它代表什麼，以及會影響什麼。 */
      if(Array.isArray(data?.wallets) && data.wallets.length === 0){
        add("info", "交易錢包", "沒有綁定（這把 API Key 只有讀取權限）",
          "模擬模式照常可用。要真的下單得回 GMGN 綁 2FA、開「允許交易」、選一個交易錢包，再建一把新 Key。");
      } else if(addrs.length){
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
