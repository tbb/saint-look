import XCTest
import Foundation

/// Shared by the existing flow and visual journeys. UIKit can expose a dialog
/// action as an outer Button containing a second Button with the same identity.
/// Resolve that one nested action, never an arbitrary first matching command.
@MainActor
func addressedNativeDialogAction(_ identifier: String, in app: XCUIApplication) throws -> XCUIElement {
    let matches = app.buttons.matching(identifier: identifier)
    guard matches.firstMatch.waitForExistence(timeout: 5) else {
        throw NativeDialogActionFailure.missing(identifier)
    }
    if matches.count == 1 { return matches.element }
    let candidates = matches.allElementsBoundByIndex
    guard candidates.count == 2 else {
        throw NativeDialogActionFailure.ambiguous("\(identifier): \(candidates.count) matching buttons")
    }
    // The recorded native hierarchy is a direct Button → Button pair. Inspect
    // each bound element: the query-wide containing filter is not unique here.
    let childCounts = candidates.map { $0.children(matching: .button).matching(identifier: identifier).count }
    guard childCounts.sorted() == [0, 1], let parentIndex = childCounts.firstIndex(of: 1) else {
        throw NativeDialogActionFailure.ambiguous("\(identifier): direct child counts \(childCounts)")
    }
    let action = candidates[parentIndex]
    let children = action.children(matching: .button).matching(identifier: identifier)
    let child = children.element
    let other = candidates[1 - parentIndex]
    let frame = action.frame
    let label = action.label
    guard action.identifier == identifier, child.identifier == identifier, other.identifier == identifier,
          !frame.isEmpty, frame == child.frame, frame == other.frame,
          !label.isEmpty, label == child.label, label == other.label else {
        throw NativeDialogActionFailure.ambiguous(identifier)
    }
    return action
}

private enum NativeDialogActionFailure: Error {
    case missing(String)
    case ambiguous(String)
}

final class OutfitFlowTests: XCTestCase {
    private let token = "saint-look-ui-tests-owner-token-00000001"
    private let baseURL = "http://127.0.0.1:8788"

