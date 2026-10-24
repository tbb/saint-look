import Foundation
import Security

struct ConnectionSettings {
    var baseURL: String
    var token: String

    static func load() throws -> Self {
        var settings = Self(
            baseURL: UserDefaults.standard.string(forKey: "backendURL") ?? "http://127.0.0.1:8787",
            token: try OwnerToken.read()
        )
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["SAINT_LOOK_UI_TESTING"] == "1" {
            settings.baseURL = environment["SAINT_LOOK_BASE_URL"] ?? settings.baseURL
            settings.token = environment["SAINT_LOOK_OWNER_TOKEN"] ?? settings.token
        }
        #endif
        return settings
    }

    func validatedURL() throws -> URL {
        guard let url = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              token.count >= 32 else { throw ClientError.invalidSettings }
        return url
    }

    func save() throws {
        _ = try validatedURL()
        try OwnerToken.save(token)
        UserDefaults.standard.set(baseURL, forKey: "backendURL")
    }
}

private enum OwnerToken {
    static let service = "SaintLook.owner-access"
    static let account = "owner"
    static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func read() throws -> String {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = value as? Data,
              let token = String(data: data, encoding: .utf8) else { throw ClientError.keychain }
        return token
    }

    static func save(_ token: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let add = query.merging(attributes) { _, new in new }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw ClientError.keychain }
        } else if status != errSecSuccess {
            throw ClientError.keychain
        }
    }
}
