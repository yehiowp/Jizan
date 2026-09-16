/* 跨行程的檔案鎖。

   為什麼需要：一條鏈一個機器人的話，會有好幾個行程同時讀寫同一個 state.json。
   沒有鎖的話是典型的「讀-改-寫」競態 —— A 讀到 2 個部位、B 也讀到 2 個，
   兩邊各自加一筆再寫回去，最後檔案裡只有 3 個部位，有一筆憑空消失。
   消失的那筆是真的買了的幣：鏈上有、帳本沒有，風控看不到它，
   停損停利也不會被監控。

   用 mkdir 當鎖，因為它在所有平台上都是原子操作 ——
   「檔案存在就不要建立」在 Windows 上沒有可靠的單一系統呼叫，mkdir 有。 */

import fs from "node:fs";

/* 鎖太舊就視為前一個行程死掉沒解鎖（當機、被 kill、斷電）。
   30 秒遠大於任何一次正常的寫入，又短到不會讓你等半天。 */
const STALE_MS = 30_000;

export function acquire(lockDir, { staleMs = STALE_MS, now = () => Date.now() } = {}){
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(`${lockDir}/owner`, JSON.stringify({ pid: process.pid, at: now() }));
    return true;
  } catch(e){
    if(e.code !== "EEXIST") throw e;
  }

  /* 已經有人拿著。看看是不是死鎖。 */
  try {
    const raw = JSON.parse(fs.readFileSync(`${lockDir}/owner`, "utf8"));
    if(now() - Number(raw.at) < staleMs) return false;     // 還活著，等
  } catch {
    /* owner 檔讀不到或壞了：可能是對方正在建立鎖的那一瞬間。
       當成「還活著」比較安全 —— 誤判成死鎖會讓兩個行程同時寫。 */
    return false;
  }

  /* 逾時了，搶過來。先刪 owner 再刪目錄，順序反過來的話
     另一個行程可能在兩步之間建立新鎖，然後被我們刪掉。 */
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { return false; }
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(`${lockDir}/owner`, JSON.stringify({ pid: process.pid, at: now(), stole: true }));
    return true;
  } catch {
    return false;      // 有人比我們快
  }
}

export function release(lockDir){
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 已經沒了就算了 */ }
}

/* 拿到鎖就跑 fn，不管成功失敗都要解鎖。
   拿不到就短暫退讓再試；試到超時就丟錯 —— 不是默默跳過，
   因為「沒寫進去」對帳本來說跟「寫錯」一樣嚴重。 */
export function withLock(lockDir, fn, { timeoutMs = 5000, retryMs = 25, now = () => Date.now(),
                                        sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}){
  const deadline = now() + timeoutMs;
  for(;;){
    if(acquire(lockDir, { now })){
      try { return fn(); }
      finally { release(lockDir); }
    }
    if(now() >= deadline){
      throw new Error(`拿不到檔案鎖（${lockDir}）：有另一個行程佔著超過 ${timeoutMs}ms`);
    }
    sleepSync(retryMs);
  }
}
