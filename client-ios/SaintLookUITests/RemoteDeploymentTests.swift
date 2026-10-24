import XCTest
import Foundation

/// Opt-in only: a real HTTPS deployment, without the local proxy or provider control routes.
final class RemoteDeploymentTests: XCTestCase {
    @MainActor
    func testRemotePhotoBecomesReadyAndSurvivesOfflineRelaunch() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SAINT_LOOK_REMOTE_SMOKE"] == "1" else {
            throw XCTSkip("Remote deployment smoke requires explicit configuration.")
        }
        continueAfterFailure = false
        let origin = try XCTUnwrap(environment["SAINT_LOOK_REMOTE_URL"])
        let url = try XCTUnwrap(URL(string: origin))
        guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else {
            XCTFail("Remote smoke requires an HTTPS origin.")
            return
        }
        let token = try XCTUnwrap(environment["SAINT_LOOK_REMOTE_TOKEN"])
        guard token.count >= 32 else { XCTFail("Remote owner token is missing."); return }
        let revision = try XCTUnwrap(environment["SAINT_LOOK_REMOTE_REVISION"])
        let deploymentID = try XCTUnwrap(environment["SAINT_LOOK_REMOTE_DEPLOYMENT_ID"])
        guard revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              !deploymentID.isEmpty else { XCTFail("Expected deployment identity is missing."); return }

        var request = URLRequest(url: url.appendingPathComponent("health"))
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let health = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(health["status"] as? String, "ok")
        XCTAssertEqual(health["mode"] as? String, "demo")
        XCTAssertEqual(health["revision"] as? String, revision)
        XCTAssertEqual(health["deploymentId"] as? String, deploymentID)
        XCTAssertEqual(health["dataVersion"] as? Int, 1)

        func launch(reset: Bool, baseURL: String) -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment["SAINT_LOOK_BASE_URL"] = baseURL
            app.launchEnvironment["SAINT_LOOK_OWNER_TOKEN"] = token
            app.launchEnvironment["SAINT_LOOK_UI_TESTING"] = "1"
            app.launchEnvironment["SAINT_LOOK_RESET_DATA"] = reset ? "1" : "0"
            app.launch()
            return app
        }
        let app = launch(reset: true, baseURL: origin)
        defer { XCUIApplication().terminate() }
        XCTAssertTrue(app.staticTexts["demo-notice"].waitForExistence(timeout: 5))
        app.buttons["add-demo-photo"].tap()
        XCTAssertTrue(app.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 120), "Remote synthetic processing did not finish.")
        XCTAssertTrue(app.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Футболка"].exists)
        XCTAssertTrue(app.staticTexts["Синий"].exists)
        app.terminate()

        let offline = launch(reset: false, baseURL: "http://127.0.0.1:1")
        XCTAssertTrue(offline.staticTexts["ready-status"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(offline.images["item-photo"].firstMatch.exists)
        XCTAssertTrue(offline.staticTexts["Футболка"].exists)
        XCTAssertTrue(offline.staticTexts["Синий"].exists)
        offline.terminate()

        // Resume acknowledgement and delete the synthetic card through the normal UI.
        let cleanup = launch(reset: false, baseURL: origin)
        let button = cleanup.buttons["delete-item"].firstMatch
        for _ in 0..<5 {
            if button.exists && button.isHittable && button.frame.maxY < cleanup.frame.maxY - 50 { break }
            cleanup.swipeUp()
        }
        XCTAssertTrue(button.isHittable)
        button.tap()
        let empty = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Всего: 0. Готово: 0. Ожидают: 0."), object: cleanup.staticTexts["wardrobe-summary"])
        await fulfillment(of: [empty], timeout: 10)
        // This allows the durable command to drain; API smoke separately verifies server cleanup.
        try await Task.sleep(nanoseconds: 2_000_000_000)
    }
}
