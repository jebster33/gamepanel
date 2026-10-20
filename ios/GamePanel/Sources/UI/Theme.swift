import SwiftUI

/// GamePanel's palette, the same tokens as public/app/app.css.
enum Palette {
    static let ink = Color(hex: 0x0D0E0C)
    static let ink2 = Color(hex: 0x141512)
    static let cell = Color(hex: 0x1A1B18)
    static let bone = Color(hex: 0xF1F0EB)
    static let moss = Color(hex: 0xA3A197)
    static let faint = Color(hex: 0x6C6A63)
    static let lime = Color(hex: 0xC6F432)
    static let limeInk = Color(hex: 0x111210)
    static let ember = Color(hex: 0xFF6159)
    static let amber = Color(hex: 0xFFB340)
    static let sep = Color.white.opacity(0.07)

    static func status(_ s: ServerStatus) -> Color {
        switch s {
        case .running: lime
        case .starting, .stopping, .installing: amber
        case .crashed, .installFailed: ember
        case .offline, .unknown: faint
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension Font {
    /// New York, the panel's display face. Server names and screen titles only.
    static func display(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
    static let console = Font.system(size: 12.5, design: .monospaced)
}

enum Format {
    static func bytes(_ value: Double?) -> String {
        guard let value else { return "–" }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .memory)
    }

    static func percent(_ value: Double?) -> String {
        guard let value else { return "–" }
        return "\(Int(value.rounded()))%"
    }

    static func uptime(_ ms: Double?) -> String? {
        guard let ms, ms > 0 else { return nil }
        let f = DateComponentsFormatter()
        f.allowedUnits = ms > 86_400_000 ? [.day, .hour] : [.hour, .minute]
        f.unitsStyle = .abbreviated
        return f.string(from: ms / 1000)
    }

    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: .now)
    }

    static func count(_ value: Double?) -> String {
        guard let value else { return "" }
        return value.formatted(.number.notation(.compactName))
    }
}
