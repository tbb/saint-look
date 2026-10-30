import Foundation
import Security

struct ConnectionSettings {
    var baseURL: String
    var token: String

    static func load() throws -> Self {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["SAINT_LOOK_UI_TESTING"] == "1" {
            if environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1" {
                guard environment["SAINT_LOOK_BENCHMARK"] == "1",
                      let baseURL = environment["SAINT_LOOK_BASE_URL"],
                      environment["SAINT_LOOK_OWNER_TOKEN"] == nil,
                      environment["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"]?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      environment["SAINT_LOOK_BENCHMARK_REVISION"]?.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
                    throw ClientError.invalidSettings
                }
                let settings = Self(baseURL: baseURL, token: "")
                guard try settings.validatedURL().scheme == "https" else { throw ClientError.invalidSettings }
                return settings
            }
            guard let baseURL = environment["SAINT_LOOK_BASE_URL"],
                  let token = environment["SAINT_LOOK_OWNER_TOKEN"] else {
                throw ClientError.invalidSettings
            }
            // UI tests supply isolated credentials; no existing Keychain state is required.
            return Self(baseURL: baseURL, token: token)
        }
        #endif
        let savedURL = UserDefaults.standard.string(forKey: "backendURL")
        let savedToken = try OwnerToken.read()
        let settings = try resolve(
            savedURL: savedURL, savedToken: savedToken,
            bundled: Bundle.main.infoDictionary ?? [:]
        )
        if savedURL == nil, !settings.token.isEmpty, (try? settings.validatedURL()) != nil {
            // Import personal defaults, including a recovered reinstall destination.
            // Later manual changes win; an unpaired Keychain token stays unconfigured.
            try settings.save()
        }
        return settings
    }

    static func resolve(savedURL: String?, savedToken: String, bundled: [String: Any]) throws -> Self {
        let localURL = "http://127.0.0.1:8787"
        // Never combine a saved server address with a bundled owner's credential.
        if let savedURL {
            return Self(baseURL: savedURL, token: savedToken)
        }
        // Keychain can outlive uninstall while UserDefaults cannot. Recover a
        // destination only from the bundled pair matching the surviving token.
        if !savedToken.isEmpty, bundled["SaintLookDefaultOwnerToken"] as? String != savedToken {
            return Self(baseURL: "", token: savedToken)
        }
        guard bundled["SaintLookDefaultBackendURL"] != nil || bundled["SaintLookDefaultOwnerToken"] != nil else {
            return Self(baseURL: localURL, token: "")
        }
        guard let url = bundled["SaintLookDefaultBackendURL"] as? String,
              let token = bundled["SaintLookDefaultOwnerToken"] as? String else {
            throw ClientError.invalidSettings
        }
        let settings = Self(baseURL: url, token: token)
        guard try settings.validatedURL().scheme == "https" else { throw ClientError.invalidSettings }
        return settings
    }

    func validatedURL() throws -> URL {
        guard let url = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw ClientError.invalidSettings
        }
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["SAINT_LOOK_UI_TESTING"] == "1" && environment["SAINT_LOOK_BENCHMARK"] == "1"
            && environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1" {
            guard token.isEmpty, url.scheme == "https", environment["SAINT_LOOK_OWNER_TOKEN"] == nil else {
                throw ClientError.invalidSettings
            }
            return url
        }
        #endif
        guard token.count >= 32 else { throw ClientError.invalidSettings }
        return url
    }

    func save() throws {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard !(environment["SAINT_LOOK_UI_TESTING"] == "1" && environment["SAINT_LOOK_BENCHMARK"] == "1"
                && environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1") else { throw ClientError.invalidSettings }
        #endif
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
