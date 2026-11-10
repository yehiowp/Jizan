import Foundation

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum SyncClient {
    /// v1 deliberately accepts only a manually entered private IPv4 address.
    /// Restricting the literal host also avoids DNS rebinding and public redirects.
    static func endpoint(_ text: String, allowUnencrypted: Bool) throws -> URL {
        guard let parts = URLComponents(string: text), let scheme = parts.scheme,
              ["http", "https"].contains(scheme), let host = parts.host,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let url = parts.url else {
            throw LedgerError.message("電腦位址格式例如 http://192.168.1.10:8765，請勿加上路徑。")
        }
        let components = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = components.compactMap { Int($0) }
        guard components.count == 4, octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }),
              zip(components, octets).allSatisfy({ String($0.0) == String($0.1) }),
              octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) ||
                (octets[0] == 192 && octets[1] == 168) || octets[0] == 127 else {
            throw LedgerError.message("目前僅支援家中區域網路的 IPv4 位址。")
        }
        if scheme == "http" && !allowUnencrypted {
            throw LedgerError.message("HTTP 未加密，請先在同步設定勾選僅於可信任的家中 Wi-Fi 使用。")
        }
        return url.appendingPathComponent("v1/sync")
    }

    static func synchronize(state: StoreState, token: String) async throws -> (SyncResponse, [IngestRecord]) {
        let url = try endpoint(state.endpoint, allowUnencrypted: state.allowUnencryptedLAN)
        guard !token.isEmpty else { throw LedgerError.message("請先輸入 Windows 配對碼。") }
        // A bounded batch; subsequent taps send the next 500. Snapshot refresh also works with [].
        let sent = Array(state.pending.prefix(500).map(\.payload))
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["records": sent])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw LedgerError.message("Windows 未傳回有效回應，手機紀錄仍保留待同步。")
        }
        guard response.statusCode == 200 else {
            if response.statusCode == 401 { throw LedgerError.message("配對碼不符，請重新確認 Windows 的配對碼。") }
            throw LedgerError.message("同步失敗（HTTP \(response.statusCode)）；手機紀錄仍保留待同步。")
        }
        guard data.count <= 8 * 1024 * 1024 else { throw LedgerError.message("帳本回應超過目前支援大小。") }
        return (try JSONDecoder().decode(SyncResponse.self, from: data), sent)
    }
}
