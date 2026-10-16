import ActivityKit
import Foundation

/// Shared by the app (which starts and updates activities) and the widget extension (which draws them).
/// Add this file to both targets when the extension is switched on.
struct ServerActivityAttributes: ActivityAttributes {
    enum Kind: String, Codable, Hashable { case pinned, task }

    struct ContentState: Codable, Hashable {
        var status: String          // ServerStatus raw value
        var players: Int?
        var maxPlayers: Int?
        var cpu: Double?
        var memoryFraction: Double?
        var task: String?           // "Backing up…", "Installing mods…"
        var progress: Double?       // 0...1 when the panel reports it, nil for an indeterminate ring
        var updated: Date
    }

    var serverId: String
    var serverName: String
    var panelName: String
    var kind: Kind
}
