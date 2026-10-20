import Foundation

/// What the Home Screen widget shows, written by the app into the shared App Group container.
struct WidgetSnapshot: Codable {
    struct Server: Codable {
        let id: String
        let name: String
        let status: String
        let players: Int?
    }

    let panelName: String
    let servers: [Server]
    let updated: Date

    static let appGroup = "group.com.jebster33.gamepanel"
    private static var url: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("widget.json")
    }

    static func load() -> WidgetSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    func save() {
        guard let url = Self.url, let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static let sample = WidgetSnapshot(panelName: "Home", servers: [
        Server(id: "a", name: "Survival SMP", status: "running", players: 12),
        Server(id: "b", name: "Rust Main", status: "offline", players: nil),
        Server(id: "c", name: "Valheim", status: "running", players: 3),
    ], updated: .now)
}