    override func setUp() async throws {
        continueAfterFailure = false
        let benchmarkFlag = ProcessInfo.processInfo.environment["SAINT_LOOK_BENCHMARK"]
        guard benchmarkFlag == nil || ["0", "1"].contains(benchmarkFlag!) else {
            throw BenchmarkFailure.invalidConfiguration
        }
        if name.contains("testCachedRealBenchmarkFirstObservedResult") {
            guard benchmarkFlag == "1" else {
                throw XCTSkip("Cached real-model measurement requires the explicit isolated benchmark configuration")
            }
            _ = try benchmarkEnvironment()
            return
        }
        if benchmarkFlag == "1" {
            throw XCTSkip("The isolated benchmark selects only its one existing-harness measurement")
        }
        try await control("online", reset: true)
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8789/__control")!)
        request.httpMethod = "POST"
        request.setValue("Bearer saint-look-ui-provider-control-token-00000001", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["reset": true, "illustrationMode": "success"])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private enum BenchmarkFailure: Error { case invalidConfiguration, invalidResponse }

    private final class BenchmarkRedirectBlocker: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private func benchmarkEnvironment() throws -> [String: String] {
        let source = ProcessInfo.processInfo.environment
        let publicFixture = source["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1"
        let keys = ["SAINT_LOOK_BENCHMARK", "SAINT_LOOK_BENCHMARK_ORIGIN", "SAINT_LOOK_BENCHMARK_MANIFEST_SHA256",
                    "SAINT_LOOK_BENCHMARK_REVISION"] + (publicFixture ? [] : ["SAINT_LOOK_BENCHMARK_TOKEN"])
        let rawOrigin = source["SAINT_LOOK_BENCHMARK_ORIGIN"] ?? ""
        let origin = URL(string: rawOrigin)
        let validOrigin: Bool
        if publicFixture {
            validOrigin = rawOrigin.range(of: "^https://[^/?#]+/?$", options: .regularExpression) != nil
                && origin?.scheme == "https" && origin?.host != nil && origin?.host != "127.0.0.1"
                && (origin?.port.map { (1...65535).contains($0) } ?? true)
                && origin?.user == nil && origin?.password == nil && origin?.query == nil && origin?.fragment == nil
                && ["", "/"].contains(origin?.path ?? "")
        } else {
            validOrigin = rawOrigin.range(of: "^http://127\\.0\\.0\\.1:[0-9]{1,5}/?$", options: .regularExpression) != nil
                && origin?.scheme == "http" && origin?.host == "127.0.0.1"
                && origin?.port.map { (1...65535).contains($0) } == true
                && origin?.user == nil && origin?.password == nil && origin?.query == nil && origin?.fragment == nil
                && ["", "/"].contains(origin?.path ?? "")
        }
        guard keys.allSatisfy({ source[$0]?.isEmpty == false }), source["SAINT_LOOK_BENCHMARK"] == "1", validOrigin,
              source["SAINT_LOOK_BENCHMARK_MANIFEST_SHA256"]!.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              source["SAINT_LOOK_BENCHMARK_REVISION"]!.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              publicFixture ? (source["SAINT_LOOK_BENCHMARK_TOKEN"] == nil) :
                (source["SAINT_LOOK_BENCHMARK_TOKEN"]!.range(of: "^bench-[a-f0-9]{64}$", options: .regularExpression) != nil) else {
            throw BenchmarkFailure.invalidConfiguration
        }
        var values = Dictionary(uniqueKeysWithValues: keys.map { ($0, source[$0]!) })
        if publicFixture { values["SAINT_LOOK_BENCHMARK_PUBLIC"] = "1" }
        return values
    }

    private func benchmarkJSON(_ path: String, environment: [String: String]) async throws -> [String: Any] {
        guard let origin = URL(string: environment["SAINT_LOOK_BENCHMARK_ORIGIN"]!),
              let url = URL(string: path, relativeTo: origin), url.host == origin.host,
              url.scheme == origin.scheme, url.port == origin.port else {
            throw BenchmarkFailure.invalidConfiguration
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        if environment["SAINT_LOOK_BENCHMARK_PUBLIC"] != "1" {
            request.setValue("Bearer " + environment["SAINT_LOOK_BENCHMARK_TOKEN"]!, forHTTPHeaderField: "Authorization")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: BenchmarkRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1024 * 1024,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BenchmarkFailure.invalidResponse
        }
        return result
    }

    @MainActor
    func testCachedRealBenchmarkFirstObservedResult() async throws {
        let environment = try benchmarkEnvironment()
        let expectedSpace = "df268e5dab58fc14040ec8d5966455e546943406bf04380d24ee8ffcf4ca7e17"
        let health = try await benchmarkJSON("/health", environment: environment)
        let configuration = try await benchmarkJSON("/v1/recommendations/config", environment: environment)
        guard health["revision"] as? String == environment["SAINT_LOOK_BENCHMARK_REVISION"],
              health["dataVersion"] as? Int == 4, health["encoderAvailable"] as? Bool == true,
              let encoder = configuration["encoder"] as? [String: Any], encoder["mode"] as? String == "real",
              encoder["available"] as? Bool == true, encoder["activeSpaceID"] as? String == expectedSpace else {
            throw BenchmarkFailure.invalidResponse
        }
        let app = XCUIApplication()
        var appEnvironment = environment.merging([
            "SAINT_LOOK_BASE_URL": environment["SAINT_LOOK_BENCHMARK_ORIGIN"]!,
            "SAINT_LOOK_UI_TESTING": "1", "SAINT_LOOK_RESET_DATA": "1"
        ]) { _, supplied in supplied }
        if environment["SAINT_LOOK_BENCHMARK_PUBLIC"] != "1" {
            appEnvironment["SAINT_LOOK_OWNER_TOKEN"] = environment["SAINT_LOOK_BENCHMARK_TOKEN"]!
        }
        app.launchEnvironment = appEnvironment
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
        let status = app.staticTexts["wardrobe-summary"]
        let expectedSummaries = [4, 300].map { "Всего: \($0). Готово: \($0). Ожидают: 0." }
        let complete = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label IN %@", expectedSummaries), object: status)
        let catalogReady = await XCTWaiter.fulfillment(of: [complete], timeout: 60)
        XCTAssertEqual(catalogReady, .completed,
                       "The isolated catalog must contain every complete cached publication before measuring")
        let count = status.label == expectedSummaries[1] ? 300 : 4
        app.tabBars.buttons["Луки"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.tap()
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        app.buttons["edit-outfit"].tap()
        let body = button(prefix: "outfit-slot-body-", in: app)
        let bottom = button(prefix: "outfit-slot-bottom-", in: app)
        guard reveal(body, in: app), reveal(bottom, in: app),
              let bottomValue = bottom.value as? String, !bottomValue.isEmpty else { throw BenchmarkFailure.invalidResponse }
        let bodyID = String(body.identifier.dropFirst("outfit-slot-body-".count))
        let bottomID = String(bottom.identifier.dropFirst("outfit-slot-bottom-".count))
        let bottomPin = app.buttons["pin-slot-\(bottomID)"]
        tap(bottomPin, in: app)
        XCTAssertTrue(bottomPin.isSelected)
        performSlotAction("clear-slot", slotID: bodyID, in: app)
        XCTAssertTrue(body.label.contains("Выбрать вещь"))
        let emptyLabel = body.label
        for phase in ["first-after-app-launch-warm-backend", "warm-repeat-after-undo"] {
            guard reveal(body, in: app, towardTop: true) else { throw BenchmarkFailure.invalidResponse }
            let before = try await benchmarkJSON("/benchmark/metrics", environment: environment)
            guard let beforeRequests = before["requests"] as? [[String: Any]] else { throw BenchmarkFailure.invalidResponse }
            capture("benchmark-\(phase)-before")
            let emptyRowPixels = body.screenshot().pngRepresentation
            tap(app.buttons["outfit-slot-menu-\(bodyID)"], in: app)
            let command = try addressedNativeDialogAction("recommend-slot-\(bodyID)", in: app)
            guard command.exists, command.isHittable else { throw BenchmarkFailure.invalidResponse }
            // Menu discovery and readiness checks are outside the clock. The end
            // includes AX observation and a returned screenshot, hence an upper bound.
            let started = ProcessInfo.processInfo.systemUptime
            command.tap()
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label != %@ AND NOT (label CONTAINS 'Выбрать вещь')", emptyLabel), object: body)
            let observed = await XCTWaiter.fulfillment(of: [changed], timeout: 30)
            let screenshot = body.screenshot()
            let upperBoundMilliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1000
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = observed == .completed ? "benchmark-\(phase)-first-observed-result" : "benchmark-\(phase)-no-observed-result"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertEqual(observed, .completed, "One real recommendation must become observable without retry")
            XCTAssertNotEqual(screenshot.pngRepresentation, emptyRowPixels,
                              "The observed target screenshot must visibly differ from the empty row")
            capture("benchmark-\(phase)-result-context")
            XCTAssertEqual(bottom.value as? String, bottomValue)
            XCTAssertTrue(bottomPin.isSelected)
            let after = try await benchmarkJSON("/benchmark/metrics", environment: environment)
            guard let requests = after["requests"] as? [[String: Any]], requests.count == beforeRequests.count + 1,
                  let last = requests.last, last["items"] as? Int == count,
                  last["endpoint"] as? String == "/v1/recommendations/single", last["status"] as? Int == 200,
                  last["outcome"] as? String == "proposed", let bytes = last["payloadBytes"] as? Int, bytes > 0,
                  let elapsed = last["elapsedMilliseconds"] as? Double, elapsed >= 0,
                  let wireSHA = last["wireSHA256"] as? String,
                  wireSHA.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let canonicalSHA = last["canonicalSHA256"] as? String,
                  canonicalSHA.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let wireBytes = last["wireBytes"] as? Int, wireBytes == bytes else { throw BenchmarkFailure.invalidResponse }
            if let previous = beforeRequests.last {
                XCTAssertNotEqual(wireSHA, previous["wireSHA256"] as? String,
                                  "The two real wire bodies differ because only request and snapshot UUIDs vary")
                XCTAssertEqual(canonicalSHA, previous["canonicalSHA256"] as? String,
                               "The fixed fixture fields must retain the same canonical request hash")
            }
            let record: [String: Any] = ["evidence": "real-ios-cached-recommendation-observed-upper-bound", "phase": phase,
                "datasetItems": count, "uniqueSourcePhotographs": 4, "syntheticClones": true,
                "baselineRevision": "73700bab547ed71113dbf27db18136e054a1cca2",
                "benchmarkRevision": environment["SAINT_LOOK_BENCHMARK_REVISION"]!, "spaceID": expectedSpace,
                "requestId": last["requestId"] as? String ?? "", "snapshotId": last["snapshotId"] as? String ?? "",
                "HTTPPayloadBytes": bytes, "serverHTTPMilliseconds": elapsed,
                "wireSHA256": wireSHA, "wireBytes": wireBytes, "canonicalSHA256": canonicalSHA,
                "tapToFirstObservedScreenshotUpperBoundMilliseconds": upperBoundMilliseconds,
                "device": ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "iOS Simulator",
                "operatingSystem": ProcessInfo.processInfo.operatingSystemVersionString,
                "testHostLogicalProcessors": ProcessInfo.processInfo.processorCount,
                "testHostPhysicalMemoryBytes": ProcessInfo.processInfo.physicalMemory,
                "connectionClass": environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1"
                    ? "GitHub Mac Simulator to operator-hosted public HTTPS isolated synthetic backend"
                    : "GitHub Mac Simulator to same-runner loopback real backend",
                "limitations": [environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1"
                    ? "Includes native tap, catalog/serialization, public HTTPS round trip, real ranking, apply, AX observation and screenshot overhead."
                    : "Includes native tap, catalog/serialization, loopback HTTP, real ranking, apply, AX observation and screenshot overhead.",
                    "Upper bound, not an exact first rendered frame or a two-second guarantee; two observations are not p95.",
                    "The isolated catalog uses synthetic image fixtures copied from four public photographs; this is not live image-provider acceptance.",
                    environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1"
                        ? "The real encoder ran once per public photograph when the isolated bundle was prepared on its Linux host; requests use 300 cached clones of those four vectors."
                        : "The real encoder runs once per public photograph on the Mac runner; requests use 300 cached clones of those four vectors.",
                    environment["SAINT_LOOK_BENCHMARK_PUBLIC"] == "1"
                        ? "Uses remote public HTTPS to an operator-hosted isolated synthetic backend; includes WAN latency but is not production Fly300 or taste acceptance."
                        : "Same-runner loopback excludes Internet and Fly latency. Repeated vectors are not 300 distinct things or taste acceptance."]]
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            print("BENCHMARK_REAL_IOS " + String(decoding: data, as: UTF8.self))
            if phase == "first-after-app-launch-warm-backend" {
                tap(app.buttons["fitting-undo"], in: app)
                let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", emptyLabel), object: body)
                let undoRestored = await XCTWaiter.fulfillment(of: [restored], timeout: 5)
                XCTAssertEqual(undoRestored, .completed)
                XCTAssertEqual(bottom.value as? String, bottomValue)
            }
        }
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
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10),
                      "Launch must reach the foreground before UI interaction; current state: \(app.state.rawValue)")
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
        // Seven scroll gestures, with a visibility check after the final gesture too.
        for attempt in 0...7 {
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
            guard attempt < 7 else { break }
            let distance = present ? viewport.midY - frame.midY : (towardTop ? 180 : -180)
            let movement: CGFloat
            let start: XCUICoordinate
            if let bar = foregroundBar, ["Собрать лук", "Изменить лук"].contains(bar.identifier) {
                let navigationFrame = bar.frame
                let visibleNavigation = navigationFrame.intersection(app.frame)
                let reachableNavigation = bar.exists && !visibleNavigation.isEmpty && bar.buttons.allElementsBoundByIndex.contains {
                    $0.exists && $0.isHittable && !$0.frame.intersection(visibleNavigation).isEmpty
                }
                let containers = app.scrollViews.containing(.textField, identifier: "outfit-name").allElementsBoundByIndex.filter {
                    guard $0.exists else { return false }
                    let bounds = $0.frame
                    return !bounds.intersection(viewport).isEmpty && bounds.maxY > navigationFrame.maxY
                        && bounds.minX < navigationFrame.maxX && bounds.maxX > navigationFrame.minX
                }
                guard reachableNavigation, containers.count == 1, let container = containers.first else {
                    capture("ambiguous-constructor-scroll-surface")
                    XCTFail("Constructor scrolling requires one visible surface under its foreground navigation bar")
                    return false
                }
                let bounds = container.frame
                let content = viewport.intersection(bounds)
                guard !content.isEmpty, content.height > 60 else {
                    capture("invalid-constructor-scroll-path")
                    XCTFail("Constructor scrolling requires a usable content viewport")
                    return false
                }
                // At maximum text, seven 180pt drags stop before the first row.
                // Use the visible height, preserving the same bounded attempt count
                // and keeping the path away from navigation and the bottom safe area.
                let direction: CGFloat = distance < 0 ? -1 : 1
                let gestureInset = min(80, content.height * 0.2)
                let travel = min(content.height - 2 * gestureInset,
                                 min(content.height * 0.65, present ? max(40, abs(distance)) : content.height * 0.65))
                movement = direction * travel
                // The 8pt gutter stays inside the ScrollView, outside padded rows.
                let y = direction < 0 ? content.maxY - gestureInset : content.minY + gestureInset
                let origin = CGPoint(x: bounds.minX + 8, y: y)
                let destination = CGPoint(x: origin.x, y: origin.y + movement)
                guard bounds.contains(origin), bounds.contains(destination),
                      app.frame.contains(origin), app.frame.contains(destination) else {
                    capture("invalid-constructor-scroll-path")
                    XCTFail("Both constructor scroll endpoints must remain inside its visible ScrollView")
                    return false
                }
                start = container.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: origin.x - bounds.minX, dy: origin.y - bounds.minY))
            } else {
                movement = (distance < 0 ? -1.0 : 1.0) * min(180, max(100, abs(distance)))
                start = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: viewport.midX, dy: viewport.midY))
            }
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
    private func requestOutfitDeletion(in app: XCUIApplication) {
        app.buttons["outfit-actions"].tap()
        let deletion = app.buttons["delete-outfit"]
        XCTAssertTrue(deletion.waitForExistence(timeout: 5))
        deletion.tap()
    }

