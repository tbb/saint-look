import XCTest

final class WardrobeFlowTests: XCTestCase {
    private let testToken = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_TOKEN"]
        ?? "saint-look-ui-tests-owner-token-00000001"
    private let testURL = ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TEST_URL"]
        ?? "http://127.0.0.1:8787"

    override func setUpWithError() throws {
        continueAfterFailure = false
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

    func testPhotoBecomesReadyThroughBackendAndSurvivesOfflineRelaunch() throws {
        let app = launch(reset: true, baseURL: testURL)
        XCTAssertTrue(app.staticTexts["demo-notice"].waitForExistence(timeout: 5))
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.images["item-photo"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["pending-status"].firstMatch.waitForExistence(timeout: 5))
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
}
