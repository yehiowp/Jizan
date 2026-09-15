#!/data/data/com.termux/files/usr/bin/sh
# 無人看管時的守門員：程式掛掉就重啟，紀錄檔太大就輪替。
#
# 為什麼需要：手機放家裡沒人看，程式半夜當掉的話會靜靜停在那裡。
# 已開的倉有 GMGN 伺服器端的停損保護，但機器人本身停了就不會再對帳、
# 不會再掃描、也不會通知你 —— 你會以為它在跑。

LOG="$HOME/gmgn-bot.log"
MAX_BYTES=$((5 * 1024 * 1024))     # 5MB 就輪替，手機空間有限

cd "$(dirname "$0")/.." || exit 1

# ── wake lock ──
# 螢幕關掉之後，Android 會把背景程式凍結：不報錯、不留紀錄、什麼都不做。
# 這個鎖是唯一的例外，也是手機掛機能不能活下去的關鍵。
# 它會在中途消失 —— 通知列上那個鎖被手動點掉、或 Termux 被系統回收後重生，
# 都會讓它不見。所以定期重抓；這個動作是冪等的，本來就持有也不會怎樣。
if command -v termux-wake-lock >/dev/null 2>&1; then
  ( while true; do termux-wake-lock >/dev/null 2>&1; sleep 1800; done ) &
  WAKE_PID=$!
  trap 'kill "$WAKE_PID" 2>/dev/null' EXIT INT TERM
  echo "$(date -Iseconds) wake lock 已開啟（每 30 分鐘重抓一次）" >> "$LOG"
else
  echo "$(date -Iseconds) ⚠️ 沒有 termux-wake-lock：螢幕關掉後機器人會被系統凍結。" >> "$LOG"
  echo "$(date -Iseconds)    pkg install -y termux-api，並到 F-Droid 裝 Termux:API App" >> "$LOG"
fi

while true; do
  # 紀錄檔輪替：只留最近一份舊的
  if [ -f "$LOG" ]; then
    size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_BYTES" ]; then
      mv "$LOG" "$LOG.1"
      echo "$(date -Iseconds) 紀錄檔輪替" > "$LOG"
    fi
  fi

  # 告訴機器人「有人在看著你」。Telegram 的 /restart 只有看到這個才敢結束自己。
  export GMGN_SUPERVISED=1

  echo "$(date -Iseconds) 啟動機器人" >> "$LOG"
  node src/index.js >> "$LOG" 2>&1
  code=$?

  # 正常關閉（Ctrl+C / SIGTERM）就不要再拉起來
  if [ "$code" -eq 0 ]; then
    echo "$(date -Iseconds) 正常結束，不重啟" >> "$LOG"
    exit 0
  fi

  # 42 = 從 Telegram 要求重啟，不是當掉。立刻拉回來。
  if [ "$code" -eq 42 ]; then
    echo "$(date -Iseconds) 收到重啟要求，立刻重啟" >> "$LOG"
    continue
  fi

  echo "$(date -Iseconds) 異常結束（code=$code），10 秒後重啟" >> "$LOG"
  sleep 10
done
