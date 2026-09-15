/* 設定精靈：一題一題問，幫你把 .env 寫好。

   用法（在 bot 資料夾裡）：
     npm run setup

   為什麼要有這支：在手機上用 nano 編設定檔，一個不小心就會開錯目錄
   編到一個全新的空檔案，或者把註解行改壞，而且兩種都不會報錯。
   這支只問必填的幾項，其他設定照原樣保留。

   跟 doctor.mjs 一樣刻意零依賴 —— 你可能還沒跑 npm install。 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(here, ".env.example");
const TARGET = path.join(here, ".env");

/* 顯示用的遮罩。設定精靈把憑證整串印回終端機，等於幫截圖外洩它。 */
export const mask = v => !v ? "" : v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`;

export const QUESTIONS = [
  {
    key: "TELEGRAM_TOKEN",
    title: "Telegram 機器人 Token",
    help: "跟 @BotFather 說 /newbot，它會給你一串長得像 123456:AAH… 的東西",
    secret: true,
    validate: v => /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(v)
      ? null : "格式不對。應該是「數字:一長串英數字」，中間有一個冒號",
  },
  {
    key: "OWNER_ID",
    title: "你的 Telegram 數字 ID",
    help: "跟 @userinfobot 說句話，它回的 Id 就是。只有這個 ID 下的指令會被接受",
    validate: v => /^\d{5,}$/.test(v) ? null : "應該是一串純數字，沒有 @ 也沒有空格",
  },
  {
    key: "GMGN_WALLET_ADDRESS",
    title: "GMGN 交易錢包位址",
    help: "跑 gmgn-cli portfolio info 會看到。只有讀取權限的 API Key 還沒有綁錢包，"
        + "這格可以先留空（直接 Enter），之後再補",
    optional: true,
    validate: v => !v || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) || /^0x[0-9a-fA-F]{40}$/.test(v)
      ? null : "看起來不像錢包位址（Solana 是 32–44 字元，EVM 是 0x 開頭共 42 字元）",
  },
];

/* 手機上貼東西很容易連 KEY= 或引號一起貼進來。
   這種是手滑不是打錯，容忍掉，不要讓人卡在格式檢查上。 */
export function cleanInput(raw, key){
  return String(raw)
    .trim()
    .replace(new RegExp(`^${key}\\s*=\\s*`), "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/* 讀現有的 .env，當作預設值 */
export function parseEnv(text){
  const out = {};
  for(const line of String(text).split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if(m) out[m[1]] = m[2].trim();
  }
  return out;
}

/* 逐行替換，而不是重新產生一份：註解、排版、以及你之前手動調過的參數
   全部原樣保留。重新產生的話，那些調整會在你不知情的情況下被洗掉。 */
export function applyEnv(baseText, answers){
  const written = new Set();
  const lines = String(baseText).split(/\r?\n/).map(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if(m && Object.prototype.hasOwnProperty.call(answers, m[1])){
      written.add(m[1]);
      return `${m[1]}=${answers[m[1]]}`;
    }
    return line;
  });
  for(const [k, v] of Object.entries(answers)){
    if(!written.has(k)) lines.push(`${k}=${v}`);
  }
  return lines.join("\n");
}

async function main(){
  if(!fs.existsSync(EXAMPLE)){
    console.error("\n❌ 這裡找不到 .env.example —— 你不在 bot 資料夾裡。");
    console.error("   先執行：cd ~/Jizan/bot\n");
    process.exit(1);
  }

  /* 這支是一問一答的，管線餵資料進來會在第二題就悄悄停住
     （readline 在非 TTY 上讀完就關閉）。直接講清楚，不要卡在那裡。 */
  if(!stdin.isTTY){
    console.error("\n❌ 這支要在終端機裡互動執行，不能用管線餵。");
    console.error("   直接打：npm run setup\n");
    process.exit(1);
  }

  const current = fs.existsSync(TARGET) ? parseEnv(fs.readFileSync(TARGET, "utf8")) : {};
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("\n════ 設定精靈 ════\n");
  console.log("一題一題填。會顯示現在的值，直接按 Enter 就是保留不動。");
  console.log("要中途離開按 Ctrl+C —— 還沒寫檔，什麼都不會變。\n");

  const answers = {};
  for(const q of QUESTIONS){
    const have = current[q.key] ? current[q.key] : null;
    const shown = have ? (q.secret ? mask(have) : have) : (q.optional ? "留空" : "尚未設定");

    console.log(`── ${q.title} ──`);
    console.log(`   ${q.help}`);

    for(;;){
      const v = cleanInput(await rl.question(`   目前：${shown}\n   輸入（Enter=不變）> `), q.key);

      if(v === ""){
        if(have){ answers[q.key] = have; break; }
        if(q.optional){ answers[q.key] = ""; break; }
        console.log("   ⚠️ 這項是必填的，沒填機器人起不來。\n");
        continue;
      }
      const err = q.validate(v);
      if(err){ console.log(`   ⚠️ ${err}\n`); continue; }
      answers[q.key] = v;
      break;
    }
    console.log("");
  }

  rl.close();

  const base = fs.readFileSync(fs.existsSync(TARGET) ? TARGET : EXAMPLE, "utf8");
  /* mode 0600：這個檔案裡有 Telegram Token。Termux 是單使用者環境，
     這行在那裡不痛不癢，但同一份程式碼放到 VPS 上時它是必要的。 */
  fs.writeFileSync(TARGET, applyEnv(base, answers), { mode: 0o600 });
  try { fs.chmodSync(TARGET, 0o600); } catch { /* 有些檔案系統不支援，不致命 */ }

  console.log("✅ 已寫入 .env\n");
  for(const q of QUESTIONS){
    const v = answers[q.key];
    console.log(`   ${q.key.padEnd(22)} ${v ? (q.secret ? mask(v) : v) : "（留空）"}`);
  }

  console.log(`
下一步：

  node doctor.mjs      # 逐項檢查，手機上還會檢查 wake lock
  npm start            # 啟動

⚠️ GMGN 的憑證不在這個檔案裡，要另外設（金鑰會存在這台裝置上）：
     gmgn-cli config
     gmgn-cli config --apply <你的KEY>

⚠️ 預設是 DRY_RUN=true（只記帳、不動真錢）。第一週請保持這樣，
   先看它選出來的幣後來怎麼走。
`);
}

/* 被 import（測試）時不要真的跑起來問問題 */
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(e => { console.error("\n❌ 設定精靈出錯：", e.message, "\n"); process.exit(1); });
}
