import AppIntents
import Foundation

struct AddTransactionIntent: AppIntent {
    static var title: LocalizedStringResource = "記錄 Apple Pay 消費"
    static var description = IntentDescription("將捷徑提供的交易資料存到本機帳本，離線也可記帳。")
    static var openAppWhenRun = false

    @Parameter(title: "金額", description: "數字字串，例如 125.50；不含貨幣符號或千分位")
    var amount: String
    @Parameter(title: "幣別", default: "TWD")
    var currency: String
    @Parameter(title: "商家")
    var merchant: String
    @Parameter(title: "帳戶／卡片名稱", default: "信用卡")
    var account: String
    @Parameter(title: "交易時間")
    var transactionDate: Date?
    @Parameter(title: "來源識別碼", description: "若 Wallet 有穩定識別碼才填入；同一識別碼不可改變內容")
    var sourceReference: String?

    static var parameterSummary: some ParameterSummary {
        Summary("記錄 \(\.$merchant) 的 \(\.$currency) \(\.$amount) 消費") {
            \.$account
            \.$transactionDate
            \.$sourceReference
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let record = try IngestRecord.make(source: "apple_pay", reference: sourceReference ?? "",
                                           amount: amount, currency: currency, merchant: merchant,
                                           date: transactionDate ?? Date(), account: account)
        try await LocalStore.shared.append(record)
        return .result(dialog: "已儲存到手機帳本，連線後可同步到 Windows。")
    }
}

struct LedgerShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AddTransactionIntent(),
                    phrases: ["用 \(.applicationName) 記帳"],
                    shortTitle: "記錄消費", systemImageName: "creditcard")
    }
}
