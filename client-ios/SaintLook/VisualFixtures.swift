#if DEBUG
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// Initial data only. After loading, all edits, selection and persistence use the normal store.
enum VisualFixtures {
    enum Scenario: String { case ready = "ready-four", legacy = "legacy-four", legacyLabels = "legacy-labels", fitting = "fitting-ready", empty, mixed = "mixed-offline", unreadable = "unreadable-catalog" }
    enum FixtureError: Error { case invalidConfiguration, missingTaxonomy }

    static func prepare(environment: [String: String], support: URL, resources: URL,
                        taxonomy: WardrobeTaxonomy) throws -> URL? {
        if let flag = environment["SAINT_LOOK_BENCHMARK"], flag != "0" {
            guard flag == "1" else { throw FixtureError.invalidConfiguration }
            return try prepareBenchmark(environment: environment, support: support, resources: resources, taxonomy: taxonomy)
        }
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

    private struct BenchmarkManifest: Decodable {
        struct Asset: Decodable { let name: String; let sha256: String; let bytes: Int }
        struct Entry: Decodable {
            let itemId: UUID
            let cutoutOperationId: UUID
            let photoVersionId: UUID
            let sourceSetVersionId: UUID
            let sourceFile: String
            let cutoutFile: String
            let illustrationFile: String
            let preparedSourceFile: String
            let representationFile: String
            let illustration: IllustrationEvidence
            let preparation: PreparationResponse
        }
        struct IllustrationEvidence: Decodable {
            struct Source: Decodable {
                struct Versions: Decodable { let modelVersion: String; let templateVersion: String; let geometryVersion: String }
                let photoId: UUID
                let sourceSHA256: String
                let preparedSHA256: String
                let versions: Versions
            }
            let response: IllustrationResponse
            let preparedSources: [Source]
            private enum CodingKeys: String, CodingKey { case preparedSources }
            init(from decoder: Decoder) throws {
                response = try IllustrationResponse(from: decoder)
                preparedSources = try decoder.container(keyedBy: CodingKeys.self).decode([Source].self, forKey: .preparedSources)
            }
        }
        let schemaVersion: Int
        let count: Int
        let uniqueSources: Int
        let sourceRevision: String
        let imageProviders: String
        let sourceProvenance: String
        let benchmarkRevision: String
        let spaceID: String
        let tokenSHA256: String
        let assets: [Asset]
        let items: [Entry]
    }

    private static func benchmarkDigest(_ data: Data) throws -> String {
        #if canImport(CryptoKit)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #else
        throw FixtureError.invalidConfiguration
        #endif
    }

    /// Explicit synthetic load data, kept out of the owner's catalog and Release resources.
    private static func prepareBenchmark(environment: [String: String], support: URL, resources: URL,
                                         taxonomy: WardrobeTaxonomy) throws -> URL {
        func matches(_ value: String?, _ pattern: String) -> Bool {
            value?.range(of: pattern, options: .regularExpression) != nil
        }
        let token = environment["SAINT_LOOK_BENCHMARK_TOKEN"] ?? ""
        guard environment["SAINT_LOOK_BENCHMARK"] == "1", environment["SAINT_LOOK_UI_TESTING"] == "1",
              ["0", "1"].contains(environment["SAINT_LOOK_RESET_DATA"] ?? ""),
              environment["SAINT_LOOK_VISUAL_SCENARIO"] == nil,
              let rawOrigin = environment["SAINT_LOOK_BENCHMARK_ORIGIN"], let origin = URL(string: rawOrigin),
              matches(rawOrigin, "^http://127\\.0\\.0\\.1:[0-9]{1,5}/?$"),
              origin.scheme == "http", origin.host == "127.0.0.1", let port = origin.port, (1...65535).contains(port),
              origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              ["", "/"].contains(origin.path),
              environment["SAINT_LOOK_BASE_URL"] == rawOrigin, environment["SAINT_LOOK_OWNER_TOKEN"] == token,
              matches(token, "^bench-[a-f0-9]{64}$"),
              matches(environment["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"], "^[a-f0-9]{64}$"),
              matches(environment["SAINT_LOOK_BENCHMARK_REVISION"], "^[a-f0-9]{40}$"),
              token != (Bundle.main.object(forInfoDictionaryKey: "SaintLookDefaultOwnerToken") as? String) else {
            throw FixtureError.invalidConfiguration
        }
        let bundle = resources.appendingPathComponent("VisualFixtures/benchmark", isDirectory: true)
        let manifestBytes = try Data(contentsOf: bundle.appendingPathComponent("manifest.json"))
        guard manifestBytes.count <= 16 * 1024 * 1024,
              try benchmarkDigest(manifestBytes) == environment["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"] else {
            throw FixtureError.invalidConfiguration
        }
        let manifest = try JSONDecoder().decode(BenchmarkManifest.self, from: manifestBytes)
        guard manifest.schemaVersion == 1, [4, 300].contains(manifest.count), manifest.uniqueSources == 4,
              manifest.sourceRevision == "73700bab547ed71113dbf27db18136e054a1cca2",
              manifest.imageProviders == "synthetic-public-photo-copies",
              manifest.sourceProvenance == "public-manifest-encoder-on-runner",
              manifest.benchmarkRevision == environment["SAINT_LOOK_BENCHMARK_REVISION"],
              manifest.spaceID == "5232e383c329cb71cea3217bfd78b7f36128b1abb6657c94e2909635b638a24b",
              manifest.tokenSHA256 == (try benchmarkDigest(Data(token.utf8))), manifest.items.count == manifest.count,
              manifest.assets.count <= 512, Set(manifest.assets.map(\.name)).count == manifest.assets.count else {
            throw FixtureError.invalidConfiguration
        }
        var assets: [String: Data] = [:]
        var hashes: [String: String] = [:]
        var totalBytes = 0
        for asset in manifest.assets {
            guard matches(asset.name, "^[a-z0-9-]+\\.(png|jpg|json)$"), matches(asset.sha256, "^[a-f0-9]{64}$"),
                  asset.bytes > 0, asset.bytes <= 16 * 1024 * 1024 else { throw FixtureError.invalidConfiguration }
            totalBytes += asset.bytes
            guard totalBytes <= 64 * 1024 * 1024 else { throw FixtureError.invalidConfiguration }
            let bytes = try Data(contentsOf: bundle.appendingPathComponent(asset.name))
            guard bytes.count == asset.bytes, try benchmarkDigest(bytes) == asset.sha256 else { throw FixtureError.invalidConfiguration }
            assets[asset.name] = bytes; hashes[asset.name] = asset.sha256
        }
        guard Set(manifest.items.compactMap { hashes[$0.sourceFile] }).count == 4 else {
            throw FixtureError.invalidConfiguration
        }
        let root = support.appendingPathComponent("wardrobe-benchmark-fixtures", isDirectory: true)
        let marker = root.appendingPathComponent("benchmark-manifest.sha256")
        if environment["SAINT_LOOK_RESET_DATA"] == "0" {
            guard try String(contentsOf: marker, encoding: .utf8) == environment["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"] else {
                throw FixtureError.invalidConfiguration
            }
            let saved = try WardrobeCatalogFile(directory: root).load()
            guard saved.items.count == manifest.count, saved.items.allSatisfy(\.hasPreparedVersion),
                  Set(saved.items.map(\.id)) == Set(manifest.items.map(\.itemId)) else { throw FixtureError.invalidConfiguration }
            return root
        }
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var items: [WardrobeItem] = []
        var identities = Set<UUID>()
        let featuresEncoder = JSONEncoder(); featuresEncoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        for entry in manifest.items {
            let illustration = entry.illustration.response, preparation = entry.preparation
            let ids = [entry.itemId, entry.cutoutOperationId, entry.photoVersionId, entry.sourceSetVersionId,
                       illustration.operationId, preparation.operationId]
            guard ids.allSatisfy({ matches($0.uuidString.lowercased(), "^b300[0-9a-f]{4}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") }),
                  ids.allSatisfy({ identities.insert($0).inserted }),
                  let sourceHash = hashes[entry.sourceFile], let cutoutHash = hashes[entry.cutoutFile],
                  let illustrationHash = hashes[entry.illustrationFile], let preparedHash = hashes[entry.preparedSourceFile],
                  let representationBytes = assets[entry.representationFile], let representationHash = hashes[entry.representationFile],
                  let features = illustration.effectiveFeatures, let observed = illustration.observedFeatures,
                  features.isValid, observed.isValid, illustration.status == .ready, illustration.mode == "test",
                  features.traits.values.allSatisfy({ $0 == "unknown" }), observed.traits.values.allSatisfy({ $0 == "unknown" }),
                  sourceHash == cutoutHash, sourceHash == preparedHash,
                  illustration.modelVersion == IllustrationContract.currentModelVersion,
                  illustration.resultSHA256 == illustrationHash,
                  illustration.observedFeaturesSHA256 == (try benchmarkDigest(featuresEncoder.encode(observed))),
                  illustration.effectiveFeaturesSHA256 == (try benchmarkDigest(featuresEncoder.encode(features))),
                  entry.illustration.preparedSources.count == 1, let preparedSource = entry.illustration.preparedSources.first,
                  preparedSource.photoId == entry.photoVersionId, preparedSource.sourceSHA256 == sourceHash,
                  preparedSource.preparedSHA256 == preparedHash,
                  preparedSource.versions.modelVersion == illustration.modelVersion,
                  preparedSource.versions.templateVersion == illustration.templateVersion,
                  preparedSource.versions.geometryVersion == illustration.geometryVersion,
                  preparation.status == .ready, preparation.mode == "real", preparation.imageMode == "test",
                  preparation.provenance == "syntheticBenchmarkFixture", preparation.spaceID == manifest.spaceID,
                  preparation.itemId == entry.itemId, preparation.photoVersionId == entry.photoVersionId,
                  preparation.sourceSetVersionId == entry.sourceSetVersionId, preparation.cutoutOperationId == entry.cutoutOperationId,
                  preparation.illustrationOperationId == illustration.operationId, preparation.revision == illustration.revision,
                  preparation.representationSHA256 == representationHash,
                  preparation.representationJSON == String(data: representationBytes, encoding: .utf8),
                  preparation.input?.sourceSHA256 == sourceHash,
                  preparation.artifacts == PreparationArtifacts(cutoutSHA256: cutoutHash, illustrationSHA256: illustrationHash,
                    observedFeaturesSHA256: illustration.observedFeaturesSHA256!, effectiveFeaturesSHA256: illustration.effectiveFeaturesSHA256!) else {
                throw FixtureError.invalidConfiguration
            }
            let canonical = try CanonicalItemFeatures(displayType: features.type, colors: features.colors, taxonomy: taxonomy)
            let text = canonical.type.replacingOccurrences(of: "_", with: " ")
                + (canonical.colors.isEmpty ? "" : ". Colors: " + canonical.colors.joined(separator: ", ")) + "."
            let representation = try JSONSerialization.jsonObject(with: representationBytes) as? [String: Any]
            let vector = representation?["vector"] as? [Double]
            guard preparation.effectiveFeatures == canonical, preparation.input?.textSHA256 == (try benchmarkDigest(Data(text.utf8))),
                  representation?["schemaVersion"] as? Int == 1, representation?["spaceID"] as? String == manifest.spaceID,
                  representation?["photoVersionID"] as? String == entry.photoVersionId.uuidString.lowercased(),
                  representation?["sourceSHA256"] as? String == sourceHash, representation?["textSHA256"] as? String == preparation.input?.textSHA256,
                  let vector, vector.count == 128, vector.allSatisfy(\.isFinite) else { throw FixtureError.invalidConfiguration }
            let squaredNorm = vector.reduce(0) { $0 + $1 * $1 }
            guard squaredNorm.isFinite, squaredNorm > 1e-12, squaredNorm < 1e12 else { throw FixtureError.invalidConfiguration }
            var item = WardrobeItem(id: entry.itemId, operationID: entry.cutoutOperationId, photoVersionID: entry.photoVersionId)
            item.sourceSetVersionID = entry.sourceSetVersionId
            item.status = .ready; item.mode = .demo; item.resultMode = .demo; item.uploadStarted = true
            item.originalFilename = entry.sourceFile; item.uploadFilename = entry.sourceFile
            item.resultFilename = entry.cutoutFile; item.resultSHA256 = cutoutHash
            item.type = features.type; item.colors = features.colors
            let request = IllustrationRequest(operationID: illustration.operationId, photoVersionID: entry.photoVersionId,
                sourceSetVersionID: entry.sourceSetVersionId, revision: illustration.revision,
                manualType: nil, manualColors: nil, status: .ready, submitted: true)
            try illustration.validate(for: item, request: request)
            item.illustration = request
            item.illustrationResult = IllustrationResult(filename: entry.illustrationFile, response: illustration)
            item.publishedVersion = ItemPublication(versionID: preparation.operationId, photoVersionID: entry.photoVersionId,
                sourceSetVersionID: entry.sourceSetVersionId, cutoutFilename: entry.cutoutFile, cutoutMode: .demo,
                illustration: item.illustrationResult, type: features.type, colors: features.colors, completeness: .prepared,
                representation: StoredRepresentation(filename: entry.representationFile, response: preparation), cutoutOperationID: entry.cutoutOperationId)
            item.preparationRevision = preparation.revision; item.photosLocked = true
            item.preparedPhotos = [IllustrationPreparedPhoto(photoID: entry.photoVersionId, filename: entry.preparedSourceFile,
                sourceDigest: sourceHash, preparedDigest: preparedHash, modelVersion: illustration.modelVersion,
                templateVersion: illustration.templateVersion, geometryVersion: illustration.geometryVersion)]
            guard item.hasPreparedVersion else { throw FixtureError.invalidConfiguration }
            let folder = root.appendingPathComponent(item.directoryName, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for filename in Set([entry.sourceFile, entry.cutoutFile, entry.illustrationFile, entry.preparedSourceFile, entry.representationFile]) {
                guard let bytes = assets[filename] else { throw FixtureError.invalidConfiguration }
                try bytes.write(to: folder.appendingPathComponent(filename), options: .atomic)
            }
            items.append(item)
        }
        guard let body = items.first(where: { OutfitZone.body.accepts($0, taxonomy: taxonomy) }),
              let bottom = items.first(where: { OutfitZone.bottom.accepts($0, taxonomy: taxonomy) }) else { throw FixtureError.invalidConfiguration }
        // A valid saved look is opened, then its body is cleared through the UI before measuring a draft.
        var outfit = Outfit(id: UUID(uuidString: "36000004-0000-4000-8000-000000000300")!, name: "Benchmark300")
        outfit.selectItem(body.id, for: outfit.slots[1].id); outfit.selectItem(bottom.id, for: outfit.slots[2].id)
        let file = WardrobeCatalogFile(directory: root)
        try file.save(WardrobeCatalog(items: items, pendingAcknowledgements: [], outfits: [outfit]))
        let loaded = try file.load()
        guard loaded.items.count == manifest.count, loaded.items.allSatisfy(\.hasPreparedVersion) else { throw FixtureError.invalidConfiguration }
        try Data(environment["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"]!.utf8).write(to: marker, options: .atomic)
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
                modelVersion: IllustrationContract.currentModelVersion, templateVersion: "front-360x560-proposed-v1",
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
