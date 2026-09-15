#!/data/data/com.termux/files/usr/bin/sh
# 無人看管時的守門員：程式掛掉就重啟，紀錄檔太大就輪替。
#
# 為什麼需要：手機放家裡沒人看，程式半夜當掉的話會靜靜停在那裡。
# 已開的倉有 GMGN 伺服器端的停損保護，但機器人本身停了就不會再對帳、
# 不會再掃描、也不會通知你 —— 你會以為它在跑。

LOG="$HOME/gmgn-bot.log"
MAX_BYTES=$((5 * 1024 * 1024))     # 5MB 就輪替，手機空間有限

cd "$(dirname "$0")/.." || exit 1

while true; do
  # 紀錄檔輪替：只留最近一份舊的
  if [ -f "$LOG" ]; then
    size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_BYTES" ]; then
      mv "$LOG" "$LOG.1"
      echo "$(date -Iseconds) 紀錄檔輪替" > "$LOG"
    fi
  fi

  echo "$(date -Iseconds) 啟動機器人" >> "$LOG"
  node src/index.js >> "$LOG" 2>&1
  code=$?

  # 正常關閉（Ctrl+C / SIGTERM）就不要再拉起來
  if [ "$code" -eq 0 ]; then
    echo "$(date -Iseconds) 正常結束，不重啟" >> "$LOG"
    exit 0
  fi

  echo "$(date -Iseconds) 異常結束（code=$code），10 秒後重啟" >> "$LOG"
  sleep 10
done
