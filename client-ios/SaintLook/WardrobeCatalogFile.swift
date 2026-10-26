import Foundation

/// A single document keeps local commands and outfits in the same atomic write.
struct WardrobeCatalog: Codable {
    var items: [WardrobeItem] = []
    var pendingDeletionIDs: Set<UUID> = []
    // nil means an old catalog still needs acknowledgement migration.
    var pendingAcknowledgements: Set<ResultAcknowledgement>? = []
    var outfits: [Outfit] = []

    private enum CodingKeys: String, CodingKey {
        case items, pendingDeletionIDs, pendingAcknowledgements, outfits
    }

    init(items: [WardrobeItem] = [], pendingDeletionIDs: Set<UUID> = [],
         pendingAcknowledgements: Set<ResultAcknowledgement>? = [], outfits: [Outfit] = []) {
        self.items = items
        self.pendingDeletionIDs = pendingDeletionIDs
        self.pendingAcknowledgements = pendingAcknowledgements
        self.outfits = outfits
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([WardrobeItem].self, forKey: .items)
        pendingDeletionIDs = try values.decode(Set<UUID>.self, forKey: .pendingDeletionIDs)
        pendingAcknowledgements = try values.decodeIfPresent(Set<ResultAcknowledgement>.self, forKey: .pendingAcknowledgements)
        outfits = try values.decodeIfPresent([Outfit].self, forKey: .outfits) ?? []
    }
}

struct WardrobeCatalogFile {
    let directory: URL
    private var url: URL { directory.appendingPathComponent("catalog.json") }

    func load() throws -> WardrobeCatalog {
        guard FileManager.default.fileExists(atPath: url.path) else { return WardrobeCatalog() }
        let data = try Data(contentsOf: url)
        if let legacyItems = try? JSONDecoder().decode([WardrobeItem].self, from: data) {
            return WardrobeCatalog(items: legacyItems, pendingAcknowledgements: nil)
        }
        return try JSONDecoder().decode(WardrobeCatalog.self, from: data)
    }

    func save(_ catalog: WardrobeCatalog) throws {
        try JSONEncoder().encode(catalog).write(to: url, options: .atomic)
    }
}
