# iPhone 個人帳本

這是 iOS 17 以上的原生 SwiftUI App 原始碼，包含完整 Xcode 專案。可離線新增收入／支出、透過捷徑接收 Apple Pay 交易、保存待同步佇列、同步 Windows 總帳、查看金額差異與股票／加密貨幣持倉快取、匯出手機 JSON 備份。

目前的開發電腦是 Windows，沒有 Apple SDK、Xcode 或實體 iPhone 連線；**iOS 原始碼尚未經 Xcode 編譯與實機測試，也尚未產生可安裝 IPA**。Windows 同步服務已用真實 HTTP 請求與一次性 SQLite 資料庫測試。手機畫面與 Wallet 變數需要下述實機驗證。

## 安裝至 iPhone

iPhone 只能安裝經過 Apple 簽署的 App，不能像 Android 一樣從網站下載安裝檔直接安裝。沒有上架 App Store 時有以下三種方式。這個原生 App 與手機網頁版「隨身帳本」是兩個不同的 App，帳目不互通：原生版透過家中網路與 Windows 同步，並可讓 Apple Pay 捷徑直接記帳。

### 方式一：不需 Mac、免費，用自己的 Apple ID 簽署

1. GitHub 上的「iPhone app (native)」工作流程（`.github/workflows/ios-app.yml`）會在 GitHub 提供的 Mac 環境編譯，產生未簽署的安裝檔。到 repo 的 **Actions** 頁面開啟最近一次成功的執行，在 **Artifacts** 下載 `PersonalLedger-unsigned-ipa`，解壓縮得到 `PersonalLedger-unsigned.ipa`（保留 30 天；修改 `ios/` 後會重新編譯，也可在 Actions 頁面手動執行）。
2. 在 Windows 安裝 Sideloadly 或 AltStore，依該工具的說明安裝它需要的 Apple 元件（iTunes／iCloud），再用 USB 連接 iPhone。
3. 用工具以自己的 Apple ID 簽署並安裝這個 IPA。工具需要登入 Apple ID 才能向 Apple 取得免費簽署，可考慮另建一個專用的 Apple ID。若提示識別碼（Bundle ID）已被使用，在工具的進階選項改成自己的，例如 `com.你的名字.personalledger`，之後每次都用同一個。
4. 第一次安裝後，在 iPhone「設定 → 隱私權與安全性 → 開發者模式」開啟並重新開機；若開啟 App 時顯示未受信任的開發者，到「設定 → 一般 → VPN 與裝置管理」信任自己的 Apple ID。
5. 免費 Apple ID 簽署的 App **7 天後就無法開啟**，需要用同一工具、同一個 Bundle ID 重新簽署安裝（AltStore 可在同一 Wi-Fi 自動續簽）。直接覆蓋安裝、不要先刪除 App，才能保留 App 內的帳目；也請定期同步到 Windows 或匯出備份。免費帳號同時最多 3 個自行安裝的 App。

### 方式二：付費 Apple Developer Program（每年 US$99）

- 可以用 **TestFlight** 安裝：在 iPhone 的 TestFlight App 點一下就像一般 App 一樣安裝，不需每 7 天重簽；每個版本 90 天後到期，期間上傳新版即可更新。也可以上架 App Store。
- 仍然不需要 Mac：簽署與上傳也能在 GitHub Actions 完成，但要先在 App Store Connect 建立這個 App，並把簽署憑證與 API 金鑰存成 repo 的 secrets。目前的工作流程只產生未簽署 IPA，改用 TestFlight 需要另外設定。

### 方式三：有 Mac 時用 Xcode 安裝

1. 使用 Mac，安裝支援你手機 iOS 版本的 Xcode，開啟 `PersonalLedger.xcodeproj`。
2. 在 Xcode 的 Apple Accounts 登入自己的 Apple Account，選取 PersonalLedger target，在 Signing & Capabilities 選擇自己的 Team，保留自動簽署。必要時將 Bundle Identifier 改為自己唯一的識別碼。
3. 選擇 iPhone 作為執行裝置，依 Xcode 提示配對並開啟 Developer Mode，按 Run。簽署憑證與 Apple Account 由你在 Xcode 管理，不需要傳給本程式。
4. 先以「＋」手動新增一筆測試記帳，開啟飛航模式確認仍可新增與查看。

這是 Apple 官方的 [Xcode 裝置執行與簽署流程](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)，以及 [Developer Mode 說明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)。使用個人開發簽署時，請依 Xcode 顯示的有效期限重新簽署；持續發佈可另採 TestFlight／App Store 流程。

可先在 Mac 執行模擬器編譯，這不需要真機簽署：

```sh
xcodebuild -project PersonalLedger.xcodeproj -scheme PersonalLedger -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Windows 配對

手機與 Windows 連接同一個可信任的私人 Wi-Fi。在 Windows 桌面程式設定中，啟用區域網路同步，再複製配對碼與電腦 IPv4 位址。也能於 `personal-ledger` 目錄啟動命令列服務：

```powershell
python sync_server.py --lan --show-pairing
```

預設資料庫與配對碼在 `%LOCALAPPDATA%\PersonalLedger`。若桌面程式使用自訂資料庫，命令列也必須傳入相同的 `--database` 路徑。不要同時啟動桌面同步服務與相同連接埠的命令列服務。

1. iPhone 開啟齒輪設定，輸入例如 `http://192.168.1.10:8765`，貼上 Windows 的配對碼。
2. HTTP 是**未加密**的區域網路傳輸，配對碼與交易內容會經過同一條連線；只在可信任的家中網路勾選允許 HTTP 同步。不要開啟路由器轉發、公開隧道或公開網路連接埠。
3. 儲存後按「同步 Windows 總帳」。iPhone 進入前景時也會嘗試同步；離線／電腦關機時保留待同步紀錄。
4. 若 Windows 防火牆擋住，僅允許這個程式在「私人網路」連線；本程式不會自動更改防火牆。

