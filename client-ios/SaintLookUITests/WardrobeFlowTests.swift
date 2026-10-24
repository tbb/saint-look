import XCTest
import Foundation

final class WardrobeFlowTests: XCTestCase {
    private let testToken = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_TOKEN"]
        ?? "saint-look-ui-tests-owner-token-00000001"
    private let testURL = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_URL"]
        ?? "http://127.0.0.1:8788"

    private let controlURL = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_CONTROL_URL"]
        ?? "http://127.0.0.1:8788/__control"
    private let controlToken = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_CONTROL_TOKEN"]
        ?? "saint-look-ui-control-test-token-00000001"

    override func setUp() async throws {
        continueAfterFailure = false
        try await control(mode: "online", reset: true)
    }

    override func tearDown() async throws {
        await MainActor.run {
            XCUIApplication().terminate()
        }
    }

    private func control(mode: String, reset: Bool = false) async throws {
        var request = URLRequest(url: URL(string: controlURL)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["mode": mode, "reset": reset])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func waitForSummary(_ app: XCUIApplication, ready: Int, pending: Int, timeout: TimeInterval = 40) async {
        let summary = app.staticTexts["wardrobe-summary"]
        let expected = "Всего: \(ready + pending). Готово: \(ready). Ожидают: \(pending)."
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", expected), object: summary)
        await fulfillment(of: [expectation], timeout: timeout)
    }

    private func launch(reset: Bool, baseURL: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SAINT_LOOK_BASE_URL"] = baseURL
        app.launchEnvironment["SAINT_LOOK_OWNER_TOKEN"] = testToken
        app.launchEnvironment["SAINT_LOOK_UI_TESTING"] = "1"
        app.launchEnvironment["SAINT_LOOK_RESET_DATA"] = reset ? "1" : "0"
        app.launch()
        return app
    }

    @MainActor
    func testPhotoBecomesReadyThroughBackendAndSurvivesOfflineRelaunch() async throws {
        let app = launch(reset: true, baseURL: testURL)
        XCTAssertTrue(app.staticTexts["demo-notice"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Подключить локальный backend"].exists, "UI test credentials must load independently of Keychain state")
        // Hold delivery until pending is observed; backend processing may finish before XCTest's first poll.
        try await control(mode: "offline")
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.images["item-photo"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
        try await control(mode: "online")
        let ready = app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 30)
        let error = app.staticTexts["item-error"].firstMatch
        XCTAssertTrue(ready, error.exists ? error.label : "Ready card did not appear; no item error is shown")
        XCTAssertTrue(app.staticTexts["Футболка"].exists)
        XCTAssertTrue(app.staticTexts["Синий"].exists)
        app.terminate()

        let offline = launch(reset: false, baseURL: "http://127.0.0.1:1")
        XCTAssertTrue(offline.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(offline.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(offline.staticTexts["Футболка"].exists)
        XCTAssertTrue(offline.staticTexts["Синий"].exists)
    }

    func testUnavailableBackendKeepsOriginalAndPendingCardAfterRelaunch() throws {
        let app = launch(reset: true, baseURL: "http://127.0.0.1:1")
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.images["item-photo"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["item-error"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["ready-status"].exists)
        app.terminate()

        let relaunched = launch(reset: false, baseURL: "http://127.0.0.1:1")
        XCTAssertTrue(relaunched.images["item-photo"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(relaunched.staticTexts["pending-status"].firstMatch.exists)
        XCTAssertFalse(relaunched.staticTexts["ready-status"].exists)
    }

    @MainActor
    func testMultipleOfflinePhotosSurviveRelaunchAndAutomaticallyResumeInForeground() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 0, pending: 2, timeout: 5)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 0, pending: 2, timeout: 5)
        try await control(mode: "online")
        // No app restart, settings change, or manual retry after connectivity returns.
        await waitForSummary(restored, ready: 2, pending: 0)
        try await control(mode: "offline")
        restored.terminate()
        let offline = launch(reset: false, baseURL: testURL)
        await waitForSummary(offline, ready: 2, pending: 0, timeout: 5)
    }


    @MainActor
    func testManualTypeSurvivesAutomaticResultAndOfflineColorEditsPersistWithoutUploadingAgain() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
        app.swipeUp()
        let edit = app.buttons["edit-item"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let type = app.textFields["edit-type"]
        XCTAssertTrue(type.waitForExistence(timeout: 5))
        type.tap()
        type.typeText("Рубашка")
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        XCTAssertTrue(restored.staticTexts["Синий"].exists, "Editing type must leave colors available for the automatic result")
        let before = try await transportState()
        XCTAssertEqual(before["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(before["forwardedUploads"] as? Int, 1)

        try await control(mode: "offline")
        restored.buttons["edit-item"].firstMatch.tap()
        let colors = restored.textFields["edit-colors"]
        XCTAssertTrue(colors.waitForExistence(timeout: 5))
        colors.tap()
        colors.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Синий".count) + "Белый, Зелёный")
        restored.buttons["save-item-edits"].tap()
        XCTAssertTrue(restored.staticTexts["Белый, Зелёный"].waitForExistence(timeout: 5))
        restored.terminate()

        let offline = launch(reset: false, baseURL: testURL)
        offline.swipeUp()
        XCTAssertTrue(offline.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["Белый, Зелёный"].exists)
        XCTAssertTrue(offline.staticTexts["ready-status"].firstMatch.exists)
        XCTAssertTrue(offline.images["item-photo"].firstMatch.exists)
        try await control(mode: "online")
        let after = try await transportState()
        XCTAssertEqual(after["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(after["forwardedUploads"] as? Int, 1, "Local edits must not submit a new processing operation")
    }

    private func transportState() async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: controlURL)!)
        request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    func testLostUploadResponseReconcilesWithoutCreatingAnotherThing() async throws {
        try await control(mode: "drop-next-upload-response")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)

        var request = URLRequest(url: URL(string: controlURL)!)
        request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(state["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(state["droppedUploadResponses"] as? Int, 1, "The proxy must actually lose an accepted response")
    }

}
