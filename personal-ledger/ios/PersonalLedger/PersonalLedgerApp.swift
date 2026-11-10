import SwiftUI

@MainActor
final class LedgerViewModel: ObservableObject {
    @Published var state = StoreState()
    @Published var error: String?
    @Published var notice: String?
    @Published var isSyncing = false
    @Published var loaded = false

    func load() async {
        do {
            state = try await LocalStore.shared.read()
            loaded = true
        } catch { self.error = "無法讀取帳本：\(error.localizedDescription)"; loaded = false }
    }

    func synchronize(quiet: Bool = false) async {
        guard !isSyncing, loaded else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let latest = try await LocalStore.shared.read()
            let token = try PairingKeychain.read()
            let (response, sent) = try await SyncClient.synchronize(state: latest, token: token)
            try await LocalStore.shared.apply(response, sent: sent)
            await load()
            let failures = response.results.filter { !$0.ok }.count
            notice = failures > 0 ? "部分紀錄需修正，\(failures) 筆仍保留待同步。" : "同步完成。"
        } catch {
            if quiet { notice = "尚未連上 Windows，手機紀錄已保留；可稍後再同步。" }
            else { self.error = error.localizedDescription }
        }
    }

    func becameActive() async {
        await load()
        if loaded && !state.endpoint.isEmpty { await synchronize(quiet: true) }
    }
}

@main
@MainActor
struct PersonalLedgerApp: App {
    @StateObject private var model = LedgerViewModel()
    var body: some Scene {
        WindowGroup { LedgerRootView().environmentObject(model) }
    }
}

@MainActor
struct LedgerRootView: View {
    @EnvironmentObject private var model: LedgerViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingAdd = false
    @State private var showingSettings = false
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("手機帳本").font(.title2.bold())
                            Text("離線記帳・Windows 對帳").foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "book.closed.fill").font(.largeTitle).foregroundStyle(.teal)
                    }.padding(.vertical, 6)
                    LabeledContent("待同步", value: "\(model.state.pending.count) 筆")
                    LabeledContent("待確認", value: "\(model.state.reviews.filter { $0.resolvedAt == nil }.count) 筆")
                    Text(model.state.lastSync.map { "最近同步：\(readableDate($0))" } ?? "尚未與 Windows 同步")
                        .font(.caption).foregroundStyle(.secondary)
                    if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.teal) }
                    Button { Task { await model.synchronize() } } label: {
                        Label(model.isSyncing ? "同步中…" : "同步 Windows 總帳", systemImage: "arrow.triangle.2.circlepath")
                    }.disabled(model.isSyncing || !model.loaded)
                }
                if !model.state.pending.isEmpty {
                    Section("手機待同步") {
                        ForEach(model.state.pending.reversed()) { item in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(item.payload.merchant).font(.headline)
                                    Spacer()
                                    Text("\(item.payload.currency) \(item.payload.amount)").monospacedDigit()
                                }
                                Text("\(item.payload.account) · \(readableDate(item.payload.occurredAt))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(item.payload.source == "apple_pay" ? "Apple Pay · 待同步" : "手動記帳 · 待同步")
                                    .font(.caption).foregroundStyle(.orange)
                                if let error = item.syncError { Text(error).font(.caption).foregroundStyle(.red) }
                            }.padding(.vertical, 3)
                        }
                    }
                }
                Section("Windows 總帳快取") {
                    if model.state.entries.isEmpty {
                        Text("新增消費後即可離線查看；連線同步後會顯示總帳及銀行核對狀態。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.state.entries.sorted { $0.occurredAt > $1.occurredAt }) { entry in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(entry.merchant ?? "未提供商家").font(.headline)
                                Spacer()
                                Text(CurrencyRules.display(minor: entry.amountMinor, currency: entry.currency,
                                                           digits: model.state.currencyDigits)).monospacedDigit()
                            }
                            HStack {
                                Text(readableDate(entry.occurredAt))
                                Spacer()
                                Text(entry.statusLabel).foregroundStyle(entry.status == "pending" ? .orange : .secondary)
                            }.font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 3)
                    }
                }
                let unresolved = model.state.reviews.filter { $0.resolvedAt == nil }
                if !unresolved.isEmpty {
                    Section("待確認項目") {
                        ForEach(unresolved) { review in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(review.reasonLabel).font(.headline)
                                if let entry = review.entry {
                                    Text("帳本金額：" + CurrencyRules.display(minor: entry.amountMinor, currency: entry.currency,
                                                                            digits: model.state.currencyDigits))
                                }
                                if let source = review.source {
                                    Text("來源金額：" + CurrencyRules.display(minor: source.amountMinor, currency: source.currency,
                                                                            digits: model.state.currencyDigits))
                                }
                                Text("請在 Windows 比對來源金額並處理，再重新同步。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("股票與加密貨幣") {
                    if model.state.portfolio.isEmpty {
                        Text("在 Windows 建立投資交易後，同步即可查看持倉與報價快取。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.state.portfolio) { position in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(position.symbol).font(.headline)
                                Spacer()
                                Text("數量 \(position.quantityDecimal)").monospacedDigit()
                            }
                            Text("\(position.market) · \(position.account)").font(.caption).foregroundStyle(.secondary)
                            Text("成本 \(position.currency) \(position.costDecimal)").font(.caption)
                            if let price = position.priceDecimal, let currency = position.quoteCurrency {
                                Text("報價 \(currency) \(price) · 市值 \(currency) \(position.valueDecimal ?? "—")")
                                    .font(.caption)
                            }
                            if let pnl = position.unrealizedDecimal {
                                Text("未實現損益 \(position.currency) \(pnl)").font(.caption)
                            }
                            Text(position.quoteAsOf.map { "報價時間：\(readableDate($0))" } ?? "尚無報價")
                                .font(.caption2).foregroundStyle(.secondary)
                        }.padding(.vertical, 3)
                    }
                }
                Section {
                    Button {
                        Task {
                            do { exportURL = try await LocalStore.shared.exportURL() }
                            catch { model.error = error.localizedDescription }
                        }
                    } label: { Label("準備手機帳本備份", systemImage: "square.and.arrow.up") }
                        .disabled(!model.loaded)
                    if let exportURL {
                        ShareLink("分享 JSON 備份", item: exportURL)
                        Text("備份包含交易及帳戶名稱，請儲存到自己的安全位置。配對碼不會匯出。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("個人帳本")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("同步設定")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingAdd = true } label: { Image(systemName: "plus") }
                        .disabled(!model.loaded).accessibilityLabel("新增記帳")
                }
            }
            .refreshable { await model.load() }
            .task { await model.becameActive() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.becameActive() } }
            }
            .sheet(isPresented: $showingAdd) { AddEntryView().environmentObject(model) }
            .sheet(isPresented: $showingSettings) { SyncSettingsView().environmentObject(model) }
            .alert("帳本訊息", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("知道了") { model.error = nil }
            } message: { Text(model.error ?? "") }
        }
    }
}

