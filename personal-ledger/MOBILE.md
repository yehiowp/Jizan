# 隨身帳本：不需 Mac 的 iPhone 入口

私人網址：https://personal-ledger-pocket-yeh.yeh2003121.chatgpt.site

靜態 PWA，使用 IndexedDB 保存裝置資料、Service Worker 保存離線畫面，不串接遠端帳目資料庫。首次開啟需要登入私人網站與載入程式；主畫面安裝、真正 Safari 飛航模式與 Wallet 欄位仍需 iPhone 實測。

`npm test` 驗證金額、來源去重、來源核對、DOM 操作、IndexedDB 儲存與模擬離線快取。DOM 使用 jsdom 與 fake-indexeddb，不能取代真實瀏覽器視覺或 iPhone 測試。此環境的瀏覽器工具沒有可用瀏覽器，因此尚未完成瀏覽器視覺 QA。

發布前執行 `node prepare.mjs`，它會依程式資源內容更新 Service Worker 快取版本，再執行 `npm test`。新版本不清除 IndexedDB，也不在舊畫面執行期間強制切換。

Windows 交換格式在同目錄的 `TRANSFER.md`；無 Mac 的 Wallet 設定在 `mobile-guides/APPLE_PAY_WITHOUT_MAC.md`。真實帳單、授權檔、交易備份及密碼不得放入 `mobile` 的 Site 原始碼目錄。
