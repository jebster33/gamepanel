import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
    var isSignedOut: Bool { status == 401 }
}

/// Talks to one panel. The session token goes out as the panel's own `gp_session` cookie,
/// which both the REST API and the `/ws` upgrade accept. Native requests send no Origin
/// header, so the panel's CSRF check lets them through.
final class APIClient {
    let baseURL: URL
    var token: String?

    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        // The token is managed here and in the Keychain, not in a shared cookie jar.
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: Requests

    func request(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("gp_session=\(token)", forHTTPHeaderField: "Cookie") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    @discardableResult
    func send(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request(method, path, query: query, body: body))
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "No response from the panel") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError(status: http.statusCode, message: message ?? "The panel answered \(http.statusCode)")
        }
        return (data, http)
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type = T.self) async throws -> T {
        let (data, _) = try await send("GET", path, query: query)
        return try decoder.decode(T.self, from: data)
    }

    func post<T: Decodable>(_ path: String, body: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
        let (data, _) = try await send("POST", path, body: body)
        return try decoder.decode(T.self, from: data)
    }

    func post(_ path: String, body: [String: Any] = [:]) async throws {
        try await send("POST", path, body: body)
    }

    // MARK: Sign in

    enum LoginResult {
        case signedIn(User, token: String)
        case needsCode(ticket: String)
    }

    private struct LoginBody: Decodable {
        let twoFactor: Bool?
        let ticket: String?
        let user: User?
    }

    func login(username: String, password: String) async throws -> LoginResult {
        try await finish(send("POST", "/api/auth/login", body: ["username": username, "password": password]))
    }

    func loginCode(ticket: String, code: String) async throws -> LoginResult {
        try await finish(send("POST", "/api/auth/login/2fa", body: ["ticket": ticket, "code": code]))
    }

    private func finish(_ result: (Data, HTTPURLResponse)) throws -> LoginResult {
        let body = try decoder.decode(LoginBody.self, from: result.0)
        if body.twoFactor == true, let ticket = body.ticket { return .needsCode(ticket: ticket) }
        guard let user = body.user, let token = Self.sessionToken(from: result.1) else {
            throw APIError(status: 0, message: "The panel signed you in but sent no session. Update the panel and try again.")
        }
        self.token = token
        return .signedIn(user, token: token)
    }

    static func sessionToken(from response: HTTPURLResponse) -> String? {
        guard let header = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        for part in header.split(separator: ";") {
            let pair = part.trimmingCharacters(in: .whitespaces)
            if pair.hasPrefix("gp_session=") { return String(pair.dropFirst("gp_session=".count)) }
        }
        return nil
    }

    func logout() async {
        _ = try? await send("POST", "/api/auth/logout")
    }

    // MARK: Endpoints

    private struct ServersBody: Decodable { let servers: [GameServer] }
    private struct MeBody: Decodable { let user: User }
    private struct LinesBody: Decodable { let lines: [ConsoleLine] }
    private struct HistoryBody: Decodable { let history: [MetricPoint] }
    private struct NotificationsBody: Decodable { let notifications: [PanelNotification] }

    func me() async throws -> User { try await get("/api/auth/me", as: MeBody.self).user }
    func servers() async throws -> [GameServer] { try await get("/api/servers", as: ServersBody.self).servers }
    func power(_ id: String, _ action: String) async throws { try await post("/api/servers/\(id)/power", body: ["action": action]) }
    func command(_ id: String, _ command: String) async throws { try await post("/api/servers/\(id)/command", body: ["command": command]) }
    func console(_ id: String) async throws -> [ConsoleLine] { try await get("/api/servers/\(id)/console", as: LinesBody.self).lines }
    func history(_ id: String, range: MetricRange) async throws -> [MetricPoint] {
        try await get("/api/servers/\(id)/history", query: ["range": range.rawValue], as: HistoryBody.self).history
    }

    func playerAction(_ id: String, action: String, name: String) async throws {
        try await post("/api/servers/\(id)/players/action", body: ["action": action, "name": name])
    }
    func playerLists(_ id: String) async throws -> PlayerListsResponse { try await get("/api/servers/\(id)/player-lists") }
    func changeList(_ id: String, list: String, add: Bool, name: String) async throws {
        try await post("/api/servers/\(id)/player-lists", body: ["list": list, "action": add ? "add" : "remove", "name": name])
    }

    func backups(_ id: String) async throws -> BackupsResponse { try await get("/api/servers/\(id)/backups") }
    func createBackup(_ id: String, label: String) async throws { try await post("/api/servers/\(id)/backups", body: ["label": label]) }
    /// Always takes a safety backup of the current files first.
    func restoreBackup(_ id: String, name: String) async throws {
        try await post("/api/servers/\(id)/backups/\(escape(name))/restore", body: ["backupFirst": true])
    }
    func deleteBackup(_ id: String, name: String) async throws { try await send("DELETE", "/api/servers/\(id)/backups/\(escape(name))") }

    func files(_ id: String, path: String) async throws -> FileListing { try await get("/api/servers/\(id)/files", query: ["path": path]) }
    func readFile(_ id: String, path: String) async throws -> FileContent { try await get("/api/servers/\(id)/files/content", query: ["path": path]) }
    func writeFile(_ id: String, path: String, content: String) async throws {
        var req = request("PUT", "/api/servers/\(id)/files/content", query: ["path": path], body: ["content": content])
        req.timeoutInterval = 60
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError(status: http.statusCode, message: message ?? "Saving failed (\(http.statusCode))")
        }
    }

    func mods(_ id: String) async throws -> ModsResponse { try await get("/api/servers/\(id)/mods") }
    func searchMods(_ id: String, provider: String, query: String) async throws -> ModSearchResponse {
        try await get("/api/servers/\(id)/mods/search", query: ["provider": provider, "query": query])
    }
    func installMod(_ id: String, provider: String, projectId: String) async throws {
        try await post("/api/servers/\(id)/mods/install", body: ["provider": provider, "projectId": projectId])
    }
    func toggleMod(_ id: String, name: String) async throws { try await post("/api/servers/\(id)/mods/\(escape(name))/toggle") }
    func removeMod(_ id: String, name: String) async throws { try await send("DELETE", "/api/servers/\(id)/mods/\(escape(name))") }

    func notifications() async throws -> [PanelNotification] { try await get("/api/notifications", as: NotificationsBody.self).notifications }

    private func escape(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? segment
    }

    // MARK: Live socket

    func socketRequest() -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent("/ws"), resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        var req = URLRequest(url: components.url!)
        if let token { req.setValue("gp_session=\(token)", forHTTPHeaderField: "Cookie") }
        return req
    }

    func webSocket() -> URLSessionWebSocketTask { session.webSocketTask(with: socketRequest()) }
}
