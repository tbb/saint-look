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

    }
}
