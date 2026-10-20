import SwiftUI
import Charts

struct GraphsView: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var range = MetricRange.hour
    @State private var points: [MetricPoint] = []
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Range", selection: $range) {
                    ForEach(MetricRange.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)

                if !loading && points.isEmpty {
                    EmptyNote(title: "No history yet", message: "Graphs fill in while the server runs.", systemImage: "chart.xyaxis.line")
                } else {
                    chart("Players", unit: "", tint: Palette.lime, value: { Double($0.players ?? 0) })
                    chart("CPU", unit: "%", tint: Palette.bone, value: { $0.cpu ?? 0 })
                    chart("Memory", unit: "GB", tint: Palette.amber, value: { ($0.mem ?? 0) / 1_073_741_824 })
                }
            }
            .padding(16)
        }
        .background(Palette.ink)
        .task(id: range) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { points = try await session.client.history(server.id, range: range) } catch { session.report(error) }
    }

    private func chart(_ title: String, unit: String, tint: Color, value: @escaping (MetricPoint) -> Double) -> some View {
        let latest = points.last.map(value)
        let peak = points.map(value).max()
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.display(20))
                Spacer()
                if let latest {
                    Text(latest.formatted(.number.precision(.fractionLength(unit == "GB" ? 1 : 0))) + (unit.isEmpty ? "" : " \(unit)"))
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                }
                if let peak {
                    Text("peak \(peak.formatted(.number.precision(.fractionLength(unit == "GB" ? 1 : 0))))")
                        .font(.caption).foregroundStyle(Palette.moss)
                }
            }
            Chart(points) { point in
                AreaMark(x: .value("Time", point.date), y: .value(title, value(point)))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.28), tint.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Time", point.date), y: .value(title, value(point)))
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 1.6))
                    .interpolationMethod(.monotone)
            }
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                    AxisGridLine().foregroundStyle(Palette.sep)
                    AxisValueLabel().foregroundStyle(Palette.faint)
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisValueLabel(format: range == .hour || range == .day ? .dateTime.hour().minute() : .dateTime.weekday(.abbreviated).day())
                        .foregroundStyle(Palette.faint)
                }
            }
            .frame(height: 140)
            .accessibilityLabel("\(title) over the last \(range.label.lowercased())")
            .accessibilityValue(latest.map { "Now \(Int($0)) \(unit), peak \(Int(peak ?? 0)) \(unit)" } ?? "")
        }
        .padding(16)
        .background(Palette.cell, in: .rect(cornerRadius: 20))
    }
}
