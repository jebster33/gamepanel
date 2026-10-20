import SwiftUI

/// The status ring: a solid dot, with a slow breathing halo while the server is running.
/// Under Reduce Motion the halo stays still.
struct StatusRing: View {
    let status: ServerStatus
    var size: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        let color = Palette.status(status)
        ZStack {
            if status == .running || status == .starting {
                Circle()
                    .stroke(color.opacity(0.5), lineWidth: size * 0.18)
                    .frame(width: size * 2.1, height: size * 2.1)
                    .scaleEffect(reduceMotion ? 1 : (breathe ? 1.0 : 0.62))
                    .opacity(reduceMotion ? 0.5 : (breathe ? 0 : 0.9))
            }
            Circle().fill(color).frame(width: size, height: size)
        }
        .frame(width: size * 2.2, height: size * 2.2)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 2.2).repeatForever(autoreverses: false)) { breathe = true }
        }
        .accessibilityElement()
        .accessibilityLabel(status.label)
    }
}

/// A thin usage bar for CPU and memory.
struct UsageBar: View {
    let fraction: Double?
    var tint: Color = Palette.bone

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.sep)
                Capsule()
                    .fill(tint.opacity(0.85))
                    .frame(width: geo.size.width * CGFloat(min(1, max(0, fraction ?? 0))))
            }
        }
        .frame(height: 4)
        .animation(.smooth(duration: 0.4), value: fraction)
    }
}

/// Shows that live numbers have gone stale when the socket drops.
struct LiveBadge: View {
    @EnvironmentObject private var session: PanelSession

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(session.connected ? Palette.lime : Palette.amber).frame(width: 6, height: 6)
            if session.connected {
                Text("Live")
            } else if let last = session.lastUpdate {
                Text("Reconnecting · updated \(Format.relative(last))")
            } else {
                Text("Connecting")
            }
        }
        .font(.caption)
        .foregroundStyle(Palette.moss)
        .accessibilityElement(children: .combine)
    }
}

/// An empty or failed state that says what to do next.
struct EmptyNote: View {
    let title: String
    let message: String
    var systemImage = "tray"
    var action: (label: String, run: () -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(.glassProminent)
                    .tint(Palette.lime)
                    .foregroundStyle(Palette.limeInk)
            }
        }
    }
}

/// Top-of-screen pop-up for errors and new alerts.
struct ToastView: View {
    let toast: PanelSession.Toast

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: toast.level == "error" ? "exclamationmark.octagon.fill" : toast.level == "warn" ? "exclamationmark.triangle.fill" : "bell.fill")
                .foregroundStyle(toast.level == "error" ? Palette.ember : toast.level == "warn" ? Palette.amber : Palette.lime)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title).font(.subheadline.weight(.semibold))
                Text(toast.message).font(.footnote).foregroundStyle(Palette.moss).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// The panel's dark ground behind lists and scroll views.
    func panelBackground() -> some View {
        scrollContentBackground(.hidden).background(Palette.ink.ignoresSafeArea())
    }
}
