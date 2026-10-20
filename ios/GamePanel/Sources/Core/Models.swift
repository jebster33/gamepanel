import Foundation

// Shapes match what the panel's API returns (server/api/routes, server/servers/manager.js publicServer).
// Every field the panel can leave out or send as null is optional.

struct User: Codable, Equatable {
    let id: String
    let username: String
    let role: String?
}

enum ServerStatus: String, Codable {
    case offline, installing, starting, running, stopping, crashed
    case installFailed = "install_failed"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ServerStatus(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .offline: "Offline"
        case .installing: "Installing"
        case .installFailed: "Install failed"
        case .starting: "Starting"
        case .running: "Running"
        case .stopping: "Stopping"
        case .crashed: "Crashed"
        case .unknown: "Unknown"
        }
    }

    var isActive: Bool { self == .running || self == .starting || self == .stopping }
}

struct WakeInfo: Codable, Equatable {
    let asleep: Bool?
}

struct GameServer: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var templateId: String?
    var status: ServerStatus
    var cpu: Double?
    var memory: Double?
    var memoryLimit: Double?
    var players: Int?
    var maxPlayers: Int?
    var playerList: [String]?
    var playerCommands: [String]?
    var playerLists: [String]?
    var uptime: Double?
    var tps: Double?
    var ping: Double?
    var task: String?
    var resolvedVersion: String?
    var node: String?
    var wake: WakeInfo?

    var isAsleep: Bool { wake?.asleep == true && status == .offline }

    var memoryFraction: Double? {
        guard let used = memory, let cap = memoryLimit, cap > 0 else { return nil }
        return min(1, used / cap)
    }

    /// `stats` messages carry only the live numbers; fold them in.
    mutating func apply(_ patch: StatsPatch) {
        if let v = patch.status { status = v }
        if let v = patch.cpu { cpu = v }
        if let v = patch.memory { memory = v }
        if let v = patch.memoryLimit { memoryLimit = v }
        if patch.players != nil { players = patch.players }
        if let v = patch.maxPlayers { maxPlayers = v }
        if let v = patch.tps { tps = v }
        if let v = patch.ping { ping = v }
    }
}

struct StatsPatch: Codable {
    let id: String
    let status: ServerStatus?
    let cpu: Double?
    let memory: Double?
    let memoryLimit: Double?
    let players: Int?
    let maxPlayers: Int?
    let tps: Double?
    let ping: Double?
}

struct ConsoleLine: Codable, Identifiable, Equatable {
    let seq: Int
    let at: Double?
    let stream: String?
    let line: String
    var id: Int { seq }

    var kind: Kind {
        switch stream {
        case "stderr": return .error
        case "system": return .system
        case "input": return .input
        default:
            let lower = line.lowercased()
            if lower.contains("error") || lower.contains("exception") { return .error }
            if lower.contains("warn") { return .warning }
            return .normal
        }
    }

    enum Kind { case normal, warning, error, system, input }
}

struct MetricPoint: Codable, Identifiable {
    let t: Double
    let cpu: Double?
    let mem: Double?
    let players: Int?
    let ping: Double?
    var id: Double { t }
    var date: Date { Date(timeIntervalSince1970: t / 1000) }
}

enum MetricRange: String, CaseIterable, Identifiable {
    case hour = "1h", day = "24h", week = "7d", month = "30d"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .hour: "Hour"
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        }
    }
}

struct PlayerListEntry: Codable, Identifiable, Equatable {
    let name: String
    let reason: String?
    var id: String { name }
}

struct PlayerList: Codable, Identifiable {
    let id: String
    let label: String
    let entries: [PlayerListEntry]
    let enabled: Bool?
}

struct PlayerListsResponse: Codable {
    let supported: Bool
    let lists: [PlayerList]?
}

struct Backup: Codable, Identifiable, Equatable {
    let name: String
    let size: Double?
    let createdAt: Double
    let kind: String?
    let label: String?
    var id: String { name }
    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

struct BackupsResponse: Codable {
    let backups: [Backup]
    let retention: Int?
}

struct FileItem: Codable, Identifiable, Equatable {
    let name: String
    let path: String
    let directory: Bool
    let size: Double?
    let modified: Double?
    let editable: Bool?
    var id: String { path }
}

struct FileListing: Codable {
    let path: String
    let items: [FileItem]
}

struct FileContent: Codable {
    let path: String
    let content: String
}

struct ModProvider: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let needsKey: Bool?
}

struct ModContext: Codable {
    let loaderLabel: String?
    let gameVersion: String?
    let filter: String?
}

struct InstalledMod: Codable, Identifiable, Equatable {
    let name: String
    let title: String?
    let size: Double?
    let key: String?
    let version: String?
    let disabled: Bool?
    var id: String { key ?? name }
}

struct ModsResponse: Codable {
    let supported: Bool
    let providers: [ModProvider]
    let context: ModContext?
    let installed: [InstalledMod]?
    let running: Bool?
}

struct ModSearchItem: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let author: String?
    let description: String?
    let downloads: Double?
    let icon: String?
    let installed: Bool?

    enum CodingKeys: String, CodingKey { case id, name, author, description, downloads, icon, installed }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Some providers use numeric ids.
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int.self, forKey: .id)) }
        name = try c.decode(String.self, forKey: .name)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        downloads = try c.decodeIfPresent(Double.self, forKey: .downloads)
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        installed = try c.decodeIfPresent(Bool.self, forKey: .installed)
    }
}

struct ModSearchResponse: Codable {
    let total: Int?
    let items: [ModSearchItem]
}

struct PanelNotification: Codable, Identifiable, Equatable {
    let id: String
    let type: String
    let title: String?
    let message: String
    let serverId: String?
    let at: Double
    let level: String
    var date: Date { Date(timeIntervalSince1970: at / 1000) }

    enum CodingKeys: String, CodingKey { case id, type, title, message, serverId, at, level }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int.self, forKey: .id)) }
        type = try c.decode(String.self, forKey: .type)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        message = try c.decode(String.self, forKey: .message)
        serverId = try c.decodeIfPresent(String.self, forKey: .serverId)
        at = try c.decode(Double.self, forKey: .at)
        level = try c.decode(String.self, forKey: .level)
    }
}

/// One panel the user has signed in to. The session token lives in the Keychain, not here.
struct SavedPanel: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    var name: String
    var baseURL: URL
    var username: String
}
