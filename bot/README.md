# GMGN 迷因幣 Telegram 機器人

用 GMGN 官方 `gmgn-cli` 執行交易的 Telegram 機器人：掃描候選幣、跑完整安全檢查、你在 Telegram 按確認後才下單，並且在買入的同時把停損停利掛到 GMGN 伺服器端。

## 先講清楚這支程式不會做什麼

- **不保證獲利。** 迷因幣絕大多數歸零。這支程式能做的是過濾掉明顯的陷阱、強制固定部位大小、確保每一單都有停損。它不預測價格。
- **不會自己買。** 每一筆買入都要你在 Telegram 按確認鍵。這既是 GMGN CLI 的硬性規定，也是 100U 該有的做法。
- **不碰你的私鑰。** 私鑰由 `gmgn-cli` 自己管在 `~/.config/gmgn/.env`，這支程式不讀、不存、不傳。
- **摩擦成本是真的。** 每次進出都要付 GMGN 抽成 + 優先費 + 小費 + 滑價。用 $20 的部位去對抗這個摩擦，勝率門檻比你想的高很多。

## 需要準備

| 項目 | 怎麼拿 |
|---|---|
| Node.js 20+ | |
| `gmgn-cli` | `npm install -g gmgn-cli` |
| GMGN API Key | `gmgn-cli config` 會告訴你去哪申請，拿到後 `gmgn-cli config --apply <KEY>` |
| 錢包私鑰 | 由 `gmgn-cli config` 一起設定。**用小額燒錢包，不要用主錢包。** |
| Telegram Bot Token | 跟 [@BotFather](https://t.me/BotFather) 說 `/newbot` |
| 你的 Telegram ID | 跟 [@userinfobot](https://t.me/userinfobot) 說句話 |

⚠️ `gmgn-cli` **只走 IPv4**。主機開著 IPv6 會拿到 401/403，而且錯誤訊息看不出真正原因。

## 安裝

```bash
cd bot
npm install
cp .env.example .env
# 編輯 .env：填 TELEGRAM_TOKEN、OWNER_ID、GMGN_WALLET_ADDRESS
```

## 上線順序（不要跳步）

### 第一步：自檢（不花錢）

```bash
npm run selftest
```

會逐項檢查 API Key、IPv6、gas 報價、trending 資料源、安全檢查端點、報價、Telegram 連線。**有任何 ❌ 就先修，不要往下走。**

### 第二步：模擬跑一週（`DRY_RUN=true`）

```bash
npm start
```

在 Telegram 用 `/scan` 找候選、`/buy <地址>` 走完整流程。它會照真實報價記帳，但不送鏈上交易。

一週後看 `/stats`：

- **期望值是負的** → 這套打法在現在的行情下不賺錢。改參數或收手，不要拿真錢去試。
- **期望值是正的但只有 5 筆** → 樣本太少，那是運氣。繼續跑。

### 第三步：真錢（確定要再做）

```bash
# 在 .env 把 DRY_RUN 改成 false，然後：
export GMGN_ALLOW_AUTOMATED_TRADES=1
npm start
```

`GMGN_ALLOW_AUTOMATED_TRADES=1` **必須由你自己在 shell 設定**。這是 GMGN 的程式碼層防線，用來擋掉「AI 讀到惡意指令就自己加 `--yes`」的情況。這支程式不會、也不該替你設定它 —— 設定它等於你明確同意讓機器人代送交易。

沒設定的話，真錢模式會直接拒絕啟動並告訴你原因。

## 指令

| 指令 | 作用 |
|---|---|
| `/scan` | 掃描 GMGN trending，評分後列出候選 |
| `/check <地址>` | 只跑檢查不下單，看閘門結果 |
| `/buy <地址> [金額]` | 準備買單，顯示確認卡（要按確認鍵，報價 2 分鐘失效） |
| `/positions` | 持倉與未實現損益 |
| `/sell <id> [百分比]` | 賣出 |
| `/stats` | 勝率、期望值、獲利因子、最大回撤 |
| `/status` | 系統狀態、風控餘額 |
| `/panic` | 全部賣光並停止交易 |
| `/resume` | 恢復交易 |

## 風控（寫死在程式裡，不是建議值）

| 上限 | 預設 | 行為 |
|---|---|---|
| 每筆投入 | $20 | 超過直接拒絕 |
| 同時持倉 | 3 個 | 滿了不給再開 |
| 在場資金 | $60 | 留 $40 當備用 |
| 單日虧損 | $20 | 觸及自動停用交易 |
| 停機線 | 淨值 $60 | 跌破全面停機 |
| 停損 | -35% | 掛成 GMGN 伺服器端 `loss_stop` |
| 停利 | +70% | 掛成 `profit_stop` |

**停損停利掛在 GMGN 伺服器端**，所以機器人關掉、主機重開、你手機沒電，出場照樣執行。這比在本機跑迴圈盯價可靠得多。

但要注意：GMGN 文件寫明策略單是 **best-effort** —— swap 成功但策略單建立失敗時，swap 結果照樣回傳。程式偵測到這種情況會明確告訴你「這個部位沒有自動出場」，看到這個訊息就要自己盯。

## 兩層篩選

1. **掃描層**（`market trending`）：便宜、可以常跑。評分 8 個因子，並用 `rug_ratio`、`is_wash_trading`、`bundler_rate`、`top_10_holder_rate`、`renounced_mint` 等欄位打紅旗。
2. **閘門層**（`token info` + `token security`）：只對你真的要買的那一顆跑。實作 GMGN 官方 skills 裡 `thresholds.md` 的量 / 深度 / 安全三道硬閘，加上方向判定（5 分鐘回撤 ≥10% 硬停，5–10% 只降級不否決）。

紅旗是**禁止進場**，不是扣分。

## 幾個會讓人賠錢的實作細節

這些都寫在程式碼註解裡，改動前先看懂：

- **Solana 的 `*_prio_fee` 三檔恆為 `1`**，那是佔位值。照它算優先費會變成 **1 SOL**。真實值在 `*_prio_fee_mixed`。
- **`liquidity` 是池子兩側之和**，約等於單邊可交易深度的兩倍。深度門檻是單邊口徑，不能直接套。
- **池子某一側的折美元儲備可能是 `"0"` 而池子完全正常**（上游沒給那一側定價）。兩側都 > 0 才取較小值，否則退回 `liquidity / 2`。
- **`token info` 回的不一定是最深的池**，深度只是下限。因此「24h 成交額遠大於池深度」是「還有別的池」的正常訊號，不是刷量。
- **稅率空字串代表未測，不是 0。**
- **開發者持倉要讀 `stat.creator_hold_rate`**，不是 `dev.top_10_holder_rate`（後者是「Top10 裡開發者相關地址佔比」，混用會誤判）。
- **代幣名稱是鏈上任何人都能填的欄位。** 所有 CLI 呼叫都用 `execFile` + 參數陣列，絕不拼 shell 字串；顯示前也會清掉控制字元。
- **限流後絕不自動重試** —— 每重試一次封禁延長 5 秒。

## 測試

```bash
npm test
```

100 條斷言，把 `gmgn-cli` 換成假的跑完整條買賣流程。不需要 API Key、不連網、不會送出任何交易。涵蓋：評分邊界、12 種陷阱是否被攔、蜜罐四層判定、深度三種取法、5 分鐘回撤硬停與降級、CLI 參數組裝（含惡意字串不被拆開）、限流/401/自動下單開關的錯誤處理、訂單輪詢必須到 `confirmed`、風控七道上限、自動停機、壞檔復原。

## 資料

全部存在 `bot/data/state.json`（已 gitignore）。刪掉就沒了，重要的話自己備份。

## GMGN skills

安全門檻與欄位對應來自 GMGN 官方 skills：

```bash
npx skills add GMGNAI/gmgn-skills
```

裝在 `.agents/skills/`（已 gitignore，不隨這個 repo 進版控）。`thresholds.md` 和 `fields.md` 是這支程式所有判準的出處，改參數前先讀。
