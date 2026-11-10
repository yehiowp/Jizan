# Gmail、帳單與行情

核心記帳、CSV 匯入、Gmail 與行情介面只使用 Python 標準函式庫。帳目保存在本機；連網功能失敗不會刪除既有資料。預設資料目錄是 `%LOCALAPPDATA%\PersonalLedger`，專案所在的 OneDrive 不保存新帳本或 Gmail token。

## Gmail 設定

這是此程式自己的 Google OAuth 授權，與 ChatGPT 的 Gmail 連接器分開。尚未設定或授權時，程式不會讀取郵件。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立自己的專案，啟用 Gmail API、設定 OAuth 同意畫面，並建立 **Desktop app** 類型 OAuth 用戶端。若專案是測試狀態，將自己的 Gmail 加為測試使用者。
2. 下載 OAuth 用戶端 JSON，保存於本機私有目錄，不提交版本控制；在 Windows 程式的 Gmail 設定選取此檔案。
3. 填入從銀行官方來源核對過的完整寄件地址，或指定自己建立的專用 Gmail 標籤。程式沒有預設銀行地址，避免猜錯來源。標籤必須是自訂標籤，不能用整個 INBOX 代替。
4. 設定帳戶名稱及來源時區，例如 `日常消費`、`+08:00`。同一張卡的 Apple Pay 與銀行資料要使用一致帳戶名稱。不同卡片／銀行請使用分開設定檔與帳戶，以免錯配。
5. 按「授權 Gmail」，在 Google 頁面登入並同意 Gmail 唯讀權限，再同步通知。

也可使用命令列：

```powershell
python integrations.py gmail-template
python integrations.py gmail-status
python integrations.py gmail-connect
python integrations.py gmail-sync --max-messages 50
```

自訂設定檔以 `--config C:\自己的路徑\gmail.json` 指定。設定結構如下，範例寄件地址不可直接當成銀行地址：

```json
{
  "oauth_client_file": "C:/自己的私有目錄/client_secret.json",
  "senders": ["請填經官方核對的完整銀行地址"],
  "label": "交易通知",
  "account": "日常消費",
  "timezone_offset": "+08:00",
  "lookback_days": 30
}
```

`senders` 與 `label` 至少設定一項；兩者都有時取交集。`lookback_days` 範圍為 1–366。每次讀取最多 50 封，可提高到 500；`has_more` 表示尚有更早郵件，下次同步會從保存的分頁繼續。完成此篩選範圍後，下次由最新郵件重新檢查；條件更改或 Google 分頁游標過期時安全重掃，已入帳來源 ID 不會重複記帳。本版不會無限制掃描整個信箱。

### 自動入帳條件

- 寄件者符合使用者設定的完整地址，且 Gmail `Authentication-Results` 包含與 From 網域相符的驗證通過結果。
- 單一明確金額與幣別、明確商家欄位、完整年份與交易時間、時區均可辨認。
- 郵件表示消費交易；退款、繳款、轉帳、金額歧義與缺少資料都需人工確認。

目前通用解析器支援 `商店：…`／`merchant: …` 等明確欄位、`NT$500`／`USD 15.50` 或 `幣別：TWD` 加 `金額：500`、`2026/11/10 12:34:00` 等完整交易時間。銀行真實格式尚未提供，因此不宣稱所有銀行通知皆已相容。收信時間不會被當成交易時間；只有月日的時間不會自動推算年份。

只有標籤而沒有白名單、驗證結果不足、來源不熟悉或資訊不完整時，解析結果保存為本機 `gmail-pending-*.json`，每次同步都回傳仍未處理的候選資料，Windows 介面可檢視及人工編輯後匯入。候選經人工匯入到帳本或待確認清單後，下次同步會從候選檔移除，避免反覆提示。月結帳單與 OTP 不會當成一筆消費；帳單改用下方對帳入口。同一封 Gmail 以郵件 ID 去重。

Gmail 權限僅請求 `https://www.googleapis.com/auth/gmail.readonly`，因此不寄信、不刪信、不更改標籤。注意：Google 的這個權限本身涵蓋整個信箱的唯讀存取，寄件者／標籤限制由此程式執行，並非 Google 提供的單一標籤授權。Windows token 以目前登入使用者的 DPAPI 保護，保存於本機資料目錄；其他平台使用權限 0600 的使用者檔案。token 不會輸出到畫面或日誌。

驗證標頭只是降低誤收風險，不能證明信件金額就是最終銀行入帳值。本版不自行下載 DKIM 金鑰或重做郵件密碼驗證，依 Gmail 接收標頭判斷；轉寄、企業郵件路由或銀行範本差異可能需要人工確認。郵件文字與連結均視為資料，不執行指令、不開啟郵件連結，也不在通知同步下載附件。

