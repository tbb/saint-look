import Foundation

@main
struct OutfitCoreChecks {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = WardrobeCatalogFile(directory: root)
        var catalog = try file.load()
        let shirtID = UUID(), jeansID = UUID()
        var outfit = Outfit()
        outfit.slots[1].itemID = shirtID
        outfit.slots[2].itemID = jeansID
        catalog.outfits = [outfit]
        try file.save(catalog)
        let restored = try WardrobeCatalogFile(directory: root).load()
        precondition(restored.outfits.count == 1)
        precondition(restored.outfits[0].id == outfit.id)
        precondition(restored.outfits[0].displayName == "Лук без названия")
        precondition(restored.outfits[0].slots[1].itemID == shirtID)
        precondition(restored.outfits[0].slots[2].itemID == jeansID)
        print("PASS: saved outfit opens with the same selection after restart")

        let taxonomy = try JSONDecoder().decode(WardrobeTaxonomy.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        var shirt = WardrobeItem(id: shirtID, operationID: UUID(), photoVersionID: UUID())
        shirt.status = .ready
        shirt.type = "Футболка"
        shirt.resultFilename = "result.png"
        var jeans = WardrobeItem(id: jeansID, operationID: UUID(), photoVersionID: UUID())
        jeans.status = .ready
        jeans.type = "Джинсы"
        jeans.resultFilename = "result.png"
        catalog.items = [shirt, jeans]
        catalog.outfits = []
        let cutouts: Set<UUID> = [shirtID, jeansID]
        do {
            try catalog.saveOutfit(outfit, taxonomy: taxonomy, availableCutouts: cutouts)
            fatalError("Cutouts alone must not admit an incomplete item to a new look")
        } catch OutfitError.unavailableItem { }
        shirt = try preparedFixture(shirt)
        jeans = try preparedFixture(jeans)
        catalog.items = [shirt, jeans]
        try catalog.saveOutfit(outfit, taxonomy: taxonomy, availableCutouts: cutouts)
        try catalog.saveOutfit(outfit, taxonomy: taxonomy, availableCutouts: cutouts)
        precondition(catalog.outfits.count == 1, "Repeated save must not duplicate a look")
        var invalid = Outfit()
        invalid.slots[1].itemID = shirtID
        do {
            try catalog.saveOutfit(invalid, taxonomy: taxonomy, availableCutouts: cutouts)
            fatalError("One thing must not save")
        } catch OutfitError.tooFewItems { }
        invalid.slots[2].itemID = shirtID
        do {
            try catalog.saveOutfit(invalid, taxonomy: taxonomy, availableCutouts: cutouts)
            fatalError("A duplicate must not save")
        } catch OutfitError.duplicateItem { }
        invalid.slots[2].itemID = jeansID
        do {
            try catalog.saveOutfit(invalid, taxonomy: taxonomy, availableCutouts: [shirtID])
            fatalError("Missing local cutout must not save")
        } catch OutfitError.unavailableItem { }
        let ack = ResultAcknowledgement(itemID: jeansID, operationID: jeans.operationID)
        catalog.pendingAcknowledgements = [ack]
        catalog.removeItem(jeansID)
        precondition(catalog.pendingDeletionIDs.contains(jeansID))
        precondition(catalog.pendingAcknowledgements == [])
        precondition(catalog.outfits[0].slots[2].id == outfit.slots[2].id)
        precondition(catalog.outfits[0].slots[2].itemID == nil)
        precondition(catalog.outfits[0].slots[2].needsReplacement)
        catalog.removeItem(shirtID)
        try file.save(catalog)
        let emptyRestored = try file.load()
        precondition(emptyRestored.outfits.count == 1, "An empty look survives deleting its last thing")
        print("PASS: selection validation, idempotent save, and durable empty placeholders")

        // Body rows keep their identity, order and deliberate gaps across restart.
        var layered = Outfit()
        let firstBody = layered.slots[1].id
        let middleBody = layered.addBodyLayer()
        let lastBody = layered.addBodyLayer()
        layered.selectItem(shirtID, for: firstBody)
        layered.selectItem(jeansID, for: layered.slots.first { $0.zone == .bottom }!.id)
        var layeredCatalog = WardrobeCatalog(items: [shirt, jeans])
        try layeredCatalog.saveOutfit(layered, taxonomy: taxonomy, availableCutouts: cutouts)
        try file.save(layeredCatalog)
        let layeredRestored = try file.load().outfits[0]
        precondition(layeredRestored.slots.filter { $0.zone == .body }.map(\.id) == [firstBody, middleBody, lastBody])
        precondition(layeredRestored.slots.filter { $0.zone == .body }.map(\.itemID) == [shirtID, nil, nil])
        layered.removeBodyLayer(middleBody)
        layered.removeBodyLayer(lastBody)
        layered.removeBodyLayer(firstBody)
        precondition(layered.slots.filter { $0.zone == .body }.map(\.id) == [firstBody])
        precondition(layered.slots.first { $0.id == firstBody }!.itemID == nil)
        precondition(layered.slots.first { $0.zone == .bottom }!.itemID == jeansID)
        print("PASS: body rows preserve order and empty gaps; the last row clears instead of disappearing")

        // Cycling changes only the addressed row and cannot reuse another layer's thing.
        var hoodie = WardrobeItem(id: UUID(), operationID: UUID(), photoVersionID: UUID())
        hoodie.status = .ready; hoodie.type = "Худи"; hoodie.resultFilename = "result.png"
        var jacket = WardrobeItem(id: UUID(), operationID: UUID(), photoVersionID: UUID())
        jacket.status = .ready; jacket.type = "Куртка"; jacket.resultFilename = "result.png"
        hoodie = try preparedFixture(hoodie)
        jacket = try preparedFixture(jacket)
        var cycling = Outfit()
        let cyclingFirst = cycling.slots[1].id
        let cyclingSecond = cycling.addBodyLayer()
        cycling.selectItem(shirtID, for: cyclingFirst)
        cycling.selectItem(hoodie.id, for: cyclingSecond)
        cycling.cycleItem(for: cyclingFirst, among: [shirtID, hoodie.id, jacket.id], forward: true)
        precondition(cycling.slots.first { $0.id == cyclingFirst }!.itemID == jacket.id)
        precondition(cycling.slots.first { $0.id == cyclingSecond }!.itemID == hoodie.id)
        cycling.cycleItem(for: cyclingFirst, among: [shirtID, hoodie.id, jacket.id], forward: true)
        precondition(cycling.slots.first { $0.id == cyclingFirst }!.itemID == shirtID)
        cycling.cycleItem(for: cyclingFirst, among: [shirtID, hoodie.id, jacket.id], forward: false)
        precondition(cycling.slots.first { $0.id == cyclingFirst }!.itemID == jacket.id)
        cycling.selectItem(hoodie.id, for: cyclingFirst)
        precondition(cycling.slots.first { $0.id == cyclingFirst }!.itemID == jacket.id)
        var cyclingCatalog = WardrobeCatalog(items: [shirt, hoodie, jacket])
        try cyclingCatalog.saveOutfit(cycling, taxonomy: taxonomy, availableCutouts: [shirtID, hoodie.id, jacket.id])
        try file.save(cyclingCatalog)
        let twoLayers = try file.load().outfits[0]
        precondition(twoLayers.slots.filter { $0.zone == .body }.map(\.itemID) == [jacket.id, hoodie.id])
        precondition(twoLayers.slots.first { $0.zone == .bottom }!.itemID == nil)
        print("PASS: forward/backward cycling wraps independently, excludes duplicates, and two body layers save")

        // A changed wardrobe never revives an old candidate or erases a row by accident.
        let beforeSmallPool = cycling
        cycling.cycleItem(for: cyclingFirst, among: [], forward: true)
        cycling.cycleItem(for: cyclingFirst, among: [jacket.id], forward: false)
        precondition(cycling == beforeSmallPool)
        cyclingCatalog.removeItem(jacket.id)
        var afterDeletion = cyclingCatalog.outfits[0]
        precondition(afterDeletion.slots.filter { $0.zone == .body }.map(\.id) == [cyclingFirst, cyclingSecond])
        precondition(afterDeletion.slots.first { $0.id == cyclingFirst }!.needsReplacement)
        let replacementID = UUID()
        afterDeletion.cycleItem(for: cyclingFirst, among: [shirtID, hoodie.id, replacementID], forward: true)
        precondition(afterDeletion.slots.first { $0.id == cyclingFirst }!.itemID == shirtID)
        precondition(!afterDeletion.slots.first { $0.id == cyclingFirst }!.needsReplacement)
        precondition(afterDeletion.slots.first { $0.id == cyclingSecond }!.itemID == hoodie.id)
        // A former candidate changes type while selected; the fresh pool does not contain it.
        afterDeletion.cycleItem(for: cyclingFirst, among: [hoodie.id, replacementID, jeansID], forward: false)
        precondition(afterDeletion.slots.first { $0.id == cyclingFirst }!.itemID == jeansID)
        afterDeletion.selectItem(nil, for: cyclingFirst)
        afterDeletion.cycleItem(for: cyclingFirst, among: [replacementID], forward: true)
        precondition(afterDeletion.slots.first { $0.id == cyclingFirst }!.itemID == replacementID, "An empty slot can select its only available candidate")
        afterDeletion.removeBodyLayer(cyclingFirst)
        let afterRemoval = afterDeletion
        afterDeletion.cycleItem(for: cyclingFirst, among: [shirtID, replacementID], forward: true)
        precondition(afterDeletion == afterRemoval, "A stale gesture cannot target a different row")
        print("PASS: empty/single pools, removed candidates and stale row gestures keep the remaining composition safe")

        // Shuffle respects stable slots and a pool containing items already pinned elsewhere.
        var shuffled = Outfit()
        let fixedBody = shuffled.slots[1].id
        let freeBody = shuffled.addBodyLayer()
        shuffled.selectItem(shirtID, for: fixedBody)
        shuffled.selectItem(hoodie.id, for: freeBody)
        let beforeShuffle = shuffled
        shuffled.shuffle(pinnedSlotIDs: [fixedBody], candidates: [.body: [shirtID, hoodie.id, jacket.id], .bottom: [jeansID]])
        precondition(shuffled.slots.first { $0.id == fixedBody }!.itemID == shirtID)
        precondition(shuffled.slots.first { $0.id == freeBody }!.itemID == jacket.id)
        precondition(shuffled.slots.first { $0.zone == .bottom }!.itemID == jeansID)
        precondition(shuffled.selectedIDs.count == 3)
        let allPinned = shuffled
        shuffled.shuffle(pinnedSlotIDs: Set(shuffled.slots.map(\.id)), candidates: [.body: [shirtID, hoodie.id, jacket.id]])
        precondition(shuffled == allPinned)
        shuffled.shuffle(pinnedSlotIDs: [], candidates: [:])
        precondition(shuffled == allPinned, "An empty wardrobe pool must not clear existing references")
        print("PASS: shuffle changes only unlocked slots with eligible candidates without duplicates")

        var history = OutfitCompositionHistory()
        history.recordChange(from: beforeShuffle, to: allPinned)
        shuffled.name = "Название не отменяется"
        history.undo(in: &shuffled, availableItemIDs: [shirtID, hoodie.id, jacket.id, jeansID])
        precondition(shuffled.slots == beforeShuffle.slots, "A whole shuffle is undone in one action")
        precondition(shuffled.name == "Название не отменяется")
        let beforeClear = shuffled
        shuffled.selectItem(nil, for: fixedBody)
        history.recordChange(from: beforeClear, to: shuffled)
        history.undo(in: &shuffled, availableItemIDs: [hoodie.id, jacket.id, jeansID])
        precondition(shuffled.slots.first { $0.id == fixedBody }!.itemID == nil)
        precondition(shuffled.slots.first { $0.id == fixedBody }!.needsReplacement)
        precondition(shuffled.slots.first { $0.id == freeBody }!.itemID == hoodie.id)
        precondition(!history.canUndo)
        print("PASS: atomic composition undo preserves name and never revives a deleted wardrobe item")

        // Both historical formats are loaded without replacing the user's wardrobe.
        let catalogURL = root.appendingPathComponent("catalog.json")
        try JSONEncoder().encode([shirt, jeans]).write(to: catalogURL)
        let legacyArray = try file.load()
        precondition(legacyArray.items.map(\.id) == [shirtID, jeansID])
        precondition(legacyArray.outfits.isEmpty && legacyArray.pendingAcknowledgements == nil)
        let deletedID = UUID()
        let queued = WardrobeCatalog(items: [shirt, jeans], pendingDeletionIDs: [deletedID], pendingAcknowledgements: [ack])
        var oldObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(queued)) as! [String: Any]
        oldObject.removeValue(forKey: "outfits")
        try JSONSerialization.data(withJSONObject: oldObject).write(to: catalogURL)
        var migrated = try file.load()
        try migrated.saveOutfit(outfit, taxonomy: taxonomy, availableCutouts: cutouts)
        try file.save(migrated)
        // A late processing/acknowledgement update changes only its owned fields.
        migrated = try file.load()
        migrated.items[0].colors = ["Белый"]
        migrated.pendingAcknowledgements = []
        try file.save(migrated)
        let afterResponse = try file.load()
        precondition(afterResponse.outfits == [outfit])
        precondition(afterResponse.pendingDeletionIDs == [deletedID])
        precondition(afterResponse.items[0].colors == ["Белый"])
        precondition(afterResponse.items[1].id == jeansID)
        let invalidJSON = Data("{broken".utf8)
        try invalidJSON.write(to: catalogURL)
        do { _ = try file.load(); fatalError("A corrupt catalog must not reset silently") }
        catch is DecodingError { }
        let unchangedData = try Data(contentsOf: catalogURL)
        precondition(unchangedData == invalidJSON)
        print("PASS: legacy migration, queued commands, later item updates, corrupt-file preservation")

