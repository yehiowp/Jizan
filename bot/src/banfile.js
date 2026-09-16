/* 跨機器人共用的限流封禁記錄。

   帳本可以各自獨立 —— 那是風控偏好，你決定。
   但限流封禁不是偏好，是 GMGN 那端的事實：封的是同一把 API Key。

   每個機器人各記各的話，解封那一刻會有 N 個行程同時去敲門，
   而文件寫明冷卻期內每送一次請求封禁就延長 5 秒 ——
   9 個機器人就是一次延長 45 秒，然後又是 9 個同時再試。
   所以這一份必須共用，而且要上鎖：它會被好幾個行程同時寫。 */

import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock.js";

export function createBanFile(filePath){
  const lockDir = `${filePath}.lock`;

  function read(){
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const until = Number(raw?.until);
      return Number.isFinite(until) ? until : 0;
    } catch {
      return 0;    // 沒有檔案、壞掉、讀不到 —— 一律當成沒有封禁
    }
  }

  return {
    path: filePath,
    read,

    /* 只往後延。比較早的時間不能把比較晚的洗掉 ——
       否則一個剛啟動、還不知道被封的機器人會把別人記下的封禁清掉。 */
    write(untilMs){
      const want = Number(untilMs);
      if(!Number.isFinite(want)) return read();
      try {
        return withLock(lockDir, () => {
          const cur = read();
          if(want <= cur) return cur;
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const tmp = `${filePath}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ until: want, at: Date.now() }, null, 2));
          fs.renameSync(tmp, filePath);
          return want;
        }, { timeoutMs: 3000 });
      } catch {
        /* 拿不到鎖或寫不進去，不能讓交易流程掛掉。
           這個行程自己的漏桶還是記得被封了，只是別人不知道。 */
        return read();
      }
    }
  };
}
