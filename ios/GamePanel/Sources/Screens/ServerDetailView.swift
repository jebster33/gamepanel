import SwiftUI

struct ServerDetailView: View {
    let serverId: String
    @EnvironmentObject private var session: PanelSession
    @State private var section = Section.console
    @State private var confirmKill = false

    enum Section: String, CaseIterable, Identifiable {
        case console = "Console", players = "Players", graphs = "Graphs", backups = "Backups", files = "Files", mods = "Mods"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .console: "terminal"
            case .players: "person.2"
            case .graphs: "chart.xyaxis.line"
            case .backups: "clock.arrow.circlepath"
            case .files: "folder"
            case .mods: "puzzlepiece.extension"
            }
        }
    }

    var body: some View {
        if let server = session.server(serverId) {
            VStack(spacing: 0) {
                header(server)
                sectionPicker
                content(server)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(server.name).font(.headline).opacity(0) // the header carries the name
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(role: .destructive) { confirmKill = true } label: { Label("Force stop", systemImage: "bolt.slash") }
                            .disabled(!server.status.isActive)
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("More actions")
                }
            }
            .confirmationDialog("Force stop \(server.name)?", isPresented: $confirmKill, titleVisibility: .visible) {
                Button("Force stop", role: .destructive) { Task { await session.power(server.id, "kill") } }
            } message: {
                Text("The server is killed without saving. Players lose anything since the last save.")
            }
        } else {
            EmptyNote(title: "Server not found", message: "It may have been deleted, or your access to it changed.", systemImage: "questionmark.folder")
        }
    }

    // MARK: Header

    private func header(_ server: GameServer) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 10) {
                StatusRing(status: server.status, size: 11)
                Text(server.task ?? (server.isAsleep ? "Asleep" : server.status.label))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.status(server.status))
                if let up = Format.uptime(server.uptime), server.status == .running {
                    Text("up \(up)").font(.subheadline).foregroundStyle(Palette.moss)
                }
                Spacer()
            }

            HStack(alignment: .lastTextBaseline, spacing: 12) {
                Text(server.name)
                    .font(.display(34, weight: .bold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 0)
                if server.status == .running, let players = server.players {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("\(players)")
                            .font(.display(34, weight: .bold))
                            .contentTransition(.numericText())
                            .animation(.smooth, value: players)
                        Text(server.maxPlayers.map { "of \($0) players" } ?? "players").font(.caption).foregroundStyle(Palette.moss)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            if server.status == .running {
                HStack(spacing: 18) {
                    stat("CPU", Format.percent(server.cpu), (server.cpu ?? 0) / 100)
                    stat("Memory", Format.bytes(server.memory), server.memoryFraction)
                    if let tps = server.tps { stat("TPS", String(format: "%.1f", tps), tps / 20) }
                }
            }

            PowerBar(server: server)
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 14)
    }

    private func stat(_ label: String, _ value: String, _ fraction: Double?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(label).font(.caption).foregroundStyle(Palette.moss)
                Text(value).font(.caption.monospacedDigit().weight(.semibold))
            }
            UsageBar(fraction: fraction)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: Sections

    private var sectionPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    ForEach(Section.allCases) { item in
                        Button {
                            Haptics.tap()
                            withAnimation(.snappy) { section = item }
                        } label: {
                            Label(item.rawValue, systemImage: item.icon)
                                .font(.subheadline.weight(section == item ? .semibold : .regular))
                                .foregroundStyle(section == item ? Palette.limeInk : Palette.bone)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 36)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(section == item ? .regular.tint(Palette.lime).interactive() : .regular.interactive(), in: .capsule)
                        .accessibilityAddTraits(section == item ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }
        }
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func content(_ server: GameServer) -> some View {
        switch section {
        case .console: ConsoleView(server: server)
        case .players: PlayersView(server: server)
        case .graphs: GraphsView(server: server)
        case .backups: BackupsView(server: server)
        case .files: FilesView(server: server, path: "")
        case .mods: ModsView(server: server)
        }
    }
}

/// Start / stop / restart as one row of glass capsules that melt together.
struct PowerBar: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var pending: String?

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                if server.status.isActive {
                    button("Restart", "arrow.clockwise", "restart", prominent: false)
                    button("Stop", "stop.fill", "stop", prominent: false, tint: Palette.ember)
                } else {
                    button(server.status == .crashed ? "Start again" : "Start", "play.fill", "start", prominent: true)
                }
            }
        }
        .disabled(server.status == .installing || server.status == .stopping || pending != nil)
        .animation(.spring(duration: 0.4, bounce: 0.2), value: server.status.isActive)
    }

    private func button(_ title: String, _ icon: String, _ action: String, prominent: Bool, tint: Color? = nil) -> some View {
        Button {
            pending = action
            Task {
                await session.power(server.id, action)
                pending = nil
            }
        } label: {
            HStack(spacing: 8) {
                if pending == action { ProgressView().controlSize(.small) } else { Image(systemName: icon) }
                Text(title).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(prominent ? Palette.limeInk : (tint ?? Palette.bone))
        }
        .buttonStyle(.plain)
        .glassEffect(prominent ? .regular.tint(Palette.lime).interactive() : .regular.interactive(), in: .capsule)
    }
}
