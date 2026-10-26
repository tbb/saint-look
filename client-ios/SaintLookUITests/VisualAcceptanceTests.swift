import XCTest
import Foundation

/// A small render journey. Network ingestion regressions remain in Wardrobe/OutfitFlowTests.
final class VisualAcceptanceTests: XCTestCase {
    private let baseURL = "http://127.0.0.1:8788"
    private var profile = ""
    private let itemIDs = (1...4).map { String(format: "36000000-0000-0000-0000-%012d", $0) }

    override func setUp() async throws {
        continueAfterFailure = false
        profile = ProcessInfo.processInfo.environment["SAINT_LOOK_VISUAL_PROFILE"] ?? ""
        try XCTSkipIf(profile.isEmpty, "Visual profiles run explicitly; ordinary regressions do not seed catalogs")
        XCTAssertTrue(["iphone-light", "iphone-dark", "iphone-max-text", "ipad-light"].contains(profile))
        try await control("online", reset: true)
    }

    @MainActor
    private func launch(_ scenario: String = "ready-four", reset: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["SAINT_LOOK_BASE_URL": baseURL,
            "SAINT_LOOK_OWNER_TOKEN": "saint-look-ui-tests-owner-token-00000001",
            "SAINT_LOOK_UI_TESTING": "1", "SAINT_LOOK_RESET_DATA": reset ? "1" : "0",
            "SAINT_LOOK_VISUAL_SCENARIO": scenario]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "Visual app must launch in foreground")
        return app
    }

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(profile)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func card(_ index: Int, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "wardrobe-item-\(itemIDs[index])").firstMatch
    }

    @MainActor
    private func openItem(_ index: Int, in app: XCUIApplication) {
        let item = card(index, in: app)
        guard reveal(item, in: app, towardTop: index == 0) else { return }
        item.tap()
        XCTAssertTrue(app.buttons["item-actions"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.firstMatch.tap()
    }

    @MainActor
    private func slot(_ zone: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "outfit-slot-\(zone)-")).firstMatch
    }

    @MainActor
    private func choose(_ index: Int, in app: XCUIApplication) {
        tap(app.buttons["outfit-candidate-\(itemIDs[index])"], in: app)
        expectGone(app.buttons["cancel-outfit-picker"], "Selection returns to its addressed screen")
    }

    @MainActor
    private func enterName(_ name: String, in app: XCUIApplication) {
        let field = app.textFields["outfit-name"]
        guard reveal(field, in: app, towardTop: true) else { return }
        field.tap()
        let current = (field.value as? String) ?? ""
        // Empty fields expose their placeholder as value, not editable content.
        if current != "Название — необязательно", !current.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(name + "\n")
        expectGone(app.keyboards.firstMatch, "Done dismisses keyboard before constructor actions", timeout: 15)
    }

    private func control(_ mode: String, reset: Bool = false) async throws {
        var request = URLRequest(url: URL(string: "\(baseURL)/__control")!)
        request.httpMethod = "POST"
        request.setValue("Bearer saint-look-ui-control-test-token-00000001", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["mode": mode, "reset": reset])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }


    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) -> Bool {
        guard !app.keyboards.firstMatch.exists || element.elementType == .textField else {
            XCTFail("Finish name entry with Done before interacting with the constructor")
            return false
        }
        var lastFrame = CGRect.zero
        var lastViewport = CGRect.zero
        for _ in 0..<7 {
            let bars = app.navigationBars.allElementsBoundByIndex
            let foregroundBar = bars.reversed().first { $0.isHittable } ?? bars.last
            let top = foregroundBar?.frame.maxY ?? app.frame.minY
            var bottom = app.frame.maxY - 24
            if let tabTop = app.tabBars.allElementsBoundByIndex.filter({ $0.isHittable }).map({ $0.frame.minY }).min() {
                bottom = min(bottom, tabTop)
            }
            if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY) }
            let viewport = CGRect(x: app.frame.minX + 16, y: top, width: app.frame.width - 32,
                                  height: max(0, bottom - top))
            let present = element.exists
            let frame = present ? element.frame : .zero
            lastFrame = frame
            lastViewport = viewport
            // Visibility is a gate, not a tap coordinate. Native tap chooses the real hit region.
            // A row starting at the navigation boundary is usable; its entire AX box need not fit.
            if present, frame.midY > viewport.minY, frame.midY < viewport.maxY, element.isHittable {
                return true
            }
            let distance = present ? viewport.midY - frame.midY : (towardTop ? 180 : -180)
            let movement = (distance < 0 ? -1.0 : 1.0) * min(180, max(100, abs(distance)))
            let start = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: viewport.midX, dy: viewport.midY))
            let end = start.withOffset(CGVector(dx: 0, dy: movement))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        capture("unreachable-outfit-control")
        XCTFail("Could not reveal control; last target frame \(lastFrame), content viewport \(lastViewport), searching toward top: \(towardTop)")
        return false
    }

    @MainActor
    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        guard reveal(element, in: app) else { return }
        element.tap()
    }


    @MainActor
    private func expectGone(_ element: XCUIElement, _ message: String, timeout: TimeInterval = 5) {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        let result = XCTWaiter.wait(for: [gone], timeout: timeout)
        if result != .completed {
            capture("outfit-dismissal-timeout")
            let state = XCTAttachment(string: element.debugDescription)
            state.name = "outfit-dismissal-accessibility-state"
            state.lifetime = .keepAlways
            add(state)
        }
        XCTAssertEqual(result, .completed, message)
    }


    private func activityCounts() async throws -> [String: Int] {
        var counts: [String: Int] = [:]
        let endpoints = [
            ("http://127.0.0.1:8788/__control", "saint-look-ui-control-test-token-00000001", ["forwardedUploads", "acceptedOperations"]),
            ("http://127.0.0.1:8789/__control", "saint-look-ui-provider-control-token-00000001", ["attributesCalls", "cutoutCalls"]),
        ]
        for (address, credential, keys) in endpoints {
            var request = URLRequest(url: URL(string: address)!)
            request.timeoutInterval = 5
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            for key in keys { counts[key] = try XCTUnwrap(state[key] as? Int) }
        }
        return counts
    }

    @MainActor
    func testPublicPhotoJourney() async throws {
        let before = try await activityCounts()
        let app = launch()
        XCTAssertTrue(card(0, in: app).waitForExistence(timeout: 10))
        XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'wardrobe-item-' ")).count, 4)
        capture("01-wardrobe-grid")
        openItem(1, in: app)
        XCTAssertTrue(app.navigationBars["Джинсы"].exists)
        capture("02-jeans-detail")
        back(app)
        openItem(0, in: app)
        let edit = app.buttons["edit-item"]
        guard reveal(edit, in: app) else { return }
        let hitEvidence = XCTAttachment(string: "edit-item accessibility frame: \(edit.frame); hittable: \(edit.isHittable)")
        hitEvidence.name = "\(profile)-item-edit-hit-frame"
        hitEvidence.lifetime = .keepAlways
        add(hitEvidence)
        edit.tap()
        tap(app.buttons["choose-colors"], in: app)
        XCTAssertTrue(app.buttons["color-white"].waitForExistence(timeout: 5))
        capture("03-item-colors")
        app.buttons["done-colors"].tap()
        app.buttons["cancel-item-edits"].tap()
        back(app)
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons["create-first-outfit"], in: app)
        tap(slot("body", in: app), in: app)
        choose(0, in: app)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        XCTAssertTrue(app.staticTexts["outfit-save-explanation"].exists)
        let firstLayer = slot("body", in: app)
        let firstID = firstLayer.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        tap(slot("bottom", in: app), in: app)
        choose(1, in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        tap(slot("shoes", in: app), in: app)
        choose(3, in: app)
        tap(firstLayer, in: app)
        let current = app.buttons["outfit-candidate-\(itemIDs[0])"]
        XCTAssertTrue(current.waitForExistence(timeout: 5))
        XCTAssertTrue(current.isSelected)
        capture("04-body-picker-current")
        app.buttons["outfit-type-filter"].tap()
        app.buttons["outfit-filter-polo"].tap()
        XCTAssertFalse(current.exists)
        XCTAssertTrue(app.buttons["outfit-candidate-\(itemIDs[2])"].exists)
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertEqual(firstLayer.value as? String, "Футболка, Белый")
        tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND identifier != %@", firstLayer.identifier)).firstMatch
        let secondID = second.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        tap(second, in: app)
        choose(2, in: app)
        XCTAssertEqual(firstLayer.value as? String, "Футболка, Белый")
        XCTAssertEqual(second.value as? String, "Поло, Белый, Чёрный")
        guard reveal(firstLayer, in: app, towardTop: true) else { return }
        capture("05-multilayer-editor")
        tap(app.buttons["outfit-slot-menu-\(secondID)"], in: app)
        app.buttons["remove-body-layer-\(secondID)"].tap()
        XCTAssertFalse(second.exists)
        app.buttons["save-outfit"].tap()
        let outfit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).firstMatch
        XCTAssertTrue(outfit.waitForExistence(timeout: 5))
        let outfitID = outfit.identifier
        XCTAssertEqual(outfit.label, "Лук без названия")
        capture("06-outfit-collection")
        outfit.tap()
        app.buttons["edit-outfit"].tap()
        let name = "Прогулка по осеннему городу после работы"
        enterName(name, in: app)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        capture("07-outfit-detail-long-name")
        app.buttons["edit-outfit"].tap()
        enterName("Черновик", in: app)
        app.buttons["cancel-outfit"].tap()
        XCTAssertTrue(app.alerts.buttons["continue-outfit-editing"].waitForExistence(timeout: 5))
        capture("08-outfit-discard-dialog")
        app.alerts.buttons["continue-outfit-editing"].tap()
        XCTAssertEqual(app.textFields["outfit-name"].value as? String, "Черновик")
        app.buttons["cancel-outfit"].tap()
        app.alerts.buttons["discard-outfit-changes"].tap()
        back(app)
        app.tabBars.buttons["Гардероб"].tap()
        openItem(0, in: app)
        app.buttons["item-actions"].tap()
        app.buttons["delete-item"].tap()
        XCTAssertTrue(app.alerts.buttons["cancel-delete-item"].waitForExistence(timeout: 5))
        capture("09-item-delete-dialog")
        app.alerts.buttons["cancel-delete-item"].tap()
        XCTAssertTrue(app.buttons["item-actions"].exists)
        app.buttons["item-actions"].tap()
        app.buttons["delete-item"].tap()
        app.alerts.buttons["confirm-delete-item"].tap()
        expectGone(app.buttons["item-actions"], "Confirmed wardrobe deletion dismisses its detail")
        XCTAssertFalse(card(0, in: app).exists)
        app.tabBars.buttons["Луки"].tap()
        let saved = app.descendants(matching: .any).matching(identifier: outfitID).firstMatch
        tap(saved, in: app)
        let repair = app.buttons["repair-slot-\(firstID)"]
        guard reveal(repair, in: app) else { return }
        capture("10-outfit-missing-body")
        repair.tap()
        XCTAssertTrue(app.buttons["outfit-candidate-\(itemIDs[2])"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["outfit-candidate-\(itemIDs[1])"].exists)
        XCTAssertFalse(app.buttons["outfit-candidate-\(itemIDs[3])"].exists)
        capture("11-targeted-replacement-picker")
        choose(2, in: app)
        XCTAssertFalse(repair.exists)
        capture("12-repaired-outfit")
        back(app)
        XCTAssertEqual(saved.label, name)
        let composition = saved.value as? String ?? ""
        for label in ["Поло", "Джинсы", "Туфли"] { XCTAssertTrue(composition.contains(label)) }
        XCUIDevice.shared.press(.home)
        app.terminate()
        let relaunched = launch(reset: false)
        relaunched.tabBars.buttons["Луки"].tap()
        let persistent = relaunched.descendants(matching: .any).matching(identifier: outfitID).firstMatch
        XCTAssertTrue(persistent.waitForExistence(timeout: 5))
        XCTAssertEqual(persistent.value as? String, composition)
        XCTAssertEqual(persistent.label, name)
        let after = try await activityCounts()
        XCTAssertEqual(after, before, "Visual UI commands must not upload photos or invoke either provider")
        let counts = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: ["before": before, "after": after], options: .sortedKeys), encoding: .utf8)!)
        counts.name = "\(profile)-no-ai-counters"; counts.lifetime = .keepAlways; add(counts)
        XCUIDevice.shared.press(.home)
        relaunched.terminate()
    }

    @MainActor
    func testSecondaryStates() async throws {
        try XCTSkipUnless(profile == "iphone-light", "Secondary states are captured once; the main journey covers four profiles")
        var app = launch("empty")
        XCTAssertTrue(app.staticTexts["wardrobe-empty"].waitForExistence(timeout: 10))
        capture("secondary-01-wardrobe-empty")
        app.tabBars.buttons["Луки"].tap()
        XCTAssertTrue(app.buttons["open-wardrobe"].waitForExistence(timeout: 5))
        capture("secondary-02-outfits-empty")
        app.buttons["open-wardrobe"].tap()
        XCTAssertTrue(app.staticTexts["wardrobe-empty"].exists)
        XCUIDevice.shared.press(.home); app.terminate()
        app = launch()
        openItem(0, in: app)
        tap(app.buttons["edit-item"], in: app)
        capture("secondary-03-item-editor")
        tap(app.buttons["choose-type"], in: app)
        XCTAssertTrue(app.buttons["type-t_shirt"].waitForExistence(timeout: 5))
        capture("secondary-04-type-picker")
        app.buttons["type-t_shirt"].tap()
        app.buttons["cancel-item-edits"].tap()
        back(app)
        app.buttons["settings"].tap()
        XCTAssertTrue(app.staticTexts["connection-status"].waitForExistence(timeout: 5))
        capture("secondary-05-settings")
        app.descendants(matching: .any).matching(identifier: "connection-settings").firstMatch.tap()
        XCTAssertTrue(app.textFields["backend-url"].waitForExistence(timeout: 5))
        capture("secondary-06-connection-settings")
        XCUIDevice.shared.press(.home); app.terminate()
        try await control("offline")
        app = launch("mixed-offline")
        XCTAssertTrue(card(0, in: app).waitForExistence(timeout: 10))
        capture("secondary-07-processing-grid")
        openItem(2, in: app)
        XCTAssertTrue(app.staticTexts["item-error"].waitForExistence(timeout: 5))
        capture("secondary-08-failed-detail")
        XCUIDevice.shared.press(.home); app.terminate()
        app = launch("unreadable-catalog")
        let error = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Не удалось открыть локальный гардероб'")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        capture("secondary-09-storage-error-wardrobe")
        app.tabBars.buttons["Луки"].tap()
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        capture("secondary-10-storage-error-outfits")
        XCUIDevice.shared.press(.home); app.terminate()
        try await control("online")
    }
}
