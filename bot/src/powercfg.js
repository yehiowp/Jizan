/* 解析 Windows `powercfg /query SCHEME_CURRENT SUB_SLEEP` 的輸出。

   為什麼要獨立成一支：中文版 Windows 的 powercfg 輸出是 CP950，
   Node 會把它解成亂碼。所以這裡一個中文字串都不能比對 ——
   只能靠 GUID（固定值）和 ASCII 的「AC」「0x…」定位。
   這種只在別的作業系統上才跑得到的程式碼，沒有測試就等於沒寫過。 */

/* Windows 內建的固定 GUID，跟語言版本無關 */
export const SLEEP_AFTER_GUID     = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da";
export const HIBERNATE_AFTER_GUID = "9d7815a6-7ee4-497e-8888-515a05f02364";

/* 讀某個設定項在「插電（AC）」時的等待秒數。
   0 代表永不，null 代表這份輸出裡找不到（不等於 0 —— 找不到就是不知道）。 */
export function readAcSeconds(text, guid){
  const s = String(text ?? "");
  const i = s.toLowerCase().indexOf(String(guid).toLowerCase());
  if(i < 0) return null;
  /* 只往後看一小段：再往後就是下一個設定項了，會讀到別人的值。
     「AC」刻意大小寫敏感 —— GUID 裡的 ac 是小寫，不會誤中。 */
  const m = s.slice(i, i + 900).match(/AC[^\n]*?0x([0-9a-fA-F]+)/);
  if(!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

export function parseSleepTimeouts(text){
  return {
    sleepSec: readAcSeconds(text, SLEEP_AFTER_GUID),
    hibernateSec: readAcSeconds(text, HIBERNATE_AFTER_GUID),
  };
}