    @MainActor
    private func performSlotAction(_ action: String, slotID: String, in app: XCUIApplication) {
        tap(app.buttons["outfit-slot-menu-\(slotID)"], in: app)
        do {
            let option = try addressedNativeDialogAction("\(action)-\(slotID)", in: app)
            option.tap()
        } catch {
            capture("ambiguous-native-dialog-action")
            XCTFail("The addressed native dialog action must be unambiguous: \(error)")
        }
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
    private func deleteWardrobeItem(_ itemID: String, in app: XCUIApplication) {
        let card = app.descendants(matching: .any).matching(identifier: "wardrobe-item-\(itemID)").firstMatch
        tap(card, in: app)
        XCTAssertTrue(app.buttons["item-actions"].waitForExistence(timeout: 5))
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
        expectGone(app.keyboards.firstMatch, "Done must dismiss the keyboard before choosing a thing", timeout: 15)
    }

    @MainActor
    private func button(prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    @MainActor
    private func publishEditedItem(_ app: XCUIApplication) async {
        let saved = app.staticTexts["illustration-saved"]
        guard saved.label.contains("предыдущая") else { return }
        tap(app.buttons["generate-illustration"], in: app)
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Иллюстрация сохранена на устройстве."), object: saved)
        await fulfillment(of: [updated], timeout: 40)
    }

    @MainActor
    private func summary(_ app: XCUIApplication, ready: Int, pending: Int) async {
        if app.buttons["item-actions"].exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.navigationBars["Гардероб"].waitForExistence(timeout: 5))
        }
        for _ in 0..<4 where !app.staticTexts["wardrobe-summary"].isHittable && !app.staticTexts["wardrobe-empty"].isHittable { app.swipeDown() }
        if ready + pending == 0 {
            XCTAssertTrue(app.staticTexts["wardrobe-empty"].waitForExistence(timeout: 40))
            XCTAssertFalse(app.images["item-photo"].exists, "An empty collection must contain no garment photos")
            return
        }
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
    func testReplacementSavesTheAddressedLayerAndAnIncompleteRepairRemainsADiscardableDraft() async throws {
        let app = launch(reset: true)
        for count in 1...3 {
            tap(app.buttons["add-demo-photo"], in: app)
            await summary(app, ready: count, pending: 0)
        }
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        enterName("Для прогулки", in: app)
        let firstLayer = button(prefix: "outfit-slot-body-", in: app)
        let firstSlotID = firstLayer.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        tap(firstLayer, in: app)
        let firstChoice = button(prefix: "outfit-candidate-", in: app)
        let firstItemID = firstChoice.identifier.replacingOccurrences(of: "outfit-candidate-", with: "")
        chooseCandidate(firstChoice, in: app)
        tap(app.buttons["add-body-layer"], in: app)
        let secondLayer = app.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2'")).firstMatch
        let secondSlotID = secondLayer.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        tap(secondLayer, in: app)
        let remaining = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'"))
        XCTAssertEqual(remaining.count, 2)
        let secondChoiceID = remaining.element(boundBy: 0).identifier
        let replacementChoiceID = remaining.element(boundBy: 1).identifier
        chooseCandidate(app.buttons[secondChoiceID], in: app)
        app.buttons["save-outfit"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let cardID = card.identifier

        app.tabBars.buttons["Гардероб"].tap()
        deleteWardrobeItem(firstItemID, in: app)
        await summary(app, ready: 2, pending: 0)
        let beforeRepair = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons[cardID], in: app)
        tap(app.buttons["repair-slot-\(firstSlotID)"], in: app)
        XCTAssertTrue(app.navigationBars["Тело"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons[replacementChoiceID].exists)
        XCTAssertFalse(app.buttons[secondChoiceID].exists, "The other layer's thing is unavailable for replacement")
        chooseCandidate(app.buttons[replacementChoiceID], in: app)
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Для прогулки"].exists)
        XCTAssertFalse(button(prefix: "repair-slot-", in: app).exists)
        capture("outfit-successful-targeted-repair")
        app.buttons["edit-outfit"].tap()
        tap(app.buttons["outfit-slot-body-\(firstSlotID)"], in: app)
        XCTAssertTrue(app.buttons[replacementChoiceID].isSelected, "Only the addressed layer receives the replacement")
        app.buttons["cancel-outfit-picker"].tap()
        tap(app.buttons["outfit-slot-body-\(secondSlotID)"], in: app)
        XCTAssertTrue(app.buttons[secondChoiceID].isSelected, "The independent layer keeps its original thing")
        app.buttons["cancel-outfit-picker"].tap()
        app.buttons["cancel-outfit"].tap()
        XCTAssertFalse(app.alerts.firstMatch.exists, "Inspecting the saved replacement must not create a draft change")
        let afterRepair = try await activityCounts()
        XCTAssertEqual(afterRepair, beforeRepair)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons[cardID].exists, "Repair retains the saved outfit identity")

        app.tabBars.buttons["Гардероб"].tap()
        deleteWardrobeItem(secondChoiceID.replacingOccurrences(of: "outfit-candidate-", with: ""), in: app)
        await summary(app, ready: 1, pending: 0)
        deleteWardrobeItem(replacementChoiceID.replacingOccurrences(of: "outfit-candidate-", with: ""), in: app)
        await summary(app, ready: 0, pending: 0)
        tap(app.buttons["add-demo-photo"], in: app)
        await summary(app, ready: 1, pending: 0)
        let beforeIncomplete = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons[cardID], in: app)
        tap(app.buttons["repair-slot-\(firstSlotID)"], in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertTrue(app.navigationBars["Изменить лук"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        XCTAssertTrue(app.staticTexts["Выберите ещё одну вещь."].exists)
        XCTAssertTrue(app.buttons["outfit-slot-body-\(firstSlotID)"].label.contains("Футболка"))
        capture("outfit-incomplete-repair-draft")
        app.buttons["cancel-outfit"].tap()
        let keep = app.alerts.buttons.matching(identifier: "continue-outfit-editing").firstMatch
        XCTAssertTrue(keep.waitForExistence(timeout: 5), "A replacement below the minimum must remain a dirty draft")
        keep.tap()
        XCTAssertTrue(app.buttons["outfit-slot-body-\(firstSlotID)"].label.contains("Футболка"))
        app.buttons["cancel-outfit"].tap()
        app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.tap()
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'repair-slot-'")).count, 2,
                       "Discarding must not persist a one-thing composition")
        let afterIncomplete = try await activityCounts()
        XCTAssertEqual(afterIncomplete, beforeIncomplete)
        try await control("offline")
        XCUIDevice.shared.press(.home)
        app.terminate()
        let offline = launch(reset: false)
        offline.tabBars.buttons["Луки"].tap()
        tap(offline.buttons[cardID], in: offline)
        XCTAssertTrue(offline.staticTexts["Для прогулки"].exists)
        XCTAssertEqual(offline.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'repair-slot-'")).count, 2)
        XCUIDevice.shared.press(.home)
        offline.terminate()
    }

    @MainActor
    func testFittingRoomHasIndependentAccessibleZonesAndHonestEmptyCanvas() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        XCTAssertTrue(app.otherElements["fitting-canvas"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["fitting-empty-preview"].exists)
        let head = app.buttons["fitting-zone-head"]
        tap(head, in: app)
        XCTAssertTrue(head.isSelected)
        let shoes = app.buttons["fitting-zone-shoes"]
        tap(shoes, in: app)
        XCTAssertTrue(shoes.isSelected)
        XCTAssertFalse(head.isSelected)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        app.buttons["cancel-outfit"].tap()
        XCTAssertFalse(app.alerts.firstMatch.exists, "Changing the active zone must not dirty an empty look")
        app.terminate()
    }

    @MainActor
    func testMannequinActiveBodyLayerSurvivesIndependentZoneSwitches() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        tap(app.buttons["fitting-add-layer"], in: app)
        let layers = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'fitting-layer-'"))
        XCTAssertEqual(layers.count, 2)
        XCTAssertTrue(layers.element(boundBy: 1).isSelected)
        tap(layers.element(boundBy: 0), in: app)
        XCTAssertTrue(layers.element(boundBy: 0).isSelected)
        tap(layers.element(boundBy: 1), in: app)
        tap(app.buttons["fitting-zone-bottom"], in: app)
        tap(app.buttons["fitting-zone-body"], in: app)
        XCTAssertTrue(layers.element(boundBy: 1).isSelected, "Returning to body restores its active layer")
        app.buttons["cancel-outfit"].tap()
        app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.tap()
        XCTAssertTrue(app.buttons["create-first-outfit"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor
    func testPinnedSlotAllowsManualReplacementAndUndoWithoutAI() async throws {
        let app = launch(reset: true)
        for count in 1...3 {
            tap(app.buttons["add-demo-photo"], in: app)
            await summary(app, ready: count, pending: 0)
        }
        let before = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons["create-first-outfit"], in: app)
        let row = button(prefix: "outfit-slot-body-", in: app)
        tap(row, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        let slotID = String(row.identifier.dropFirst("outfit-slot-body-".count))
        let pin = app.buttons["pin-slot-\(slotID)"]
        tap(pin, in: app)
        XCTAssertTrue(pin.isSelected)
        tap(row, in: app)
        let old = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' AND selected == true")).firstMatch.identifier
        let alternative = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' AND selected == false")).firstMatch
        let new = alternative.identifier
        chooseCandidate(alternative, in: app)
        XCTAssertTrue(pin.isSelected, "Manual choice must not remove the slot pin")
        tap(app.buttons["fitting-undo"], in: app)
        tap(row, in: app)
        XCTAssertTrue(app.buttons[old].isSelected)
        XCTAssertFalse(app.buttons[new].isSelected)
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(pin.isSelected, "Undo changes composition, not pins")
        let after = try await activityCounts()
        XCTAssertEqual(after, before, "Pinning, manual choice and undo must stay local")
        app.buttons["cancel-outfit"].tap()
        app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch.tap()
        app.terminate()
    }

    @MainActor
    func testEmptyLooksOfferWardrobeAndPendingChoicesExplainReadiness() async throws {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        let wardrobe = app.buttons["В гардероб"]
        XCTAssertTrue(wardrobe.waitForExistence(timeout: 5),
                      "Before there are enough ready things, the empty collection must lead to the wardrobe")
        wardrobe.tap()
        XCTAssertTrue(app.navigationBars["Гардероб"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["add-photo"].exists)
        try await control("offline")
        tap(app.buttons["add-demo-photo"], in: app)
        await summary(app, ready: 0, pending: 1)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        tap(button(prefix: "outfit-slot-body-", in: app), in: app)
        XCTAssertTrue(app.staticTexts["Вещи ещё обрабатываются"].waitForExistence(timeout: 5),
                      "A pending thing with an unknown type must be explained as processing")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'")).count, 0)
        capture("outfit-picker-processing-empty")
        app.buttons["cancel-outfit-picker"].tap()
        app.buttons["cancel-outfit"].tap()
        XCTAssertFalse(app.alerts.firstMatch.exists, "Looking at an empty picker must not dirty the draft")
        XCUIDevice.shared.press(.home)
        app.terminate()
    }

    @MainActor
    func testPickerMarksCurrentThingAndFiltersTypesWithoutChangingTheSlotOnCancel() async throws {
        let app = launch(reset: true)
        for (index, type) in ["t_shirt", "hoodie"].enumerated() {
            tap(app.buttons["add-demo-photo"], in: app)
            await summary(app, ready: index + 1, pending: 0)
            openFirstItem(in: app)
            tap(app.buttons["edit-item"], in: app)
            tap(app.buttons["choose-type"], in: app)
            tap(app.buttons["type-\(type)"], in: app)
            app.buttons["save-item-edits"].tap()
        await publishEditedItem(app)
            await summary(app, ready: index + 1, pending: 0)
        }
        let before = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        let body = button(prefix: "outfit-slot-body-", in: app)
        tap(body, in: app)
        let shirt = app.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'outfit-candidate-' AND label CONTAINS 'Футболка'")).firstMatch
        let shirtID = shirt.identifier
        chooseCandidate(shirt, in: app)
        XCTAssertTrue(body.label.contains("Футболка"))
        tap(body, in: app)
        XCTAssertTrue(app.buttons[shirtID].isSelected,
                      "Reopening the picker must identify the thing currently occupying this slot")
        capture("outfit-picker-current-selection")
        app.buttons["outfit-type-filter"].tap()
        app.buttons["outfit-filter-hoodie"].tap()
        XCTAssertFalse(app.buttons[shirtID].exists, "The hoodie filter must hide the selected T-shirt without changing the slot")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'")).count, 1)
        XCTAssertTrue(button(prefix: "outfit-candidate-", in: app).label.contains("Худи"))
        capture("outfit-picker-type-filter")
        app.buttons["outfit-type-filter"].tap()
        app.buttons["outfit-filter-all"].tap()
        XCTAssertTrue(app.buttons[shirtID].isSelected)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'")).count, 2)
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(body.label.contains("Футболка"))
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled, "Filtering must not select a second thing")
        let after = try await activityCounts()
        XCTAssertEqual(after, before, "Choosing and filtering existing things must stay local")
        app.buttons["cancel-outfit"].tap()
        let discard = app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        discard.tap()
        XCUIDevice.shared.press(.home)
        app.terminate()
    }

    @MainActor
    func testMissingBodyLayerOpensItsPickerDirectlyAndCancelPreservesTheLook() async throws {
        let app = launch(reset: true)
        for count in 1...2 {
            tap(app.buttons["add-demo-photo"], in: app)
            await summary(app, ready: count, pending: 0)
        }
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        tap(button(prefix: "outfit-slot-body-", in: app), in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        tap(app.buttons["add-body-layer"], in: app)
        let secondLayer = app.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2'")).firstMatch
        tap(secondLayer, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        app.buttons["save-outfit"].tap()
        let card = button(prefix: "outfit-card-", in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let cardID = card.identifier

        app.tabBars.buttons["Гардероб"].tap()
        deleteFirstItem(in: app)
        await summary(app, ready: 1, pending: 0)
        let before = try await activityCounts()
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons[cardID], in: app)
        let missingLayer = button(prefix: "repair-slot-", in: app)
        guard reveal(missingLayer, in: app) else { return }
        let missingLayerID = missingLayer.identifier
        missingLayer.tap()

        XCTAssertTrue(app.navigationBars["Тело"].waitForExistence(timeout: 5),
                      "Replacing a deleted body layer must open that zone's picker directly")
        XCTAssertTrue(app.buttons["cancel-outfit-picker"].exists)
        XCTAssertFalse(app.buttons["save-outfit"].exists, "Repair must not begin in the general editor")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'outfit-candidate-'")).count, 0,
                       "The surviving thing is already used by the other layer")
        capture("outfit-targeted-replacement-empty")
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(app.buttons["edit-outfit"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons[missingLayerID].exists, "Cancelling must leave the original missing layer unchanged")
        let after = try await activityCounts()
        XCTAssertEqual(after, before, "Opening and cancelling repair must not upload photos or call AI")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons[cardID].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-'")).count, 1)
        XCUIDevice.shared.press(.home)
        app.terminate()
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
        await publishEditedItem(app)
        await summary(app, ready: 2, pending: 0)

        // The pending photo must finish after the new outfit is saved.
        try await control("offline")
        app.buttons["add-demo-photo"].tap()
        await summary(app, ready: 2, pending: 1)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(button(prefix: "outfit-slot-head-", in: app), in: app)
        XCTAssertTrue(app.navigationBars["Голова"].exists)
        XCTAssertTrue(app.staticTexts["Вещи ещё обрабатываются"].waitForExistence(timeout: 5),
                      "The unknown pending thing is not eligible until processing identifies its zone")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 0)
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
        tap(offline.buttons[savedCardID], in: offline)
        XCTAssertTrue(offline.staticTexts["Лук без названия"].exists)
        capture("outfit-detail-composition")
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
        tap(offline.buttons[savedCardID], in: offline)
        XCTAssertFalse(button(prefix: "repair-slot-", in: offline).exists,
                       "Cancelling wardrobe deletion must preserve the saved outfit's links")
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Брюки'")).firstMatch.exists)
        offline.navigationBars.buttons.firstMatch.tap()
        offline.tabBars.buttons["Гардероб"].tap()
        deleteFirstItem(in: offline)
        await summary(offline, ready: 1, pending: 0)
        offline.tabBars.buttons["Луки"].tap()
        tap(offline.buttons[savedCardID], in: offline)
        let missingSlot = button(prefix: "repair-slot-", in: offline)
        guard reveal(missingSlot, in: offline) else { return }
        capture("outfit-03-missing-item")
        missingSlot.tap()
        XCTAssertTrue(offline.navigationBars["Низ"].waitForExistence(timeout: 5))
        XCTAssertEqual(offline.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'")).count, 0)
        offline.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(offline.buttons["edit-outfit"].waitForExistence(timeout: 5))
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
        await publishEditedItem(app)
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
        let cycleSlotID = firstID.replacingOccurrences(of: "outfit-slot-body-", with: "")
        func waitForCycledType(_ type: String) {
            // A native dialog can dismiss before the row's accessibility label updates.
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS %@", type), object: app.buttons[firstID])
            let result = XCTWaiter.wait(for: [changed], timeout: 5)
            if result != .completed { capture("cycle-selection-timeout") }
            XCTAssertEqual(result, .completed, "The single cycle action must update its addressed layer")
        }
        performSlotAction("next-slot", slotID: cycleSlotID, in: app)
        waitForCycledType("Футболка")
        XCTAssertTrue(app.buttons[firstID].label.contains("Футболка"))
        performSlotAction("previous-slot", slotID: cycleSlotID, in: app)
        waitForCycledType("Свитер")
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists)
        tap(app.buttons[firstID], in: app)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 2)
        app.buttons["cancel-outfit-picker"].tap()
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        let providerCounts = try await activityCounts()
        performSlotAction("recommend-slot", slotID: cycleSlotID, in: app)
        let proposed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'Футболка'"), object: app.buttons[firstID])
        XCTAssertEqual(XCTWaiter.wait(for: [proposed], timeout: 30), .completed,
                       "Controlled backend recommendation replaces only the first layer")
        XCTAssertTrue(app.buttons[secondID].label.contains("Худи"))
        XCTAssertTrue(app.buttons[thirdID].label.contains("Куртка"))
        let afterRecommendation = try await activityCounts()
        XCTAssertEqual(afterRecommendation, providerCounts, "Recommendation must not upload images or call image/attribute providers")
        tap(app.buttons["fitting-undo"], in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"), "One undo restores the pre-proposal draft")
        performSlotAction("similar-slot", slotID: cycleSlotID, in: app)
        let similar = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'Футболка'"), object: app.buttons[firstID])
        XCTAssertEqual(XCTWaiter.wait(for: [similar], timeout: 30), .completed,
                       "Similar intent may offer the only eligible alternative without an exact type match")
        XCTAssertTrue(app.buttons[secondID].label.contains("Худи"))
        XCTAssertTrue(app.buttons[thirdID].label.contains("Куртка"))
        tap(app.buttons["fitting-undo"], in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"))
        let afterSimilar = try await activityCounts()
        XCTAssertEqual(afterSimilar, providerCounts, "Both intentions reuse cached representations without provider or encoder calls")
        // Actual HTTP composition uses the already prepared catalog. A pinned
        // empty head and the existing occupied places survive fillEmpty.
        let headRow = button(prefix: "outfit-slot-head-", in: app)
        let headSlotID = String(headRow.identifier.dropFirst("outfit-slot-head-".count))
        tap(app.buttons["pin-slot-\(headSlotID)"], in: app)
        performSlotAction("clear-slot", slotID: cycleSlotID, in: app)
        tap(app.buttons["fitting-fill-empty"], in: app)
        let filled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "NOT (label CONTAINS 'Выбрать вещь')"), object: app.buttons[firstID])
        XCTAssertEqual(XCTWaiter.wait(for: [filled], timeout: 30), .completed)
        XCTAssertTrue(app.buttons[secondID].label.contains("Худи"))
        XCTAssertTrue(app.buttons[thirdID].label.contains("Куртка"))
        XCTAssertTrue(headRow.label.contains("Выбрать вещь"))
        XCTAssertTrue(app.buttons["pin-slot-\(headSlotID)"].isSelected)
        tap(app.buttons["fitting-undo"], in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Выбрать вещь"), "Whole fill is undone in one step")
        tap(app.buttons["fitting-undo"], in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Свитер"), "The preceding manual clear has its own undo entry")
        let afterComposition = try await activityCounts()
        XCTAssertEqual(afterComposition, providerCounts, "Whole composition must not repeat image providers or encoder")
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
        tap(offline.buttons[cardID], in: offline)
        offline.buttons["edit-outfit"].tap()
        guard reveal(offline.buttons[firstID], in: offline) else { return }
        XCTAssertTrue(offline.buttons[firstID].label.contains("Тело · слой 1"))
        XCTAssertTrue(offline.buttons[firstID].label.contains("Свитер"))
        guard reveal(offline.buttons[secondID], in: offline) else { return }
        XCTAssertTrue(offline.buttons[secondID].label.contains("Худи"))
        guard reveal(offline.buttons[thirdID], in: offline) else { return }
        XCTAssertTrue(offline.buttons[thirdID].label.contains("Тело · слой 3"))
        XCTAssertTrue(offline.buttons[thirdID].label.contains("Куртка"))
        let emptyFourth = offline.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 4'")).firstMatch
        guard reveal(emptyFourth, in: offline) else { return }
        XCTAssertTrue(emptyFourth.label.contains("Выбрать вещь"), "The deliberately empty final layer must survive relaunch")
        capture("outfit-05-layers-offline")
        XCUIDevice.shared.press(.home)
        offline.terminate()
    }

    @MainActor
    func testSwipeDoesNotOpenPickerAndVerticalDragScrollsThroughRow() {
        let app = launch(reset: true)
        app.tabBars.buttons["Луки"].tap()
        app.buttons["create-first-outfit"].tap()
        for _ in 0..<5 { tap(app.buttons["add-body-layer"], in: app) }
        let head = button(prefix: "outfit-slot-head-", in: app)
        guard reveal(head, in: app, towardTop: true) else { return }
        head.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "Horizontal drag must never open the picker")
        guard !app.buttons["cancel-outfit-picker"].exists else { return }
        // Selecting the head zone via swipe collapses body-layer controls above this row.
        // Re-reveal after that layout change before measuring or starting a vertical gesture.
        guard reveal(head, in: app, towardTop: true) else { return }
        let body = button(prefix: "outfit-slot-body-", in: app)
        let originalBodyY = body.frame.minY
        let dragStart = head.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        dragStart.press(forDuration: 0.05, thenDragTo: dragStart.withOffset(CGVector(dx: 0, dy: -160)))
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "Vertical drag must never open the picker")
        XCTAssertLessThan(body.frame.minY, originalBodyY - 20, "Dragging through a row must still scroll the constructor")
        tap(body, in: app)
        XCTAssertTrue(app.buttons["cancel-outfit-picker"].waitForExistence(timeout: 5), "A real tap still opens the picker")
        app.buttons["cancel-outfit-picker"].tap()
        app.buttons["cancel-outfit"].tap()
        let discard = app.alerts.buttons.matching(identifier: "discard-outfit-changes").firstMatch
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        discard.tap()
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
        guard reveal(head, in: app, towardTop: true) else { return }
        head.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "A swipe must not activate the row's tap action")
        guard !app.buttons["cancel-outfit-picker"].exists else { return }
        XCTAssertEqual(head.label, originalHead)
        tap(head, in: app)
        XCTAssertTrue(app.staticTexts["Нет вещей для этой зоны"].waitForExistence(timeout: 5))
        app.buttons["cancel-outfit-picker"].tap()
        let first = button(prefix: "outfit-slot-body-", in: app)
        tap(first, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        let firstID = first.identifier
        let selectedLabel = first.label
        guard reveal(first, in: app) else { return }
        first.swipeLeft()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "A one-candidate swipe must stay in the editor")
        XCTAssertEqual(first.label, selectedLabel, "One candidate must never clear a selection")
        tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND label BEGINSWITH 'Тело · слой 2' ")).firstMatch
        tap(second, in: app)
        XCTAssertTrue(app.staticTexts["Все подходящие вещи уже выбраны"].waitForExistence(timeout: 5))
        app.buttons["cancel-outfit-picker"].tap()
        let secondID = second.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        guard reveal(second, in: app) else { return }
        second.swipeRight()
        XCTAssertFalse(app.buttons["cancel-outfit-picker"].exists, "An empty-pool swipe must stay in the editor")
        XCTAssertTrue(second.label.contains("Выбрать вещь"))
        performSlotAction("remove-body-layer", slotID: secondID, in: app)
        let firstSlotID = firstID.replacingOccurrences(of: "outfit-slot-body-", with: "")
        performSlotAction("clear-slot", slotID: firstSlotID, in: app)
        XCTAssertTrue(app.buttons[firstID].label.contains("Выбрать вещь"))
        performSlotAction("remove-body-layer", slotID: firstSlotID, in: app)
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
        await publishEditedItem(app)
            await summary(app, ready: index + 1, pending: 0)
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
        tap(app.buttons[cardIDs[0]], in: app)
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
        XCTAssertTrue(app.staticTexts["Первый"].waitForExistence(timeout: 5))
        app.buttons["edit-outfit"].tap()
        enterName(" сохранён", in: app)
        let bottom = button(prefix: "outfit-slot-bottom-", in: app)
        let bottomID = bottom.identifier.replacingOccurrences(of: "outfit-slot-bottom-", with: "")
        performSlotAction("clear-slot", slotID: bottomID, in: app)
        XCTAssertFalse(app.buttons["save-outfit"].isEnabled)
        tap(bottom, in: app)
        chooseCandidate(button(prefix: "outfit-candidate-", in: app), in: app)
        tap(app.buttons["add-body-layer"], in: app)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.staticTexts["Первый сохранён"].waitForExistence(timeout: 5))
        capture("outfit-07-edited")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).count, 2)
        app.tabBars.buttons["Гардероб"].tap()
        deleteFirstItem(in: app)
        await summary(app, ready: 1, pending: 0)
        app.tabBars.buttons["Луки"].tap()
        tap(app.buttons[cardIDs[0]], in: app)
        app.buttons["edit-outfit"].tap()
        enterName(" неполный", in: app)
        XCTAssertTrue(app.buttons["save-outfit"].isEnabled)
        app.buttons["save-outfit"].tap()
        XCTAssertTrue(app.staticTexts["Первый сохранён неполный"].waitForExistence(timeout: 5))
        requestOutfitDeletion(in: app)
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "cancel-delete-outfit").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "confirm-delete-outfit").firstMatch.exists)
        capture("outfit-11-delete-confirmation")
        app.alerts.buttons.matching(identifier: "cancel-delete-outfit").firstMatch.tap()
        XCTAssertTrue(app.buttons["edit-outfit"].exists)
        requestOutfitDeletion(in: app)
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
            ("http://127.0.0.1:8789/__control", "saint-look-ui-provider-control-token-00000001", ["attributesCalls", "cutoutCalls", "encoderPreparationCalls"]),
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
        XCTAssertTrue(app.staticTexts["На прогулку"].waitForExistence(timeout: 5))
        capture("outfit-detail-renamed")
        requestOutfitDeletion(in: app)
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
