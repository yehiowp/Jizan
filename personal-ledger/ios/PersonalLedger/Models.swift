import Foundation

enum LedgerError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let message): return message }
    }
}

enum CurrencyRules {
    static let digits = ["TWD": 2, "USD": 2, "HKD": 2, "EUR": 2, "GBP": 2,
                         "CNY": 2, "JPY": 0, "KRW": 0, "SGD": 2, "AUD": 2,
                         "CAD": 2, "CHF": 2, "BHD": 3, "KWD": 3, "USDT": 6, "USDC": 6]
    static var supported: [String] { digits.keys.sorted() }

    static func validate(amount: String, currency: String) throws -> String {
        let value = amount.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let precision = digits[currency],
              value.range(of: #"^[0-9]+(?:\.[0-9]+)?$"#, options: .regularExpression) != nil,
              let number = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")),
              number > 0, number <= 1_000_000_000 else {
            throw LedgerError.message("請輸入大於 0、最多十億元的金額；小數點使用句點。")
        }
        let fraction = value.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first
        guard (fraction?.count ?? 0) <= precision else {
            throw LedgerError.message("\(currency) 最多支援 \(precision) 位小數，金額不會自動四捨五入。")
        }
        return NSDecimalNumber(decimal: number).stringValue
    }

    static func display(minor: Int64, currency: String, digits: [String: Int]) -> String {
        guard let precision = digits[currency] else { return "\(currency) \(minor)（最小單位）" }
        let divisor = pow(Decimal(10), precision)
        let value = Decimal(minor) / divisor
        return "\(currency) \(NSDecimalNumber(decimal: value).stringValue)"
    }
}

struct IngestRecord: Codable, Identifiable {
    let source: String
    let externalID: String
    let amount: String
    let currency: String
    let merchant: String
    let occurredAt: String
    let account: String
    let kind: String
    var id: String { source + ":" + externalID }

    enum CodingKeys: String, CodingKey {
        case source, amount, currency, merchant, account, kind
        case externalID = "external_id", occurredAt = "occurred_at"
    }

    static func make(source: String, reference: String = "", amount: String,
                     currency: String, merchant: String, date: Date,
                     account: String, kind: String = "expense") throws -> IngestRecord {
        let currency = currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let amount = try CurrencyRules.validate(amount: amount, currency: currency)
        let merchant = merchant.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = account.trimmingCharacters(in: .whitespacesAndNewlines)
        let reference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !merchant.isEmpty, merchant.count <= 200, !account.isEmpty, account.count <= 120,
              reference.count <= 200 else {
            throw LedgerError.message("請填寫商家與帳戶；商家及來源識別碼最多 200 字，帳戶最多 120 字。")
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return IngestRecord(source: source, externalID: reference.isEmpty ? UUID().uuidString : reference,
                            amount: amount, currency: currency, merchant: merchant,
                            occurredAt: formatter.string(from: date), account: account, kind: kind)
    }
}

struct QueuedRecord: Codable, Identifiable {
    let payload: IngestRecord
    var accepted = false
    var acceptedEntryID: String?
    var syncError: String?
    var id: String { payload.id }
}

struct ServerEntry: Codable, Identifiable {
    let id: String
    let amountMinor: Int64
    let currency: String
    let merchant: String?
    let occurredAt: String
    let status: String
    let kind: String
    enum CodingKeys: String, CodingKey {
        case id, currency, merchant, status, kind
        case amountMinor = "amount_minor", occurredAt = "occurred_at"
    }
    var statusLabel: String {
        switch status {
        case "verified": return "已核對"
        case "pending": return "待確認"
        default: return "尚未銀行核對"
        }
    }
}

struct ServerReview: Codable, Identifiable {
    let id: String
    let reason: String
    let entryID: String?
    let resolvedAt: String?
    let entry: ServerEntry?
    let source: ReviewSource?
    enum CodingKeys: String, CodingKey {
        case id, reason, entry, source
        case entryID = "entry_id", resolvedAt = "resolved_at"
    }
    var reasonLabel: String {
        ["amount_mismatch": "金額不一致", "currency_mismatch": "幣別不一致", "merchant_mismatch": "商家描述不同，需核對",
         "possible_duplicate": "疑似重複通知", "manual_confirmation": "需人工確認來源資料",
         "ambiguous_match": "有多筆候選交易", "time_uncertain": "交易時間不明確",
         "missing_entry": "尚未找到可核對的帳目"][reason] ?? reason
    }
}

struct ReviewSource: Codable {
    let amountMinor: Int64
    let currency: String
    let merchant: String?
    enum CodingKeys: String, CodingKey {
        case currency, merchant
        case amountMinor = "amount_minor"
    }
}

struct ServerPosition: Codable, Identifiable {
    let instrumentID: String
    let account: String
    let currency: String
    let symbol: String
    let market: String
    let quantityDecimal: String
    let costDecimal: String
    let priceDecimal: String?
    let quoteCurrency: String?
    let quoteAsOf: String?
    let valueDecimal: String?
    let unrealizedDecimal: String?
    var id: String { instrumentID + ":" + account + ":" + currency }
    enum CodingKeys: String, CodingKey {
        case account, currency, symbol, market
        case instrumentID = "instrument_id", quantityDecimal = "quantity_decimal", costDecimal = "cost_decimal"
        case priceDecimal = "price_decimal", quoteCurrency = "quote_currency", quoteAsOf = "quote_as_of"
        case valueDecimal = "value_decimal", unrealizedDecimal = "unrealized_decimal"
    }
}

struct SyncResult: Decodable {
    let source: String?
    let externalID: String?
    let ok: Bool
    let error: String?
    let result: IngestResult?
    enum CodingKeys: String, CodingKey {
        case source, ok, error, result
        case externalID = "external_id"
    }
}

struct IngestResult: Decodable {
    let entryID: String?
    enum CodingKeys: String, CodingKey { case entryID = "entry_id" }
}

struct SyncResponse: Decodable {
    let results: [SyncResult]
    let entries: [ServerEntry]
    let reviews: [ServerReview]
    let currencyDigits: [String: Int]
    let serverTime: String
    let portfolio: [ServerPosition]
    enum CodingKeys: String, CodingKey {
        case results, entries, reviews, portfolio
        case currencyDigits = "currency_digits", serverTime = "server_time"
    }
}

struct StoreState: Codable {
    var version = 1
    var records: [QueuedRecord] = []
    var entries: [ServerEntry] = []
    var reviews: [ServerReview] = []
    var portfolio: [ServerPosition] = []
    var currencyDigits = CurrencyRules.digits
    var endpoint = ""
    var allowUnencryptedLAN = false
    var lastSync: String?
    var pending: [QueuedRecord] { records.filter { !$0.accepted } }
}

func readableDate(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    return date?.formatted(date: .abbreviated, time: .shortened) ?? iso
}
