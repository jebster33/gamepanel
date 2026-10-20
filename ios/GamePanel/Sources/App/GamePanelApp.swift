import SwiftUI

@main
struct GamePanelApp: App {
    @StateObject private var panels = PanelStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(panels)
                .preferredColorScheme(.dark)
                .tint(Palette.lime)
        }
    }
}

/// Picks between signing in and the open panel, and rebuilds the session when the panel changes.
struct RootView: View {
    @EnvironmentObject private var panels: PanelStore

    var body: some View {
        Group {
            if let panel = panels.current {
                PanelRoot(panel: panel).id(panel.id)
            } else {
                NavigationStack { SignInView() }
            }
        }
        .background(Palette.ink.ignoresSafeArea())
    }
}

struct PanelRoot: View {
    @EnvironmentObject private var panels: PanelStore
    @StateObject private var session: PanelSession
    @Environment(\.scenePhase) private var phase
    @State private var tab = Tab.servers

    enum Tab: Hashable { case servers, alerts, settings }

    init(panel: SavedPanel) {
        _session = StateObject(wrappedValue: PanelSession(panel: panel))
    }

    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Servers", systemImage: "server.rack", value: Tab.servers) {
                NavigationStack { ServersView() }
            }
            SwiftUI.Tab("Alerts", systemImage: "bell", value: Tab.alerts) {
                NavigationStack { AlertsView() }
            }
            .badge(session.unread)
            SwiftUI.Tab("Settings", systemImage: "gearshape", value: Tab.settings) {
                NavigationStack { SettingsView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .environmentObject(session)
        .overlay(alignment: .top) {
            if let toast = session.toast {
                ToastView(toast: toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { session.toast = nil }
                    .task(id: toast.id) {
                        try? await Task.sleep(for: .seconds(4))
                        if session.toast == toast { session.toast = nil }
                    }
            }
        }
        .animation(.spring(duration: 0.35), value: session.toast)
        .task { await session.start() }
        .onDisappear { session.stop() }
        .onChange(of: phase) { _, now in
            // Coming back from the background: reconnect and catch up straight away.
            if now == .active { Task { await session.start() } }
            if now == .background { session.stop() }
        }
        .sheet(isPresented: $session.signedOut) {
            NavigationStack { SignInView(reauth: session.panel) }
                .interactiveDismissDisabled()
        }
    }
}
