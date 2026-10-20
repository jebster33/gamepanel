import SwiftUI

struct PlayersView: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var lists: [PlayerList] = []
    @State private var listsSupported = false
    @State private var adding: PlayerList?
    @State private var newName = ""
    @State private var confirm: (action: String, name: String)?

    private var online: [String] { server.playerList ?? [] }
    private var actions: [String] { server.playerCommands ?? [] }

    var body: some View {
        List {
            Section {
                if online.isEmpty {
                    Text(server.status == .running ? "Nobody is on right now." : "The server is stopped.")
                        .foregroundStyle(Palette.moss)
                }
                ForEach(online, id: \.self) { name in
                    HStack(spacing: 12) {
                        Avatar(name: name)
                        Text(name).font(.body.weight(.medium))
                        Spacer()
                        if !actions.isEmpty {
                            Menu {
                                ForEach(actions, id: \.self) { action in
                                    Button(role: action == "ban" || action == "kick" ? .destructive : nil) {
                                        confirm = (action, name)
                                    } label: { Text(action.capitalized) }
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle").font(.title3).foregroundStyle(Palette.moss).frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Actions for \(name)")
                        }
                    }
                    .listRowBackground(Palette.cell)
                }
            } header: {
                Text("Online now · \(online.count)")
            }

            if listsSupported {
                ForEach(lists) { list in
                    Section {
                        if list.entries.isEmpty { Text("Empty").foregroundStyle(Palette.faint) }
                        ForEach(list.entries) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.name)
                                if let reason = entry.reason, !reason.isEmpty {
                                    Text(reason).font(.caption).foregroundStyle(Palette.moss)
                                }
                            }
                            .listRowBackground(Palette.cell)
                            .swipeActions {
                                Button("Remove", role: .destructive) { change(list, add: false, entry.name) }
                            }
                        }
                        Button { adding = list } label: { Label("Add to \(list.label.lowercased())", systemImage: "plus") }
                            .listRowBackground(Palette.cell)
                    } header: {
                        HStack {
                            Text(list.label)
                            if let on = list.enabled { Text(on ? "· on" : "· off").foregroundStyle(on ? Palette.lime : Palette.faint) }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .refreshable { await loadLists() }
        .task(id: server.id) { await loadLists() }
        .alert("Add to \(adding?.label.lowercased() ?? "list")", isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } })) {
            TextField("Player name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Add") {
                if let list = adding { change(list, add: true, newName) }
                newName = ""
            }
            Button("Cancel", role: .cancel) { newName = "" }
        }
        .confirmationDialog(
            confirm.map { "\($0.action.capitalized) \($0.name)?" } ?? "",
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible
        ) {
            if let c = confirm {
                Button(c.action.capitalized, role: .destructive) {
                    Task {
                        do {
                            try await session.client.playerAction(server.id, action: c.action, name: c.name)
                            Haptics.success()
                        } catch { session.report(error) }
                    }
                }
            }
        }
    }

    private func loadLists() async {
        guard let response = try? await session.client.playerLists(server.id) else { return }
        listsSupported = response.supported
        lists = response.lists ?? []
    }

    private func change(_ list: PlayerList, add: Bool, _ name: String) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task {
            do {
                try await session.client.changeList(server.id, list: list.id, add: add, name: name)
                Haptics.success()
                await loadLists()
            } catch { session.report(error) }
        }
    }
}

/// A player's initial on a tint picked from their name, so the same player always looks the same.
struct Avatar: View {
    let name: String
    var body: some View {
        // hashValue changes every launch; this does not.
        let hue = Double(name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
        Text(String(name.prefix(1)).uppercased())
            .font(.callout.weight(.bold))
            .foregroundStyle(Palette.ink)
            .frame(width: 32, height: 32)
            .background(Color(hue: hue, saturation: 0.35, brightness: 0.9), in: .circle)
            .accessibilityHidden(true)
    }
}
