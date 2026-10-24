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
        // Only setup resets are retried: no app action or one-shot failure is running yet.
        for attempt in 0..<3 {
            do {
                try await control(mode: "online", reset: true, timeout: 15)
                _ = try await providerControl(["reset": true], timeout: 15)
                return
            } catch let error as URLError {
                guard attempt < 2, [URLError.Code.timedOut, .networkConnectionLost, .cannotConnectToHost].contains(error.code) else { throw error }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    override func tearDown() async throws {
        await MainActor.run {
            XCUIApplication().terminate()
        }
    }

    private func control(mode: String, reset: Bool = false, timeout: TimeInterval = 5) async throws {
        var request = URLRequest(url: URL(string: controlURL)!)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
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
    func testDeletingTwoOfflineThingsSurvivesRelaunchAndNeverUploadsTheirPhotos() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 0, pending: 2, timeout: 5)
        try tapVisibleButton("delete-item", in: app)
        await waitForSummary(app, ready: 0, pending: 1, timeout: 5)
        try tapVisibleButton("delete-item", in: app)
        await waitForSummary(app, ready: 0, pending: 0, timeout: 5)
        XCTAssertFalse(app.images["item-photo"].exists)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 0, pending: 0, timeout: 5)
        try await control(mode: "online")
        var delivered = false
        for _ in 0..<200 {
            let state = try await transportState()
            XCTAssertEqual(state["forwardedUploads"] as? Int, 0, "Deleted local photos must never be uploaded")
            if state["deletedItems"] as? Int == 2 { delivered = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(delivered, "Both durable deletion commands must resume without another user action")
        await waitForSummary(restored, ready: 0, pending: 0, timeout: 5)
        restored.terminate()
        let again = launch(reset: false, baseURL: testURL)
        await waitForSummary(again, ready: 0, pending: 0, timeout: 5)
        XCTAssertFalse(again.images["item-photo"].exists)
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
        try tapVisibleButton("edit-item", in: app)
        let type = app.textFields["edit-type"]
        XCTAssertTrue(type.waitForExistence(timeout: 5))
        await enterText("Shirt", replacing: "", in: type, app: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Shirt"].waitForExistence(timeout: 5))
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Shirt"].waitForExistence(timeout: 5))
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertTrue(restored.staticTexts["Shirt"].exists)
        XCTAssertTrue(restored.staticTexts["Синий"].exists, "Editing type must leave colors available for the automatic result")
        let before = try await transportState()
        XCTAssertEqual(before["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(before["forwardedUploads"] as? Int, 1)

        try await control(mode: "offline")
        try tapVisibleButton("edit-item", in: restored)
        let colors = restored.textFields["edit-colors"]
        XCTAssertTrue(colors.waitForExistence(timeout: 5))
        await enterText("White, Green", replacing: "Синий", in: colors, app: restored)
        restored.buttons["save-item-edits"].tap()
        XCTAssertTrue(restored.staticTexts["White, Green"].waitForExistence(timeout: 5))
        restored.terminate()

        let offline = launch(reset: false, baseURL: testURL)
        offline.swipeUp()
        XCTAssertTrue(offline.staticTexts["Shirt"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["White, Green"].exists)
        XCTAssertTrue(offline.staticTexts["ready-status"].firstMatch.exists)
        XCTAssertTrue(offline.images["item-photo"].firstMatch.exists)
        try await control(mode: "online")
        let after = try await transportState()
        XCTAssertEqual(after["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(after["forwardedUploads"] as? Int, 1, "Local edits must not submit a new processing operation")
    }

    @MainActor
    func testManualColorsWinOverInFlightResultAndReadyEditsDoNotSubmitAgain() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        app.swipeUp()
        try tapVisibleButton("edit-item", in: app)
        let colors = app.textFields["edit-colors"]
        XCTAssertTrue(colors.waitForExistence(timeout: 3))
        await enterText("Red", replacing: "", in: colors, app: app)
        // Prepare input before starting delivery, but save only while the result is in flight.
        try await control(mode: "hold-next-result")
        var held = false
        for _ in 0..<400 {
            let state = try await transportState()
            if state["heldResultResponses"] as? Int == 1 {
                held = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(held, "The result response must be in flight before saving the edit")
        app.buttons["save-item-edits"].tap()
        let waiting = try await transportState()
        XCTAssertEqual(waiting["heldResultResponses"] as? Int, 1, "The response must remain held until the manual edit is saved")
        try await control(mode: "online")
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Red"].exists)
        XCTAssertTrue(app.staticTexts["Футболка"].exists, "A colors-only edit must retain the automatic type")

        try tapVisibleButton("edit-item", in: app)
        let type = app.textFields["edit-type"]
        XCTAssertTrue(type.waitForExistence(timeout: 3))
        await enterText("Shirt", replacing: "Футболка", in: type, app: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Shirt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Red"].exists)
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Shirt"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.staticTexts["Red"].exists)
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.exists)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(state["forwardedUploads"] as? Int, 1, "Online edits and relaunch must not create another processing request")
    }

    @MainActor
    func testExplicitRetryKeepsOneThingAndPreviousCutoutWithManualValuesAcrossRelaunch() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        app.swipeUp()
        try tapVisibleButton("edit-item", in: app)
        await enterText("Shirt", replacing: "Футболка", in: app.textFields["edit-type"], app: app)
        await enterText("Red", replacing: "Синий", in: app.textFields["edit-colors"], app: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Shirt"].waitForExistence(timeout: 5))

        try await control(mode: "offline")
        let problem = app.buttons["cutout-problem"].firstMatch
        XCTAssertTrue(problem.waitForExistence(timeout: 5))
        try tapVisibleButton("cutout-problem", in: app)
        try tapVisibleButton("retry-processing", in: app)
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertTrue(app.staticTexts["previous-result-notice"].exists)
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Shirt"].exists)
        XCTAssertTrue(app.staticTexts["Red"].exists)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["previous-result-notice"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists)
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertTrue(restored.staticTexts["Shirt"].exists)
        XCTAssertTrue(restored.staticTexts["Red"].exists)
        XCTAssertFalse(restored.staticTexts["previous-result-notice"].exists)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 2)
        XCTAssertEqual(state["forwardedUploads"] as? Int, 2)
        restored.swipeDown()
        await waitForSummary(restored, ready: 1, pending: 0, timeout: 5)
    }

    @MainActor
    func testProviderFailureCanRetryAndUnsuitablePhotoOffersReplacementInSameThing() async throws {
        _ = try await providerControl(["nextCutout": "provider_quota_exceeded"])
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.staticTexts["failed-status"].firstMatch.waitForExistence(timeout: 30))
        app.swipeUp()
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["item-error"].firstMatch.label.contains("Лимит"))
        try tapVisibleButton("retry-processing", in: app)
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 30))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        let retried = try await providerControl()
        XCTAssertEqual(retried["attributesCalls"] as? Int, 2)
        XCTAssertEqual(retried["cutoutCalls"] as? Int, 2)

        _ = try await providerControl(["nextAttributes": "photo_on_person"])
        try tapVisibleButton("cutout-problem", in: app)
        try tapVisibleButton("replace-demo-photo", in: app)
        XCTAssertTrue(app.staticTexts["failed-status"].firstMatch.waitForExistence(timeout: 30))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertTrue(app.staticTexts["replace-photo-hint"].exists)
        XCTAssertTrue(app.staticTexts["previous-result-notice"].exists)
        XCTAssertFalse(app.buttons["retry-processing"].exists)
        try tapVisibleButton("replace-demo-photo", in: app)
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 30))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertFalse(app.staticTexts["previous-result-notice"].exists)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 4)
        XCTAssertEqual(state["forwardedUploads"] as? Int, 4)
        app.swipeDown()
        await waitForSummary(app, ready: 1, pending: 0, timeout: 5)
    }

    @MainActor
    func testOfflineReplacementRetainsPreviousCutoutAndEditsUntilNewResultAfterRelaunch() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        app.swipeUp()
        try tapVisibleButton("edit-item", in: app)
        await enterText("Shirt", replacing: "Футболка", in: app.textFields["edit-type"], app: app)
        await enterText("White", replacing: "Синий", in: app.textFields["edit-colors"], app: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Shirt"].waitForExistence(timeout: 5))
        let previousImage = app.images["item-photo"].firstMatch.screenshot().pngRepresentation
        try await control(mode: "offline")
        try tapVisibleButton("cutout-problem", in: app)
        try tapVisibleButton("replace-demo-photo", in: app)
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertTrue(app.staticTexts["previous-result-notice"].exists)
        XCTAssertTrue(app.images["item-photo"].firstMatch.screenshot().pngRepresentation == previousImage,
                       "The previous cutout must remain visible instead of the red replacement source")
        // Replace again before either new photo reaches the server; the persisted revision may skip one.
        try tapVisibleButton("replace-demo-photo", in: app)
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertTrue(app.staticTexts["previous-result-notice"].exists)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["previous-result-notice"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.staticTexts["Shirt"].exists)
        XCTAssertTrue(restored.staticTexts["White"].exists)
        _ = try await providerControl(["nextCutout": "red"])
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertFalse(restored.staticTexts["previous-result-notice"].exists)
        XCTAssertTrue(restored.staticTexts["Shirt"].exists)
        XCTAssertTrue(restored.staticTexts["White"].exists)
        XCTAssertFalse(restored.images["item-photo"].firstMatch.screenshot().pngRepresentation == previousImage,
                          "The new red cutout must replace the previous blue one after becoming ready")
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 2)
        XCTAssertEqual(state["forwardedUploads"] as? Int, 2)
        try await control(mode: "offline")
        restored.terminate()
        let offline = launch(reset: false, baseURL: testURL)
        offline.swipeUp()
        XCTAssertTrue(offline.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["Shirt"].exists)
        XCTAssertTrue(offline.staticTexts["White"].exists)
        XCTAssertFalse(offline.staticTexts["previous-result-notice"].exists)
        offline.swipeDown()
        await waitForSummary(offline, ready: 1, pending: 0, timeout: 5)
    }

    private func providerControl(_ input: [String: Any]? = nil, timeout: TimeInterval = 5) async throws -> [String: Any] {
        let url = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_PROVIDER_CONTROL_URL"]
            ?? "http://127.0.0.1:8789/__control"
        let token = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_PROVIDER_CONTROL_TOKEN"]
            ?? "saint-look-ui-provider-control-token-00000001"
        var request = URLRequest(url: URL(string: url)!)
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let input {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: input)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    private func assertRecoveryDidNotOpenPhotoPicker(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        // Accessibility still exposes the underlying card while a system picker covers it.
        // The wardrobe toolbar must remain directly tappable after retry/debug replacement.
        XCTAssertTrue(app.navigationBars.buttons["Настройки"].firstMatch.isHittable,
                      "Recovery must leave the wardrobe interactive, without opening PhotosPicker",
                      file: file, line: line)
    }

    private enum InteractionError: Error { case buttonNotVisible(String) }

    @MainActor
    private func tapVisibleButton(_ identifier: String, in app: XCUIApplication) throws {
        let button = app.buttons[identifier].firstMatch
        // A ready update can push a row below the home indicator after a previous scroll.
        // Do not tap a merely existing or partially visible accessibility element.
        let top = app.frame.minY + 70
        let bottom = app.frame.maxY - 50
        for _ in 0..<4 {
            if button.exists && button.isHittable && button.frame.minY >= top && button.frame.maxY <= bottom {
                button.tap()
                return
            }
            if button.exists && button.frame.minY < top { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTFail("Button \(identifier) did not become fully visible")
        throw InteractionError.buttonNotVisible(identifier)
    }

    @MainActor
    private func enterText(_ text: String, replacing previous: String, in field: XCUIElement, app: XCUIApplication) async {
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count) + text)
        // Synthesized input can arrive after typeText returns; saving must observe the entered value.
        let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        await fulfillment(of: [entered], timeout: 10)
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
