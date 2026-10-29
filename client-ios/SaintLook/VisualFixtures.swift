#if DEBUG
import Foundation

/// Initial data only. After loading, all edits, selection and persistence use the normal store.
enum VisualFixtures {
    enum Scenario: String { case ready = "ready-four", legacy = "legacy-four", legacyLabels = "legacy-labels", fitting = "fitting-ready", empty, mixed = "mixed-offline", unreadable = "unreadable-catalog" }
    enum FixtureError: Error { case invalidConfiguration, missingTaxonomy }

    static func prepare(environment: [String: String], support: URL, resources: URL,
                        taxonomy: WardrobeTaxonomy) throws -> URL? {
        guard let name = environment["SAINT_LOOK_VISUAL_SCENARIO"] else { return nil }
        guard environment["SAINT_LOOK_UI_TESTING"] == "1", let scenario = Scenario(rawValue: name),
              ["0", "1"].contains(environment["SAINT_LOOK_RESET_DATA"] ?? "") else {
            throw FixtureError.invalidConfiguration
        }
        let root = support.appendingPathComponent("wardrobe-visual-fixtures", isDirectory: true)
        guard environment["SAINT_LOOK_RESET_DATA"] == "1" else { return root }
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if scenario == .unreadable {
            try Data("invalid catalog fixture".utf8).write(to: root.appendingPathComponent("catalog.json"), options: .atomic)
            return root
        }
        if scenario == .fitting {
            try prepareFitting(root: root, resources: resources, taxonomy: taxonomy)
            return root
        }
        var preparedSeeds: [WardrobeItem] = []
        if scenario == .ready {
            try prepareFitting(root: root, resources: resources, taxonomy: taxonomy)
            preparedSeeds = try WardrobeCatalogFile(directory: root).load().items
        }
        var items: [WardrobeItem] = []
        if scenario != .empty {
            let inputs: [(String, String, String, [String])] = [
                ("TrialPhotos", "photo-1.png", "t_shirt", ["white"]),
                ("TrialPhotos", "photo-2.jpg", "jeans", ["blue"]),
                ("TrialPhotos", "photo-3.jpg", "polo", ["white", "black"]),
                ("VisualFixtures", "shoes.png", "shoes", ["black", "white", "brown"])
            ]
            for (index, input) in inputs.prefix(scenario == .legacyLabels ? 1 : inputs.count).enumerated() {
                guard let type = taxonomy.types.first(where: { $0.id == input.2 })?.label else { throw FixtureError.missingTaxonomy }
                let colors = try input.3.map { id -> String in
                    guard let label = taxonomy.colors.first(where: { $0.id == id })?.label else { throw FixtureError.missingTaxonomy }
                    return label
                }
                let suffix = String(format: "%012d", index + 1)
                var item = WardrobeItem(id: UUID(uuidString: "36000000-0000-0000-0000-\(suffix)")!,
                    operationID: UUID(uuidString: "36000001-0000-0000-0000-\(suffix)")!,
                    photoVersionID: UUID(uuidString: "36000002-0000-0000-0000-\(suffix)")!)
                item.status = .ready
                item.type = type
                item.colors = colors
                if scenario == .legacyLabels {
                    // Historical local labels, not an unvalidated new provider response.
                    item.type = "Накидка"
                    item.colors = ["Сиреневый"]
                }
                item.mode = .demo
                item.resultMode = .demo
                item.originalFilename = input.1
                item.uploadFilename = input.1
                item.resultFilename = input.1
                let folder = root.appendingPathComponent(item.directoryName, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: resources.appendingPathComponent(input.0).appendingPathComponent(input.1),
                                                to: folder.appendingPathComponent(input.1))
                if scenario == .mixed {
                    if index == 1 { item.status = .pending; item.resultFilename = nil; item.resultMode = nil }
                    if index == 2 {
                        item.status = .failed; item.resultFilename = nil; item.resultMode = nil
                        item.errorCode = "provider_quota_exceeded"
                        item.errorMessage = ProcessingFailure.message(for: item.errorCode)
                    }
                    if index == 3 { item.status = .pending; item.action = .replace; item.revision = 1 }
                }
                if scenario == .ready {
                    item = try preparePublicFixture(item, seed: preparedSeeds[index], key: ["tee", "jeans", "jacket", "shoes"][index],
                        root: root, resources: resources, taxonomy: taxonomy)
                }
                items.append(item)
            }
        }
        try WardrobeCatalogFile(directory: root).save(WardrobeCatalog(items: items, pendingAcknowledgements: []))
        return root
    }

    private struct Metadata: Decodable {
        let imageSHA256: String
        let representationSHA256: String
        let representationFilename: String
    }

