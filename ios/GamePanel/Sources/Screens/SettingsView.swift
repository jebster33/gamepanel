import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: PanelSession
    @EnvironmentObject private var panels: PanelStore
    @State private var adding = false
    @State private var renaming: SavedPanel?
    @State private var newName = ""
    @State private var confirmSignOut = false

    var body: some View {
        List {
            Section("Panels") {
                ForEach(panels.panels) { panel in
                    Button {
                        Haptics.tap()
                        panels.select(panel.id)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(panel.name).foregroundStyle(Palette.bone)
                                Text("\(panel.username) · \(panel.baseURL.host ?? "")").font(.caption).foregroundStyle(Palette.moss)
                            }
                            Spacer()
                            if panel.id == panels.currentId { Image(systemName: "checkmark").foregroundStyle(Palette.lime) }
                        }
                    }
                    .listRowBackground(Palette.cell)
                    .swipeActions {
                        Button("Remove", role: .destructive) { panels.remove(panel.id) }
                        Button("Rename") { newName = panel.name; renaming = panel }.tint(Palette.amber)
                    }
                }
                Button { adding = true } label: { Label("Add a panel", systemImage: "plus") }
                    .listRowBackground(Palette.cell)
            }

            Section("This panel") {
                LabeledContent("Signed in as", value: session.user?.username ?? session.panel.username)
                LabeledContent("Address", value: session.panel.baseURL.absoluteString)
                LabeledContent("Live connection") { LiveBadge() }
                Link(destination: session.panel.baseURL) { Label("Open in Safari", systemImage: "safari") }
            }
            .listRowBackground(Palette.cell)

            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }
                    .listRowBackground(Palette.cell)
            } footer: {
                Text("Notifications appear under Alerts while the app is open. For alerts when it's closed, set up ntfy or Discord in the panel.")
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .navigationTitle("Settings")
        .sheet(isPresented: $adding) { NavigationStack { SignInView() } }
        .alert("Rename panel", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") { if let p = renaming, !newName.isEmpty { panels.rename(p.id, to: newName) } }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Sign out of \(session.panel.name)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                let id = session.panel.id
                Task {
                    await session.client.logout()
                    panels.remove(id)
                }
            }
        }
    }
}
