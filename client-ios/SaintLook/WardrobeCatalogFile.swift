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

extension WardrobeCatalog {
    mutating func editAttributes(for id: UUID, type: String?, colors: [String]?, taxonomy: WardrobeTaxonomy) throws {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        if let type, !taxonomy.contains(type: type) { throw ClientError.invalidAttributes }
        if let colors, !taxonomy.contains(colors: colors) { throw ClientError.invalidAttributes }
        var item = items[index]
        let oldType = item.manualType, oldColors = item.manualColors
        // Capture the previous image/attributes before changing the editable input.
        item.publishIngestion()
        if let type { item.manualType = type }
        if let colors { item.manualColors = colors }
        if item.manualType != oldType || item.manualColors != oldColors {
            if item.illustration?.status == .pending {
                item.illustration?.status = .failed
                item.illustration?.error = "source_changed"
            }
            // Legacy cutouts have no type-dependent illustration or encoder yet.
            // Publishing these local attributes is atomic; this is not #68 readiness.
            item.publishIngestion()
        }
        items[index] = item
    }

    mutating func publishIllustration(for id: UUID, request: IllustrationRequest, result: IllustrationResult,
                                     preparedPhotos: [IllustrationPreparedPhoto]) throws {
        guard let index = items.firstIndex(where: { $0.id == id }) else { throw CancellationError() }
        var item = items[index]
        guard item.illustration?.operationID == request.operationID,
              item.photoVersionID == request.photoVersionID, item.sourceSetVersionID == request.sourceSetVersionID,
              item.manualType == request.manualType, item.manualColors == request.manualColors,
              request.status == .ready, let filename = item.resultFilename else { throw CancellationError() }
        try result.response.validate(for: item, request: request)
        guard let features = result.response.effectiveFeatures, result.response.status == .ready,
              preparedPhotos.count == item.additionalPhotos.count + 1,
              Set(preparedPhotos.map(\.photoID)) == Set([item.photoVersionID] + item.additionalPhotos.map(\.id)) else {
            throw ClientError.invalidResponse
        }
        item.publishedVersion = ItemPublication(versionID: request.operationID, photoVersionID: item.photoVersionID,
            sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: filename, cutoutMode: item.resultMode,
            illustration: result, type: features.type, colors: features.colors, completeness: .illustrated)
        item.photosLocked = true
        item.illustration = request
        item.illustrationResult = result
        item.preparedPhotos = preparedPhotos
        items[index] = item
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