@MainActor
struct AddEntryView: View {
    @EnvironmentObject private var model: LedgerViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var currency = "TWD"
    @State private var merchant = ""
    @State private var account = "信用卡"
    @State private var kind = "expense"
    @State private var date = Date()
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("交易") {
                    Picker("類型", selection: $kind) {
                        Text("支出").tag("expense")
                        Text("收入").tag("income")
                    }
                    TextField("金額", text: $amount).keyboardType(.decimalPad)
                    Picker("幣別", selection: $currency) {
                        ForEach(CurrencyRules.supported, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("商家／交易對象", text: $merchant)
                    TextField("帳戶／卡片名稱", text: $account)
                    DatePicker("交易時間", selection: $date)
                }
                Section {
                    Text("銀行與 Apple Pay 請使用相同帳戶名稱，方便配對。資料會先儲存在手機，之後再同步。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("快速記帳")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "儲存中…" : "儲存") {
                        saving = true
                        Task {
                            defer { saving = false }
                            do {
                                let record = try IngestRecord.make(source: "manual", amount: amount,
                                                                  currency: currency, merchant: merchant,
                                                                  date: date, account: account, kind: kind)
                                try await LocalStore.shared.append(record)
                                await model.load()
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(saving)
                }
            }
            .alert("無法儲存", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了") { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}

@MainActor
struct SyncSettingsView: View {
    @EnvironmentObject private var model: LedgerViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var token = ""
    @State private var allowUnencrypted = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Windows 配對") {
                    TextField("http://192.168.1.10:8765", text: $endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Windows 配對碼", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("手機與 Windows 請連接同一個家中網路，並啟動電腦同步服務。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("連線保護") {
                    Toggle("允許家中 Wi-Fi 的 HTTP 同步", isOn: $allowUnencrypted)
                    Text("HTTP 連線未加密，配對碼及交易資料可能被同網路設備看到。僅在可信任的私人網路使用；不要開放路由器連接埠。若設為 HTTPS，系統會正常驗證憑證。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("離線與資料") {
                    Text("未連線時仍能記帳與查看快取。此版支援新增手機紀錄，已入帳內容及待確認項目由 Windows 管理；重新同步後會更新手機快取。")
                    Text("Apple Pay 捷徑需自行在 iPhone 建立 Wallet／交易自動化；請依實機可用欄位設定，缺少金額或商家時不會猜測入帳。")
                }.font(.caption).foregroundStyle(.secondary)
            }
            .navigationTitle("同步設定")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") {
                        Task {
                            do {
                                _ = try SyncClient.endpoint(endpoint, allowUnencrypted: allowUnencrypted)
                                try PairingKeychain.save(token)
                                try await LocalStore.shared.configure(endpoint: endpoint, allowUnencrypted: allowUnencrypted)
                                await model.load()
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
            .task {
                endpoint = model.state.endpoint
                allowUnencrypted = model.state.allowUnencryptedLAN
                do { token = try PairingKeychain.read() }
                catch { self.error = error.localizedDescription }
            }
            .alert("設定訊息", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了") { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}
