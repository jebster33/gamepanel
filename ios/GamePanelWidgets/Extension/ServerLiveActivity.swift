import ActivityKit
import SwiftUI
import WidgetKit

private let lime = Color(red: 0.776, green: 0.957, blue: 0.196)
private let ember = Color(red: 1, green: 0.38, blue: 0.35)
private let amber = Color(red: 1, green: 0.70, blue: 0.25)
private let moss = Color(red: 0.64, green: 0.63, blue: 0.59)

private func tint(_ status: String) -> Color {
    switch status {
    case "running": lime
    case "crashed", "install_failed": ember
    case "starting", "stopping", "installing": amber
    default: moss
    }
}

/// Dynamic Island + Lock Screen for a pinned server or a long task.
struct ServerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ServerActivityAttributes.self) { context in
            LockScreenCard(context: context)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(lime)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Circle().fill(tint(state.status)).frame(width: 8, height: 8)
                        Text(context.attributes.serverName).font(.system(.headline, design: .serif)).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let players = state.players {
                        Text(state.maxPlayers.map { "\(players)/\($0)" } ?? "\(players)")
                            .font(.system(.title3, design: .serif).weight(.bold))
                            .contentTransition(.numericText())
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.attributes.kind == .task, let task = state.task {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(task).font(.caption).foregroundStyle(moss)
                            if let p = state.progress { ProgressView(value: p).tint(lime) } else { ProgressView().tint(lime) }
                        }
                    } else {
                        HStack(spacing: 14) {
                            Gauge(value: (state.cpu ?? 0) / 100) { Text("CPU") }.gaugeStyle(.accessoryLinearCapacity).tint(.white)
                            Gauge(value: state.memoryFraction ?? 0) { Text("RAM") }.gaugeStyle(.accessoryLinearCapacity).tint(amber)
                        }
                        .font(.caption2)
                    }
                }
            } compactLeading: {
                Circle().fill(tint(state.status)).frame(width: 9, height: 9)
            } compactTrailing: {
                if context.attributes.kind == .task {
                    if let p = state.progress {
                        ProgressView(value: p).progressViewStyle(.circular).tint(lime).frame(width: 18)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(lime)
                    }
                } else {
                    Text("\(state.players ?? 0)").font(.caption.monospacedDigit().weight(.bold)).foregroundStyle(lime)
                }
            } minimal: {
                Circle().fill(tint(state.status)).frame(width: 9, height: 9)
            }
            .keylineTint(lime)
            .widgetURL(URL(string: "gamepanel://server/\(context.attributes.serverId)"))
        }
    }
}

private struct LockScreenCard: View {
    let context: ActivityViewContext<ServerActivityAttributes>

    var body: some View {
        let state = context.state
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle().fill(tint(state.status)).frame(width: 9, height: 9)
                Text(context.attributes.serverName).font(.system(.title3, design: .serif).weight(.semibold)).lineLimit(1)
                Spacer()
                if let players = state.players {
                    Text(state.maxPlayers.map { "\(players)/\($0)" } ?? "\(players)")
                        .font(.system(.title2, design: .serif).weight(.bold))
                }
            }
            if context.attributes.kind == .task, let task = state.task {
                Text(task).font(.subheadline).foregroundStyle(moss)
                if let p = state.progress { ProgressView(value: p).tint(lime) } else { ProgressView().tint(lime) }
            } else {
                HStack(spacing: 14) {
                    Gauge(value: (state.cpu ?? 0) / 100) { Text("CPU") }.gaugeStyle(.accessoryLinearCapacity).tint(.white)
                    Gauge(value: state.memoryFraction ?? 0) { Text("Memory") }.gaugeStyle(.accessoryLinearCapacity).tint(amber)
                }
                .font(.caption)
            }
            Text("\(context.attributes.panelName) · updated \(state.updated, style: .relative) ago")
                .font(.caption2).foregroundStyle(moss)
        }
        .padding(16)
    }
}
