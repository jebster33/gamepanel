import SwiftUI

struct BackupsView: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var backups: [Backup] = []
    @State private var loaded = false
    @State private var making = false
    @State private var restoring: Backup?
    @State private var deleting: Backup?
    @State private var busy: String?

    var body: some View {
        List {
            Section {
                Button {
                    Task { await make() }
                } label: {
                    HStack {
                        if making { ProgressView().tint(Palette.limeInk) } else { Image(systemName: "plus") }
                        Text(making ? "Backing up…" : "Back up now").fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.lime)
                .foregroundStyle(Palette.limeInk)
                .disabled(making)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            if loaded && backups.isEmpty {
                Text("No backups yet. The first one takes a copy of everything in the server folder.")
                    .foregroundStyle(Palette.moss)
                    .listRowBackground(Color.clear)
            }

            Section {
                ForEach(backups) { backup in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(backup.label?.isEmpty == false ? backup.label! : backup.date.formatted(date: .abbreviated, time: .shortened))
                                .font(.body.weight(.medium))
                            Text([Format.relative(backup.date), Format.bytes(backup.size), backup.kind == "incremental" ? "Incremental" : nil]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Palette.moss)
                        }
                        Spacer()
                        if busy == backup.name { ProgressView() }
                    }
                    .listRowBackground(Palette.cell)
                    .swipeActions(edge: .trailing) {
                        Button("Delete", role: .destructive) { deleting = backup }
                        Button("Restore") { restoring = backup }.tint(Palette.amber)
                    }
                    .contextMenu {
                        Button { restoring = backup } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                        Button(role: .destructive) { deleting = backup } label: { Label("Delete", systemImage: "trash") }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .task(id: server.id) { await load() }
        .refreshable { await load() }
        .confirmationDialog("Restore this backup?", isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }), titleVisibility: .visible) {
            Button("Restore", role: .destructive) {
                if let b = restoring { run(b, "Restored", { try await session.client.restoreBackup(server.id, name: b.name) }) }
            }
        } message: {
            Text(server.status.isActive
                 ? "Stop the server first. Restoring needs it stopped."
                 : "The server's files go back to how they were then. A backup of the current files is made first.")
        }
        .confirmationDialog("Delete this backup?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let b = deleting { run(b, "Deleted", { try await session.client.deleteBackup(server.id, name: b.name) }) }
            }
        } message: {
            Text("It can't be brought back.")
        }
    }

    private func load() async {
        do {
            backups = try await session.client.backups(server.id).backups
            loaded = true
        } catch { session.report(error) }
    }

    private func make() async {
        making = true
        defer { making = false }
        do {
            try await session.client.createBackup(server.id, label: "")
            Haptics.success()
            session.notify("Backed up", server.name)
            await load()
        } catch { session.report(error) }
    }

    private func run(_ backup: Backup, _ done: String, _ work: @escaping () async throws -> Void) {
        busy = backup.name
        Task {
            defer { busy = nil }
            do {
                try await work()
                Haptics.success()
                session.notify(done, backup.label ?? backup.date.formatted(date: .abbreviated, time: .shortened))
                await load()
            } catch { session.report(error) }
        }
    }
}
