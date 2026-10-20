import ActivityKit
import Foundation
import WidgetKit

/// App-side half: starts, updates and ends Live Activities and writes the widget snapshot.
/// Move this file into ios/GamePanel/Sources when the extension is switched on, then call
/// `LiveActivities.shared.sync(session)` wherever PanelSession updates its servers.
@MainActor
final class LiveActivities {
    static let shared = LiveActivities()

    /// Servers the user pinned to the Dynamic Island.
    var pinned: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: "pinned") ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: "pinned") }
    }

    func sync(_ session: PanelSession) {
        let now = Date()
        for server in session.servers {
            let state = ServerActivityAttributes.ContentState(
                status: server.status.rawValue,
                players: server.players,
                maxPlayers: server.maxPlayers,
                cpu: server.cpu,
                memoryFraction: server.memoryFraction,
                task: server.task,
                progress: nil,
                updated: now
            )
            update(kind: .pinned, server: server, session: session, state: state, wanted: pinned.contains(server.id))
            update(kind: .task, server: server, session: session, state: state, wanted: server.task != nil)
        }

        WidgetSnapshot(
            panelName: session.panel.name,
            servers: session.servers.map { .init(id: $0.id, name: $0.name, status: $0.status.rawValue, players: $0.players) },
            updated: now
        ).save()
        WidgetCenter.shared.reloadTimelines(ofKind: "ServerStatus")
    }

    private func update(kind: ServerActivityAttributes.Kind, server: GameServer, session: PanelSession, state: ServerActivityAttributes.ContentState, wanted: Bool) {
        let existing = Activity<ServerActivityAttributes>.activities.first { $0.attributes.serverId == server.id && $0.attributes.kind == kind }
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(300))
        switch (existing, wanted) {
        case (nil, true):
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            let attributes = ServerActivityAttributes(serverId: server.id, serverName: server.name, panelName: session.panel.name, kind: kind)
            _ = try? Activity.request(attributes: attributes, content: content)
        case (let activity?, true):
            Task { await activity.update(content) }
        case (let activity?, false):
            Task { await activity.end(content, dismissalPolicy: kind == .task ? .after(.now.addingTimeInterval(8)) : .immediate) }
        case (nil, false):
            break
        }
    }
}