        // Candidate rules use the effective manual type, never a guessed fallback.
        var corrected = shirt
        corrected.publishedVersion = nil // Category mapping also applies to editable incomplete items.
        corrected.manualType = "Брюки"
        precondition(OutfitZone.bottom.accepts(corrected, taxonomy: taxonomy))
        precondition(!OutfitZone.body.accepts(corrected, taxonomy: taxonomy))
        corrected.manualType = "Платье"
        precondition(!OutfitZone.allCases.contains { $0.accepts(corrected, taxonomy: taxonomy) })
        corrected.manualType = "Неизвестно"
        precondition(!OutfitZone.allCases.contains { $0.accepts(corrected, taxonomy: taxonomy) })
        print("PASS: effective type and excluded categories control new choices")

        // Renaming a saved look remains possible after wardrobe deletions.
        var editing = WardrobeCatalog(items: [shirt, jeans], outfits: [outfit])
        editing.removeItem(jeansID)
        var incomplete = editing.outfits[0]
        incomplete.name = "  На прогулку  "
        try editing.saveOutfit(incomplete, taxonomy: taxonomy, availableCutouts: [shirtID])
        precondition(editing.outfits[0].name == "На прогулку")
        precondition(editing.outfits[0].id == outfit.id)
        editing.removeItem(shirtID)
        var emptyRename = editing.outfits[0]
        emptyRename.name = ""
        try editing.saveOutfit(emptyRename, taxonomy: taxonomy, availableCutouts: [])
        precondition(editing.outfits[0].displayName == "Лук без названия")
        var changedEmpty = editing.outfits[0]
        changedEmpty.addBodyLayer()
        do {
            try editing.saveOutfit(changedEmpty, taxonomy: taxonomy, availableCutouts: [])
            fatalError("A changed incomplete composition must not save")
        } catch OutfitError.tooFewItems { }
        precondition(editing.outfits[0].slots == emptyRename.slots)
        try file.save(editing)
        let renamedRestored = try file.load()
        precondition(renamedRestored.outfits.count == 1)
        precondition(renamedRestored.outfits[0].selectedIDs.isEmpty)
        print("PASS: incomplete and empty looks can rename, composition changes still require two things")

