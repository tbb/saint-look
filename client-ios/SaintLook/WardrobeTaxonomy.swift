import Foundation

struct WardrobeTaxonomy: Decodable {
    struct Option: Decodable, Identifiable {
        let id: String
        let label: String
    }

    let version: Int
    let types: [Option]
    let colors: [Option]

    // The same repository resource is bundled by Xcode and loaded by the backend.
    static let shared: WardrobeTaxonomy = {
        guard let url = Bundle.main.url(forResource: "wardrobe-taxonomy", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let taxonomy = try? JSONDecoder().decode(WardrobeTaxonomy.self, from: data),
              taxonomy.version == 1, !taxonomy.types.isEmpty, !taxonomy.colors.isEmpty else {
            preconditionFailure("The wardrobe taxonomy resource is missing or invalid")
        }
        return taxonomy
    }()

    func contains(type: String) -> Bool { types.contains { $0.label == type } }

    func contains(colors selected: [String]) -> Bool {
        (1...5).contains(selected.count) && Set(selected).count == selected.count
            && selected.allSatisfy { label in colors.contains { $0.label == label } }
    }
}
