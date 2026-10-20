import SwiftUI

struct AlertsView: View {
    @EnvironmentObject private var session: PanelSession

    var body: some View {
        List {
            if session.notifications.isEmpty {
                EmptyNote(title: "All quiet", message: "Crashes, finished installs and backups show up here.", systemImage: "bell.slash")
                    .listRowBackground(Color.clear)
            }
            ForEach(session.notifications) { item in
                Group {
                    if let id = item.serverId, session.server(id) != nil {
                        NavigationLink(value: id) { row(item) }
                    } else {
                        row(item)
                    }
                }
                .listRowBackground(Palette.cell)
            }
        }
        .listStyle(.insetGrouped)
        .panelBackground()
        .navigationTitle("Alerts")
        .navigationDestination(for: String.self) { id in ServerDetailView(serverId: id) }
        .refreshable { await session.loadNotifications() }
        .onAppear { session.markRead() }
        .onChange(of: session.notifications) { _, _ in session.markRead() }
    }

    private func row(_ item: PanelNotification) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.level == "error" ? "exclamationmark.octagon.fill" : item.level == "warn" ? "exclamationmark.triangle.fill" : "checkmark.circle")
                .foregroundStyle(item.level == "error" ? Palette.ember : item.level == "warn" ? Palette.amber : Palette.moss)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                if let title = item.title { Text(title).font(.subheadline.weight(.semibold)) }
                Text(item.message).font(.subheadline).foregroundStyle(item.title == nil ? Palette.bone : Palette.moss)
                Text(Format.relative(item.date)).font(.caption).foregroundStyle(Palette.faint)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