官方參考：[Gmail API 篩選](https://developers.google.com/workspace/gmail/api/guides/filtering)、[訊息清單與分頁](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[唯讀權限範圍](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Desktop OAuth／PKCE／loopback](https://developers.google.com/identity/protocols/oauth2/native-app)、[Gmail 郵件驗證說明](https://support.google.com/mail/answer/180707)。

## 離線帳單對帳

CSV／TSV 可離線匯入 UTF-8 或 Big5 檔案。不需要把銀行帳單上傳到任何服務。推薦欄位為：

```csv
date,amount,currency,merchant,kind,transaction_id,account
```

- `date`：完整日期與時間（如 `2026-11-10 12:34:00+08:00`），或完整日期。日期缺少年份不推算。
- `amount`：正數，可有正常千分位。負號／括號的銀行記法保留待確認，不猜收入或支出。
- `currency`：TWD、USD 等三碼幣別。
- `merchant`：交易商家或摘要。
- `kind`：expense／income／refund／transfer，或支出／收入／退款／轉帳。需明確提供類型，不把所有列都當支出。
- `transaction_id` 與 `account`：可省略；缺少交易 ID 時以整份檔案雜湊加列號去重。重新匯出成不同檔案可能產生不同來源 ID，仍需透過帳本核對，不能直接批准所有資料。

一般中文欄名可自動辨認。不同欄名可設定對照 JSON，例如：

```json
{"date":"消費日期","amount":"原幣金額","currency":"原幣幣別","merchant":"交易說明","kind":"交易類型"}
```

合計、應繳、餘額列不會當成交易；缺欄、未知分類、無效日期、重複 ID 留在預覽。正確資料帶 `force_review=true` 交給帳本：能與既有交易精確核對者關聯來源，金額有差異或找不到紀錄者列入待確認。日期只有到日時，午夜只是儲存佔位並標示 `date_precision=day`，一律待確認，不能憑假定的午夜自動配對。

退款以收入方向傳入待確認，確認後需分開建立收入帳目，不能合併到原支出而漏掉退款。可自行填寫退款分類與備註；本版尚未提供退款與原消費的專用關聯欄位。信用卡繳款為轉帳，不計為第二次消費。這一版尚未提供每家銀行不同借貸欄位、海外原幣與結算幣別的專用轉換器。

PDF 使用 `pypdf` 在本機擷取文字，支援加密 PDF 密碼在記憶體解密，密碼不保存。[台新信用卡文字型電子帳單](TAISHIN_STATEMENT.md) 已用實際版型驗證：僅將交易表轉為待確認候選，區分消費、費用、退款及繳款，並檢查逐筆淨額、已繳款項及摘要餘額。任何控制未通過或仍有未辨識交易列，預覽保留但匯入按鈕停用。日期精度及入帳日期會隨手機快照和 CSV 保留。

其他銀行 PDF 先提供文字預覽，再整理為 CSV 對帳。掃描影像目前沒有 OCR。退款的專用原交易關聯及多卡帳戶分配仍需人工核對。

```powershell
python -m pip install -r requirements.txt
```

`pypdf` 是選用功能；未安裝仍可記帳、讀 Gmail、匯入 CSV 與更新行情。

## 股票與加密貨幣報價

| 資產 | 自動來源 | 價格意義 | 價格時間 |
|---|---|---|---|
| TWSE 上市股票／支援的上市商品 | 證交所 OpenAPI `STOCK_DAY_ALL` | 最近可取得交易日收盤價，非盤中價 | 來源交易日＋台灣一般收盤時間 13:30 |
| 市場明確設為 `BINANCE` 的加密貨幣 | Binance Spot 公開市場資料 `trades?limit=1` | 此交易所最近一筆成交價 | API 回傳毫秒成交時間 |
| Coinbase 支援的加密貨幣交易對 | Coinbase Exchange ticker | 此交易所最後一筆成交價，非所有市場平均價 | API 回傳最後成交時間 |
| 上櫃、美股與其他市場 | 手動輸入 | 使用者提供 | 使用者指定 |

自動報價由介面按鈕或啟用後的定時更新觸發。每次請求設逾時，僅有限次重試；離線、限流、交易對不支援或 TLS 憑證錯誤會顯示失敗並保留最後快取。程式維持 TLS 憑證驗證，不跳過憑證錯誤。

`as_of` 是市場資料時間，`fetched_at` 是下載時間，兩者分開。TWSE `as_of` 的 13:30 是日收盤資料標準化時間，不是 API 逐筆成交時間。非交易日或來源延遲時，會顯示較早交易日，不把下載時間當成最新行情。

加密貨幣若要使用 Binance 報價，建立持倉時將「市場」填為 `BINANCE`、代號填為 `BTC` 等資產代號。成本為 TWD 或 USD 時，Binance 使用真實 `BTCUSDT` 等 USDT 交易對，報價幣別保存為 **USDT**，不假設 USDT 等於 USD。其他報價幣別會查詢相應支援交易對。失敗時不偷偷改用其他供應商。

其他加密貨幣市場欄位沿用 Coinbase 介面；成本是 TWD 時，Coinbase 報價使用 USD 並明確保存報價幣別。本版尚未自動匯率換算，不用 USDT／USD 市值直接減去 TWD 成本顯示損益。代幣代碼相同不代表同一鏈或同一合約，實際持倉仍須依帳戶／資產識別管理。

官方參考：[TWSE OpenAPI](https://openapi.twse.com.tw/)、[Binance 公開市場資料主機與時間單位](https://developers.binance.com/en/docs/products/spot/rest-api)、[Binance Spot 最近成交](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)、[Coinbase Exchange ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)。

## 驗證範圍

自動測試涵蓋解析歧義、時間與金額拒絕、Gmail 範圍限制、寄件者驗證、郵件去重、實際本機 OAuth callback／state／PKCE、Windows token 保護、CSV 收支及退款、日精度與錯誤列、行情時間與失敗保留快取。測試使用合成郵件與 mock 網路，未讀取私人 Gmail。

2026-11-10 曾以程式成功取得 TWSE 上市收盤資料及 Binance Spot BTCUSDT 最近成交，連線均維持 TLS 驗證。Coinbase 在目前電腦的連線被 TLS 信任鏈錯誤阻擋，解析與錯誤處理已測試，但尚未完成這台電腦的 Coinbase 端到端連線。真實 Gmail 授權、銀行範本及使用者的 Apple Pay 欄位仍需實機驗證。