    private static func prepareFitting(root: URL, resources: URL, taxonomy: WardrobeTaxonomy) throws {
        let fixtures = resources.appendingPathComponent("VisualFixtures")
        let metadata = try JSONDecoder().decode([String: Metadata].self,
            from: Data(contentsOf: fixtures.appendingPathComponent("prepared-manifest.json")))
        let inputs = [("tee", "t_shirt", "beige"), ("jeans", "jeans", "blue"),
                      ("jacket", "jacket", "burgundy"), ("shoes", "shoes", "black")]
        var items: [WardrobeItem] = []
        for (index, input) in inputs.enumerated() {
            guard let type = taxonomy.types.first(where: { $0.id == input.1 })?.label,
                  let color = taxonomy.colors.first(where: { $0.id == input.2 })?.label else { throw FixtureError.missingTaxonomy }
            let suffix = String(format: "%012d", index + 1)
            var item = WardrobeItem(id: UUID(uuidString: "36000000-0000-0000-0000-\(suffix)")!,
                operationID: UUID(uuidString: "36000001-0000-0000-0000-\(suffix)")!,
                photoVersionID: UUID(uuidString: "36000002-0000-0000-0000-\(suffix)")!)
            let filename = "fitting-\(input.0).png"
            item.status = .ready
            item.type = type
            item.colors = [color]
            item.mode = .demo
            item.resultMode = .demo
            item.originalFilename = filename
            item.uploadFilename = filename
            item.resultFilename = filename
            let operation = UUID(uuidString: "36000003-0000-0000-0000-\(suffix)")!
            item.illustration = IllustrationRequest(operationID: operation, photoVersionID: item.photoVersionID,
                sourceSetVersionID: item.sourceSetVersionID, revision: 1, manualType: nil, manualColors: nil,
                status: .ready, submitted: true)
            let keys = ["silhouette", "body_length", "sleeves", "pattern", "pattern_location", "pattern_size",
                        "neckline", "fastening", "surface", "hood", "kangaroo_pocket", "patch_pockets",
                        "dropped_shoulders", "contrast_cuffs", "lettering"]
            let features = IllustrationFeatures(version: "fitting-observable-v2-photoroom-sandbox", type: type,
                colors: [color], traits: Dictionary(uniqueKeysWithValues: keys.map { ($0, "unknown") }))
            let response = IllustrationResponse(itemId: item.id, operationId: operation,
                photoVersionId: item.photoVersionID, sourceSetVersionId: item.sourceSetVersionID,
                revision: 1, status: .ready, mode: "test", processing: [:], observedFeatures: features,
                effectiveFeatures: features, manualType: nil, manualColors: nil,
                modelVersion: "fal-ai/nano-banana-pro/edit", templateVersion: "front-360x560-proposed-v1",
                geometryVersion: "fitting-square-1024-v1",
                resultPath: "/v1/items/\(item.id.uuidString.lowercased())/illustrations/\(operation.uuidString.lowercased())/result", error: nil)
            item.illustrationResult = IllustrationResult(filename: filename, response: response)
            // This isolated scenario depicts an already committed test publication,
            // not a v2 catalog awaiting a real server receipt.
            item.publishedVersion = ItemPublication(versionID: operation, photoVersionID: item.photoVersionID,
                sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: filename, cutoutMode: .demo,
                illustration: item.illustrationResult, type: type, colors: [color], completeness: .illustrated)
            guard let hashes = metadata[input.0] else { throw FixtureError.invalidConfiguration }
            let representationJSON = try String(contentsOf: fixtures.appendingPathComponent(hashes.representationFilename), encoding: .utf8)
            let preparationID = UUID(uuidString: "36000005-0000-0000-0000-\(suffix)")!
            let preparation = PreparationResponse(itemId: item.id, operationId: preparationID, revision: 1,
                photoVersionId: item.photoVersionID, sourceSetVersionId: item.sourceSetVersionID,
                illustrationOperationId: operation, cutoutOperationId: item.operationID,
                spaceID: "visual-fixture-only", status: .ready, mode: "controlled", imageMode: "test", provenance: "pipeline",
                effectiveFeatures: CanonicalItemFeatures(type: input.1, colors: [input.2]),
                representationJSON: representationJSON, representationSHA256: hashes.representationSHA256,
                input: .init(sourceSHA256: hashes.imageSHA256, textSHA256: String(repeating: "0", count: 64)),
                artifacts: .init(cutoutSHA256: hashes.imageSHA256, illustrationSHA256: hashes.imageSHA256,
                    observedFeaturesSHA256: String(repeating: "0", count: 64), effectiveFeaturesSHA256: String(repeating: "0", count: 64)), error: nil)
            item.publishedVersion = ItemPublication(versionID: preparationID, photoVersionID: item.photoVersionID,
                sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: filename, cutoutMode: .demo,
                illustration: item.illustrationResult, type: type, colors: [color], completeness: .prepared,
                representation: StoredRepresentation(filename: hashes.representationFilename, response: preparation), cutoutOperationID: item.operationID)
            item.preparationRevision = 1
            item.preparedPhotos = [IllustrationPreparedPhoto(photoID: item.photoVersionID, filename: filename,
                sourceDigest: hashes.imageSHA256, preparedDigest: hashes.imageSHA256, modelVersion: response.modelVersion,
                templateVersion: response.templateVersion, geometryVersion: response.geometryVersion)]
            item.photosLocked = true
            let folder = root.appendingPathComponent(item.directoryName, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: resources.appendingPathComponent("VisualFixtures").appendingPathComponent(filename),
                                            to: folder.appendingPathComponent(filename))
            try FileManager.default.copyItem(at: fixtures.appendingPathComponent(hashes.representationFilename),
                to: folder.appendingPathComponent(hashes.representationFilename))
            items.append(item)
        }
        var outfit = Outfit(id: UUID(uuidString: "36000004-0000-0000-0000-000000000001")!, name: "Тестовые слои · без генерации")
        outfit.selectItem(items[0].id, for: outfit.slots[1].id)
        outfit.selectItem(items[1].id, for: outfit.slots[2].id)
        outfit.selectItem(items[3].id, for: outfit.slots[3].id)
        let outer = outfit.addBodyLayer()
        outfit.selectItem(items[2].id, for: outer)
        try WardrobeCatalogFile(directory: root).save(WardrobeCatalog(items: items, pendingAcknowledgements: [], outfits: [outfit]))
    }
    private static func preparePublicFixture(_ input: WardrobeItem, seed: WardrobeItem, key: String,
                                             root: URL, resources: URL, taxonomy: WardrobeTaxonomy) throws -> WardrobeItem {
        var item = input
        let fixtures = resources.appendingPathComponent("VisualFixtures")
        let metadata = try JSONDecoder().decode([String: Metadata].self,
            from: Data(contentsOf: fixtures.appendingPathComponent("prepared-manifest.json")))
        guard let hashes = metadata["public-" + key], let imageHashes = metadata[key],
              let old = seed.illustrationResult, let seedRepresentation = seed.publishedVersion?.representation else { throw FixtureError.invalidConfiguration }
        let features = IllustrationFeatures(version: old.response.effectiveFeatures!.version,
            type: item.type!, colors: item.colors, traits: old.response.effectiveFeatures!.traits)
        let response = IllustrationResponse(itemId: item.id, operationId: old.response.operationId,
            photoVersionId: item.photoVersionID, sourceSetVersionId: item.sourceSetVersionID, revision: 1,
            status: .ready, mode: "test", processing: [:], observedFeatures: features, effectiveFeatures: features,
            manualType: nil, manualColors: nil, modelVersion: old.response.modelVersion,
            templateVersion: old.response.templateVersion, geometryVersion: old.response.geometryVersion,
            resultPath: nil, error: nil)
        item.illustration = seed.illustration
        item.illustrationResult = IllustrationResult(filename: old.filename, response: response)
        let representationJSON = try String(contentsOf: fixtures.appendingPathComponent(hashes.representationFilename), encoding: .utf8)
        let preparation = PreparationResponse(itemId: item.id, operationId: seedRepresentation.response.operationId, revision: 1,
            photoVersionId: item.photoVersionID, sourceSetVersionId: item.sourceSetVersionID,
            illustrationOperationId: response.operationId, cutoutOperationId: item.operationID,
            spaceID: "visual-fixture-only", status: .ready, mode: "controlled", imageMode: "test", provenance: "pipeline",
            effectiveFeatures: try CanonicalItemFeatures(displayType: item.type, colors: item.colors, taxonomy: taxonomy),
            representationJSON: representationJSON, representationSHA256: hashes.representationSHA256,
            input: .init(sourceSHA256: hashes.imageSHA256, textSHA256: String(repeating: "0", count: 64)),
            artifacts: .init(cutoutSHA256: hashes.imageSHA256, illustrationSHA256: imageHashes.imageSHA256,
                observedFeaturesSHA256: String(repeating: "0", count: 64), effectiveFeaturesSHA256: String(repeating: "0", count: 64)), error: nil)
        item.publishedVersion = ItemPublication(versionID: preparation.operationId, photoVersionID: item.photoVersionID,
            sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: item.resultFilename!, cutoutMode: .demo,
            illustration: item.illustrationResult, type: item.type, colors: item.colors, completeness: .prepared,
            representation: StoredRepresentation(filename: hashes.representationFilename, response: preparation), cutoutOperationID: item.operationID)
        item.preparedPhotos = [IllustrationPreparedPhoto(photoID: item.photoVersionID, filename: old.filename,
            sourceDigest: hashes.imageSHA256, preparedDigest: imageHashes.imageSHA256, modelVersion: response.modelVersion,
            templateVersion: response.templateVersion, geometryVersion: response.geometryVersion)]
        item.photosLocked = true
        item.preparationRevision = 1
        try FileManager.default.copyItem(at: fixtures.appendingPathComponent(hashes.representationFilename),
            to: root.appendingPathComponent(item.directoryName).appendingPathComponent(hashes.representationFilename))
        return item
    }

}
#endif