        let other = Outfit(name: "Второй", slots: outfit.slots)
        var deletion = WardrobeCatalog(items: [shirt, jeans], pendingDeletionIDs: [deletedID],
            pendingAcknowledgements: [ack], outfits: [outfit, other])
        deletion.removeOutfit(outfit.id)
        try file.save(deletion)
        let deletedRestored = try file.load()
        precondition(deletedRestored.outfits == [other])
        precondition(deletedRestored.items.map(\.id) == [shirtID, jeansID])
        precondition(deletedRestored.pendingDeletionIDs == [deletedID])
        precondition(deletedRestored.pendingAcknowledgements == [ack])
        print("PASS: deleting one look preserves its shared things, other looks and offline queues")

        // An editor opened before deletion cannot write the removed reference back.
        var current = WardrobeCatalog(items: [shirt, jeans], outfits: [outfit, other])
        var staleDraft = outfit
        staleDraft.name = "Старый черновик"
        current.removeItem(jeansID)
        do {
            try current.saveOutfit(staleDraft, taxonomy: taxonomy, availableCutouts: cutouts)
            fatalError("A stale editor must not revive a deleted thing")
        } catch OutfitError.unavailableItem { }
        let reconciledDraft = staleDraft.removingItem(jeansID)
        try current.saveOutfit(reconciledDraft, taxonomy: taxonomy, availableCutouts: [shirtID])
        precondition(current.outfits[0].slots[2].itemID == nil)
        precondition(current.outfits[0].slots[2].needsReplacement)
        precondition(current.items.map(\.id) == [shirtID])
        precondition(current.outfits[1].slots[2].needsReplacement)
        // Existing slot remains in place after type correction or a retry.
        current.items[0].manualType = "Брюки"
        current.items[0].status = .pending
        var duringRetry = current.outfits[0]
        duringRetry.name = "Во время обработки"
        try current.saveOutfit(duringRetry, taxonomy: taxonomy, availableCutouts: [shirtID])
        precondition(current.outfits[0].slots[1].zone == .body)
        precondition(current.outfits[0].slots[1].itemID == shirtID)
        precondition(current.items[0].resultFilename == "result.png")
        try file.save(current)
        let beforeFailure = try file.load()
        var failedChange = current
        failedChange.outfits[0].name = "Не записалось"
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path) }
        do {
            try file.save(failedChange)
            fatalError("Writing into a read-only directory must fail (run checks as non-root)")
        } catch { }
        let afterFailure = try file.load()
        precondition(afterFailure.outfits == beforeFailure.outfits)
        precondition(afterFailure.items.map(\.id) == beforeFailure.items.map(\.id))
        precondition(afterFailure.pendingDeletionIDs == beforeFailure.pendingDeletionIDs)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        print("PASS: stale editor cannot revive deletion, references survive retries, failed atomic write preserves saved catalog")

        // Publication is observed through the same catalog commands used by the app.
        var publishing = WardrobeCatalog(items: [shirt, jeans], outfits: [outfit])
        publishing.items[0].publishedVersion = nil
        publishing.items[0].photosLocked = false
        let initialRequest = IllustrationRequest(operationID: UUID(), photoVersionID: shirt.photoVersionID,
            sourceSetVersionID: shirt.sourceSetVersionID, revision: 1, manualType: nil, manualColors: nil, status: .ready)
        publishing.items[0].illustration = initialRequest
        let source = IllustrationPreparedPhoto(photoID: shirt.photoVersionID, filename: "prepared-original.png",
            sourceDigest: "original-digest", preparedDigest: "prepared-digest", modelVersion: "fal-ai/nano-banana-pro/edit",
            templateVersion: "front-360x560-proposed-v1", geometryVersion: "fitting-square-1024-v1")
        let firstResult = illustrationResult(item: shirt, request: initialRequest, type: "Футболка", filename: "first-illustration.png")
        try publishing.stageIllustration(for: shirtID, request: initialRequest, result: firstResult, preparedPhotos: [source])
        precondition(publishing.items[0].pendingPublication == nil && publishing.items[0].canEditPhotos)
        precondition(!publishing.items[0].hasPreparedVersion, "Illustration readiness alone must never admit an item")
        do {
            try publishing.confirmPublication(for: shirtID, operationID: initialRequest.operationID)
            fatalError("A downloaded illustration cannot commit without prepared representations")
        } catch is CancellationError { }
        try stagePrepared(&publishing, for: shirtID, request: initialRequest, result: firstResult, preparedPhotos: [source])
        precondition(!publishing.items[0].photosLocked, "Downloaded output is not yet a committed publication")
        precondition(!publishing.items[0].canEditPhotos, "An uncertain commit freezes source editing until reconciliation")
        try file.save(publishing)
        publishing = try file.load()
        precondition(publishing.items[0].pendingPublication != nil)
        do {
            try publishing.editAttributes(for: shirtID, type: "Куртка", colors: nil, taxonomy: taxonomy)
            fatalError("An uncertain publication cannot change its input")
        } catch ClientError.publicationInProgress { }
        try publishing.confirmPublication(for: shirtID, operationID: initialRequest.operationID)
        precondition(publishing.items[0].photosLocked)
        precondition(publishing.items[0].publishedVersion?.completeness == .prepared)
        try publishing.editAttributes(for: shirtID, type: "Худи", colors: ["Чёрный"], taxonomy: taxonomy)
        precondition(publishing.items[0].editedType == "Худи")
        precondition(publishing.items[0].displayedType == "Футболка")
        precondition(publishing.items[0].displayedColors == ["Белый"])
        let next = IllustrationRequest(operationID: UUID(), photoVersionID: shirt.photoVersionID,
            sourceSetVersionID: shirt.sourceSetVersionID, revision: 2, manualType: "Худи", manualColors: ["Чёрный"])
        publishing.items[0].illustration = next
        try file.save(publishing)
        publishing = try file.load()
        precondition(publishing.items[0].photosLocked && publishing.items[0].hasUsableImageVersion)
        precondition(publishing.items[0].displayedIllustration?.filename == "first-illustration.png")
        precondition(publishing.outfits == [outfit])
        publishing.items[0].illustration?.status = .failed
        publishing.items[0].illustration?.error = "offline"
        try file.save(publishing)
        publishing = try file.load()
        precondition(publishing.items[0].displayedType == "Футболка")
        precondition(publishing.items[0].editedType == "Худи")
        precondition(publishing.items[0].displayedIllustration?.filename == "first-illustration.png")
        var completed = next
        completed.status = .ready
        let newResult = illustrationResult(item: shirt, request: completed, type: "Худи", filename: "second-illustration.png")
        do {
            try stagePrepared(&publishing, for: shirtID, request: completed, result: newResult, preparedPhotos: [])
            fatalError("A partial package must not publish")
        } catch ClientError.invalidResponse { }
        precondition(publishing.items[0].displayedType == "Футболка")
        try stagePrepared(&publishing, for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
        precondition(publishing.items[0].displayedType == "Футболка", "Staging is not visible publication")
        try file.save(publishing)
        publishing = try file.load()
        try publishing.confirmPublication(for: shirtID, operationID: completed.operationID)
        try file.save(publishing)
        let published = try file.load()
        precondition(published.items[0].displayedType == "Худи")
        precondition(published.items[0].displayedColors == ["Чёрный"])
        precondition(published.items[0].displayedIllustration?.filename == "second-illustration.png")
        precondition(published.items[0].publishedVersion?.versionID == published.items[0].publishedVersion?.representation?.response.operationId)
        precondition(published.items[0].publishedVersion?.representation?.response.illustrationOperationId == completed.operationID)
        precondition(published.outfits == [outfit])
        var deletingCommit = published
        try stagePrepared(&deletingCommit, for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
        deletingCommit.removeItem(shirtID)
        try file.save(deletingCommit)
        deletingCommit = try file.load()
        do {
            try deletingCommit.confirmPublication(for: shirtID, operationID: completed.operationID)
            fatalError("A late successful commit response must not restore deletion")
        } catch is CancellationError { }
        precondition(deletingCommit.pendingDeletionIDs.contains(shirtID))
        precondition(deletingCommit.outfits[0].slots.first { $0.zone == .body }?.itemID == nil)
        try publishing.editAttributes(for: shirtID, type: "Куртка", colors: nil, taxonomy: taxonomy)
        do {
            try stagePrepared(&publishing, for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
            fatalError("A late package must not cancel a newer edit")
        } catch is CancellationError { }
        publishing.removeItem(shirtID)
        do {
            try stagePrepared(&publishing, for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
            fatalError("A late publication must not restore a deleted thing")
        } catch is CancellationError { }
        precondition(publishing.items.map(\.id) == [jeansID])
        print("PASS: attribute updates publish atomically, partial/failed/offline updates retain the old version, stale results cannot restore edits or deletions")

        // Preparation is a separate durable operation; no encoder response can
        // change a publication until matching files and the commit are confirmed.
        var preparing = published
        try preparing.stageIllustration(for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
        let preparation = try preparationIntent(item: preparing.items[0], candidate: preparing.items[0].downloadedIllustration!)
        try preparing.beginPreparation(for: shirtID, intent: preparation)
        var submittedPreparation = preparation
        submittedPreparation.submitted = true
        try preparing.savePreparation(for: shirtID, intent: submittedPreparation)
        try file.save(preparing)
        preparing = try file.load()
        precondition(preparing.items[0].preparation?.operationID == preparation.operationID)
        precondition(preparing.items[0].preparation?.submitted == true)
        precondition(preparing.items[0].publishedVersion?.versionID == published.items[0].publishedVersion?.versionID)
        let preparedResponse = preparationResponse(item: preparing.items[0], intent: preparation)
        do {
            try preparing.stagePreparation(for: shirtID, response: preparedResponse, representationFilename: "broken.json",
                representationDigest: "wrong-hash", actualArtifacts: preparation.artifacts, actualSourceDigest: preparation.sourceSHA256)
            fatalError("Corrupted representation bytes must never stage")
        } catch ClientError.invalidResponse { }
        do {
            try preparing.stagePreparation(for: shirtID, response: preparedResponse, representationFilename: "response.json",
                representationDigest: preparedResponse.representationSHA256!, actualArtifacts: preparation.artifacts, actualSourceDigest: "different-photo")
            fatalError("Representation from another original must never stage")
        } catch ClientError.invalidResponse { }
        var encoderFailure = preparation
        encoderFailure.status = .failed; encoderFailure.error = "encoder_failed"
        try preparing.savePreparation(for: shirtID, intent: encoderFailure)
        try file.save(preparing)
        preparing = try file.load()
        precondition(preparing.items[0].hasPreparedVersion, "Previous complete packet remains available after encoder failure/restart")
        precondition(preparing.items[0].publishedVersion?.versionID == published.items[0].publishedVersion?.versionID)
        var supersededPreparation = preparing
        let newerPreparation = try preparationIntent(item: supersededPreparation.items[0], candidate: supersededPreparation.items[0].downloadedIllustration!, space: "next-controlled-space")
        try supersededPreparation.beginPreparation(for: shirtID, intent: newerPreparation)
        do {
            try supersededPreparation.stagePreparation(for: shirtID, response: preparedResponse, representationFilename: "old.json",
                representationDigest: preparedResponse.representationSHA256!, actualArtifacts: preparation.artifacts, actualSourceDigest: preparation.sourceSHA256)
            fatalError("Late response for the old operation/space must not replace the new intent")
        } catch ClientError.invalidResponse { }
        var editedPreparation = preparing
        try editedPreparation.editAttributes(for: shirtID, type: "Куртка", colors: nil, taxonomy: taxonomy)
        do {
            try editedPreparation.stagePreparation(for: shirtID, response: preparedResponse, representationFilename: "late.json",
                representationDigest: preparedResponse.representationSHA256!, actualArtifacts: preparation.artifacts, actualSourceDigest: preparation.sourceSHA256)
            fatalError("Late preparation must not overwrite newer manual input")
        } catch is CancellationError { }
        precondition(editedPreparation.items[0].editedType == "Куртка" && editedPreparation.items[0].displayedType == "Худи")
        try preparing.stagePreparation(for: shirtID, response: preparedResponse, representationFilename: "exact.json",
            representationDigest: preparedResponse.representationSHA256!, actualArtifacts: preparation.artifacts, actualSourceDigest: preparation.sourceSHA256)
        try file.save(preparing)
        preparing = try file.load()
        precondition(preparing.items[0].pendingPublication?.publication.representation?.response.representationJSON == "{\"fixture\": 1.00000000001}")
        precondition(!preparing.items[0].canEditAttributes && preparing.items[0].publishedVersion?.versionID != preparation.operationID)
        try preparing.confirmPublication(for: shirtID, operationID: completed.operationID)
        precondition(preparing.items[0].publishedVersion?.versionID == preparation.operationID && preparing.items[0].hasPreparedVersion)
        precondition(preparing.items[0].preparation == nil && preparing.items[0].downloadedIllustration == nil)
        // Generator cache is intermediate: losing it must not force paid work
        // during an encoder-only legacy import or representation refresh.
        for mode in [ItemPreparation.Mode.legacyImport, .reusePublication] {
            var cacheless = published
            let packet = PendingItemPublication(publication: cacheless.items[0].publishedVersion!, request: completed, preparedPhotos: [])
            let intent = try preparationIntent(item: cacheless.items[0], candidate: packet, mode: mode)
            try cacheless.beginPreparation(for: shirtID, intent: intent)
            let response = preparationResponse(item: cacheless.items[0], intent: intent)
            try cacheless.stagePreparation(for: shirtID, response: response, representationFilename: "cacheless.json",
                representationDigest: response.representationSHA256!, actualArtifacts: intent.artifacts, actualSourceDigest: intent.sourceSHA256)
            var uncertain = cacheless.items[0].preparation!
            uncertain.status = .failed; uncertain.error = "confirmation_failed" // e.g. credentials repaired after401
            try cacheless.savePreparation(for: shirtID, intent: uncertain)
            try file.save(cacheless)
            cacheless = try file.load()
            try cacheless.resumePreparation(for: shirtID)
            precondition(cacheless.items[0].preparation?.status == .pending)
            precondition(cacheless.items[0].preparation?.operationID == intent.operationID)
            precondition(cacheless.items[0].pendingPublication?.publication.versionID == intent.operationID)
            precondition(!cacheless.items[0].canEditPhotos)
            try cacheless.confirmPublication(for: shirtID, operationID: completed.operationID)
            precondition(cacheless.items[0].hasPreparedVersion && cacheless.items[0].preparedPhotos.isEmpty)
            precondition(cacheless.items[0].publishedVersion?.representation?.response.provenance == intent.provenance)
        }
        var transportUnavailable = preparation
        transportUnavailable.status = .failed; transportUnavailable.error = "encoder_unavailable"
        precondition(!transportUnavailable.needsNewAttempt, "A transport503 does not prove an accepted operation failed")
        var terminalUnavailable = transportUnavailable
        terminalUnavailable.terminalFailure = true
        var stoppedWorker = published
        try stoppedWorker.beginPreparation(for: shirtID, intent: terminalUnavailable)
        try file.save(stoppedWorker)
        stoppedWorker = try file.load()
        precondition(stoppedWorker.items[0].preparation?.needsNewAttempt == true,
                     "A persisted failed server row requires a new CPU operation when the model becomes available")
        precondition(stoppedWorker.items[0].publishedVersion?.versionID == published.items[0].publishedVersion?.versionID)
        var strictNew = published
        let cachelessNew = PendingItemPublication(publication: strictNew.items[0].publishedVersion!, request: completed, preparedPhotos: [])
        do {
            let intent = try preparationIntent(item: strictNew.items[0], candidate: cachelessNew)
            try strictNew.beginPreparation(for: shirtID, intent: intent)
            fatalError("A new pipeline still requires all freshly prepared sources")
        } catch ClientError.invalidResponse { }
        var rejectedSpace = published
        try rejectedSpace.stageIllustration(for: shirtID, request: completed, result: newResult, preparedPhotos: [source])
        var rejectedIntent = try preparationIntent(item: rejectedSpace.items[0], candidate: rejectedSpace.items[0].downloadedIllustration!)
        rejectedIntent.status = .failed; rejectedIntent.error = "representation_space_changed"
        try rejectedSpace.beginPreparation(for: shirtID, intent: rejectedIntent)
        precondition(rejectedSpace.clearRejectedPreparationSpace())
        precondition(rejectedSpace.items[0].preparation == nil && rejectedSpace.items[0].downloadedIllustration != nil)
        precondition(rejectedSpace.items[0].publishedVersion?.versionID == published.items[0].publishedVersion?.versionID)
        print("PASS: optional generator cache for legacy/reuse, strict new pipeline, same-candidate commit retry and rejected-space recovery")
        let emptyColorFeatures = try CanonicalItemFeatures(displayType: "Рубашка", colors: [], taxonomy: taxonomy)
        precondition(emptyColorFeatures == CanonicalItemFeatures(type: "shirt", colors: []))
        print("PASS: preparation identity/space, opaque bytes, artifact digests, failure/restart, stale edits, and atomic full admission")

        // A legacy edited illustration is paired with its old effective attributes,
        // while the newer manual input remains available in the editor.
        var legacyPublication = published
        legacyPublication.items[0].manualType = "Куртка"
        legacyPublication.items[0].illustration = IllustrationRequest(operationID: UUID(), photoVersionID: shirt.photoVersionID,
            sourceSetVersionID: shirt.sourceSetVersionID, revision: 3, manualType: "Куртка", manualColors: ["Чёрный"], submitted: true)
        var legacyJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacyPublication)) as! [String: Any]
        var legacyRecords = legacyJSON["items"] as! [[String: Any]]
        for index in legacyRecords.indices {
            legacyRecords[index].removeValue(forKey: "publishedVersion")
            legacyRecords[index].removeValue(forKey: "photosLocked")
        }
        legacyJSON["items"] = legacyRecords
        try JSONSerialization.data(withJSONObject: legacyJSON).write(to: catalogURL)
        let migratedPublication = try file.load()
        precondition(migratedPublication.items[0].displayedType == "Худи")
        precondition(migratedPublication.items[0].editedType == "Куртка")
        precondition(!migratedPublication.items[0].photosLocked,
                     "A v2 local result is not proof of a server publication commit")
        precondition(migratedPublication.items[0].publishedVersion?.completeness == .legacyIllustration)
        precondition(migratedPublication.items[0].pendingPublication?.legacyReconciliation == true)
        precondition(!migratedPublication.items[0].canEditPhotos)
        let legacyAck = ResultAcknowledgement(itemID: shirtID, operationID: completed.operationID, illustration: true)
        precondition(migratedPublication.pendingAcknowledgements?.contains(legacyAck) == true)
        try file.save(migratedPublication)
        var reconciledLegacy = try file.load()
        try reconciledLegacy.reconcileLegacyPublication(legacyAck, committed: true)
        precondition(reconciledLegacy.items[0].photosLocked)
        precondition(reconciledLegacy.items[0].publishedVersion?.completeness == .illustrated)
        precondition(reconciledLegacy.items[0].editedType == "Куртка")
        precondition(reconciledLegacy.items[0].displayedType == "Худи")
        precondition(reconciledLegacy.items[0].illustration?.operationID == migratedPublication.items[0].illustration?.operationID)
        precondition(reconciledLegacy.pendingAcknowledgements?.contains(legacyAck) == false)
        // A v3 ready illustration whose old cutout receipt has no hash must
        // upload its actual legacy packet after v4 refuses bodyless acknowledgement.
        var uncommittedLegacy = migratedPublication
        uncommittedLegacy.items[0].illustration = completed
        try uncommittedLegacy.reconcileLegacyPublication(legacyAck, committed: false, requiresPreparation: true)
        try file.save(uncommittedLegacy)
        uncommittedLegacy = try file.load()
        let historicalCandidate = uncommittedLegacy.items[0].downloadedIllustration!
        precondition(historicalCandidate.canPrepare(for: uncommittedLegacy.items[0]),
                     "CPU migration of visible legacy A preserves a newer manual draft")
        precondition(historicalCandidate.preparationMode == .legacyImport,
                     "An uncommitted historical packet must import actual final artifacts, not rely on unavailable old receipt hashes")
        precondition(uncommittedLegacy.items[0].pendingPublication == nil)
        precondition(!uncommittedLegacy.items[0].photosLocked && !uncommittedLegacy.items[0].hasPreparedVersion)
        precondition(uncommittedLegacy.pendingAcknowledgements?.contains(legacyAck) == false)
        let historicalIntent = try preparationIntent(item: uncommittedLegacy.items[0], candidate: historicalCandidate,
                                                     mode: historicalCandidate.preparationMode)
        precondition(historicalIntent.request.operationID == legacyAck.operationID)
        precondition(historicalIntent.cutoutOperationID == migratedPublication.items[0].operationID)
        try uncommittedLegacy.beginPreparation(for: shirtID, intent: historicalIntent)
        try file.save(uncommittedLegacy)
        uncommittedLegacy = try file.load()
        precondition(uncommittedLegacy.items[0].preparation?.manualType == "Куртка")
        var newerDraft = uncommittedLegacy
        try newerDraft.editAttributes(for: shirtID, type: "Пальто", colors: nil, taxonomy: taxonomy)
        precondition(!historicalIntent.matches(newerDraft.items[0]))
        do {
            try newerDraft.savePreparation(for: shirtID, intent: historicalIntent)
            fatalError("A late legacy preparation must not overwrite a later manual edit")
        } catch is CancellationError { }
        var newerIllustration = uncommittedLegacy
        newerIllustration.items[0].illustration = migratedPublication.items[0].illustration
        precondition(!historicalCandidate.canPrepare(for: newerIllustration.items[0]))
        precondition(!historicalIntent.matches(newerIllustration.items[0]))
        do {
            let supersedingIntent = try preparationIntent(item: newerIllustration.items[0], candidate: historicalCandidate,
                                                         mode: historicalCandidate.preparationMode)
            try newerIllustration.beginPreparation(for: shirtID, intent: supersedingIntent)
            fatalError("Historical A must not replace a newer illustration B intent")
        } catch is CancellationError { }
        var ordinaryCandidate = historicalCandidate
        ordinaryCandidate.legacyReconciliation = nil
        precondition(!ordinaryCandidate.canPrepare(for: uncommittedLegacy.items[0]),
                     "A new pipeline result still requires its exact manual snapshot")
        let historicalResponse = preparationResponse(item: uncommittedLegacy.items[0], intent: historicalIntent)
        do {
            try newerIllustration.stagePreparation(for: shirtID, response: historicalResponse,
                representationFilename: "late-historical.json", representationDigest: historicalResponse.representationSHA256!,
                actualArtifacts: historicalIntent.artifacts, actualSourceDigest: historicalIntent.sourceSHA256)
            fatalError("A late encoder result for A must not stage over newer B with the same draft")
        } catch is CancellationError { }
        try uncommittedLegacy.stagePreparation(for: shirtID, response: historicalResponse, representationFilename: "historical-representation.json",
            representationDigest: historicalResponse.representationSHA256!, actualArtifacts: historicalIntent.artifacts,
            actualSourceDigest: historicalIntent.sourceSHA256)
        precondition(!uncommittedLegacy.items[0].hasPreparedVersion)
        var lateHistoricalAck = uncommittedLegacy
        lateHistoricalAck.items[0].illustration = migratedPublication.items[0].illustration
        do {
            try lateHistoricalAck.confirmPublication(for: shirtID, operationID: legacyAck.operationID)
            fatalError("A late commit for A must not overwrite newer B")
        } catch is CancellationError { }
        precondition(lateHistoricalAck.items[0].illustration?.operationID == migratedPublication.items[0].illustration?.operationID)
        try uncommittedLegacy.confirmPublication(for: shirtID, operationID: legacyAck.operationID)
        precondition(uncommittedLegacy.items[0].hasPreparedVersion && uncommittedLegacy.items[0].photosLocked)
        precondition(uncommittedLegacy.items[0].editedType == "Куртка")
        precondition(uncommittedLegacy.items[0].displayedType == "Худи")
        precondition(uncommittedLegacy.items[0].illustrationIsStale,
                     "Full commit of legacy A must not pretend the newer draft was applied")
        precondition(uncommittedLegacy.outfits == [outfit])
        print("PASS: historical uncommitted illustration imports final artifacts and requires full preparation commit")
        var rejectedLegacy = migratedPublication
        try rejectedLegacy.reconcileLegacyPublication(legacyAck, committed: false)
        try file.save(rejectedLegacy)
        rejectedLegacy = try file.load()
        precondition(rejectedLegacy.items[0].pendingPublication == nil)
        precondition(!rejectedLegacy.items[0].isReconcilingLegacyPublication)
        precondition(rejectedLegacy.items[0].illustration?.operationID == legacyPublication.items[0].illustration?.operationID)
        precondition(rejectedLegacy.items[0].illustration?.status == .pending)
        precondition(rejectedLegacy.items[0].illustration?.submitted == true,
                     "Refusing the old receipt retains the existing submitted operation for resumption")
        try rejectedLegacy.editAttributes(for: shirtID, type: "Пальто", colors: nil, taxonomy: taxonomy)
        precondition(!rejectedLegacy.items[0].photosLocked)
        precondition(rejectedLegacy.items[0].publishedVersion?.completeness == .legacyIllustration)
        precondition(rejectedLegacy.items[0].displayedIllustration?.filename == "second-illustration.png")
        precondition(rejectedLegacy.items[0].displayedType == "Худи")
        precondition(rejectedLegacy.items[0].editedType == "Пальто")
        precondition(rejectedLegacy.outfits == [outfit])
        precondition(rejectedLegacy.pendingAcknowledgements?.contains(legacyAck) == false)
        precondition(migratedPublication.items[1].publishedVersion?.completeness == .legacyImage)
        precondition(!migratedPublication.items[1].photosLocked)
        precondition(migratedPublication.outfits == [outfit])
        var incompleteLegacy = legacyJSON
        var incompleteRecords = legacyRecords
        incompleteRecords[0].removeValue(forKey: "preparedPhotos")
        incompleteLegacy["items"] = incompleteRecords
        try JSONSerialization.data(withJSONObject: incompleteLegacy).write(to: catalogURL)
        var incompleteMigration = try file.load()
        try incompleteMigration.reconcileLegacyPublication(legacyAck, committed: true)
        precondition(incompleteMigration.items[0].photosLocked)
        precondition(incompleteMigration.items[0].publishedVersion?.completeness == .legacyIllustration,
                     "A confirmed source lock does not invent missing locally prepared artifacts")
        precondition(incompleteMigration.items[0].displayedIllustration?.filename == "second-illustration.png")
        print("PASS: legacy migration preserves image/attribute consistency, manual edits, references and incomplete readiness")
        // An old illustration from another photograph is never the fallback of a
        // published image-only packet, even if the legacy result is still retained.
        var replacedLegacy = legacyJSON
        var replacedRecords = legacyRecords
        replacedRecords[0]["photoVersionID"] = UUID().uuidString
        replacedRecords[0]["sourceSetVersionID"] = UUID().uuidString
        replacedLegacy["items"] = replacedRecords
        try JSONSerialization.data(withJSONObject: replacedLegacy).write(to: catalogURL)
        let replacedMigration = try file.load()
        precondition(replacedMigration.items[0].publishedVersion?.completeness == .legacyImage)
        precondition(replacedMigration.items[0].displayedIllustration == nil,
                     "A publication with no illustration must not borrow one from another version")
        print("PASS: migration never borrows a stale illustration from another photo version")

    }
    static func stagePrepared(_ catalog: inout WardrobeCatalog, for id: UUID, request: IllustrationRequest,
                              result: IllustrationResult, preparedPhotos: [IllustrationPreparedPhoto]) throws {
        try catalog.stageIllustration(for: id, request: request, result: result, preparedPhotos: preparedPhotos)
        let item = catalog.items.first { $0.id == id }!
        let candidate = item.downloadedIllustration!
        let intent = try preparationIntent(item: item, candidate: candidate)
        try catalog.beginPreparation(for: id, intent: intent)
        let response = preparationResponse(item: item, intent: intent)
        try catalog.stagePreparation(for: id, response: response, representationFilename: "representation.json",
            representationDigest: response.representationSHA256!, actualArtifacts: intent.artifacts, actualSourceDigest: intent.sourceSHA256)
    }

    static func preparationIntent(item: WardrobeItem, candidate: PendingItemPublication, space: String = "controlled-space", mode: ItemPreparation.Mode = .fromIllustration) throws -> ItemPreparation {
        let digest = String(repeating: "a", count: 64)
        return ItemPreparation(operationID: UUID(), revision: item.preparationRevision + 1, spaceID: space,
            mode: mode, cutoutOperationID: item.operationID, publication: candidate.publication,
            request: candidate.request, preparedPhotos: candidate.preparedPhotos,
            features: try CanonicalItemFeatures(displayType: candidate.publication.type, colors: candidate.publication.colors),
            sourceSHA256: digest, artifacts: .init(cutoutSHA256: digest, illustrationSHA256: digest,
                observedFeaturesSHA256: digest, effectiveFeaturesSHA256: digest), provenance: mode == .reusePublication ? "reused" : mode == .legacyImport ? "legacyImport" : "pipeline",
            manualType: item.manualType, manualColors: item.manualColors)
    }

    static func preparationResponse(item: WardrobeItem, intent: ItemPreparation) -> PreparationResponse {
        PreparationResponse(itemId: item.id, operationId: intent.operationID, revision: intent.revision,
            photoVersionId: intent.publication.photoVersionID, sourceSetVersionId: intent.publication.sourceSetVersionID,
            illustrationOperationId: intent.request.operationID, cutoutOperationId: intent.cutoutOperationID, spaceID: intent.spaceID, status: .ready,
            mode: "controlled", imageMode: "test", provenance: intent.provenance, effectiveFeatures: intent.features,
            representationJSON: "{\"fixture\": 1.00000000001}", representationSHA256: String(repeating: "b", count: 64),
            input: .init(sourceSHA256: intent.sourceSHA256, textSHA256: String(repeating: "c", count: 64)), artifacts: intent.artifacts, error: nil)
    }

    static func preparedFixture(_ input: WardrobeItem) throws -> WardrobeItem {
        var item = input
        let request = IllustrationRequest(operationID: UUID(), photoVersionID: item.photoVersionID,
            sourceSetVersionID: item.sourceSetVersionID, revision: 1, manualType: nil, manualColors: nil, status: .ready)
        let result = illustrationResult(item: item, request: request, type: item.type!, filename: "controlled-illustration.png")
        item.colors = result.response.effectiveFeatures!.colors
        let id = UUID(), digest = String(repeating: "a", count: 64)
        let response = PreparationResponse(itemId: item.id, operationId: id, revision: 1,
            photoVersionId: item.photoVersionID, sourceSetVersionId: item.sourceSetVersionID,
            illustrationOperationId: request.operationID, cutoutOperationId: item.operationID, spaceID: "controlled-fixture-space", status: .ready,
            mode: "controlled", imageMode: "test", provenance: "pipeline",
            effectiveFeatures: try CanonicalItemFeatures(displayType: item.type, colors: item.colors),
            representationJSON: "{\"controlledFixture\":true}", representationSHA256: digest,
            input: .init(sourceSHA256: digest, textSHA256: digest),
            artifacts: .init(cutoutSHA256: digest, illustrationSHA256: digest, observedFeaturesSHA256: digest, effectiveFeaturesSHA256: digest), error: nil)
        item.publishedVersion = ItemPublication(versionID: id, photoVersionID: item.photoVersionID,
            sourceSetVersionID: item.sourceSetVersionID, cutoutFilename: item.resultFilename!, cutoutMode: .demo,
            illustration: result, type: item.type, colors: item.colors, completeness: .prepared,
            representation: StoredRepresentation(filename: "controlled-representation.json", response: response))
        return item
    }
    static func illustrationResult(item: WardrobeItem, request: IllustrationRequest, type: String, filename: String) -> IllustrationResult {
        let keys = ["silhouette", "body_length", "sleeves", "pattern", "pattern_location", "pattern_size", "neckline", "fastening", "surface", "hood", "kangaroo_pocket", "patch_pockets", "dropped_shoulders", "contrast_cuffs", "lettering"]
        let features = IllustrationFeatures(version: "fitting-observable-v2-photoroom-sandbox", type: type,
            colors: request.manualColors ?? ["Белый"], traits: Dictionary(uniqueKeysWithValues: keys.map { ($0, "unknown") }))
        let response = IllustrationResponse(itemId: item.id, operationId: request.operationID,
            photoVersionId: request.photoVersionID, sourceSetVersionId: request.sourceSetVersionID, revision: request.revision,
            status: .ready, mode: "test", processing: [:], observedFeatures: features, effectiveFeatures: features,
            manualType: request.manualType, manualColors: request.manualColors, modelVersion: "fal-ai/nano-banana-pro/edit",
            templateVersion: "front-360x560-proposed-v1", geometryVersion: "fitting-square-1024-v1", resultPath: nil, error: nil,
            preparedSources: [IllustrationPreparedSource(photoId: item.photoVersionID, preparedPath: "/prepared")])
        return IllustrationResult(filename: filename, response: response)
    }

}
