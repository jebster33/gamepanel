import SwiftUI

struct FilesView: View {
    let server: GameServer
    let path: String
    @EnvironmentObject private var session: PanelSession
    @State private var items: [FileItem] = []
    @State private var loaded = false
    @State private var failed: String?

    var body: some View {
        List {
            if let failed {
                Text(failed).foregroundStyle(Palette.ember).listRowBackground(Color.clear)
            } else if loaded && items.isEmpty {
                Text("This folder is empty.").foregroundStyle(Palette.moss).listRowBackground(Color.clear)
            }
            ForEach(items) { item in
                Group {
                    if item.directory {
                        NavigationLink { FilesView(server: server, path: item.path).navigationTitle(item.name) } label: { row(item) }
                    } else if item.editable == true {
                        NavigationLink { FileEditor(server: server, item: item) } label: { row(item) }
                    } else {
                        row(item).foregroundStyle(Palette.moss)
                    }
                }
                .listRowBackground(Palette.cell)
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .safeAreaInset(edge: .top) {
            if !path.isEmpty {
                Text("/" + path)
                    .font(.caption.monospaced())
                    .foregroundStyle(Palette.moss)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
            }
        }
        .task(id: path) { await load() }
        .refreshable { await load() }
    }

    private func row(_ item: FileItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(item))
                .foregroundStyle(item.directory ? Palette.lime : Palette.moss)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).lineLimit(1)
                Text([item.directory ? nil : Format.bytes(item.size), item.modified.map { Format.relative(Date(timeIntervalSince1970: $0 / 1000)) }]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Palette.faint)
            }
        }
    }

    private func icon(_ item: FileItem) -> String {
        if item.directory { return "folder.fill" }
        let ext = (item.name as NSString).pathExtension.lowercased()
        switch ext {
        case "jar", "zip", "gz", "tar", "7z": return "shippingbox"
        case "json", "yml", "yaml", "toml", "properties", "cfg", "ini", "conf": return "slider.horizontal.3"
        case "log", "txt", "md": return "doc.text"
        case "png", "jpg", "jpeg": return "photo"
        default: return "doc"
        }
    }

    private func load() async {
        do {
            items = try await session.client.files(server.id, path: path).items
            failed = nil
            loaded = true
        } catch {
            failed = error.localizedDescription
        }
    }
}

struct FileEditor: View {
    let server: GameServer
    let item: FileItem
    @EnvironmentObject private var session: PanelSession
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var original = ""
    @State private var loading = true
    @State private var saving = false
    @State private var confirmDiscard = false

    private var changed: Bool { text != original }

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TextEditor(text: $text)
                    .font(.system(size: 13, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 8)
            }
        }
        .background(Palette.ink2.ignoresSafeArea())
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(changed)
        .toolbar {
            if changed {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { confirmDiscard = true }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(!changed || saving)
                    .fontWeight(.semibold)
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
        }
        .task {
            do {
                let file = try await session.client.readFile(server.id, path: item.path)
                text = file.content
                original = file.content
            } catch {
                session.report(error)
            }
            loading = false
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await session.client.writeFile(server.id, path: item.path, content: text)
            original = text
            Haptics.success()
            session.notify("Saved", item.name + (server.status.isActive ? " · restart the server for it to take effect" : ""))
        } catch { session.report(error) }
    }
}
