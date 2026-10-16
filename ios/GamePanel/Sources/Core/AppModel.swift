import Foundation
import SwiftUI
import Combine

/// Saved panels and which one is open. Panels are kept in UserDefaults; tokens in the Keychain.
@MainActor
final class PanelStore: ObservableObject {
    @Published private(set) var panels: [SavedPanel] = []
    @Published var currentId: UUID?

    private let key = "panels.v1"
    private let currentKey = "panels.current"

    init() {
        if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([SavedPanel].self, from: data) {
            panels = saved
        }
        if let raw = UserDefaults.standard.string(forKey: currentKey), let id = UUID(uuidString: raw), panels.contains(where: { $0.id == id }) {
            currentId = id
        } else {
            currentId = panels.first?.id
        }
    }

    var current: SavedPanel? { panels.first { $0.id == currentId } }

    func add(_ panel: SavedPanel, token: String) {
        Keychain.setToken(token, for: panel.id)
        panels.removeAll { $0.id == panel.id }
        panels.append(panel)
        select(panel.id)
        save()
    }

    func select(_ id: UUID) {
        currentId = id
        UserDefaults.standard.set(id.uuidString, forKey: currentKey)
    }

    func remove(_ id: UUID) {
        Keychain.removeToken(for: id)
        panels.removeAll { $0.id == id }
        if currentId == id { currentId = panels.first?.id }
        UserDefaults.standard.set(currentId?.uuidString, forKey: currentKey)
        save()
    }

    func rename(_ id: UUID, to name: String) {
        guard let i = panels.firstIndex(where: { $0.id == id }) else { return }
        panels[i].name = name
        save()
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(panels), forKey: key)
    }
}

/// Everything live about the open panel: its servers, consoles and notifications.
@MainActor
final class PanelSession: ObservableObject {
    let panel: SavedPanel
    let client: APIClient

    @Published var user: User?
    @Published var servers: [GameServer] = []
    @Published var consoles: [String: [ConsoleLine]] = [:]
    @Published var notifications: [PanelNotification] = []
    @Published var unread = 0
    @Published var connected = false
    @Published var lastUpdate: Date?
    @Published var signedOut = false
    @Published var toast: Toast?

    private var socket: LiveSocket?
    private var seenNotification: String?

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let message: String
        let level: String
    }

    init(panel: SavedPanel) {
        self.panel = panel
        client = APIClient(baseURL: panel.baseURL, token: Keychain.token(for: panel.id))
        seenNotification = UserDefaults.standard.string(forKey: "seen.\(panel.id.uuidString)")
    }

    func start() async {
        socket = LiveSocket(client: client) { [weak self] event in self?.handle(event) }
        socket?.start()
        await refresh()
    }

    func stop() {
        socket?.stop()
        socket = nil
    }

    func refresh() async {
        do {
            if user == nil { user = try await client.me() }
            servers = try await client.servers()
            lastUpdate = .now
            await loadNotifications()
        } catch let error as APIError where error.isSignedOut {
            signedOut = true
        } catch {
            connected = false
        }
    }

    func loadNotifications() async {
        guard let list = try? await client.notifications() else { return }
        let fresh = list.prefix { $0.id != seenNotification }
        // Pop up anything new that went wrong since the last look.
        if !notifications.isEmpty, let first = fresh.first(where: { $0.level != "info" }) {
            toast = Toast(title: first.title ?? "Panel", message: first.message, level: first.level)
        }
        notifications = list
        unread = fresh.count
    }

    func markRead() {
        unread = 0
        seenNotification = notifications.first?.id
        UserDefaults.standard.set(seenNotification, forKey: "seen.\(panel.id.uuidString)")
    }

    func server(_ id: String) -> GameServer? { servers.first { $0.id == id } }

    // MARK: Console

    func openConsole(_ id: String) async {
        socket?.subscribe("console:\(id)")
        if let lines = try? await client.console(id) { consoles[id] = Array(lines.suffix(800)) }
    }

    func closeConsole(_ id: String) {
        socket?.unsubscribe("console:\(id)")
    }

    // MARK: Actions

    func power(_ id: String, _ action: String) async {
        do {
            try await client.power(id, action)
            Haptics.success()
        } catch {
            report(error)
        }
    }

    func report(_ error: Error) {
        if let api = error as? APIError, api.isSignedOut { signedOut = true; return }
        Haptics.error()
        toast = Toast(title: "That didn't work", message: error.localizedDescription, level: "error")
    }

    func notify(_ title: String, _ message: String) {
        toast = Toast(title: title, message: message, level: "info")
    }

    // MARK: Live feed

    private func handle(_ event: LiveSocket.Event) {
        switch event {
        case .connected(let up):
            if up != connected { connected = up }
        case .servers(let list):
            servers = list
            lastUpdate = .now
        case .status(let server):
            if let i = servers.firstIndex(where: { $0.id == server.id }) {
                let before = servers[i].status
                servers[i] = server
                if before != .crashed && server.status == .crashed {
                    Haptics.error()
                    Task { await loadNotifications() }
                }
            }
            lastUpdate = .now
        case .stats(let patches):
            for patch in patches {
                if let i = servers.firstIndex(where: { $0.id == patch.id }) { servers[i].apply(patch) }
            }
            lastUpdate = .now
        case .console(let id, let lines, let cleared):
            var buffer = cleared ? [] : consoles[id] ?? []
            buffer.append(contentsOf: lines)
            if buffer.count > 800 { buffer.removeFirst(buffer.count - 800) }
            consoles[id] = buffer
        }
    }
}

enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
