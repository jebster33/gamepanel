import SwiftUI

struct ServersView: View {
    @EnvironmentObject private var session: PanelSession
    @EnvironmentObject private var panels: PanelStore
    @State private var search = ""
    @State private var addingPanel = false

    private var shown: [GameServer] {
        let list = session.servers.sorted { a, b in
            // Running first, then whatever needs attention, then the rest by name.
            func rank(_ s: GameServer) -> Int { s.status == .running ? 0 : (s.status == .crashed || s.status == .installFailed) ? 1 : s.status.isActive ? 2 : 3 }
            return rank(a) != rank(b) ? rank(a) < rank(b) : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
        guard !search.isEmpty else { return list }
        return list.filter { $0.name.localizedCaseInsensitiveContains(search) || ($0.templateId ?? "").localizedCaseInsensitiveContains(search) }
    }

    private var onlineCount: Int { session.servers.filter { $0.status == .running }.reduce(0) { $0 + ($1.players ?? 0) } }

    var body: some View {
        List {
            Section {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(onlineCount)")
                            .font(.display(44, weight: .bold))
                            .contentTransition(.numericText())
                            .animation(.smooth, value: onlineCount)
                        Text(onlineCount == 1 ? "player online" : "players online")
                            .foregroundStyle(Palette.moss)
                    }
                    Spacer()
                    LiveBadge()
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4))
                .accessibilityElement(children: .combine)
            }

            if session.servers.isEmpty {
                EmptyNote(
                    title: session.connected || session.lastUpdate != nil ? "No servers yet" : "Connecting",
                    message: session.lastUpdate != nil ? "Create a server in the panel and it shows up here." : "Reaching \(session.panel.baseURL.host ?? "your panel")…",
                    systemImage: "server.rack"
                )
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(shown) { server in
                        NavigationLink(value: server.id) { ServerRow(server: server) }
                            .listRowBackground(Palette.cell)
                            .swipeActions(edge: .trailing) { swipeActions(server) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Find a server")
        .refreshable { await session.refresh() }
        .navigationDestination(for: String.self) { id in ServerDetailView(serverId: id) }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { PanelSwitcher(adding: $addingPanel) }
        }
        .sheet(isPresented: $addingPanel) { NavigationStack { SignInView() } }
    }

    @ViewBuilder
    private func swipeActions(_ server: GameServer) -> some View {
        if server.status.isActive {
            Button { Task { await session.power(server.id, "restart") } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                .tint(Palette.amber)
            Button { Task { await session.power(server.id, "stop") } } label: { Label("Stop", systemImage: "stop.fill") }
                .tint(Palette.ember)
        } else {
            Button { Task { await session.power(server.id, "start") } } label: { Label("Start", systemImage: "play.fill") }
                .tint(Palette.lime)
        }
    }
}

struct ServerRow: View {
    let server: GameServer

    var body: some View {
        HStack(spacing: 12) {
            StatusRing(status: server.status, size: 9)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(server.name)
                        .font(.display(18))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if server.status == .running, let players = server.players {
                        Text(server.maxPlayers.map { "\(players)/\($0)" } ?? "\(players)")
                            .font(.subheadline.monospacedDigit().weight(.medium))
                            .contentTransition(.numericText())
                    }
                }
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(server.status == .crashed ? Palette.ember : Palette.moss)
                    .lineLimit(1)
                if server.status == .running {
                    HStack(spacing: 10) {
                        UsageBar(fraction: (server.cpu ?? 0) / 100)
                        UsageBar(fraction: server.memoryFraction)
                    }
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityValue(server.status == .running ? "CPU \(Format.percent(server.cpu)), memory \(Format.bytes(server.memory))" : "")
    }

    private var subtitle: String {
        if let task = server.task { return task }
        if server.isAsleep { return "Asleep · starts when someone joins" }
        var parts = [server.status == .running ? nil : server.status.label]
        parts.append(server.templateId.map(Self.gameName))
        if let v = server.resolvedVersion { parts.append(v) }
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    static func gameName(_ template: String) -> String {
        template.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}

/// The current panel's name; tap to switch, add or manage panels.
struct PanelSwitcher: View {
    @EnvironmentObject private var panels: PanelStore
    @EnvironmentObject private var session: PanelSession
    @Binding var adding: Bool

    var body: some View {
        Menu {
            Section("Panels") {
                ForEach(panels.panels) { panel in
                    Button {
                        Haptics.tap()
                        panels.select(panel.id)
                    } label: {
                        if panel.id == panels.currentId { Label(panel.name, systemImage: "checkmark") } else { Text(panel.name) }
                    }
                }
            }
            Button { adding = true } label: { Label("Add a panel", systemImage: "plus") }
        } label: {
            HStack(spacing: 4) {
                Text(session.panel.name).font(.headline).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.moss)
            }
        }
        .accessibilityLabel("Panel: \(session.panel.name). Switch panel")
    }
}
