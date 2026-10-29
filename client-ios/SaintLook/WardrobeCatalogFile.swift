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
        queueLegacyPublicationAcknowledgements()
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([WardrobeItem].self, forKey: .items)
        pendingDeletionIDs = try values.decode(Set<UUID>.self, forKey: .pendingDeletionIDs)
        pendingAcknowledgements = try values.decodeIfPresent(Set<ResultAcknowledgement>.self, forKey: .pendingAcknowledgements)
        outfits = try values.decodeIfPresent([Outfit].self, forKey: .outfits) ?? []
        queueLegacyPublicationAcknowledgements()
    }
}

extension WardrobeCatalog {
    var legacyPublicationAcknowledgements: Set<ResultAcknowledgement> {
        Set(items.compactMap { item in
            guard let candidate = item.pendingPublication, candidate.legacyReconciliation == true else { return nil }
            return ResultAcknowledgement(itemID: item.id, operationID: candidate.request.operationID, illustration: true)
        })
    }

    private mutating func queueLegacyPublicationAcknowledgements() {
        // nil still means the pre-ack catalog needs its ordinary-image migration.
        if let pendingAcknowledgements {
            self.pendingAcknowledgements = pendingAcknowledgements.union(legacyPublicationAcknowledgements)
        }
    }

    mutating func reconcileLegacyPublication(_ acknowledgement: ResultAcknowledgement, committed: Bool, requiresPreparation: Bool = false) throws {
        guard acknowledgement.illustration == true,
              let index = items.firstIndex(where: { $0.id == acknowledgement.itemID }),
              let candidate = items[index].pendingPublication, candidate.legacyReconciliation == true,
              candidate.request.operationID == acknowledgement.operationID else { return }
        if committed {
            try confirmPublication(for: acknowledgement.itemID, operationID: acknowledgement.operationID)
        } else {
            // A definitive server refusal preserves the visible legacy snapshot,
            // but never upgrades it to a confirmed publication or retries paid work.
            items[index].pendingPublication = nil
            if requiresPreparation { items[index].downloadedIllustration = candidate }
        }
        pendingAcknowledgements?.remove(acknowledgement)
    }

