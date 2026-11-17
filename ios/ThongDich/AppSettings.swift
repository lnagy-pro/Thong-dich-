import Foundation
import Security

/// Réglages persistants. La clé API va dans le trousseau, le reste dans UserDefaults.
struct AppSettings {
    private enum Keys {
        static let model = "model"
        static let mic = "micSource"
        static let showVietnamese = "showVietnamese"
        static let priority = "priority"
    }

    var apiKey: String {
        didSet { Keychain.save(apiKey) }
    }
    var model: GeminiModel {
        didSet { UserDefaults.standard.set(model.rawValue, forKey: Keys.model) }
    }
    var micSource: MicSource {
        didSet { UserDefaults.standard.set(micSource.rawValue, forKey: Keys.mic) }
    }
    var showVietnamese: Bool {
        didSet { UserDefaults.standard.set(showVietnamese, forKey: Keys.showVietnamese) }
    }
    /// Niveau « priority » de l'API Gemini : latence plus basse et plus stable, prix plus élevé.
    var priority: Bool {
        didSet { UserDefaults.standard.set(priority, forKey: Keys.priority) }
    }

    init() {
        let defaults = UserDefaults.standard
        apiKey = Keychain.read()
        model = GeminiModel(rawValue: defaults.string(forKey: Keys.model) ?? "") ?? .balanced
        micSource = MicSource(rawValue: defaults.string(forKey: Keys.mic) ?? "") ?? .iPhone
        showVietnamese = defaults.object(forKey: Keys.showVietnamese) as? Bool ?? true
        priority = defaults.object(forKey: Keys.priority) as? Bool ?? true
    }
}

/// Stockage de la clé API dans le trousseau, lisible seulement sur cet appareil
/// (jamais sauvegardée dans iCloud ni transférée sur un autre iPhone).
enum Keychain {
    private static let service = "ThongDich.gemini"
    private static let account = "api-key"

    static func read() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }

    static func save(_ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        _ = SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var attributes = base
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        _ = SecItemAdd(attributes as CFDictionary, nil)
    }
}
