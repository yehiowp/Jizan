#!/data/data/com.termux/files/usr/bin/bash
# 在 Android 手機上架設這個機器人（Termux）。
#
# 為什麼是手機而不是 VPS：
#   GMGN 走 Cloudflare，機房／雲主機 IP 常被直接 403。手機用的是電信或家用
#   網路，屬於住宅 IP，這正是它需要的。而且手機本來就 24 小時開著。
#
# 用法：
#   pkg install -y git && git clone -b claude/meme-money-program-4sb7gn \
#     https://github.com/yehiowp/Jizan.git && bash Jizan/bot/scripts/termux-setup.sh

set -e

echo "── 1/6 更新套件庫 ──"
pkg update -y

echo "── 2/6 安裝 Node.js 與 git ──"
pkg install -y nodejs-lts git

node_major=$(node -p "process.versions.node.split('.')[0]")
if [ "$node_major" -lt 20 ]; then
  echo "❌ Node 版本是 $(node -v)，需要 20 以上。試試：pkg install nodejs"
  exit 1
fi
echo "   Node $(node -v)"

echo "── 3/6 安裝 gmgn-cli ──"
npm install -g gmgn-cli

echo "── 4/6 安裝專案相依套件 ──"
cd "$(dirname "$0")/.."
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "   已建立 .env（待填）"
fi

echo "── 5/6 防止系統把它睡掉 ──"
# 沒有 wake lock 的話，螢幕一關 Android 就會凍結背景程式，
# 機器人會安靜停擺 —— 不是崩潰，是什麼都不做，你不會收到任何訊息。
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "   wake lock 已開啟"
else
  echo "   ⚠️ 找不到 termux-wake-lock。裝 Termux:API（pkg install termux-api）"
fi

echo "── 6/6 設定開機自動啟動 ──"
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/gmgn-bot.sh <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd $(pwd)
exec node src/index.js >> ~/gmgn-bot.log 2>&1
EOF
chmod +x ~/.termux/boot/gmgn-bot.sh
echo "   已寫入 ~/.termux/boot/gmgn-bot.sh"

cat <<'DONE'

════════════════════════════════════════

還要做三件事，缺一個就會在你沒注意的時候停掉：

1. 裝 Termux:Boot（F-Droid 上），開一次讓它取得權限。
   沒有它，手機重開機後機器人不會自己起來。

2. 系統設定 → 電池 → 找到 Termux → 選「不最佳化 / 無限制」。
   Android 的省電機制會把背景程式凍結，這是手機掛機最常見的死因。

3. 填設定：
     nano .env
   要填 TELEGRAM_TOKEN、OWNER_ID。存檔是 Ctrl+O 然後 Enter，離開是 Ctrl+X。

   GMGN 憑證另外設（金鑰會存在這支手機上）：
     gmgn-cli config
     gmgn-cli config --apply <你的KEY>

然後：
     node doctor.mjs      # 檢查每一項
     npm start            # 啟動

確認能跑之後，用這個在背景常駐（關掉 Termux 也不會停）：
     nohup node src/index.js >> ~/gmgn-bot.log 2>&1 &

看它的紀錄：
     tail -f ~/gmgn-bot.log

════════════════════════════════════════

⚠️ 手機上會放著 GMGN 的 API Key 和簽名私鑰（在 ~/.config/gmgn/.env）。
   手機掉了等於那把鑰匙掉了 —— 記得設螢幕鎖，並且只放你賠得起的金額。

DONE
