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
    private func tap(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 {
            if element.exists && element.isHittable && element.frame.maxY < app.frame.maxY - 70 {
                element.tap()
                return
            }
            if element.exists && element.frame.minY < 100 { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTFail("Could not reach \(element)")
    }

    @MainActor
    private func button(prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    @MainActor
    private func summary(_ app: XCUIApplication, ready: Int, pending: Int) async {
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
        button(prefix: "outfit-candidate-", in: app).tap()
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(button(prefix: "outfit-slot-bottom-", in: app), in: app)
        button(prefix: "outfit-candidate-", in: app).tap()
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
        tap(offline.navigationBars.buttons.firstMatch, in: offline)
        offline.tabBars.buttons["Гардероб"].tap()
        // Delete the newest (unselected) thing, then trousers belonging to the outfit.
        tap(offline.buttons["delete-item"].firstMatch, in: offline)
        tap(offline.buttons["delete-item"].firstMatch, in: offline)
        offline.tabBars.buttons["Луки"].tap()
        offline.buttons[savedCardID].tap()
        tap(button(prefix: "repair-slot-", in: offline), in: offline)
        XCTAssertFalse(offline.buttons["save-outfit"].isEnabled)
        capture("outfit-03-missing-item")
        offline.buttons["cancel-outfit"].tap()
        XCUIDevice.shared.press(.home)
        offline.terminate()
    }

    @MainActor
    func testCancelDraftDoesNotCreateOutfit() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        app.textFields["outfit-name"].tap()
        app.textFields["outfit-name"].typeText("Не сохранять")
        app.buttons["cancel-outfit"].tap()
        XCTAssertTrue(app.buttons["create-first-outfit"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).count, 0)
        XCUIDevice.shared.press(.home)
        app.terminate()
    }
}
