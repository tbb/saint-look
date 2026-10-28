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

    }
}
