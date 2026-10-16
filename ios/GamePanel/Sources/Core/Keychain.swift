import Foundation
import Security

/// Session tokens, one per saved panel. Only readable while the phone is unlocked, never synced.
enum Keychain {
    private static let service = "com.jebster33.gamepanel.session"

    /// Tokens for this launch. If the Keychain refuses a write (an unsigned build, a locked
    /// device), the sign-in still works until the app quits instead of failing straight away.
    private static var memory: [UUID: String] = [:]

    static func token(for panel: UUID) -> String? {
        if let token = memory[panel] { return token }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: panel.uuidString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func setToken(_ token: String, for panel: UUID) {
        removeToken(for: panel)
        memory[panel] = token
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: panel.uuidString,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: Data(token.utf8),
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func removeToken(for panel: UUID) {
        memory[panel] = nil
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: panel.uuidString,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
