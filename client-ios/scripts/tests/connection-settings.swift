import Foundation

// Compile the production settings implementation without UIKit or a live Keychain.
enum ClientError: Error { case invalidSettings, keychain }

@main
struct SettingsChecks {
    static func main() throws {
        let token = String(repeating: "t", count: 40)
        let bundle: [String: Any] = ["SaintLookDefaultBackendURL": "https://example.com", "SaintLookDefaultOwnerToken": token]
        let personal = try ConnectionSettings.resolve(savedURL: nil, savedToken: "", bundled: bundle)
        precondition(personal.baseURL == "https://example.com" && personal.token == token)
        let local = try ConnectionSettings.resolve(savedURL: nil, savedToken: "", bundled: [:])
        precondition(local.baseURL == "http://127.0.0.1:8787" && local.token.isEmpty)
        let saved = try ConnectionSettings.resolve(savedURL: "https://other.example", savedToken: "manual", bundled: bundle)
        precondition(saved.baseURL == "https://other.example" && saved.token == "manual")
        let missingToken = try ConnectionSettings.resolve(savedURL: "https://other.example", savedToken: "", bundled: bundle)
        precondition(missingToken.token.isEmpty, "Never send bundled token to a saved server")
        let orphanToken = try ConnectionSettings.resolve(savedURL: nil, savedToken: "old", bundled: bundle)
        precondition(orphanToken.token == "old" && orphanToken.baseURL == local.baseURL)
        for invalid: [String: Any] in [
            ["SaintLookDefaultBackendURL": "https://example.com"],
            ["SaintLookDefaultOwnerToken": token],
            ["SaintLookDefaultBackendURL": "http://127.0.0.1:8787", "SaintLookDefaultOwnerToken": token],
            ["SaintLookDefaultBackendURL": "https://example.com", "SaintLookDefaultOwnerToken": "short"]
        ] {
            do {
                _ = try ConnectionSettings.resolve(savedURL: nil, savedToken: "", bundled: invalid)
                fatalError("Invalid bundled settings accepted")
            } catch ClientError.invalidSettings { }
        }
        print("Connection defaults checks passed")
    }
}
