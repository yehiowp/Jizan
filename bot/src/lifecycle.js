/* 從 Telegram 重啟機器人。

   做法是「結束自己，讓守門員把自己拉回來」—— 沒有別的辦法：
   一個行程沒辦法把自己換成新的自己，而重讀 .env、重新載入程式碼
   都需要一個全新的行程。

   所以整件事的成敗只取決於一件事：**真的有人會把它拉回來嗎**。
   沒有守門員的時候結束自己，結果是它再也不會起來，而你人不在電腦前 ——
   這正好是你想避免的情況的最壞版本。所以這裡寧可拒絕，也不冒這個險。 */

/* 守門員腳本會設這個環境變數。它的意思不是「我在 Windows 上」，
   而是「有一個迴圈在等我結束，並且會把我重新叫起來」。 */
export const SUPERVISED_ENV = "GMGN_SUPERVISED";

/* 用一個特別的離開碼，讓守門員的紀錄看得出來這是「要求重啟」，
   不是當掉。守門員看到它會立刻重啟，不等那 10 秒。 */
export const RESTART_EXIT_CODE = 42;

export function isSupervised(env = process.env){
  return env[SUPERVISED_ENV] === "1";
}

export function restartPlan(env = process.env){
  if(!isSupervised(env)){
    return {
      ok: false,
      reason: "沒有守門員在看著這個行程",
      detail: [
        "現在是直接用 npm start 之類的方式跑的 —— 結束之後沒有人會把它拉回來。",
        "如果我照做，機器人會關掉，而你人不在電腦前，就再也開不起來了。",
        "",
        "要能從 Telegram 重啟，請改用守門員啟動：",
        "  Windows：powershell -ExecutionPolicy Bypass -File scripts\\run-forever.ps1",
        "  手機／Linux：sh scripts/run-forever.sh",
        "",
        "或註冊成排程工作（關掉視窗也會跑）：",
        "  powershell -ExecutionPolicy Bypass -File scripts\\install-task.ps1",
      ].join("\n"),
    };
  }
  return { ok: true, exitCode: RESTART_EXIT_CODE };
}
