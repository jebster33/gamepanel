import SwiftUI

struct ConsoleView: View {
    let server: GameServer
    @EnvironmentObject private var session: PanelSession
    @State private var command = ""
    @State private var history: [String] = []
    @State private var historyIndex: Int?
    @State private var follow = true
    @FocusState private var typing: Bool

    private var lines: [ConsoleLine] { session.consoles[server.id] ?? [] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if lines.isEmpty {
                        Text(server.status.isActive ? "Waiting for output…" : "The server is stopped. Start it to see its console.")
                            .font(.console)
                            .foregroundStyle(Palette.faint)
                            .padding(.top, 8)
                    }
                    ForEach(lines) { line in
                        Text(line.line.isEmpty ? " " : line.line)
                            .font(.console)
                            .foregroundStyle(color(line.kind))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.seq)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .background(Palette.ink2)
            .clipShape(.rect(cornerRadius: 18))
            .padding(.horizontal, 12)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 40
            } action: { _, atBottom in
                follow = atBottom
            }
            .onChange(of: lines.last?.seq) { _, _ in
                if follow { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .overlay(alignment: .bottomTrailing) {
                if !follow {
                    Button {
                        withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").font(.callout.weight(.bold)).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .padding(24)
                    .accessibilityLabel("Jump to latest output")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.snappy, value: follow)
        }
        .safeAreaInset(edge: .bottom) { commandBar }
        .task(id: server.id) { await session.openConsole(server.id) }
        .onDisappear { session.closeConsole(server.id) }
    }

    private var commandBar: some View {
        HStack(spacing: 10) {
            if !history.isEmpty {
                Button {
                    // Step back through what was sent, newest first.
                    let next = min((historyIndex ?? -1) + 1, history.count - 1)
                    historyIndex = next
                    command = history[history.count - 1 - next]
                } label: {
                    Image(systemName: "chevron.up").font(.callout.weight(.semibold)).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Previous command")
            }
            HStack {
                Text(">").font(.console).foregroundStyle(Palette.lime).accessibilityHidden(true)
                TextField("Send a command", text: $command)
                    .font(.system(size: 15, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($typing)
                    .onSubmit(send)
                    .disabled(!server.status.isActive)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func send() {
        let text = command.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        command = ""
        historyIndex = nil
        history.removeAll { $0 == text }
        history.append(text)
        follow = true
        Task {
            do { try await session.client.command(server.id, text) } catch { session.report(error) }
        }
        typing = true
    }

    private func color(_ kind: ConsoleLine.Kind) -> Color {
        switch kind {
        case .normal: Palette.bone.opacity(0.88)
        case .warning: Palette.amber
        case .error: Palette.ember
        case .system: Palette.moss
        case .input: Palette.lime
        }
    }
}
