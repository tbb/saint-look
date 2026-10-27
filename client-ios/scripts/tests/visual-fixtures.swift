import Foundation

@main struct VisualFixtureChecks {
    static func main() throws {
        let sources = URL(fileURLWithPath: CommandLine.arguments[1])
        let taxonomy = try JSONDecoder().decode(WardrobeTaxonomy.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
        let support = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: support) }
        let normal = support.appendingPathComponent("wardrobe")
        try FileManager.default.createDirectory(at: normal, withIntermediateDirectories: true)
        try Data("do not overwrite".utf8).write(to: normal.appendingPathComponent("catalog.json"))
        let environment = ["SAINT_LOOK_UI_TESTING": "1", "SAINT_LOOK_RESET_DATA": "1", "SAINT_LOOK_VISUAL_SCENARIO": "ready-four"]
        let root = try VisualFixtures.prepare(environment: environment, support: support, resources: sources, taxonomy: taxonomy)!
        let catalog = try WardrobeCatalogFile(directory: root).load()
        precondition(catalog.items.count == 4 && catalog.outfits.isEmpty)
        precondition(Set(catalog.items.compactMap(\.type)) == Set(["Футболка", "Джинсы", "Поло", "Туфли"]))
        precondition(catalog.pendingAcknowledgements == [] && catalog.pendingDeletionIDs.isEmpty)
        for item in catalog.items {
            precondition(item.status == .ready)
            let bytes = try Data(contentsOf: root.appendingPathComponent(item.directoryName).appendingPathComponent(item.resultFilename!))
            precondition(!bytes.isEmpty)
        }
        let untouched = try String(contentsOf: normal.appendingPathComponent("catalog.json"), encoding: .utf8)
        precondition(untouched == "do not overwrite")
        print("PASS: four public photos load through the normal catalog without touching normal data")
        var edited = catalog
        edited.removeItem(catalog.items[0].id)
        try WardrobeCatalogFile(directory: root).save(edited)
        var relaunch = environment
        relaunch["SAINT_LOOK_RESET_DATA"] = "0"
        _ = try VisualFixtures.prepare(environment: relaunch, support: support, resources: sources, taxonomy: taxonomy)
        let persisted = try WardrobeCatalogFile(directory: root).load()
        precondition(persisted.items.count == 3 && persisted.pendingDeletionIDs.contains(catalog.items[0].id))
        print("PASS: relaunch preserves deletion and delivery intent")
        var invalid = environment
        invalid["SAINT_LOOK_VISUAL_SCENARIO"] = "../../wardrobe"
        do {
            _ = try VisualFixtures.prepare(environment: invalid, support: support, resources: sources, taxonomy: taxonomy)
            fatalError("Unknown scenario must fail")
        } catch VisualFixtures.FixtureError.invalidConfiguration { }
        invalid = environment
        invalid["SAINT_LOOK_UI_TESTING"] = "0"
        do {
            _ = try VisualFixtures.prepare(environment: invalid, support: support, resources: sources, taxonomy: taxonomy)
            fatalError("Fixture access requires UI test gate")
        } catch VisualFixtures.FixtureError.invalidConfiguration { }
        let inactive = try VisualFixtures.prepare(environment: [:], support: support, resources: sources, taxonomy: taxonomy)
        precondition(inactive == nil)
        print("PASS: fixture boundary rejects unknown scenarios and non-test launches")
        var broken = environment
        broken["SAINT_LOOK_VISUAL_SCENARIO"] = "unreadable-catalog"
        _ = try VisualFixtures.prepare(environment: broken, support: support, resources: sources, taxonomy: taxonomy)
        do { _ = try WardrobeCatalogFile(directory: root).load(); fatalError("Unreadable catalog must reach actual loader failure") }
        catch is DecodingError { }
        print("PASS: unreadable fixture exercises the normal loader error")
    }
}