    mutating func editAttributes(for id: UUID, type: String?, colors: [String]?, taxonomy: WardrobeTaxonomy) throws {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        if let type, !taxonomy.contains(type: type) { throw ClientError.invalidAttributes }
        if let colors, !taxonomy.contains(colors: colors) { throw ClientError.invalidAttributes }
        var item = items[index]
        guard item.canEditAttributes else { throw ClientError.publicationInProgress }
        let oldType = item.manualType, oldColors = item.manualColors
        // Capture the previous image/attributes before changing the editable input.
        item.publishIngestion()
        if let type { item.manualType = type }
        if let colors { item.manualColors = colors }
        if item.manualType != oldType || item.manualColors != oldColors {
            item.preparation = nil
            item.downloadedIllustration = nil
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

    mutating func stageIllustration(for id: UUID, request: IllustrationRequest, result: IllustrationResult,
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
        let publication = ItemPublication(versionID: request.operationID, photoVersionID: item.photoVersionID,
            sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: filename, cutoutMode: item.resultMode,
            illustration: result, type: features.type, colors: features.colors, completeness: .illustrated,
            cutoutOperationID: item.operationID)
        item.downloadedIllustration = PendingItemPublication(publication: publication, request: request, preparedPhotos: preparedPhotos)
        item.illustration = request
        item.illustration?.status = .ready
        item.illustration?.readyForDelivery = false
        items[index] = item
    }

    mutating func confirmPublication(for id: UUID, operationID: UUID) throws {
        guard let index = items.firstIndex(where: { $0.id == id }),
              let candidate = items[index].pendingPublication,
              candidate.request.operationID == operationID,
              items[index].photoVersionID == candidate.publication.photoVersionID,
              items[index].sourceSetVersionID == candidate.publication.sourceSetVersionID else { throw CancellationError() }
        if candidate.legacyReconciliation == true {
            guard items[index].publishedVersion?.versionID == candidate.publication.versionID else { throw CancellationError() }
            // The old result may precede newer editable inputs or another request.
            // Reconciliation owns only its old snapshot, never those newer intents.
        } else {
            if let representation = candidate.publication.representation {
                guard candidate.publication.completeness == .prepared,
                      let intent = items[index].preparation, intent.matches(items[index]),
                      intent.operationID == representation.response.operationId else { throw CancellationError() }
            } else {
                throw ClientError.resultUnavailable("preparation_required")
            }
            items[index].illustration = candidate.request
            items[index].illustration?.status = .ready
            items[index].illustration?.readyForDelivery = false
            items[index].illustrationResult = candidate.publication.illustration
            items[index].preparedPhotos = candidate.preparedPhotos
        }
        items[index].publishedVersion = candidate.publication
        items[index].photosLocked = true
        items[index].pendingPublication = nil
        items[index].preparation = nil
        items[index].downloadedIllustration = nil
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

extension WardrobeCatalog {
    mutating func beginPreparation(for id: UUID, intent: ItemPreparation) throws {
        guard let index = items.firstIndex(where: { $0.id == id }), intent.matches(items[index]),
              items[index].pendingPublication == nil, intent.revision > items[index].preparationRevision else { throw CancellationError() }
        guard let illustration = intent.publication.illustration,
              illustration.response.observedFeatures?.isValid == true,
              illustration.response.effectiveFeatures?.isValid == true,
              illustration.response.effectiveFeatures?.type == intent.publication.type,
              illustration.response.effectiveFeatures?.colors == intent.publication.colors,
              intent.sourceSHA256.count == 64, intent.artifacts.cutoutSHA256.count == 64,
              intent.artifacts.illustrationSHA256.count == 64 else { throw ClientError.invalidResponse }
        if intent.mode == .fromIllustration {
            guard intent.preparedPhotos.count == items[index].additionalPhotos.count + 1,
                  Set(intent.preparedPhotos.map(\.photoID)) == Set([items[index].photoVersionID] + items[index].additionalPhotos.map(\.id)) else {
                throw ClientError.invalidResponse
            }
        }
        items[index].preparation = intent
        items[index].preparationRevision = intent.revision
    }

    mutating func savePreparation(for id: UUID, intent: ItemPreparation) throws {
        guard let index = items.firstIndex(where: { $0.id == id }), intent.matches(items[index]),
              items[index].preparation?.operationID == intent.operationID else { throw CancellationError() }
        items[index].preparation = intent
    }

    mutating func stagePreparation(for id: UUID, response: PreparationResponse, representationFilename: String,
                                   representationDigest: String, actualArtifacts: PreparationArtifacts,
                                   actualSourceDigest: String) throws {
        guard let index = items.firstIndex(where: { $0.id == id }), let intent = items[index].preparation,
              intent.matches(items[index]), items[index].pendingPublication == nil else { throw CancellationError() }
        try response.validate(for: id, intent: intent)
        guard response.status == .ready, actualArtifacts == intent.artifacts,
              representationDigest == response.representationSHA256, actualSourceDigest == intent.sourceSHA256 else {
            throw ClientError.invalidResponse
        }
        var publication = ItemPublication(versionID: intent.operationID,
            photoVersionID: intent.publication.photoVersionID, sourceSetVersionID: intent.publication.sourceSetVersionID,
            cutoutFilename: intent.publication.cutoutFilename, cutoutMode: intent.publication.cutoutMode,
            illustration: intent.publication.illustration, type: intent.publication.type, colors: intent.publication.colors,
            completeness: .prepared, cutoutOperationID: intent.cutoutOperationID)
        publication.representation = StoredRepresentation(filename: representationFilename, response: response)
        items[index].pendingPublication = PendingItemPublication(publication: publication, request: intent.request,
            preparedPhotos: intent.preparedPhotos)
        items[index].preparation?.status = .ready
    }
}


extension WardrobeCatalog {
    /// Retry an uncertain commit with exactly the persisted packet and operation.
    mutating func resumePreparation(for id: UUID) throws {
        guard let index = items.firstIndex(where: { $0.id == id }), let intent = items[index].preparation,
              intent.matches(items[index]) else { throw CancellationError() }
        items[index].preparation?.status = .pending
        items[index].preparation?.error = nil
        items[index].pendingPublication?.error = nil
    }

    /// An authoritative space rejection is not a lost acknowledgement. After fresh
    /// server config arrives, retain the downloaded packet and allow a new CPU intent.
    mutating func clearRejectedPreparationSpace() -> Bool {
        var changed = false
        for index in items.indices where items[index].preparation?.status == .failed
            && items[index].preparation?.error == "representation_space_changed"
            && items[index].pendingPublication == nil {
            items[index].preparation = nil
            changed = true
        }
        return changed
    }
}
