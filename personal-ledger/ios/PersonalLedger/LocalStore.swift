import Foundation
import Security

/// The App Intent is in the main application target, so it shares this actor and sandbox.
/// Each operation rereads the file. A failed read is surfaced; it never resets the ledger.
actor LocalStore {
    static let shared = LocalStore()

    private func fileURL() throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory,
                                                  in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("PersonalLedger", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return directory.appendingPathComponent("ledger-v1.json")
    }

    func read() throws -> StoreState {
        let url = try fileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return StoreState() }
        let state = try JSONDecoder().decode(StoreState.self, from: Data(contentsOf: url))
        guard state.version == 1 else { throw LedgerError.message("帳本版本不相容，請先更新 App。") }
        return state
    }

    private func write(_ state: StoreState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(state).write(to: fileURL(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func append(_ record: IngestRecord) throws {
        var state = try read()
        if let previous = state.records.first(where: { $0.id == record.id }) {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            guard try encoder.encode(previous.payload) == encoder.encode(record) else {
                throw LedgerError.message("相同來源識別碼已有不同內容，請檢查捷徑設定。")
            }
            return
        }
        state.records.append(QueuedRecord(payload: record))
        try write(state)
    }

    func configure(endpoint: String, allowUnencrypted: Bool) throws {
        var state = try read()
        state.endpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        state.allowUnencryptedLAN = allowUnencrypted
        try write(state)
    }

    func apply(_ response: SyncResponse, sent: [IngestRecord]) throws {
        // Reread to preserve records an App Intent added while the request was in flight.
        var state = try read()
        for payload in sent {
            guard let index = state.records.firstIndex(where: { $0.id == payload.id }),
                  let result = response.results.first(where: { $0.externalID == payload.externalID && $0.source == payload.source }) else { continue }
            state.records[index].accepted = result.ok
            state.records[index].acceptedEntryID = result.result?.entryID
            state.records[index].syncError = result.ok ? nil : (result.error ?? "Windows 未接受此紀錄")
        }
        state.entries = response.entries
        state.reviews = response.reviews
        state.portfolio = response.portfolio
        state.currencyDigits = response.currencyDigits
        state.lastSync = response.serverTime
        try write(state)
    }

    func exportURL() throws -> URL {
        // Export the actual protected local ledger; the pairing token is only in Keychain.
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("個人帳本備份.json")
        try JSONEncoder().encode(read()).write(to: destination,
                                              options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return destination
    }
}

enum PairingKeychain {
    private static let service = "PersonalLedger.Pairing"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "windows"]
    }
    static func read() throws -> String {
        var parameters = query
        parameters[kSecReturnData as String] = true
        parameters[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(parameters as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw LedgerError.message("無法讀取鑰匙圈配對碼（\(status)）。")
        }
        return value
    }
    static func save(_ value: String) throws {
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count >= 32, token.count <= 256,
              token.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw LedgerError.message("請貼上 Windows 產生的完整配對碼。")
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var new = query
            attributes.forEach { new[$0.key] = $0.value }
            let added = SecItemAdd(new as CFDictionary, nil)
            guard added == errSecSuccess else { throw LedgerError.message("無法儲存配對碼（\(added)）。") }
        } else if status != errSecSuccess {
            throw LedgerError.message("無法儲存配對碼（\(status)）。")
        }
    }
}
