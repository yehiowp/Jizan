# iPhone 與 Windows 檔案交換

沒有 Mac 也可使用手機網頁記帳，再用 JSON 檔把紀錄交給 Windows 總帳本。iPhone 與 Windows 各自保留資料；檔案交換由你操作，不會監看資料夾或自行匯入檔案。

## 手機紀錄交給 Windows

1. 在 iPhone 記帳頁選擇「匯出」，把 JSON 存到「檔案」。
2. 透過你使用的檔案傳輸方式，把該檔放到 Windows。若透過 OneDrive 或 iCloud Drive，等候檔案下載完成。
3. Windows 總帳本開啟「匯入」，按「匯入手機紀錄」並選取 JSON。
4. 檢查預覽，再按「確認匯入預覽資料」。預覽本身不會寫入帳本。

同一來源識別碼的相同內容只接收一次。若同一識別碼的金額、時間、帳戶等內容不同，會列出錯誤並保留舊紀錄。需更正時在手機另建更正紀錄，或使用 Windows 的帳目修改功能；不要改寫已匯出的原始交易。

部分交易不合格時，預覽會顯示原始列號與原因。按確認只會接收合格列；錯誤列仍留在原始檔，匯入結果也會列出，沒有刪除手機資料。

## Windows 總帳交給手機

1. Windows「匯入」頁按「匯出手機總帳」，自行選擇檔案位置。
2. 將該 JSON 放入 iPhone「檔案」，再從手機記帳頁匯入。
3. 手機讀取帳目、待確認事項及資產快照，也能依已接收來源識別碼顯示上次交換結果。

總帳檔是一份匯出當下的快照，沒有自動連線或即時更新。快照包含帳目及資產顯示資料，不包含原始郵件內文、來源原始 JSON 或 Gmail 授權憑證。資料庫備份請使用 Windows 原有備份功能。

## 手機紀錄格式 v1

檔案使用 UTF-8 JSON（可含 BOM），最大 10 MiB，每檔最多 5000 筆。金額必須是正數十進位字串，精度依幣別檢查；交易時間必須帶時區。

```json
{
  "format": "personal-ledger-transfer",
  "version": 1,
  "device_id": "743dbe4b-bb48-4e28-94f8-d902c6e2e775",
  "export_id": "a2c31937-f443-4773-b477-d21c57f4012d",
  "created_at": "2026-11-10T10:00:00+08:00",
  "records": [
    {
      "source": "apple_pay",
      "external_id": "stable-wallet-transaction-id",
      "amount": "120.00",
      "currency": "TWD",
      "merchant": "咖啡店",
      "occurred_at": "2026-11-10T09:00:00+08:00",
      "account": "日常消費",
      "kind": "expense",
      "category": "餐飲",
      "time_precision": "minute",
      "source_timezone": "Asia/Taipei",
      "provenance": {"capture_method": "wallet_shortcut"}
    }
  ]
}
```

- `device_id`、`export_id`：UUID。
- `source`：`manual` 或 `apple_pay`。
- `external_id`：穩定且不空白的來源識別碼，最多 500 字元；可使用 UUID 或來源的交易代碼。
- `kind`：`expense`、`income`、`transfer` 或 `investment`。
- `category`：選填，預設「未分類」。
- `time_precision`：選填，`minute`、`second` 或 `day`，預設 `minute`；亦接受同義欄位 `date_precision`，兩者同時存在時必須一致。
- `source_timezone`：選填，最多 100 字元；不會取代 `occurred_at` 自身的時區。
- `force_review`：選填，必須為布林值；`true` 會要求人工核對，適用於捷徑未取得原始交易時間等不確定資料。
- `provenance`：選填，JSON 編碼最多 2000 個 UTF-8 位元組的來源資訊物件。匯入器會補上經封套驗證的 `transfer_device_id`、`transfer_export_id`。

手機檔案不能指定 Windows 的帳目 ID、帳戶 ID 或修改既有帳目。配對、去重、金額差異與待確認處理均交給 Windows 的帳本規則。

## 手機總帳格式 v1

```text
format: "personal-ledger-snapshot"
version: 1
export_id: UUID
created_at: ISO 8601 含時區
entries: 帳目顯示資料陣列
reviews: 待確認項目陣列，含已篩選的 entry/source/candidates
portfolio: 持倉與最近報價資料陣列
currency_digits: 幣別與小數位數對照
accepted_sources: [{source, external_id, entry_id}]
```

含金額的帳目／來源同時提供 `amount` 十進位字串。手機應以字串處理金額，避免 JavaScript 大整數精度問題。`accepted_sources.entry_id` 可為 `null`，表示來源已接收且仍待確認，並非尚未匯入。
