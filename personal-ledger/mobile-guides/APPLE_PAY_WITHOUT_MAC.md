# 沒有 Mac 的 iPhone 記帳與 Apple Pay 設定

iPhone 使用加入主畫面的網頁 App，Windows 保存總帳。手機先保存紀錄，之後以 JSON 檔交給電腦匯入，不需要編譯 iOS App。以下捷徑流程已按 Apple 公開文件設計，但尚未在你的 iPhone、卡片或 iOS 版本實測；不能將它當成已驗證的全自動銀行介接。

## 安裝手機網頁 App

1. 在 iPhone Safari 打開提供的 HTTPS 帳本網址。
2. 選「分享」→「加入主畫面」。若有「以網頁 App 打開／Open as Web App」，將它開啟，再按「加入」。[Apple 安裝步驟](https://support.apple.com/en-eg/guide/iphone/iphea86e5236/ios)
3. 從剛加入的主畫面圖示開啟帳本，等候離線資源準備完成。首次安裝與下載必須連網；離線使用靠 Service Worker 預先快取程式資源。[MDN PWA 安裝與離線說明](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
4. 在主畫面 App 中新增一筆測試帳目，關閉後重開，再以飛航模式確認可查到及新增。這項檢查尚需使用者的 iPhone 完成。
5. 日後固定從此圖示記帳。Safari 與加入主畫面的 App 不共用本機帳本；若先在 Safari 記過帳，先匯出檔案，再從主畫面 App 匯入。[WebKit 儲存隔離說明](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)

## 先準備離線收件資料夾

1. 開啟 iPhone「檔案」→「瀏覽」→「我的 iPhone」，建立 `PersonalLedger` 資料夾。
2. 捷徑的收件檔先存在此處。Apple 將「我的 iPhone」列為本機位置，與同步用途的 iCloud Drive 分開。[Apple 檔案位置說明](https://support.apple.com/en-ae/102570)
3. 需要傳到 Windows 時，再將匯出檔複製至自己的 OneDrive 或 iCloud Drive。OneDrive 等服務可在「檔案」中啟用；未連網的本機收件不依賴雲端完成。[Apple 第三方雲端檔案說明](https://support.apple.com/en-us/102238)

## Apple Pay 交易自動化

Apple 官方提供 Wallet 卡片感應的交易觸發器，可挑選要觸發的卡片；其文件沒有保證每個卡片、地區與版本都提供哪些金額、商家、幣別或交易 ID 欄位，也不能據此保證涵蓋所有網路付款或 Apple Watch 付款。[Apple 交易觸發器](https://support.apple.com/en-ie/guide/shortcuts/apd65c67538a/ios)

1. 打開「捷徑」→「自動化」→新增，選 Wallet／錢包／交易，選擇要記帳的卡片。
2. 若畫面提供「立即執行」，選它；較早版本可能顯示「執行前詢問」，關閉此選項。Apple 列出 Transaction 可以自動執行，但個別動作仍可能另外要求授權。[Apple 自動執行說明](https://support.apple.com/en-ae/guide/shortcuts/apd602971e63/ios)
3. 先新增「快速查看／Quick Look」，輸入選「捷徑輸入」。請以一次自己的小額付款確認實際輸入，或在編輯欄位中點選輸入變數，查看可用的屬性。沒有實際交易輸入時，直接按測試可能取不到資料。
4. 確認有可用的金額及商家後，建立下列「辭典／Dictionary」；各交易欄位選擇實際輸入的對應屬性。**若沒有金額或商家，不要用固定金額代替，也不要產生自動入帳檔案**。這張卡改用手動記帳與 Gmail／對帳單核對。

| 辭典鍵 | 型別與值 |
|---|---|
| `source` | 文字：`apple_pay` |
| `external_id` | 文字：該筆交易的穩定 ID；沒有時，使用此次執行產生的唯一 ID |
| `amount` | 文字：實際金額，例如 `500.00`，不含 `NT$`、貨幣符號與千分位；JSON 中必須是字串 |
| `currency` | 文字：實際三碼幣別，例如 `TWD`；無法判斷時先人工確認 |
| `merchant` | 文字：實際商家／交易摘要 |
| `account` | 文字：自己的卡片名稱，須與 Windows、Gmail 規則一致 |
| `kind` | 文字：`expense` |
| `occurred_at` | 文字：帶時區的時間，例 `2026-11-10T18:30:00+08:00` |
| `time_precision` | 文字：`second` |
| `category` | 文字：`未分類` |

5. 沒有交易 ID 時，可用捷徑中可用的 UUID 動作產生一次 ID，並保存成變數，之後的檔名與 `external_id` 共用同一值。若自己的版本找不到此動作，可把「目前日期」格式化為 `yyyyMMddHHmmssSSS`，串接一個「隨機數字」與卡片代稱作為此次執行 ID。**重新匯入同一檔案可以去重；重新執行整個自動化會產生新 ID，仍可能成為疑似重複待確認，請勿重跑真實交易來測試。**
6. 時間優先取實際交易時間；若沒有，只能用「目前日期」代表捷徑捕捉時間，並在辭典加入布林值 `force_review = true`，讓 Windows 先人工確認。加上「格式化日期／Format Date」，使用 ISO 8601，或自訂 `yyyy-MM-dd'T'HH:mm:ssXXX`，保留當時的時區。捷徑自訂格式依 Unicode 日期格式規則運作。[Apple 日期格式](https://support.apple.com/en-euro/guide/shortcuts/apd8d9b19184/ios)
7. 用「辭典」建立 JSON，避免手寫字串拼接造成商家名稱中的引號或換行損壞檔案。Apple 支援以辭典建立 JSON 結構。[Apple 辭典與 JSON](https://support.apple.com/en-ie/guide/shortcuts/apd43b69f337/ios)
8. 加入「從輸入取得文字／Get Text from Input」，輸入選剛才的辭典；首次保留「快速查看」確認輸出是有效 JSON 物件，且金額、幣別、時間及商家正確。若輸出不是 JSON，停止啟用，先確認該版捷徑的辭典轉文字行為。
9. 加入「設定名稱／Set Name」，檔名填 `apple-pay-`＋同一個唯一 ID＋`.json`。
10. 加入「儲存檔案／Save File」，目標指定「我的 iPhone／PersonalLedger」，關閉每次詢問儲存位置；不覆寫既有檔案。先手動執行並在手機上完成檔案存取授權。Apple 將 Save File 列為捷徑的檔案儲存動作。[Apple 檔案儲存動作](https://support.apple.com/en-gb/guide/shortcuts/apdaf74d75a5/ios)
11. 移除測試用「快速查看」，可保留一則「已儲存交易檔」通知。做一次小額交易，確認資料夾中真的出現正確的 JSON，再長期使用。鎖定螢幕、重開機後與離線的動作行為，需在自己的 iPhone 驗證。

每筆一檔可避免讀取、追加及覆寫同一檔案造成遺失，也方便重試。這條路線不要求網頁 App 在背景接收檔案或讀取 Wallet 通知。

## 把收件檔加入手機帳本

1. 從主畫面打開帳本，選「匯入 JSON」或檔案匯入入口。
2. 透過檔案選擇器，選取「我的 iPhone／PersonalLedger」中的一個或多個 `.json` 檔，確認預覽後匯入。網頁只能讀取你選擇的檔案，不會在背景掃描收件資料夾。[MDN 本機檔案選擇器](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications)
3. 匯出交給 Windows 的交易檔，保存在「檔案」。需要用雲端檔案傳遞時，連網後複製至自己的 OneDrive／iCloud Drive。
4. Windows 匯入後以 `source + external_id` 去重，再與 Gmail／對帳單核對；金額不一致進「待確認」。同一檔案重匯不代表重新發生消費。
5. 確認 Windows 已收到且備份後，再整理手機收件檔。以 Windows 完整資料庫備份作為總帳備份。

## 範例格式

以下僅為格式展示，請勿將此範例當成真實交易匯入正式帳本：

```json
{
  "source": "apple_pay",
  "external_id": "EXAMPLE-ONLY-20261110-001",
  "amount": "500.00",
  "currency": "TWD",
  "merchant": "測試商店",
  "account": "我的信用卡",
  "kind": "expense",
  "occurred_at": "2026-11-10T18:30:00+08:00",
  "time_precision": "second",
  "category": "未分類"
}
```

## 使用界線

- 手機網頁 App 可離線記帳與讀取已存在本機的檔案；第一次安裝、接收新 Gmail、取得新報價與雲端檔案傳送需要網路。
- Apple Pay 自動化的第一步是先把交易存成檔案；加入手機帳本與傳給 Windows 仍需要檔案選取／匯入操作。這不是已完成的無人值守雙向同步。
- 不使用「打開網址」把交易悄悄寫入主畫面 App；Safari 可能使用另一份本機儲存，且開啟網址也不等於能在鎖定時背景入帳。
- 網頁本機資料可能受清除網站資料、移除 App 或儲存空間回收影響；請定期匯出。WebKit 說明網站資料在儲存壓力等條件下可能被回收，持久儲存由瀏覽器決定。[WebKit 儲存政策](https://webkit.org/blog/14403/updates-to-storage-policy/)
- 帳單最終扣款可能與 Apple Pay 當時金額不同。所有來源各自保存，差額交由 Windows 待確認處理，不擅自覆寫原金額。
