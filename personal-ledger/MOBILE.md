# 隨身帳本：不需 Mac 的 iPhone 入口

私人網址：https://personal-ledger-pocket-yeh.yeh2003121.chatgpt.site

靜態 PWA，使用 IndexedDB 保存裝置資料、Service Worker 保存離線畫面，不串接遠端帳目資料庫。首次開啟需要登入私人網站與載入程式；主畫面安裝、真正 Safari 飛航模式與 Wallet 欄位仍需 iPhone 實測。

帳目清單一次顯示 100 筆，按清單底部的「顯示更多」載入下一批；搜尋與篩選仍涵蓋全部帳目。開啟或回到 App 只讀取資料，不會重寫整份帳本。

在 iPhone 的 Safari 等瀏覽器分頁中開啟時，畫面上方會提示「加入主畫面，當成 App 使用」，按「怎麼加入」看步驟。加入後從主畫面圖示開啟就是全螢幕 App、沒有網址列，離線也能用。瀏覽器分頁與主畫面 App 的帳目分開保存；若分頁裡已有紀錄，提示會說明先在「轉移」頁「完整備份」，再到主畫面 App「匯入備份」。從主畫面圖示開啟時不顯示這個提示，按 × 後這台裝置的這個瀏覽器也不再顯示。

畫面與程式一律取自同一個已安裝版本的離線快取，所以離線、訊號不穩或私人網站登入逾期時都能立即開啟，也不會出現新畫面搭配舊程式。有新版本時在背景下載，完成後顯示提示；關閉所有帳本視窗再開啟才切換。若安裝時拿到的是登入頁，不會把它存成帳本畫面，畫面上方會顯示「離線畫面尚未準備」，重新登入後再開啟即可。

`npm test` 驗證金額、來源去重、來源核對、DOM 操作、IndexedDB 儲存與模擬離線快取，也會檢查 `sw.js` 的快取版本與檔案清單是否和 `dist/` 一致：改了手機程式卻沒有執行 `node prepare.mjs` 時，測試會失敗並提示。DOM 使用 jsdom 與 fake-indexeddb，不能取代真實瀏覽器或 iPhone 測試。

`npm run test:browser` 是選用的真實瀏覽器檢查，需另外安裝 Playwright（`npm install --no-save playwright`、`npx playwright install chromium`），未安裝時會自動略過。它以 Chromium 模擬 iPhone 尺寸，檢查新增紀錄、長清單分頁與搜尋、離線重新開啟、登入逾期不快取登入頁、起始網址轉址，以及新版本在背景安裝後的切換。2026-11-10 在 Linux 的 Chromium 上 11 項全數通過；iPhone Safari、主畫面安裝與 Wallet 欄位仍需實機驗證。

發布前執行 `node prepare.mjs`，它會依程式資源內容更新 Service Worker 快取版本，再執行 `npm test`。新版本不清除 IndexedDB，也不在舊畫面執行期間強制切換。

Windows 交換格式在同目錄的 `TRANSFER.md`；無 Mac 的 Wallet 設定在 `mobile-guides/APPLE_PAY_WITHOUT_MAC.md`。真實帳單、授權檔、交易備份及密碼不得放入 `mobile` 的 Site 原始碼目錄。
