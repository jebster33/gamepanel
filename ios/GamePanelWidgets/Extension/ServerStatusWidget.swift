import SwiftUI
import WidgetKit

/// Home Screen widget. The app writes a snapshot to the shared App Group whenever its server
/// list changes (see Shared/WidgetSnapshot.swift); the widget only reads it, so it needs no network or token.
struct ServerStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ServerStatus", provider: SnapshotProvider()) { entry in
            ServerStatusWidgetView(entry: entry)
                .containerBackground(Color(red: 0.05, green: 0.055, blue: 0.047), for: .widget)
        }
        .configurationDisplayName("Servers")
        .description("Which servers are up and who's on.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: .sample) }
    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: WidgetSnapshot.load() ?? .sample))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        // The app reloads timelines when it writes a new snapshot; this is only the fallback.
        completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: WidgetSnapshot.load())], policy: .after(.now.addingTimeInterval(1800))))
    }
}

struct ServerStatusWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family
    private let lime = Color(red: 0.776, green: 0.957, blue: 0.196)
    private let moss = Color(red: 0.64, green: 0.63, blue: 0.59)

    var body: some View {
        if let snap = entry.snapshot {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(snap.servers.reduce(0) { $0 + ($1.players ?? 0) })")
                        .font(.system(size: 34, weight: .bold, design: .serif))
                    Text("online").font(.caption).foregroundStyle(moss)
                }
                ForEach(snap.servers.prefix(family == .systemSmall ? 3 : 4), id: \.id) { s in
                    HStack(spacing: 6) {
                        Circle().fill(s.status == "running" ? lime : s.status == "crashed" ? .red : moss).frame(width: 7, height: 7)
                        Text(s.name).font(.caption).lineLimit(1)
                        Spacer(minLength: 4)
                        if s.status == "running", let p = s.players { Text("\(p)").font(.caption.monospacedDigit()).foregroundStyle(moss) }
                    }
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
        } else {
            Text("Open GamePanel to sign in.").font(.caption).foregroundStyle(moss)
        }
    }
}

@main
struct GamePanelWidgetBundle: WidgetBundle {
    var body: some Widget {
        ServerStatusWidget()
        ServerLiveActivity()
    }
}
