import XCTest
import Foundation

final class OutfitFlowTests: XCTestCase {
    private let token = "saint-look-ui-tests-owner-token-00000001"
    private let baseURL = "http://127.0.0.1:8788"

    override func setUp() async throws {
        continueAfterFailure = false
        try await control("online", reset: true)
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
    private func launch(reset: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SAINT_LOOK_BASE_URL"] = baseURL
        app.launchEnvironment["SAINT_LOOK_OWNER_TOKEN"] = token
        app.launchEnvironment["SAINT_LOOK_UI_TESTING"] = "1"
        app.launchEnvironment["SAINT_LOOK_RESET_DATA"] = reset ? "1" : "0"
        app.launch()
        return app
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
    private func expectGone(_ element: XCUIElement, _ message: String) {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, message)
    }

    @MainActor
    private func openFirstItem(in app: XCUIApplication) {
        if app.buttons["item-actions"].exists { return }
        let photo = app.images["item-photo"].firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 5))
        guard reveal(photo, in: app, towardTop: true) else { return }
        photo.tap()
        XCTAssertTrue(app.buttons["item-actions"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func deleteFirstItem(in app: XCUIApplication) {
        openFirstItem(in: app)
        app.buttons["item-actions"].tap()
        app.buttons["delete-item"].firstMatch.tap()
        let confirmation = app.alerts.buttons.matching(identifier: "confirm-delete-item").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
    }

    @MainActor
    private func chooseCandidate(_ candidate: XCUIElement, in app: XCUIApplication) {
        tap(candidate, in: app)
        expectGone(app.buttons["cancel-outfit-picker"], "Selecting a thing must immediately return to the constructor")
    }

    @MainActor
    private func enterName(_ text: String, in app: XCUIApplication) {
        let field = app.textFields["outfit-name"]
        tap(field, in: app)
        field.typeText(text + "\n")
        expectGone(app.keyboards.firstMatch, "Done must dismiss the keyboard before choosing a thing")
    }

    @MainActor
    private func button(prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    @MainActor
    private func summary(_ app: XCUIApplication, ready: Int, pending: Int) async {
        if app.buttons["item-actions"].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.navigationBars["Гардероб"].waitForExistence(timeout: 5))
        }
        for _ in 0..<4 where !app.staticTexts["wardrobe-summary"].isHittable { app.swipeDown() }
        let predicate = NSPredicate(format: "label == %@", "Всего: \(ready + pending). Готово: \(ready). Ожидают: \(pending).")
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: predicate, object: app.staticTexts["wardrobe-summary"])], timeout: 40)
    }

    @MainActor
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testCreateUnnamedOutfitSurvivesBackgroundResultOfflineRestartAndItemDeletion() async throws {
        let app = launch(reset: true)
        app.buttons["add-demo-photo"].tap()
        await summary(app, ready: 1, pending: 0)
        app.buttons["add-demo-photo"].tap()
        await summary(app, ready: 2, pending: 0)
        openFirstItem(in: app)
        tap(app.buttons["edit-item"].firstMatch, in: app)
        tap(app.buttons["choose-type"], in: app)
        tap(app.buttons["type-trousers"], in: app)
        app.buttons["save-item-edits"].tap()
        await summary(app, ready: 2, pending: 0)

        // The pending photo must finish after the new outfit is saved.
        try await control("offline")
        app.buttons["add-demo-photo"].tap()
        await summary(app, ready: 2, pending: 1)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(button(prefix: "outfit-slot-head-", in: app), in: app)
        XCTAssertTrue(app.otherElements["outfit-picker-empty"].waitForExistence(timeout: 5)
            || app.staticTexts["Подходящих вещей пока нет"].exists)
        app.buttons["cancel-outfit-picker"].tap()
        tap(button(prefix: "outfit-slot-body-", in: app), in: app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 1,
                       "The pending third photo is not eligible")
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(button(prefix: "outfit-slot-bottom-", in: app), in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        capture("outfit-01-create")
        app.buttons["save-outfit"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).count, 1)
        let savedCardID = card.identifier
        capture("outfit-02-collection")

        try await control("online")
        app.tabBars.buttons["Гардероб"].tap()
        await summary(app, ready: 3, pending: 0)
        try await control("offline")
        // Background first: exercise lifecycle without XCTest's foreground termination assertion.
        XCUIDevice.shared.press(.home)
        app.terminate()
        let offline = launch(reset: false)
        offline.tabBars.buttons["Луки"].tap()
        XCTAssertTrue(offline.buttons[savedCardID].waitForExistence(timeout: 5))
        offline.buttons[savedCardID].tap()
        XCTAssertTrue(offline.navigationBars["Лук без названия"].exists)
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Футболка'")).firstMatch.exists)
        offline.navigationBars.buttons.firstMatch.tap()
        offline.tabBars.buttons["Гардероб"].tap()
        // Delete the newest (unselected) thing, then trousers belonging to the outfit.
        deleteFirstItem(in: offline)
        await summary(offline, ready: 2, pending: 0)
        openFirstItem(in: offline)
        offline.buttons["item-actions"].tap()
        offline.buttons["delete-item"].firstMatch.tap()
        let cancelDeletion = offline.alerts.buttons.matching(identifier: "cancel-delete-item").firstMatch
        XCTAssertTrue(cancelDeletion.waitForExistence(timeout: 5))
        cancelDeletion.tap()
        await summary(offline, ready: 2, pending: 0)
        offline.tabBars.buttons["Луки"].tap()
        offline.buttons[savedCardID].tap()
        XCTAssertFalse(button(prefix: "repair-slot-", in: offline).exists,
                       "Cancelling wardrobe deletion must preserve the saved outfit's links")
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Брюки'")).firstMatch.exists)
        offline.navigationBars.buttons.firstMatch.tap()
        offline.tabBars.buttons["Гардероб"].tap()
        deleteFirstItem(in: offline)
        await summary(offline, ready: 1, pending: 0)
        offline.tabBars.buttons["Луки"].tap()
        offline.buttons[savedCardID].tap()
        let missingSlot = button(prefix: "repair-slot-", in: offline)
        guard reveal(missingSlot, in: offline) else { return }
        capture("outfit-03-missing-item")
        missingSlot.tap()
        XCTAssertFalse(offline.buttons["save-outfit"].isEnabled)
        offline.buttons["cancel-outfit"].tap()
        XCUIDevice.shared.press(.home)
        offline.terminate()
    }

    @MainActor
    func testIndependentBodyLayersCycleAndSurviveOfflineRestart() async throws {
        let app = launch(reset: true)
        // Distinct types make selection observable without depending on generated IDs/order.
        for (index, type) in ["t_shirt", "hoodie", "jacket", "sweater", "trousers"].enumerated() {
            app.buttons["add-demo-photo"].tap()
            await summary(app, ready: index + 1, pending: 0)
            openFirstItem(in: app)
            tap(app.buttons["edit-item"].firstMatch, in: app)
            tap(app.buttons["choose-type"], in: app)
            tap(app.buttons["type-\(type)"], in: app)
            XCTAssertTrue(app.buttons["save-item-edits"].waitForExistence(timeout: 5), "Choosing a visible type must return to the editor")
            app.buttons["save-item-edits"].tap()
            await summary(app, ready: index + 1, pending: 0)
        }
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        let first = button(prefix: "outfit-slot-body-", in: app)
        let firstID = first.identifier
        func choose(_ type: String, row: XCUIElement) {
            tap(row, in: app)
            let candidate = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' AND label CONTAINS %@", type)).firstMatch
            chooseCandidate(candidate, in: app)
            XCTAssertTrue(row.label.contains(type), "The chosen type must appear in the addressed row")
        }
        choose("Футболка", row: first)
        tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2' ")).firstMatch
        choose("Худи", row: second)
        let secondID = second.identifier
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled, "Two body layers alone form a valid look")
        tap(app.buttons["add-body-layer"], in: app)
        let third = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 3' ")).firstMatch
        choose("Куртка", row: third)
        let thirdID = third.identifier
        choose("Брюки", row: button(prefix: "outfit-slot-bottom-", in: app))
        // Scroll back to the first row without changing the selection.
        guard reveal(app.buttons[firstID], in: app, towardTop: true) else { return }
        XCTAssertTrue(app.buttons[firstID].label.contains("Футболка"))
        app.buttons[firstID].swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists)
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        guard reveal(app.buttons[secondID], in: app) else { return }
        XCTAssertTrue(app.buttons[secondID].label.contains("Худи"))
        guard reveal(app.buttons[thirdID], in: app) else { return }
        XCTAssertTrue(app.buttons[thirdID].label.contains("Куртка"))
        guard reveal(app.buttons[firstID], in: app, towardTop: true) else { return }
        app.buttons[firstID].swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists)
        XCTAssertTrue(app.buttons[firstID].label.contains("Футболка"))
        app.buttons[firstID].swipeRight()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists)
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        tap(app.buttons[firstID], in: app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 2)
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        tap(app.buttons["add-body-layer"], in: app)
        // A deliberately empty final layer is also durable.
        capture("outfit-04-independent-layers")
        app.buttons["save-outfit"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let cardID = card.identifier
        capture("outfit-06-multilayer-collection")
        try await control("offline")
        XCUIDevice.shared.press(.home)
        app.terminate()
        let offline = launch(reset: false)
        offline.tabBars.buttons["Луки"].tap()
        offline.buttons[cardID].tap()
        XCTAssertTrue(offline.staticTexts["Тело · слой 1"].exists)
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Свитер'")).firstMatch.exists)
        for _ in 0..<4 where !offline.staticTexts["Тело · слой 3"].isHittable { offline.swipeUp() }
        XCTAssertTrue(offline.staticTexts["Тело · слой 3"].exists)
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Куртка'")).firstMatch.exists)
        for _ in 0..<4 where !offline.staticTexts["Тело · слой 4"].isHittable { offline.swipeUp() }
        XCTAssertTrue(offline.staticTexts["Тело · слой 4"].exists)
        capture("outfit-05-layers-offline")
        XCUIDevice.shared.press(.home)
        offline.terminate()
    }

    @MainActor
    func testSwipeDoesNotOpenPickerAndVerticalDragScrollsThroughRow() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        let head = button(prefix: "outfit-slot-head-", in: app)
        head.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "Horizontal drag must never open the picker")
        guard !app.buttons["cancel-outfit-picker"].exists else { return }
        let body = button(prefix: "outfit-slot-body-", in: app)
        let originalBodyY = body.frame.minY
        head.swipeUp()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "Vertical drag must never open the picker")
        XCTAssertLessThan(body.frame.minY, originalBodyY - 20, "Dragging through a row must still scroll the constructor")
        tap(body, in: app)
        XCTAssertTrue(app.buttons["cancel-outfit-picker"].waitForExistence(timeout: 5), "A real tap still opens the picker")
        app.buttons["cancel-outfit-picker"].tap()
        app.buttons["cancel-outfit"].tap()
        XCUIDevice.shared.press(.home)
        app.terminate()
    }

    @MainActor
    func testEmptyAndSingleCandidateRowsCanClearAndRemoveWithoutLosingLastBodyRow() async throws {
        let app = launch(reset: true)
        app.buttons["add-demo-photo"].tap()
        await summary(app, ready: 1, pending: 0)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        let head = button(prefix: "outfit-slot-head-", in: app)
        let originalHead = head.label
        head.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "A swipe must not activate the row's tap action")
        guard !app.buttons["cancel-outfit-picker"].exists else { return }
        XCTAssertEqual(head.label, originalHead)
        let first = button(prefix: "outfit-slot-body-", in: app)
        tap(first, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        let firstID = first.identifier
        let selectedLabel = first.label
        first.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "A one-candidate swipe must stay in the editor")
        XCTAssertEqual(first.label, selectedLabel, "One candidate must never clear a selection")
        tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2' ")).firstMatch
        tap(second, in: app)
        XCTAssertTrue(app.otherElements["outfit-picker-empty"].waitForExistence(timeout: 5)
            || app.staticTexts["Подходящих вещей пока нет"].exists)
        app.buttons["cancel-outfit-picker"].tap()
        let secondID = second.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        second.swipeRight()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "An empty-pool swipe must stay in the editor")
        XCTAssertTrue(second.label.contains("Выбрать вещь"))
        tap(app.buttons["remove-body-layer-\(secondID)"], in: app)
        let firstSlotID = firstID.replacingOccurrences(of: "outfit-slot-body-", with: "")
        tap(app.buttons["clear-slot-\(firstSlotID)"], in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Выбрать вещь"))
        tap(app.buttons["remove-body-layer-\(firstSlotID)"], in: app)
        XCTAssertTrue(app.buttons[firstID].exists, "Removing the last body row keeps an empty row")
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        capture("outfit-06-empty-last-layer")
        app.buttons["cancel-outfit"].tap()
        XCUIDevice.shared.press(.home)
        app.terminate()
    }

    @MainActor
    func testEditCancelRenameIncompleteAndDeletePreservesOtherLookOffline() async throws {
        let app = launch(reset: true)
        for (index, type) in ["t_shirt", "trousers"].enumerated() {
            app.buttons["add-demo-photo"].tap()
            await summary(app, ready: index + 1, pending: 0)
            openFirstItem(in: app)
            tap(app.buttons["edit-item"].firstMatch, in: app)
            tap(app.buttons["choose-type"], in: app)
            tap(app.buttons["type-\(type)"], in: app)
            XCTAssertTrue(app.buttons["save-item-edits"].waitForExistence(timeout: 5), "Choosing a visible type must return to the editor")
            app.buttons["save-item-edits"].tap()
        }
        try await control("offline")
        app.tabBars.buttons["Луки"].tap()
        var cardIDs: [String] = []
        for name in ["Первый", "Второй"] {
            app.buttons["create-outfit"].tap()
            enterName(name, in: app)
            tap(button(prefix: "outfit-slot-body-", in: app), in: app)
            chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
            tap(button(prefix: "outfit-slot-bottom-", in: app), in: app)
            chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
            app.buttons["save-outfit"].tap()
            let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' AND label CONTAINS %@", name)).firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            cardIDs.append(card.identifier)
        }
        app.buttons[cardIDs[0]].tap()
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        app.buttons["edit-outfit"].tap()
        enterName(" изменён", in: app)
        app.buttons["cancel-outfit"].tap()
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "continue-outfit-editing").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.exists)
        capture("outfit-10-discard-confirmation")
        app.alerts.buttons.matching(identifier: "continue-outfit-editing").firstMatch.tap()
        XCTAssertTrue(app.textFields["outfit-name"].exists)
        app.buttons["cancel-outfit"].tap()
        app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Первый"].waitForExistence(timeout: 5))
        app.buttons["edit-outfit"].tap()
        enterName(" сохранён", in: app)
        let bottom = button(prefix: "outfit-slot-bottom-", in: app)
        let bottomID = bottom.identifier.replacingOccurrences(of: "outfit-slot-bottom-", with: "")
        tap(app.buttons["clear-slot-\(bottomID)"], in: app)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(bottom, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        tap(app.buttons["add-body-layer"], in: app)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.navigationBars["Первый сохранён"].waitForExistence(timeout: 5))
        capture("outfit-07-edited")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).count, 2)
        app.tabBars.buttons["Гардероб"].tap()
        deleteFirstItem(in: app)
        await summary(app, ready: 1, pending: 0)
        app.tabBars.buttons["Луки"].tap()
        app.buttons[cardIDs[0]].tap()
        app.buttons["edit-outfit"].tap()
        enterName(" неполный", in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.navigationBars["Первый сохранён неполный"].waitForExistence(timeout: 5))
        tap(app.buttons["delete-outfit"], in: app)
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "cancel-delete-outfit").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.exists)
        capture("outfit-11-delete-confirmation")
        app.alerts.buttons.matching(identifier: "cancel-delete-outfit").firstMatch.tap()
        XCTAssertTrue(app.buttons["edit-outfit"].exists)
        tap(app.buttons["delete-outfit"], in: app)
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.tap()
        XCTAssertTrue(app.buttons[cardIDs[1]].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons[cardIDs[0]].exists)
        XCUIDevice.shared.press(.home)
        app.terminate()
        let restored = launch(reset: false)
        restored.tabBars.buttons["Луки"].tap()
        XCTAssertTrue(restored.buttons[cardIDs[1]].waitForExistence(timeout: 5))
        XCTAssertFalse(restored.buttons[cardIDs[0]].exists)
        restored.tabBars.buttons["Гардероб"].tap()
        await summary(restored, ready: 1, pending: 0)
        XCUIDevice.shared.press(.home)
        restored.terminate()
    }

    /// The public transport/provider counters observe real requests without inspecting Store internals.
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
    func testOutfitActionsStayLocalAndAccessibleWithoutSwipes() async throws {
        let app = launch(reset: true)
        for count in 1...2 {
            tap(app.buttons["add-demo-photo"], in: app)
            await summary(app, ready: count, pending: 0)
        }
        // Keep the transport ONLINE: an offline proxy would hide attempted uploads.
        let before = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons["create-first-outfit"], in: app)
        let first = button(prefix: "outfit-slot-body-", in: app)
        tap(first, in: app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 2)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2' ")).firstMatch
        tap(second, in: app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 1)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        capture("outfit-08-accessible-layers")
        app.buttons["save-outfit"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let cardID = card.identifier
        capture("outfit-09-accessible-collection")
        tap(card, in: app)
        app.buttons["edit-outfit"].tap()
        enterName("На прогулку", in: app)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.navigationBars["На прогулку"].waitForExistence(timeout: 5))
        tap(app.buttons["delete-outfit"], in: app)
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.tap()
        XCTAssertTrue(app.buttons["create-first-outfit"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons[cardID].exists)
        let after = try await activityCounts()
        XCTAssertEqual(after, before, "Creating, opening, renaming and deleting looks must not upload photos or call AI")
        let evidence = try JSONSerialization.data(withJSONObject: ["before": before, "after": after], options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
        attachment.name = "outfit-local-actions-provider-counts"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.tabBars.buttons["Гардероб"].tap()
        await summary(app, ready: 2, pending: 0)
        XCUIDevice.shared.press(.home)
        app.terminate()
    }

    @MainActor
    func testCancelDraftDoesNotCreateOutfit() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        enterName("Не сохранять", in: app)
        app.buttons["cancel-outfit"].tap()
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.tap()
        XCTAssertTrue(app.buttons["create-first-outfit"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).count, 0)
        XCUIDevice.shared.press(.home)
        app.terminate()
    }
}