程式目前只接受使用者手動輸入的私人 IPv4 位址（10.x、172.16–31.x、192.168.x，以及供模擬器使用的 127.x），不支援公網 URL 或重新導向。更換 Wi-Fi 或 DHCP 位址後需更新設定。

同步服務預設不帶 `--lan` 時僅綁定 `127.0.0.1`。它檢查來源網段、Host 與 Bearer 配對碼，拒絕瀏覽器 Origin，沒有 CORS 或雲端轉送。配對碼是本機設定檔，不是郵件密碼；Windows 使用者資料夾權限與 BitLocker 可保護本機資料。不要把配對碼貼進公開文件。

若已有 iPhone 信任的本機 TLS 憑證，可用 `--tls-cert <憑證.pem> --tls-key <私鑰.pem>` 啟用 HTTPS；iPhone 保留系統憑證驗證，不略過無效憑證。App 的 ATS 設定僅宣告本機網路存取，沒有全域允許任意 HTTP。[Apple 本機網路 ATS 說明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)

## Apple Pay 捷徑

Apple 官方提供依 Wallet 卡片感應觸發的 [Transaction 自動化](https://support.apple.com/en-ie/guide/shortcuts/apd65c67538a/ios)。官方此頁沒有保證每個地區、卡片與系統版本都提供完整的金額、商家或交易識別碼；也不能推論它涵蓋所有網路 Apple Pay 交易。請先以自己的卡片測試。

1. 安裝 App 並開啟一次後，進入「捷徑」建立個人自動化，選擇 Wallet／交易觸發器與要使用的卡片。名稱依 iOS 版本而異。
2. 新增「個人帳本」的「記錄 Apple Pay 消費」動作。
3. 若實際交易輸入有金額與商家，將它們分別接入動作欄位。金額應是純數字字串，例如 `500.00`，不含 `NT$` 或千分位；必要時先使用捷徑的數字格式化動作。
4. 幣別可接入交易幣別，或僅在確定這張卡／流程都是新臺幣時填 `TWD`。外幣交易不要固定填 TWD。
5. 帳戶／卡片名稱需與 Gmail 匯入規則、Windows 帳目使用相同名稱，例如「國泰信用卡」。交易時間若有原始欄位應傳入；留空時記為捷徑執行當下的時間，可能影響配對。
6. 「來源識別碼」只有在交易輸入確實提供穩定、唯一的交易 ID 時才填入。未提供時 App 為這次紀錄建立 UUID。同一筆已存資料的網路重試不會重複入帳；**缺少穩定來源 ID 時，人工重跑整個捷徑仍可能新增一筆**，請勿重跑真實交易來測試。
7. 若自動化有「立即執行」選項，可依需要選取。請做一筆自己的小額交易，檢查金額、商家、時間與帳戶後才長期啟用。

若該卡片沒有可用的交易欄位，先保留手動記帳／Gmail 匯入；不要在捷徑寫死真實交易金額。App 不讀取其他 App 的通知權限或冒充銀行通知來源。捷徑動作利用 Apple 的 [App Intents 輸入參數](https://developer.apple.com/documentation/appintents/adding-parameters-to-an-app-intent)，只儲存傳入的資料。

## 同步與資料規則

- 本機檔案位於 App sandbox 的 Application Support，用 Codable JSON 原子寫入。Data Protection 採「開機首次解鎖後可存取」，以便首次解鎖後的捷徑背景記帳；重開機尚未解鎖前無法讀寫。[Apple Data Protection 說明](https://support.apple.com/en-ca/guide/security/secb010e978a/web)
- 配對碼只放在鑰匙圈，設定為本裝置、首次解鎖後可存取；JSON 備份不包含配對碼。
- 每筆手機來源紀錄在存入後保持不變。同步只有收到該 `source + external_id` 的 `ok: true` 才標記已傳送。斷線或解碼失敗時保留原佇列並可安全重試。
- POST `/v1/sync` 傳 `{ "records": [...] }`，空陣列代表只刷新快取。每次最多 500 筆／1 MiB；超過 500 筆請再次同步。伺服器以每筆結果明確回覆成功或驗證錯誤，回傳總帳、待確認與持倉快照。
- 同步回應套用前重新讀取本機檔案，保留請求期間新增的手機紀錄。已傳送的來源不另外加總到畫面，避免與 Windows 帳目重複顯示。
- 金額差異不覆寫既有帳目；手機顯示帳本金額與來源金額，實際確認與修改在 Windows 完成。此版手機支援新增紀錄與唯讀總帳快取，沒有手機端編輯既有帳目／解決衝突功能。
- 股票與加密貨幣的交易及行情由 Windows 管理，手機同步後顯示最近報價時間。手機離線不會假裝報價是即時價格，也不會把不同幣別直接加總。
- 「準備手機帳本備份」後可以分享 JSON 檔；它包含交易與帳戶資訊。此版未提供 iPhone 端還原介面，Windows 的資料庫備份仍是完整總帳的主要備份。

## 首次實機驗收

依序驗證：飛航模式新增與重啟保留 → 開機首次解鎖後執行捷徑 → 區域網路配對 → 連線中斷後重試仍只入帳一次 → Gmail 相同金額核對 → 不同金額只產生一筆帳目與待確認 → Windows 處理後手機刷新 → 投資持倉與報價時間 → 手機備份匯出。

Windows 端測試：`python -m unittest test_sync_server -v`。此測試涵蓋實際 HTTP、部分成功、重試去重、金額差異、授權、Host／Origin、大小限制與儲存失敗；不代表 iPhone 或 Wallet 已通過測試。
