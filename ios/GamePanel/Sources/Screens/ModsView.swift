import SwiftUI

struct ModsView: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var info: ModsResponse?
    @State private var browsing = false
    @State private var removing: InstalledMod?

    var body: some View {
        List {
            if let info, !info.supported {
                EmptyNote(title: "No mods for this game", message: "The panel can't add mods to \(ServerRow.gameName(server.templateId ?? "this game")).", systemImage: "puzzlepiece")
                    .listRowBackground(Color.clear)
            } else if let info {
                Section {
                    Button { browsing = true } label: {
                        Label("Find mods", systemImage: "magnifyingglass").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.lime)
                    .foregroundStyle(Palette.limeInk)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    if let filter = info.context?.filter { Text("Only shows what fits: \(filter).") }
                }

                Section("Installed · \(info.installed?.count ?? 0)") {
                    if (info.installed ?? []).isEmpty { Text("Nothing installed yet.").foregroundStyle(Palette.moss) }
                    ForEach(info.installed ?? []) { mod in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mod.title ?? mod.name).font(.body.weight(.medium)).opacity(mod.disabled == true ? 0.5 : 1)
                                Text([mod.version, mod.disabled == true ? "Off" : nil, Format.bytes(mod.size)].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(Palette.moss)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(get: { mod.disabled != true }, set: { _ in toggle(mod) }))
                                .labelsHidden()
                                .accessibilityLabel("\(mod.title ?? mod.name) enabled")
                        }
                        .listRowBackground(Palette.cell)
                        .swipeActions { Button("Remove", role: .destructive) { removing = mod } }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .task(id: server.id) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $browsing, onDismiss: { Task { await load() } }) {
            if let info { NavigationStack { ModBrowser(server: server, providers: info.providers) } }
        }
        .confirmationDialog("Remove \(removing?.title ?? "this mod")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let mod = removing else { return }
                Task {
                    do {
                        try await session.client.removeMod(server.id, name: mod.key ?? mod.name)
                        Haptics.success()
                        await load()
                    } catch { session.report(error) }
                }
            }
        } message: {
            Text("Dependencies nothing else needs go too.")
        }
    }

    private func load() async {
        do { info = try await session.client.mods(server.id) } catch { session.report(error) }
    }

    private func toggle(_ mod: InstalledMod) {
        Task {
            do {
                try await session.client.toggleMod(server.id, name: mod.key ?? mod.name)
                Haptics.tap()
                await load()
            } catch { session.report(error) }
        }
    }
}

struct ModBrowser: View {
    let server: GameServer
    let providers: [ModProvider]
    @EnvironmentObject private var session: PanelSession
    @Environment(\.dismiss) private var dismiss
    @State private var provider: ModProvider?
    @State private var query = ""
    @State private var results: [ModSearchItem] = []
    @State private var searching = false
    @State private var installing: String?
    @State private var installed = Set<String>()

    var body: some View {
        List {
            if providers.count > 1 {
                Picker("Source", selection: $provider) {
                    ForEach(providers) { Text($0.label).tag(Optional($0)) }
                }
                .listRowBackground(Palette.cell)
            }
            if searching && results.isEmpty { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            ForEach(results) { item in
                HStack(alignment: .top, spacing: 12) {
                    AsyncImage(url: item.icon.flatMap(URL.init(string:))) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Palette.ink2
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(.rect(cornerRadius: 10))
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.name).font(.body.weight(.semibold))
                        if let d = item.description { Text(d).font(.caption).foregroundStyle(Palette.moss).lineLimit(2) }
                        Text([item.author.map { "by \($0)" }, item.downloads.map { "\(Format.count($0)) downloads" }].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(Palette.faint)
                    }
                    Spacer(minLength: 0)
                    installButton(item)
                }
                .padding(.vertical, 4)
                .listRowBackground(Palette.cell)
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .navigationTitle("Find mods")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search \(provider?.label ?? "mods")")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .onAppear { if provider == nil { provider = providers.first } }
        .task(id: "\(provider?.id ?? "")|\(query)") {
            // Wait for typing to settle before searching.
            try? await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 350))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    private func installButton(_ item: ModSearchItem) -> some View {
        let done = item.installed == true || installed.contains(item.id)
        return Button {
            Task { await install(item) }
        } label: {
            Group {
                if installing == item.id { ProgressView().controlSize(.small) } else { Text(done ? "Added" : "Add").font(.subheadline.weight(.semibold)) }
            }
            .frame(minWidth: 56, minHeight: 34)
        }
        .buttonStyle(.glass)
        .disabled(done || installing != nil)
        .accessibilityLabel(done ? "\(item.name) installed" : "Install \(item.name)")
    }

    private func search() async {
        guard let provider else { return }
        searching = true
        defer { searching = false }
        do { results = try await session.client.searchMods(server.id, provider: provider.id, query: query).items } catch { session.report(error) }
    }

    private func install(_ item: ModSearchItem) async {
        guard let provider else { return }
        installing = item.id
        defer { installing = nil }
        do {
            try await session.client.installMod(server.id, provider: provider.id, projectId: item.id)
            installed.insert(item.id)
            Haptics.success()
            session.notify("Installed \(item.name)", server.status.isActive ? "Restart the server to load it." : server.name)
        } catch { session.report(error) }
    }
}
