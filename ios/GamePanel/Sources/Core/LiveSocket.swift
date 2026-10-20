import Foundation

/// The panel's `/ws` feed: server list, status changes, live stats and console lines.
/// Reconnects by itself and re-subscribes to the console topics that were open.
final class LiveSocket {
    enum Event {
        case servers([GameServer])
        case status(GameServer)
        case stats([StatsPatch])
        case console(serverId: String, lines: [ConsoleLine], cleared: Bool)
        case connected(Bool)
    }

    private let client: APIClient
    private let onEvent: @MainActor (Event) -> Void
    private var task: URLSessionWebSocketTask?
    private var topics = Set<String>()
    private var stopped = false
    private var retry: Task<Void, Never>?

    init(client: APIClient, onEvent: @escaping @MainActor (Event) -> Void) {
        self.client = client
        self.onEvent = onEvent
    }

    func start() {
        stopped = false
        guard task == nil else { return }
        let task = client.webSocket()
        self.task = task
        task.resume()
        if !topics.isEmpty { send(["type": "subscribe", "topics": Array(topics)]) }
        receive(on: task)
    }

    func stop() {
        stopped = true
        retry?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    func subscribe(_ topic: String) {
        topics.insert(topic)
        send(["type": "subscribe", "topics": [topic]])
    }

    func unsubscribe(_ topic: String) {
        topics.remove(topic)
        send(["type": "unsubscribe", "topics": [topic]])
    }

    private func send(_ object: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.task else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message { self.handle(text) }
                if case .data(let data) = message, let text = String(data: data, encoding: .utf8) { self.handle(text) }
                Task { @MainActor in self.onEvent(.connected(true)) }
                self.receive(on: task)
            case .failure:
                self.task = nil
                Task { @MainActor in self.onEvent(.connected(false)) }
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        retry?.cancel()
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.start()
        }
    }

    private struct Envelope: Decodable {
        let topic: String?
        let type: String?
        let serverId: String?
        let servers: [GameServer]?
        let server: GameServer?
        let lines: [ConsoleLine]?
    }

    private struct StatsEnvelope: Decodable { let servers: [StatsPatch] }

    private func handle(_ text: String) {
        let data = Data(text.utf8)
        let decoder = JSONDecoder()
        guard let msg = try? decoder.decode(Envelope.self, from: data), let topic = msg.topic else { return }
        let event: Event?
        switch topic {
        case "servers":
            event = msg.servers.map(Event.servers)
        case "server:status":
            event = msg.server.map(Event.status)
        case "stats":
            event = (try? decoder.decode(StatsEnvelope.self, from: data)).map { .stats($0.servers) }
        default:
            if topic.hasPrefix("console:") {
                event = .console(serverId: String(topic.dropFirst(8)), lines: msg.lines ?? [], cleared: msg.type == "clear")
            } else {
                event = nil
            }
        }
        if let event { Task { @MainActor in self.onEvent(event) } }
    }
}
