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
        let expectedVersion = try XCTUnwrap(environment["SAINT_LOOK_REMOTE_DATA_VERSION"])
        let dataVersion = try XCTUnwrap(Int(expectedVersion))
        guard dataVersion == 4 else { XCTFail("This client release requires data version 4."); return }
        XCTAssertEqual(health["dataVersion"] as? Int, dataVersion)

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
        let photo = cleanup.images["item-photo"].firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 5))
        photo.tap()
        XCTAssertTrue(cleanup.buttons["item-actions"].waitForExistence(timeout: 5))
        cleanup.buttons["item-actions"].tap()
        cleanup.buttons["delete-item"].tap()
        let confirmation = cleanup.alerts.buttons.matching(identifier: "confirm-delete-item").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
        XCTAssertTrue(cleanup.staticTexts["wardrobe-empty"].waitForExistence(timeout: 10))
        XCTAssertFalse(cleanup.images["item-photo"].exists)
        // This allows the durable command to drain; API smoke separately verifies server cleanup.
        try await Task.sleep(nanoseconds: 2_000_000_000)
    }
}

/// Paid-provider work is opt-in; ordinary CI skips this test before touching the app or API.
final class LiveTrialTests: XCTestCase {
    @MainActor
    private func readyCard(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'wardrobe-item-' AND value == 'Готово'")).firstMatch
    }

    @MainActor
    func testPublicPhotosBecomeRealCardsAndSurviveOfflineRelaunch() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["SAINT_LOOK_LIVE_TRIAL"] == "1" else { throw XCTSkip("Live trial requires explicit account and photo preflight.") }
        continueAfterFailure = false
        let count = try XCTUnwrap(Int(env["SAINT_LOOK_TRIAL_PHOTO_COUNT"] ?? ""))
        guard [2, 3].contains(count) else { XCTFail("Select two or three approved photos."); return }
        let origin = try XCTUnwrap(env["SAINT_LOOK_REMOTE_URL"])
        let url = try XCTUnwrap(URL(string: origin))
        guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { XCTFail("Use an HTTPS origin."); return }
        let token = try XCTUnwrap(env["SAINT_LOOK_REMOTE_TOKEN"])
        guard token.count >= 32 else { XCTFail("Owner token is missing."); return }
        let revision = try XCTUnwrap(env["SAINT_LOOK_REMOTE_REVISION"])
        let marker = try XCTUnwrap(env["SAINT_LOOK_REMOTE_DEPLOYMENT_ID"])
        guard revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              !marker.isEmpty else { XCTFail("Expected deployment identity is missing."); return }
        var request = URLRequest(url: url.appendingPathComponent("health"))
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let health = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(health["status"] as? String, "ok")
        XCTAssertEqual(health["mode"] as? String, "live")
        XCTAssertEqual(health["revision"] as? String, revision)
        XCTAssertEqual(health["deploymentId"] as? String, marker)
        let expectedVersion = try XCTUnwrap(env["SAINT_LOOK_REMOTE_DATA_VERSION"])
        let dataVersion = try XCTUnwrap(Int(expectedVersion))
        guard dataVersion == 4 else { XCTFail("This client release requires data version 4."); return }
        XCTAssertEqual(health["dataVersion"] as? Int, dataVersion)
        guard health["illustrationAvailable"] as? Bool == true,
              health["encoderAvailable"] as? Bool == true,
              health["preparationAvailable"] as? Bool == true,
              health["publicationProtocol"] as? String == "prepared-item-v1" else {
            XCTFail("Full item preparation must be available before submitting trial photos.")
            return
        }
        defer { XCUIApplication().terminate() }
        func launch(reset: Bool, online: Bool, index: Int) -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment = ["SAINT_LOOK_BASE_URL": online ? origin : "http://127.0.0.1:1",
                "SAINT_LOOK_OWNER_TOKEN": token, "SAINT_LOOK_UI_TESTING": "1", "SAINT_LOOK_RESET_DATA": reset ? "1" : "0",
                "SAINT_LOOK_LIVE_TRIAL": "1", "SAINT_LOOK_TRIAL_PHOTO_INDEX": String(index)]
            app.launch()
            return app
        }
        for index in 0..<count {
            let app = launch(reset: index == 0, online: true, index: index)
            let add = app.buttons["add-trial-photo"]
            XCTAssertTrue(add.waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["add-demo-photo"].exists)
            // Exactly one upload action per selected photo. Never retry a failed provider result.
            add.tap()
            // The summary counts verified complete local publications, including
            // illustration, attributes and cached representations after commit.
            let expected = "Всего: \(index + 1). Готово: \(index + 1). Ожидают: 0."
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", expected), object: app.staticTexts["wardrobe-summary"])
            await fulfillment(of: [ready], timeout: 180)
            let preparedCard = readyCard(in: app)
            XCTAssertEqual(preparedCard.value as? String, "Готово")
            let cardIdentifier = preparedCard.identifier
            XCTAssertFalse(app.staticTexts["Тестовая вырезка"].exists, "Real provider results must not be demo fixtures")
            XCTAssertTrue(preparedCard.images["item-photo"].firstMatch.exists)
            let type = preparedCard.staticTexts["item-type"].firstMatch.label
            let colorsElement = preparedCard.staticTexts["item-colors"].firstMatch
            let colors = colorsElement.exists ? colorsElement.label : nil
            XCTAssertFalse(type.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            // Empty colors are a valid canonical attribute set, not incomplete preparation.
            let image = preparedCard.images["item-photo"].firstMatch.screenshot().pngRepresentation
            app.terminate()
            let offline = launch(reset: false, online: false, index: index)
            let retainedCard = offline.buttons[cardIdentifier]
            XCTAssertTrue(retainedCard.waitForExistence(timeout: 5))
            XCTAssertEqual(retainedCard.value as? String, "Готово")
            XCTAssertEqual(offline.staticTexts["wardrobe-summary"].label, expected)
            XCTAssertEqual(retainedCard.staticTexts["item-type"].firstMatch.label, type)
            let offlineColors = retainedCard.staticTexts["item-colors"].firstMatch
            XCTAssertEqual(offlineColors.exists ? offlineColors.label : nil, colors)
            XCTAssertEqual(retainedCard.images["item-photo"].firstMatch.screenshot().pngRepresentation, image)
            print("Live trial photo \(index + 1)/\(count): fully prepared and retained offline; backend \(revision), deployment \(marker)")
            offline.terminate()
        }
        // Reconnect so durable acknowledgements drain. Keep cards for visual/manual quality review.
        let final = launch(reset: false, online: true, index: count - 1)
        XCTAssertTrue(readyCard(in: final).waitForExistence(timeout: 5))
        try await Task.sleep(nanoseconds: 2_000_000_000)
    }
}
