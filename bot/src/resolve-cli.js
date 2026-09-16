import fs from "node:fs";
import path from "node:path";

/* 在 Windows 上把 `gmgn-cli` 解析成「用 node 直接跑它的 JS 進入點」。

   為什麼需要這個：Windows 的全域 npm 指令其實是 `gmgn-cli.cmd` 這種批次檔包裝。
   Node 18.20.2 / 20.12.2 之後（CVE-2024-27980 的修正）不准 spawn .cmd，
   直接執行會拿到 `Error: spawn EINVAL` —— 錯誤訊息完全看不出真正原因。

   常見的解法是加 shell: true，但那會把參數陣列併成一個字串，
   `--condition-orders '[{"order_type":...}]'` 這種含引號的 JSON 會被拆爛，
   而且代幣名稱是鏈上任何人都能填的欄位，走 shell 等於開一個注入面。

   所以這裡改成找出 .cmd 背後真正的 JS 檔，用 process.execPath（node 自己）去跑它，
   參數仍然是陣列，語意完全一樣，也不經過 shell。 */

const WIN = process.platform === "win32";

/* Windows 全域 npm 套件可能在的幾個位置 */
function candidateRoots(){
  const roots = [];
  if(process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  roots.push(path.join(path.dirname(process.execPath), "node_modules"));
  if(process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "nodejs", "node_modules"));
  if(process.env.npm_config_prefix) roots.push(path.join(process.env.npm_config_prefix, "node_modules"));
  return roots;
}

/* 從套件的 package.json 找出對應的進入點檔案 */
function entryFromPackage(pkgDir, binName){
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    let rel = null;
    if(typeof pkg.bin === "string") rel = pkg.bin;
    else if(pkg.bin && typeof pkg.bin === "object") rel = pkg.bin[binName] ?? Object.values(pkg.bin)[0];
    if(!rel) rel = pkg.main;
    if(!rel) return null;
    const full = path.join(pkgDir, rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/* 回傳 { cmd, prefixArgs, via }。
   呼叫端執行 execFile(cmd, [...prefixArgs, ...args]) 即可。 */
export function resolveCli(binName = "gmgn-cli", { win = WIN, roots = null } = {}){
  if(!win) return { cmd: binName, prefixArgs: [], via: "direct" };

  for(const root of (roots ?? candidateRoots())){
    const entry = entryFromPackage(path.join(root, binName), binName);
    if(entry) return { cmd: process.execPath, prefixArgs: [entry], via: "node-entry" };
  }

  /* 找不到就退回 .cmd + shell。
     這條路徑上帶引號的 JSON 參數可能會壞，所以呼叫端要知道自己走的是哪條。 */
  return { cmd: `${binName}.cmd`, prefixArgs: [], via: "cmd-shell", needsShell: true };
}
