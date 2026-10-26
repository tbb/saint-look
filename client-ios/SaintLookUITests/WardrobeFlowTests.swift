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

    private func control(mode: String, reset: Bool = false, advanceTimeMs: Int? = nil, timeout: TimeInterval = 5) async throws {
        var request = URLRequest(url: URL(string: controlURL)!)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: Any] = ["mode": mode, "reset": reset]
        if let advanceTimeMs { payload["advanceTimeMs"] = advanceTimeMs }
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
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

    private func launch(reset: Bool, baseURL: String, trialIndex: Int? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SAINT_LOOK_BASE_URL"] = baseURL
        app.launchEnvironment["SAINT_LOOK_OWNER_TOKEN"] = testToken
        app.launchEnvironment["SAINT_LOOK_UI_TESTING"] = "1"
        app.launchEnvironment["SAINT_LOOK_RESET_DATA"] = reset ? "1" : "0"
        if let trialIndex {
            app.launchEnvironment["SAINT_LOOK_LIVE_TRIAL"] = "1"
            app.launchEnvironment["SAINT_LOOK_TRIAL_PHOTO_INDEX"] = String(trialIndex)
        }
        app.launch()
        return app
    }

    @MainActor
    func testOpeningPhotoKeepsItemContextThroughEditingAndBackToCollection() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)

        let photo = app.images["item-photo"].firstMatch
        XCTAssertTrue(photo.exists)
        photo.tap()
        XCTAssertTrue(app.navigationBars["Футболка"].waitForExistence(timeout: 5),
                      "Tapping the garment photo must open that garment's detail")
        let detail = XCTAttachment(screenshot: app.screenshot())
        detail.name = "wardrobe-item-detail"
        detail.lifetime = .keepAlways
        add(detail)

        try tapVisibleButton("edit-item", in: app)
        try chooseType("hoodie", in: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.navigationBars["Худи"].waitForExistence(timeout: 5),
                      "Saving edits must return to the same item with its current type")
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Гардероб"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Худи"].exists)
        await waitForSummary(app, ready: 1, pending: 0)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 1,
                       "Opening and editing a detail must not upload another photo")
    }

    @MainActor
    func testPhotoBecomesReadyThroughBackendAndSurvivesOfflineRelaunch() async throws {
        let app = launch(reset: true, baseURL: testURL, trialIndex: 1)
        XCTAssertTrue(app.staticTexts["demo-notice"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Подключить локальный backend"].exists, "UI test credentials must load independently of Keychain state")
        // Hold delivery until pending is observed; backend processing may finish before XCTest's first poll.
        try await control(mode: "offline")
        app.buttons["add-trial-photo"].tap()
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

    @MainActor
    func testSavedResultAcknowledgementSurvivesRelaunchAndLostResponseWithoutLosingLocalCard() async throws {
        try await control(mode: "block-acks")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        let uploaded = try await transportState()
        let operationPath = try XCTUnwrap(uploaded["lastOperationPath"] as? String)
        let before = try await backendResponse(path: operationPath + "/result")
        XCTAssertEqual(before.status, 200, "The server copy remains until acknowledgement can be delivered")
        try await control(mode: "offline")
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 1, pending: 0)
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(restored.staticTexts["Футболка"].exists)
        try await control(mode: "drop-next-ack-response")
        var acknowledged = false
        for _ in 0..<200 {
            let state = try await transportState()
            if state["acknowledgedOperations"] as? Int == 1,
               state["droppedAcknowledgementResponses"] as? Int == 1,
               (state["forwardedAcknowledgements"] as? Int ?? 0) >= 2 {
                acknowledged = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(acknowledged, "Saved results must be acknowledged automatically after relaunch, including a lost response")
        let cleaned = try await backendResponse(path: operationPath + "/result")
        XCTAssertEqual(cleaned.status, 410)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: cleaned.data) as? [String: String])?["error"], "result_delivered")
        await waitForSummary(restored, ready: 1, pending: 0)
        try await control(mode: "offline")
        restored.terminate()
        let offline = launch(reset: false, baseURL: testURL)
        await waitForSummary(offline, ready: 1, pending: 0)
        XCTAssertTrue(offline.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(offline.staticTexts["Футболка"].exists)
        XCTAssertTrue(offline.staticTexts["Синий"].exists)
        let finalState = try await transportState()
        XCTAssertEqual(finalState["forwardedUploads"] as? Int, 1)
    }

    @MainActor
    func testExpiredUndeliveredResultKeepsOriginalAndRequiresExplicitRetryAfterRelaunch() async throws {
        try await control(mode: "accept-upload-then-offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        let accepted = try await waitForTransportCount("acceptedOperations", equalTo: 1, timeout: 20)
        XCTAssertTrue(accepted, "The real backend must accept the photo before delivery is disconnected")
        await waitForSummary(app, ready: 0, pending: 1, timeout: 5)
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 0, pending: 1, timeout: 5)
        try await control(mode: "online", advanceTimeMs: 7 * 24 * 60 * 60 * 1000)
        XCTAssertTrue(restored.staticTexts["failed-status"].firstMatch.waitForExistence(timeout: 30))
        XCTAssertTrue(restored.staticTexts["item-error"].firstMatch.label.contains("истёк"))
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists, "The local original must remain available after server expiry")
        XCTAssertFalse(restored.staticTexts["ready-status"].exists)
        let expired = try await transportState()
        XCTAssertEqual(expired["forwardedUploads"] as? Int, 1, "Expiry must never automatically start another paid processing attempt")
        let operationPath = try XCTUnwrap(expired["lastOperationPath"] as? String)
        let result = try await backendResponse(path: operationPath + "/result")
        XCTAssertEqual(result.status, 410)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: result.data) as? [String: String])?["error"], "result_expired")

        try tapVisibleButton("retry-processing", in: restored)
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        assertRecoveryDidNotOpenPhotoPicker(in: restored)
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists)
        let retried = try await transportState()
        XCTAssertEqual(retried["acceptedOperations"] as? Int, 2)
        XCTAssertEqual(retried["forwardedUploads"] as? Int, 2)
        restored.swipeDown()
        await waitForSummary(restored, ready: 1, pending: 0, timeout: 5)
    }

    private func backendResponse(path: String) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: URL(string: testURL + path)!)
        request.timeoutInterval = 5
        request.setValue("Bearer \(testToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        return (try XCTUnwrap(response as? HTTPURLResponse).statusCode, data)
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
    func testCancelDeletionKeepsPhotoAndDoesNotSendDelete() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        let before = try await transportState()
        try tapVisibleButton("delete-item", in: app)
        let cancel = app.alerts.buttons.matching(identifier: "cancel-delete-item").firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "Deletion must wait for explicit confirmation")
        XCTAssertTrue(app.alerts.staticTexts["Вещь исчезнет из гардероба. В сохранённых луках её места останутся пустыми."].exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "item-delete-confirmation"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let during = try await transportState()
        XCTAssertEqual(during["forwardedDeletes"] as? Int, before["forwardedDeletes"] as? Int)
        cancel.tap()
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.exists)
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 1, pending: 0)
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists)
        let after = try await transportState()
        XCTAssertEqual(after["forwardedDeletes"] as? Int, before["forwardedDeletes"] as? Int)
        XCTAssertEqual(after["forwardedUploads"] as? Int, before["forwardedUploads"] as? Int)
    }

    @MainActor
    func testDeletingTwoOfflineThingsSurvivesRelaunchAndNeverUploadsTheirPhotos() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 0, pending: 2, timeout: 5)
        try deleteFirstItem(in: app)
        await waitForSummary(app, ready: 0, pending: 1, timeout: 5)
        try deleteFirstItem(in: app)
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
    func testReadyThingDeletedOfflineStaysGoneAfterLostDeletionResponseAndAutomaticRetry() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        try await control(mode: "offline")
        try deleteFirstItem(in: app)
        await waitForSummary(app, ready: 0, pending: 0, timeout: 5)
        XCTAssertFalse(app.images["item-photo"].exists)
        app.terminate()

        try await control(mode: "drop-next-delete-response")
        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 0, pending: 0, timeout: 5)
        var repeated = false
        for _ in 0..<200 {
            let state = try await transportState()
            if state["deletedItems"] as? Int == 1,
               state["droppedDeleteResponses"] as? Int == 1,
               (state["forwardedDeletes"] as? Int ?? 0) >= 2 {
                repeated = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(repeated, "An accepted DELETE with a lost response must be retried automatically")
        await waitForSummary(restored, ready: 0, pending: 0, timeout: 5)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 1)
        XCTAssertEqual(state["forwardedUploads"] as? Int, 1, "Deleting a completed thing must not submit another processing request")
        try await control(mode: "offline")
        restored.terminate()
        let offline = launch(reset: false, baseURL: testURL)
        await waitForSummary(offline, ready: 0, pending: 0, timeout: 5)
        XCTAssertFalse(offline.images["item-photo"].exists)
    }

    @MainActor
    func testFailedThingCanBeDeletedOfflineAndItsCommandSurvivesRelaunch() async throws {
        _ = try await providerControl(["nextCutout": "provider_quota_exceeded"])
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.staticTexts["failed-status"].firstMatch.waitForExistence(timeout: 40))
        try await control(mode: "offline")
        try deleteFirstItem(in: app)
        await waitForSummary(app, ready: 0, pending: 0, timeout: 5)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        await waitForSummary(restored, ready: 0, pending: 0, timeout: 5)
        try await control(mode: "online")
        let delivered = try await waitForTransportCount("deletedItems", equalTo: 1, timeout: 20)
        XCTAssertTrue(delivered, "Deletion of a failed thing must resume after connectivity returns")
        XCTAssertFalse(restored.staticTexts["failed-status"].exists)
        XCTAssertFalse(restored.images["item-photo"].exists)
        let state = try await transportState()
        XCTAssertEqual(state["forwardedUploads"] as? Int, 1, "Deleting a failed thing must not retry processing")
    }

    @MainActor
    func testManualEditDraftCanContinueOrDiscardAndOnlySavePersists() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        let before = try await transportState()
        try tapVisibleButton("edit-item", in: app)
        app.navigationBars["Тип и цвета"].buttons["Отмена"].tap()
        XCTAssertFalse(app.alerts.firstMatch.exists, "An unchanged editor closes directly")
        XCTAssertFalse(app.buttons["save-item-edits"].exists)
        try tapVisibleButton("edit-item", in: app)
        try chooseType("shirt", in: app)
        app.navigationBars["Тип и цвета"].buttons["Отмена"].tap()
        let keepEditing = app.alerts.buttons.matching(identifier: "continue-item-editing").firstMatch
        XCTAssertTrue(keepEditing.waitForExistence(timeout: 5))
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "discard-item-changes").firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "item-draft-discard-confirmation"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        keepEditing.tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].exists)
        let header = app.navigationBars["Тип и цвета"]
        header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(app.buttons["save-item-edits"].exists, "A dirty sheet must survive a dismissal drag")
        app.navigationBars["Тип и цвета"].buttons["Отмена"].tap()
        app.alerts.buttons.matching(identifier: "discard-item-changes").firstMatch.tap()
        XCTAssertFalse(app.buttons["save-item-edits"].exists)
        XCTAssertTrue(app.staticTexts["Футболка"].exists)
        XCTAssertFalse(app.staticTexts["Рубашка"].exists)
        try tapVisibleButton("edit-item", in: app)
        try chooseType("shirt", in: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        try await control(mode: "offline")
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        try tapVisibleButton("edit-item", in: restored)
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        let after = try await transportState()
        XCTAssertEqual(after["forwardedUploads"] as? Int, before["forwardedUploads"] as? Int)
        XCTAssertEqual(after["acceptedOperations"] as? Int, before["acceptedOperations"] as? Int)
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
        XCTAssertFalse(app.textFields["edit-type"].exists)
        try chooseType("shirt", in: app)
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
        try tapVisibleButton("edit-item", in: restored)
        try chooseColors(["white", "green"], replacing: ["blue"], in: restored)
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

    @MainActor
    func testEmptyNewColorSelectionCannotFinishAndDoneOnlyUpdatesDraft() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        let before = try await transportState()
        try tapVisibleButton("edit-item", in: app)
        try tapVisibleButton("choose-colors", in: app)
        try tapColor("blue", in: app)
        XCTAssertFalse(app.buttons["done-colors"].isEnabled, "Removing the final color must not finish a new invalid selection")
        XCTAssertTrue(app.staticTexts["color-selection-requirement"].exists)
        try tapColor("green", in: app)
        XCTAssertTrue(app.buttons["done-colors"].isEnabled)
        app.buttons["done-colors"].tap()
        XCTAssertTrue(app.staticTexts["Зелёный"].exists)
        app.navigationBars["Тип и цвета"].buttons["Отмена"].tap()
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "discard-item-changes").firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons.matching(identifier: "discard-item-changes").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Синий"].exists, "Done must not persist before the item editor is saved")
        XCTAssertFalse(app.staticTexts["Зелёный"].exists)
        try tapVisibleButton("edit-item", in: app)
        try chooseColors(["green"], replacing: ["blue"], in: app)
        app.buttons["save-item-edits"].tap()
        try await control(mode: "offline")
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        try tapVisibleButton("edit-item", in: restored)
        XCTAssertTrue(restored.staticTexts["Зелёный"].exists)
        let after = try await transportState()
        XCTAssertEqual(after["forwardedUploads"] as? Int, before["forwardedUploads"] as? Int)
        XCTAssertEqual(after["acceptedOperations"] as? Int, before["acceptedOperations"] as? Int)
    }

    @MainActor
    func testPaletteAllowsAtMostFiveColorsAndPersistsCanonicalLabels() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        try tapVisibleButton("edit-item", in: app)
        try tapVisibleButton("choose-colors", in: app)
        for id in ["black", "white", "gray", "beige", "brown"] {
            try tapVisibleButton("color-\(id)", in: app)
        }
        XCTAssertFalse(app.buttons["color-red"].isEnabled, "A sixth color must be unavailable")
        try tapVisibleButton("color-black", in: app)
        XCTAssertTrue(app.buttons["color-red"].isEnabled)
        try tapVisibleButton("color-red", in: app)
        app.buttons["done-colors"].tap()
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Белый, Серый, Бежевый, Коричневый, Красный"].waitForExistence(timeout: 5))
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Белый, Серый, Бежевый, Коричневый, Красный"].waitForExistence(timeout: 5))
        XCTAssertFalse(restored.staticTexts["item-type"].exists, "Editing colors must not invent a manual type")
        let state = try await transportState()
        XCTAssertEqual(state["forwardedUploads"] as? Int, 0)
    }

    @MainActor
    func testLegacyLabelsSurviveUntouchedSaveAndExplicitSelectionReplacesOnlyEditedField() async throws {
        try await control(mode: "legacy-attributes")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        try await control(mode: "offline")
        try tapVisibleButton("edit-item", in: app)
        try tapVisibleButton("choose-colors", in: app)
        app.buttons["done-colors"].tap()
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Накидка"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Сиреневый"].exists)
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Накидка"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.staticTexts["Сиреневый"].exists)
        try tapVisibleButton("edit-item", in: restored)
        try chooseType("shirt", in: restored)
        restored.buttons["save-item-edits"].tap()
        XCTAssertTrue(restored.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.staticTexts["Сиреневый"].exists, "An untouched legacy color must survive a type edit")
        try tapVisibleButton("edit-item", in: restored)
        try chooseColors(["purple"], replacing: [], in: restored)
        restored.buttons["save-item-edits"].tap()
        XCTAssertTrue(restored.staticTexts["Фиолетовый"].waitForExistence(timeout: 5))
        XCTAssertFalse(restored.staticTexts["Сиреневый"].exists)
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        let state = try await transportState()
        XCTAssertEqual(state["forwardedUploads"] as? Int, 1)
    }

    @MainActor
    func testManualColorsWinOverInFlightResultAndReadyEditsDoNotSubmitAgain() async throws {
        try await control(mode: "offline")
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        app.swipeUp()
        try tapVisibleButton("edit-item", in: app)
        try chooseColors(["red"], replacing: [], in: app)
        // Prepare input before starting delivery, but save only while the result is in flight.
        try await control(mode: "hold-next-result")
        let held = try await waitForTransportCount("heldResultResponses", equalTo: 1, timeout: 40)
        XCTAssertTrue(held, "The result response must be in flight before saving the edit")
        app.buttons["save-item-edits"].tap()
        let waiting = try await transportState()
        XCTAssertEqual(waiting["heldResultResponses"] as? Int, 1, "The response must remain held until the manual edit is saved")
        try await control(mode: "online")
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Красный"].exists)
        XCTAssertTrue(app.staticTexts["Футболка"].exists, "A colors-only edit must retain the automatic type")

        try tapVisibleButton("edit-item", in: app)
        try chooseType("shirt", in: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Красный"].exists)
        app.terminate()
        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["Рубашка"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.staticTexts["Красный"].exists)
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
        try chooseType("shirt", in: app)
        try chooseColors(["red"], replacing: ["blue"], in: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].waitForExistence(timeout: 5))

        try await control(mode: "offline")
        let problem = app.buttons["cutout-problem"].firstMatch
        XCTAssertTrue(problem.waitForExistence(timeout: 5))
        try tapVisibleButton("cutout-problem", in: app)
        try tapVisibleButton("retry-processing", in: app)
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
        assertRecoveryDidNotOpenPhotoPicker(in: app)
        XCTAssertTrue(app.staticTexts["previous-result-notice"].exists)
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Рубашка"].exists)
        XCTAssertTrue(app.staticTexts["Красный"].exists)
        app.terminate()

        let restored = launch(reset: false, baseURL: testURL)
        restored.swipeUp()
        XCTAssertTrue(restored.staticTexts["previous-result-notice"].waitForExistence(timeout: 5))
        XCTAssertTrue(restored.images["item-photo"].firstMatch.exists)
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        XCTAssertTrue(restored.staticTexts["Красный"].exists)
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
        try chooseType("shirt", in: app)
        try chooseColors(["white"], replacing: ["blue"], in: app)
        app.buttons["save-item-edits"].tap()
        XCTAssertTrue(app.staticTexts["Рубашка"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        XCTAssertTrue(restored.staticTexts["Белый"].exists)
        _ = try await providerControl(["nextCutout": "red"])
        try await control(mode: "online")
        XCTAssertTrue(restored.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 40))
        XCTAssertFalse(restored.staticTexts["previous-result-notice"].exists)
        XCTAssertTrue(restored.staticTexts["Рубашка"].exists)
        XCTAssertTrue(restored.staticTexts["Белый"].exists)
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
        XCTAssertTrue(offline.staticTexts["Рубашка"].exists)
        XCTAssertTrue(offline.staticTexts["Белый"].exists)
        XCTAssertFalse(offline.staticTexts["previous-result-notice"].exists)
        offline.swipeDown()
        await waitForSummary(offline, ready: 1, pending: 0, timeout: 5)
    }

    @MainActor
    func testReplacementDeletedBeforeHeldResultArrivesStaysGoneAfterOfflineRelaunch() async throws {
        let app = launch(reset: true, baseURL: testURL)
        app.buttons["add-demo-photo"].tap()
        await waitForSummary(app, ready: 1, pending: 0)
        try await control(mode: "hold-next-result")
        try tapVisibleButton("cutout-problem", in: app)
        try tapVisibleButton("replace-demo-photo", in: app)
        let held = try await waitForTransportCount("heldResultResponses", equalTo: 1, timeout: 10)
        XCTAssertTrue(held, "The replacement result must be held before deleting the thing")
        try deleteFirstItem(in: app)
        await waitForSummary(app, ready: 0, pending: 0, timeout: 5)
        try await control(mode: "online")
        let deleted = try await waitForTransportCount("deletedItems", equalTo: 1, timeout: 10)
        XCTAssertTrue(deleted)
        XCTAssertFalse(app.images["item-photo"].exists)
        let state = try await transportState()
        XCTAssertEqual(state["acceptedOperations"] as? Int, 2)
        try await control(mode: "offline")
        app.terminate()
        let offline = launch(reset: false, baseURL: testURL)
        await waitForSummary(offline, ready: 0, pending: 0, timeout: 5)
        XCTAssertFalse(offline.images["item-photo"].exists)
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
    private func deleteFirstItem(in app: XCUIApplication) throws {
        try tapVisibleButton("delete-item", in: app)
        let confirmation = app.alerts.buttons.matching(identifier: "confirm-delete-item").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
    }

    @MainActor
    private func chooseType(_ id: String, in app: XCUIApplication) throws {
        try tapVisibleButton("choose-type", in: app)
        try tapVisibleButton("type-\(id)", in: app)
    }

    @MainActor
    private func chooseColors(_ selected: [String], replacing previous: [String], in app: XCUIApplication) throws {
        try tapVisibleButton("choose-colors", in: app)
        for id in previous where !selected.contains(id) {
            try tapColor(id, in: app)
        }
        for id in selected where !previous.contains(id) {
            try tapColor(id, in: app)
        }
        app.buttons["done-colors"].tap()
    }

    @MainActor
    private func tapColor(_ id: String, in app: XCUIApplication) throws {
        // List may remove offscreen rows from accessibility. Start from its known first row
        // before searching down, including when the previous choice was near the bottom.
        for _ in 0..<4 {
            let first = app.buttons["color-black"]
            if first.exists && first.isHittable { break }
            app.swipeDown()
        }
        try tapVisibleButton("color-\(id)", in: app)
    }

    private func waitForTransportCount(_ key: String, equalTo expected: Int, timeout: TimeInterval) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(timeout))
        while clock.now < deadline {
            if (try await transportState())[key] as? Int == expected { return true }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
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
