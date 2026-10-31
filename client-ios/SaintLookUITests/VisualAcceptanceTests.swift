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
        try require(["iphone-light", "iphone-dark", "iphone-max-text", "ipad-light"].contains(profile))
        try await control("online", reset: true)
    }

    private enum JourneyFailure: Error { case failed }

    private func require(_ condition: Bool, _ message: String = "Required public UI state was not observed",
                         file: StaticString = #filePath, line: UInt = #line) throws {
        guard condition else {
            XCTFail(message, file: file, line: line)
            throw JourneyFailure.failed
        }
    }

    private func requireEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "Public UI value differs",
                                            file: StaticString = #filePath, line: UInt = #line) throws {
        try require(actual == expected, "\(message): actual=\(actual), expected=\(expected)", file: file, line: line)
    }

    @MainActor
    private func launch(_ scenario: String = "ready-four", reset: Bool = true) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["SAINT_LOOK_BASE_URL": baseURL,
            "SAINT_LOOK_OWNER_TOKEN": "saint-look-ui-tests-owner-token-00000001",
            "SAINT_LOOK_UI_TESTING": "1", "SAINT_LOOK_RESET_DATA": reset ? "1" : "0",
            "SAINT_LOOK_VISUAL_SCENARIO": scenario]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        try require(app.wait(for: .runningForeground, timeout: 10), "Visual app must launch in foreground")
        return app
    }

    @MainActor
    private func capture(_ name: String) throws {
        try requireEqual(testRun?.failureCount ?? 0, 0, "Do not label later screenshots as successful after a failed action")
        recordScreen(name)
    }

    @MainActor
    private func recordScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(profile)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func diagnose(_ name: String, app: XCUIApplication, detail: String = "") {
        recordScreen(name)
        let state = XCTAttachment(string: detail + "\n" + app.debugDescription)
        state.name = "\(profile)-\(name)-accessibility"
        state.lifetime = .keepAlways
        add(state)
    }

    @MainActor
    private func waitVisible(_ element: XCUIElement, in app: XCUIApplication) throws {
        // Each AX property read is a remote snapshot. Re-reading frames consumed
        // the full wait deadline on iPad even when the control was already hittable.
        let viewport = app.frame
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard element.exists else { return false }
            let frame = element.frame
            return element.isHittable && !frame.isEmpty && viewport.intersects(frame)
        }, object: element)
        guard XCTWaiter.wait(for: [ready], timeout: 10) == .completed else {
            diagnose("unavailable-native-control", app: app, detail: element.debugDescription)
            try require(false, "The intended native control is not visible and hittable")
            return
        }
    }

    @MainActor
    private func nativeTap(_ element: XCUIElement, in app: XCUIApplication) throws {
        try waitVisible(element, in: app)
        try performNativeTap(element)
    }

    @MainActor
    private func performNativeTap(_ element: XCUIElement) throws {
        let failures = testRun?.failureCount ?? 0
        element.tap()
        try requireEqual(testRun?.failureCount ?? 0, failures, "Native tap failed; stop this journey")
    }

    @MainActor
    private func hasReachableNavigationControl(_ bar: XCUIElement, in app: XCUIApplication) -> Bool {
        guard bar.exists, !bar.frame.intersection(app.frame).isEmpty else { return false }
        // Background bars remain in AX under sheets. Their native actions are not hittable.
        return bar.buttons.allElementsBoundByIndex.contains {
            $0.exists && $0.isHittable && !$0.frame.intersection(bar.frame.intersection(app.frame)).isEmpty
        }
    }

    @MainActor
    private func navigationBar(_ app: XCUIApplication) throws -> XCUIElement {
        let bars = app.navigationBars.allElementsBoundByIndex.filter {
            hasReachableNavigationControl($0, in: app)
        }
        guard bars.count == 1, let bar = bars.first else {
            diagnose("missing-foreground-navigation", app: app,
                     detail: "Expected one navigation bar with a reachable native action, found \(bars.count)")
            try require(false, "The foreground navigation bar must be unambiguous")
            throw JourneyFailure.failed
        }
        return bar
    }

    @MainActor
    private func waitNavigation(_ title: String, in app: XCUIApplication) throws {
        let bar = app.navigationBars[title]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            // Error destinations may intentionally offer no toolbar actions.
            bar.exists && bar.identifier == title && !bar.frame.intersection(app.frame).isEmpty
        }, object: bar)
        guard XCTWaiter.wait(for: [ready], timeout: 10) == .completed else {
            diagnose("unavailable-navigation", app: app, detail: "Expected destination: \(title)")
            try require(false, "Expected navigation title must be visible")
            return
        }
    }

    @MainActor
    private func selectTab(_ title: String, in app: XCUIApplication) throws {
        let button: XCUIElement
        if app.tabBars.firstMatch.exists {
            button = app.tabBars.buttons.matching(identifier: title).firstMatch
        } else {
            // iPad's native top tabs have duplicate outer/inner Button representations.
            let symbol = title == "Луки" ? "square.grid.2x2" : "tshirt"
            button = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", symbol, title)).firstMatch
        }
        try nativeTap(button, in: app)
        try waitNavigation(title, in: app)
        try require(button.isSelected, "The intended native tab must be selected")
    }

    @MainActor
    private func card(_ index: Int, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "wardrobe-item-\(itemIDs[index])").firstMatch
    }

    @MainActor
    private func openItem(_ index: Int, in app: XCUIApplication) throws {
        let item = card(index, in: app)
        try reveal(item, in: app, towardTop: index == 0)
        try nativeTap(item, in: app)
        try waitVisible(app.buttons["item-actions"], in: app)
    }

    @MainActor
    private func back(_ app: XCUIApplication, to destination: String = "Гардероб") throws {
        let bar = try navigationBar(app)
        try require(bar.identifier != destination, "Back requires a detail screen, not the destination itself")
        try nativeTap(bar.buttons.firstMatch, in: app)
        try waitNavigation(destination, in: app)
    }

    @MainActor
    private func createFirstOutfit(in app: XCUIApplication) throws {
        let createFirst = app.buttons["create-first-outfit"]
        let outfitsBar = try navigationBar(app)
        try requireEqual(outfitsBar.identifier, "Луки")
        let overlays = app.tabBars.allElementsBoundByIndex + app.keyboards.allElementsBoundByIndex
        // ContentUnavailableView has no ScrollView when its contents already fit (iPad).
        let creationIsVisible = createFirst.exists && createFirst.isHittable
            && app.frame.contains(createFirst.frame) && createFirst.frame.minY >= outfitsBar.frame.maxY
            && !overlays.contains { $0.exists && $0.frame.intersects(createFirst.frame) }
        if creationIsVisible {
            try nativeTap(createFirst, in: app)
        } else {
            try tap(createFirst, in: app) // Maximum text still exercises bounded native scrolling.
        }
    }

    @MainActor
    private func slot(_ zone: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "outfit-slot-\(zone)-")).firstMatch
    }

    @MainActor
    private func choose(_ index: Int, in app: XCUIApplication) throws {
        try waitVisible(app.buttons["cancel-outfit-picker"], in: app)
        try tap(app.buttons["outfit-candidate-\(itemIDs[index])"], in: app)
        try expectGone(app.buttons["cancel-outfit-picker"], "Selection returns to its addressed screen")
    }

    @MainActor
    private func enterName(_ name: String, in app: XCUIApplication) throws {
        let field = app.textFields["outfit-name"]
        try reveal(field, in: app, towardTop: true)
        let current = (field.value as? String) ?? ""
        let populated = !current.isEmpty && current != "Название — необязательно"
        // Focus first, then choose the native editing command on the insertion point.
        let appFrame = app.frame
        try nativeTap(field, in: app)
        let keyboardReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let keyboard = app.keyboards.firstMatch
            guard keyboard.exists else { return false }
            // Resolve keyboard geometry once per poll while its AX snapshot settles.
            let frame = keyboard.frame
            return !frame.isEmpty && appFrame.intersects(frame) && keyboard.isHittable
        }, object: app)
        guard XCTWaiter.wait(for: [keyboardReady], timeout: 15) == .completed else {
            diagnose("keyboard-focus-unavailable", app: app)
            try require(false, "No visible, hittable Simulator keyboard; stop before typing")
            return
        }
        if populated {
            try selectEntireName(field, in: app)
        }
        let failures = testRun?.failureCount ?? 0
        field.typeText(name)
        try requireEqual(testRun?.failureCount ?? 0, failures, "Native text entry failed")
        try requireEqual(field.value as? String, name, "Native replacement must produce the exact name before Done")
        field.typeText("\n")
        try requireEqual(testRun?.failureCount ?? 0, failures, "Native Done action failed")
        try expectGone(app.keyboards.firstMatch, "Done must dismiss the keyboard", timeout: 15)
    }

    @MainActor
    private func selectEntireName(_ field: XCUIElement, in app: XCUIApplication) throws {
        try require(field.isEnabled, "The focused name field must allow native editing")
        // Tapping the insertion point opens the native edit menu without selecting a word.
        try nativeTap(field, in: app)
        let selectionLabels = ["Select All", "Выбрать всё", "Выбрать все"]
        let forwardLabels = ["Forward", "Вперёд", "Вперед"]
        // Resolve all currently offered commands in one query. Asking separately
        // for an absent Select All can exhaust XCTest's deadline before Forward
        // is inspected, even though that arrow is already visible on the page.
        let offeredCommands = app.descendants(matching: .any).matching(NSPredicate(
            format: "(elementType == %d OR elementType == %d) AND label IN %@",
            XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue,
            selectionLabels + forwardLabels))
        for page in 0..<3 {
            // Only existence belongs inside the waiter. Several remote property
            // reads in one predicate inherit its deadline and can be cancelled
            // midway through an already-visible Forward button's hit test.
            guard offeredCommands.firstMatch.waitForExistence(timeout: 5) else { break }
            let visible = offeredCommands.allElementsBoundByIndex.filter { $0.isHittable }
            let selection = visible.first { selectionLabels.contains($0.label) }
            let forward = visible.first { forwardLabels.contains($0.label) }
            if let command = selection {
                try require(command.isEnabled, "Native Select All must be enabled")
                try performNativeTap(command)
                return
            }
            guard page < 2, let nextPage = forward, nextPage.isEnabled else { break }
            try performNativeTap(nextPage)
        }
        diagnose("native-select-all-unavailable", app: app)
        try require(false, "Native edit menu must expose an enabled Select All before replacement")
    }

    private func control(_ mode: String, reset: Bool = false) async throws {
        var request = URLRequest(url: URL(string: "\(baseURL)/__control")!)
        request.httpMethod = "POST"
        request.setValue("Bearer saint-look-ui-control-test-token-00000001", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["mode": mode, "reset": reset])
        let (_, response) = try await URLSession.shared.data(for: request)
        try requireEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    /// Match a foreground scroll surface by its screen-specific public child, not by global order.
    @MainActor
    private func scrollSurface(in app: XCUIApplication, bar: XCUIElement) throws -> XCUIElement {
        let query: XCUIElementQuery
        switch bar.identifier {
        case "Гардероб": query = app.scrollViews.containing(.staticText, identifier: "wardrobe-summary")
        case "Тип и цвета": query = app.collectionViews.containing(.button, identifier: "choose-type")
        case "Собрать лук", "Изменить лук": query = app.scrollViews.containing(.textField, identifier: "outfit-name")
        case "Голова", "Тело", "Низ", "Обувь": query = app.scrollViews.containing(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-'"))
        case "Луки": query = app.scrollViews.containing(NSPredicate(format: "identifier == 'create-first-outfit' OR identifier BEGINSWITH 'outfit-card-'"))
        case "Лук": query = app.scrollViews.containing(NSPredicate(format: "identifier == 'fitting-canvas' OR identifier BEGINSWITH 'repair-slot-'"))
        default: query = app.scrollViews.containing(.button, identifier: "edit-item")
        }
        // A native Form's CollectionView is a layout/scroll surface, not a tappable control.
        // Its visible child buttons can be hittable even when the container itself is not.
        let visible = query.allElementsBoundByIndex.filter {
            let frame = $0.frame
            return $0.exists && !frame.intersection(app.frame).isEmpty
                && frame.minX < bar.frame.maxX && frame.maxX > bar.frame.minX
                && frame.maxY > bar.frame.maxY
        }
        guard let surface = visible.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            diagnose("missing-scroll-surface", app: app, detail: "Foreground navigation: \(bar.identifier)")
            throw JourneyFailure.failed
        }
        return surface
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) throws {
        try require(!app.keyboards.firstMatch.exists || element.elementType == .textField,
                    "Finish name entry before interacting with content")
        let bar = try navigationBar(app)
        let container = try scrollSurface(in: app, bar: bar)
        var last = ""
        for attempt in 0...7 {
            var viewport = container.frame.intersection(app.frame)
            if bar.frame.intersects(viewport) { viewport.origin.y = max(viewport.minY, bar.frame.maxY); viewport.size.height = max(0, container.frame.intersection(app.frame).maxY - viewport.minY) }
            let blockers = app.tabBars.allElementsBoundByIndex + app.keyboards.allElementsBoundByIndex
                + app.staticTexts.matching(identifier: "color-selection-requirement").allElementsBoundByIndex
            for blocker in blockers where blocker.isHittable && blocker.frame.intersects(viewport) && blocker.frame.midY > viewport.midY {
                viewport.size.height = max(0, blocker.frame.minY - viewport.minY)
            }
            viewport = viewport.insetBy(dx: 8, dy: 8)
            try require(viewport.width > 40 && viewport.height > 60, "The foreground content viewport must be usable")
            let frame = element.exists ? element.frame : .zero
            last = "target=\(frame), container=\(container.frame), viewport=\(viewport), navigation=\(bar.identifier)"
            // A partly visible card can report hittable while its native tap center is under a bar.
            // Requiring the center also works for content taller than the safe viewport.
            let tapCenter = CGPoint(x: frame.midX, y: frame.midY)
            if element.exists && element.isHittable && viewport.contains(tapCenter) { return }
            // Inspect the result of the final bounded drag before declaring it unreachable.
            if attempt == 7 { break }
            let direction: CGFloat = element.exists ? (frame.midY < viewport.midY ? 1 : -1) : (towardTop ? 1 : -1)
            // ScrollView's AX frame includes the sheet's bottom safe area. Starting
            // 12pt from that edge can hit Home's gesture region instead of scrolling.
            // Keep both endpoints inside content, including at maximum Dynamic Type.
            let gestureInset = min(80, viewport.height * 0.2)
            let distance = min(viewport.height - 2 * gestureInset,
                               min(viewport.height * 0.65, element.exists ? max(40, abs(viewport.midY - frame.midY)) : viewport.height * 0.65))
            let y = direction < 0 ? viewport.maxY - gestureInset : viewport.minY + gestureInset
            let bounds = container.frame
            let isConstructor = ["Собрать лук", "Изменить лук"].contains(bar.identifier)
            // Constructor controls have 16pt horizontal padding. A centre drag
            // can select a fitting zone and remove the layer we are revealing.
            // Use the same 8pt ScrollView gutter as the outfit-flow checks.
            let x = isConstructor ? bounds.minX + 8 : viewport.midX
            if isConstructor {
                let origin = CGPoint(x: x, y: y)
                let destination = CGPoint(x: x, y: y + direction * distance)
                guard [bounds, viewport, app.frame].allSatisfy({ $0.contains(origin) && $0.contains(destination) }) else {
                    diagnose("invalid-constructor-scroll-path", app: app, detail: last)
                    throw JourneyFailure.failed
                }
            }
            let start = container.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: x - bounds.minX, dy: y - bounds.minY))
            let end = start.withOffset(CGVector(dx: 0, dy: direction * distance))
            let failures = testRun?.failureCount ?? 0
            start.press(forDuration: 0.05, thenDragTo: end)
            try requireEqual(testRun?.failureCount ?? 0, failures, "Native scroll failed; stop this journey")
        }
        diagnose("unreachable-content", app: app, detail: last)
        try require(false, "Could not reveal intended content: \(last)")
    }

    @MainActor
    private func tap(_ element: XCUIElement, in app: XCUIApplication) throws {
        try reveal(element, in: app)
        // reveal already proves existence, hittability and a safe tap center.
        // No input intervenes: another readiness wait only repeats remote AX reads.
        try performNativeTap(element)
    }

    @MainActor
    private func tapMenuAction(_ identifier: String, in app: XCUIApplication) throws {
        let action: XCUIElement
        do {
            action = try addressedNativeDialogAction(identifier, in: app)
        } catch {
            diagnose("ambiguous-native-dialog-action", app: app, detail: "\(error)")
            throw error
        }
        // Resolve the visible native action container even when its action is
        // inside the application frame: a clipped popup can still hide that row.
        // Confirmation dialogs also expose nested Other containers on this runtime.
        for attempt in 0...4 {
            let ancestors = app.otherElements.containing(.button, identifier: identifier).allElementsBoundByIndex
                .filter { $0.exists && !$0.frame.intersection(app.frame).isEmpty }
            guard let popup = ancestors.min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                diagnose("missing-native-menu-viewport", app: app)
                try require(false, "The exact action must have a visible native menu ancestor")
                return
            }
            let viewport = popup.frame.intersection(app.frame)
            try require(viewport.width > 80 && viewport.height > 80, "Native menu viewport must allow scrolling")
            let actionFrame = action.exists ? action.frame : .zero
            if !actionFrame.isEmpty && viewport.contains(actionFrame) {
                // Visibility and native hit readiness are different gates. A
                // visible dialog action must settle through the existing strict
                // waitVisible, never be dragged because isHittable is still false.
                // Dragging that state can activate a different dialog command.
                try nativeTap(action, in: app)
                return
            }
            if attempt == 4 { break }
            // The rounded popup bounds include bottom chrome outside its scroll
            // indicators. Start inside content, not 16pt from that clipped edge.
            let gestureInset = min(80, viewport.height * 0.2)
            let distance = min(viewport.height * 0.6, viewport.height - 2 * gestureInset)
            let start = popup.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: viewport.midX - popup.frame.minX,
                                     dy: viewport.maxY - gestureInset - popup.frame.minY))
            let end = start.withOffset(CGVector(dx: 0, dy: -distance))
            let failures = testRun?.failureCount ?? 0
            start.press(forDuration: 0.05, thenDragTo: end)
            try requireEqual(testRun?.failureCount ?? 0, failures, "Native menu scroll failed")
        }
        diagnose("unreachable-native-menu-action", app: app, detail: action.debugDescription)
        try require(false, "The exact native action must become fully visible inside its menu")
    }

    @MainActor
    private func expectGone(_ element: XCUIElement, _ message: String, timeout: TimeInterval = 5) throws {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        let result = XCTWaiter.wait(for: [gone], timeout: timeout)
        if result != .completed { try capture("dismissal-timeout") }
        try requireEqual(result, .completed, message)
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
            try requireEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            for key in keys { counts[key] = try XCTUnwrap(state[key] as? Int) }
        }
        return counts
    }

    /// Drawn fixtures verify native compositing and local behavior, not provider quality.
    @MainActor
    func testPreparedFittingLayersAndFallbackStayLocal() async throws {
        func illustrationCounts() async throws -> [String: Int] {
            var request = URLRequest(url: URL(string: "\(baseURL)/__control")!)
            request.setValue("Bearer saint-look-ui-control-test-token-00000001", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: request)
            try requireEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return try Dictionary(uniqueKeysWithValues: ["illustrationUploads", "illustrationOperations", "illustrationAcknowledgements"].map {
                ($0, try XCTUnwrap(state[$0] as? Int))
            })
        }
        func canvas(in app: XCUIApplication) throws -> XCUIElement {
            // A sheet retains the detail canvas in accessibility, and global query order
            // does not identify the foreground. Use the same content surface as reveal.
            let surface = try scrollSurface(in: app, bar: navigationBar(app))
            return try XCTUnwrap(surface.otherElements.matching(identifier: "fitting-canvas").allElementsBoundByIndex.first)
        }
        let before = try await activityCounts()
        let illustrationsBefore = try await illustrationCounts()
        let app = try launch("fitting-ready")
        try selectTab("Луки", in: app)
        let saved = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).firstMatch
        try require(saved.waitForExistence(timeout: 5))
        try reveal(try canvas(in: app), in: app, towardTop: true)
        try capture("fitting-01-prepared-collection")
        try tap(saved, in: app)
        try waitVisible(app.buttons["edit-outfit"], in: app)
        try reveal(try canvas(in: app), in: app, towardTop: true)
        try capture("fitting-02-open-jacket-over-tee-detail")
        try nativeTap(app.buttons["edit-outfit"], in: app)
        try waitVisible(app.buttons["cancel-outfit"], in: app)
        try reveal(try canvas(in: app), in: app, towardTop: true)
        try require(!(app.staticTexts["fitting-missing-illustration"].exists))
        try capture("fitting-03-prepared-editor")
        let layers = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'fitting-layer-'"))
        // The iPad sheet can show only the canvas: its lazy layer grid enters
        // accessibility when scrolled into view, so reveal it before counting.
        try reveal(layers.firstMatch, in: app)
        try requireEqual(layers.count, 2)
        let layerIDs = (0..<2).map { layers.element(boundBy: $0).identifier }
        let activeLayer = app.buttons["fitting-choose-active"]
        for (index, identifier) in layerIDs.enumerated() {
            let layer = app.buttons[identifier]
            let expectedTitle = "Тело · слой \(index + 1)"
            try tap(layer, in: app)
            // One native tap; observe the resulting state with the same bounded
            // transition timeout as waitVisible, rather than retrying the action.
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                layer.exists && layer.isSelected && activeLayer.exists && activeLayer.label.contains(expectedTitle)
            }, object: layer)
            guard XCTWaiter.wait(for: [selected], timeout: 10) == .completed else {
                diagnose("layer-selection-not-observed", app: app,
                         detail: "Expected selected \(identifier), active title \(expectedTitle); active label: \(activeLayer.exists ? activeLayer.label : "missing")")
                try require(false, "The tapped layer must become selected and active after one native tap")
                return
            }
            try require(layer.isSelected)
            try require(activeLayer.label.contains(expectedTitle))
        }
        let outerID = String(layerIDs[1].dropFirst("fitting-layer-".count))
        let pin = app.buttons["pin-slot-\(outerID)"]
        try tap(pin, in: app)
        try require(pin.isSelected)
        let shoes = slot("shoes", in: app)
        let shoeID = String(shoes.identifier.dropFirst("outfit-slot-shoes-".count))
        try tap(app.buttons["outfit-slot-menu-\(shoeID)"], in: app)
        try tapMenuAction("clear-slot-\(shoeID)", in: app)
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            shoes.exists && shoes.label.contains("Выбрать вещь")
        }, object: shoes)
        guard XCTWaiter.wait(for: [cleared], timeout: 5) == .completed else {
            try capture("footwear-clear-timeout")
            try require(false, "Clearing the addressed footwear slot must expose its empty state")
            return
        }
        try require(shoes.label.contains("Выбрать вещь"))
        try tap(shoes, in: app)
        let footwear = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' AND label CONTAINS 'Туфли'")).firstMatch
        try tap(footwear, in: app)
        try require(shoes.label.contains("Туфли"), "Manual choice fills the empty footwear slot without server receipts")
        try require(pin.isSelected)
        try tap(app.buttons["fitting-undo"], in: app)
        try require(shoes.label.contains("Выбрать вещь"), "A manual choice is undone as one composition change")
        try tap(app.buttons["fitting-undo"], in: app)
        try require(shoes.label.contains("Туфли"))
        try require(pin.isSelected, "Composition undo preserves the outer layer pin")
        try reveal(try canvas(in: app), in: app, towardTop: true)
        try capture("fitting-04-layers-restored-after-two-undos")
        try nativeTap(app.buttons["cancel-outfit"], in: app)
        try require(!(app.alerts.firstMatch.exists), "Undo restored the saved composition; a pin alone does not dirty it")
        let afterOnline = try await activityCounts()
        let illustrationsAfter = try await illustrationCounts()
        try requireEqual(afterOnline, before, "Prepared fitting interactions must not invoke ingestion providers")
        try requireEqual(illustrationsAfter, illustrationsBefore, "Prepared fitting must not submit or acknowledge generation")
        app.terminate()

        try await control("offline")
        let offline = try launch("fitting-ready", reset: false)
        try selectTab("Луки", in: offline)
        let offlineSaved = offline.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).firstMatch
        try tap(offlineSaved, in: offline)
        try reveal(try canvas(in: offline), in: offline, towardTop: true)
        try require((try canvas(in: offline)).label.contains("иллюстрация"))
        try capture("fitting-05-prepared-offline-restart")
        offline.terminate()

        let fallback = try launch("legacy-four")
        try selectTab("Луки", in: fallback)
        try require(fallback.buttons["open-wardrobe"].waitForExistence(timeout: 5))
        try createFirstOutfit(in: fallback)
        try require(!fallback.buttons["save-outfit"].isEnabled, "An empty draft cannot be saved")
        try tap(slot("body", in: fallback), in: fallback)
        try waitVisible(fallback.buttons["cancel-outfit-picker"], in: fallback)
        try requireEqual(fallback.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-candidate-' ")).count, 0,
                         "Incomplete legacy cutouts cannot enter a new look")
        try capture("fitting-06-incomplete-legacy-admission")
        fallback.terminate()
        let evidence = try JSONSerialization.data(withJSONObject: ["providersBefore": before, "providersAfter": afterOnline,
            "illustrationsBefore": illustrationsBefore, "illustrationsAfter": illustrationsAfter], options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: evidence, uniformTypeIdentifier: "public.json")
        attachment.name = "\(profile)-fitting-local-only-counters"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testReplaceSavedNameThroughNativeMenu() async throws {
        let app = try launch("fitting-ready")
        try selectTab("Луки", in: app)
        let saved = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).firstMatch
        try tap(saved, in: app)
        for name in ["Прогулка по осеннему городу после работы", "Черновик", "Вечерний лук"] {
            try nativeTap(app.buttons["edit-outfit"], in: app)
            try waitVisible(app.buttons["cancel-outfit"], in: app)
            try enterName(name, in: app)
            try nativeTap(app.buttons["save-outfit"], in: app)
            try expectGone(app.textFields["outfit-name"], "Saved editor field must disappear")
            try require(app.staticTexts[name].waitForExistence(timeout: 5), "Detail must show the exact replacement name")
        }
    }

    @MainActor
    func testPublicPhotoJourney() async throws {
        let before = try await activityCounts()
        let app = try launch()
        try require(card(0, in: app).waitForExistence(timeout: 10))
        let summary = app.staticTexts["wardrobe-summary"]
        try require(summary.waitForExistence(timeout: 5))
        try requireEqual(summary.label, "Всего: 4. Готово: 4. Ожидают: 0.")
        try capture("01-wardrobe-grid")
        try openItem(1, in: app)
        try require(app.navigationBars["Джинсы"].exists)
        try capture("02-jeans-detail")
        try back(app)
        try openItem(0, in: app)
        let edit = app.buttons["edit-item"]
        try reveal(edit, in: app)
        let hitEvidence = XCTAttachment(string: "edit-item accessibility frame: \(edit.frame); hittable: \(edit.isHittable)")
        hitEvidence.name = "\(profile)-item-edit-hit-frame"
        hitEvidence.lifetime = .keepAlways
        add(hitEvidence)
        try require(edit.frame.height >= 44, "Item editing needs a native hit target at least 44 points tall")
        try nativeTap(edit, in: app)
        try waitVisible(app.buttons["cancel-item-edits"], in: app)
        try tap(app.buttons["choose-colors"], in: app)
        try require(app.buttons["color-white"].waitForExistence(timeout: 5))
        try capture("03-item-colors")
        try nativeTap(app.buttons["done-colors"], in: app)
        try nativeTap(app.buttons["cancel-item-edits"], in: app)
        try back(app)
        try selectTab("Луки", in: app)
        try createFirstOutfit(in: app)
        try waitVisible(app.buttons["cancel-outfit"], in: app)
        try tap(slot("body", in: app), in: app)
        try choose(0, in: app)
        try require(!(app.buttons["save-outfit"].isEnabled))
        try require(app.staticTexts["outfit-save-explanation"].exists)
        let firstLayer = slot("body", in: app)
        let firstID = firstLayer.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        try tap(slot("bottom", in: app), in: app)
        try choose(1, in: app)
        try require(app.buttons["save-outfit"].isEnabled)
        try tap(slot("shoes", in: app), in: app)
        try choose(3, in: app)
        try tap(firstLayer, in: app)
        let current = app.buttons["outfit-candidate-\(itemIDs[0])"]
        try require(current.waitForExistence(timeout: 5))
        try require(current.isSelected)
        try capture("04-body-picker-current")
        try nativeTap(app.buttons["outfit-type-filter"], in: app)
        try nativeTap(app.buttons["outfit-filter-polo"], in: app)
        try require(!(current.exists))
        try require(app.buttons["outfit-candidate-\(itemIDs[2])"].exists)
        try nativeTap(app.buttons["cancel-outfit-picker"], in: app)
        try requireEqual(firstLayer.value as? String, "Футболка, Белый")
        try tap(app.buttons["add-body-layer"], in: app)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-slot-body-' AND identifier != %@", firstLayer.identifier)).firstMatch
        let secondID = second.identifier.replacingOccurrences(of: "outfit-slot-body-", with: "")
        try tap(second, in: app)
        try choose(2, in: app)
        try requireEqual(firstLayer.value as? String, "Футболка, Белый")
        try requireEqual(second.value as? String, "Поло, Белый, Чёрный")
        try reveal(firstLayer, in: app, towardTop: true)
        try capture("05-multilayer-editor")
        try tap(app.buttons["outfit-slot-menu-\(secondID)"], in: app)
        try tapMenuAction("remove-body-layer-\(secondID)", in: app)
        try expectGone(second, "Removing the addressed body layer must finish before saving the outfit")
        try nativeTap(app.buttons["save-outfit"], in: app)
        let outfit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'outfit-card-' ")).firstMatch
        try require(outfit.waitForExistence(timeout: 5))
        let outfitID = outfit.identifier
        try requireEqual(outfit.label, "Лук без названия")
        try capture("06-outfit-collection")
        try nativeTap(outfit, in: app)
        try nativeTap(app.buttons["edit-outfit"], in: app)
        try waitVisible(app.buttons["cancel-outfit"], in: app)
        let name = "Прогулка по осеннему городу после работы"
        try enterName(name, in: app)
        try nativeTap(app.buttons["save-outfit"], in: app)
        try expectGone(app.textFields["outfit-name"], "Saved editor field must disappear")
        try expectGone(app.buttons["cancel-outfit"], "Saved editor controls must disappear")
        try require(app.staticTexts[name].waitForExistence(timeout: 5), "Detail must show the exact saved name")
        try waitVisible(app.buttons["edit-outfit"], in: app)
        try capture("07-outfit-detail-long-name")
        try nativeTap(app.buttons["edit-outfit"], in: app)
        try waitVisible(app.buttons["cancel-outfit"], in: app)
        try enterName("Черновик", in: app)
        try nativeTap(app.buttons["cancel-outfit"], in: app)
        let discardAlert = app.alerts["Отбросить изменения?"]
        try require(discardAlert.waitForExistence(timeout: 5))
        try require(discardAlert.buttons.matching(identifier: "continue-outfit-editing").firstMatch.exists)
        try capture("08-outfit-discard-dialog")
        try nativeTap(discardAlert.buttons.matching(identifier: "continue-outfit-editing").firstMatch, in: app)
        try requireEqual(app.textFields["outfit-name"].value as? String, "Черновик")
        try nativeTap(app.buttons["cancel-outfit"], in: app)
        try require(discardAlert.waitForExistence(timeout: 5))
        try nativeTap(discardAlert.buttons.matching(identifier: "discard-outfit-changes").firstMatch, in: app)
        try expectGone(app.textFields["outfit-name"], "Discarded editor must disappear")
        try require(app.staticTexts[name].waitForExistence(timeout: 5), "Discard must retain the exact saved name")
        try back(app, to: "Луки")
        try selectTab("Гардероб", in: app)
        try openItem(0, in: app)
        try nativeTap(app.buttons["item-actions"], in: app)
        try tapMenuAction("delete-item", in: app)
        let deletionAlert = app.alerts["Удалить вещь?"]
        try require(deletionAlert.waitForExistence(timeout: 5))
        try require(deletionAlert.buttons.matching(identifier: "cancel-delete-item").firstMatch.exists)
        try capture("09-item-delete-dialog")
        try nativeTap(deletionAlert.buttons.matching(identifier: "cancel-delete-item").firstMatch, in: app)
        try require(app.buttons["item-actions"].exists)
        try nativeTap(app.buttons["item-actions"], in: app)
        try tapMenuAction("delete-item", in: app)
        try require(deletionAlert.waitForExistence(timeout: 5))
        try nativeTap(deletionAlert.buttons.matching(identifier: "confirm-delete-item").firstMatch, in: app)
        try expectGone(app.buttons["item-actions"], "Confirmed wardrobe deletion dismisses its detail")
        try require(!(card(0, in: app).exists))
        try selectTab("Луки", in: app)
        let saved = app.descendants(matching: .any).matching(identifier: outfitID).firstMatch
        try tap(saved, in: app)
        let repair = app.buttons["repair-slot-\(firstID)"]
        try reveal(repair, in: app)
        try capture("10-outfit-missing-body")
        try nativeTap(repair, in: app)
        try require(app.buttons["outfit-candidate-\(itemIDs[2])"].waitForExistence(timeout: 5))
        try require(!(app.buttons["outfit-candidate-\(itemIDs[1])"].exists))
        try require(!(app.buttons["outfit-candidate-\(itemIDs[3])"].exists))
        try capture("11-targeted-replacement-picker")
        try choose(2, in: app)
        try require(!(repair.exists))
        try capture("12-repaired-outfit")
        try back(app, to: "Луки")
        try requireEqual(saved.label, name)
        let composition = saved.value as? String ?? ""
        for label in ["Поло", "Джинсы", "Туфли"] { try require(composition.contains(label)) }
        XCUIDevice.shared.press(.home)
        app.terminate()
        let relaunched = try launch(reset: false)
        try selectTab("Луки", in: relaunched)
        let persistent = relaunched.descendants(matching: .any).matching(identifier: outfitID).firstMatch
        try require(persistent.waitForExistence(timeout: 5))
        try requireEqual(persistent.value as? String, composition)
        try requireEqual(persistent.label, name)
        let after = try await activityCounts()
        try requireEqual(after, before, "Visual UI commands must not upload photos or invoke either provider")
        let counts = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: ["before": before, "after": after], options: .sortedKeys), encoding: .utf8)!)
        counts.name = "\(profile)-no-ai-counters"; counts.lifetime = .keepAlways; add(counts)
        XCUIDevice.shared.press(.home)
        relaunched.terminate()
    }

    @MainActor
    func testSecondaryStates() async throws {
        try XCTSkipUnless(profile == "iphone-light", "Secondary states are captured once; the main journey covers four profiles")
        let before = try await activityCounts()
        var app = try launch("empty")
        try require(app.staticTexts["wardrobe-empty"].waitForExistence(timeout: 10))
        try capture("secondary-01-wardrobe-empty")
        try selectTab("Луки", in: app)
        try require(app.buttons["open-wardrobe"].waitForExistence(timeout: 5))
        try capture("secondary-02-outfits-empty")
        try nativeTap(app.buttons["open-wardrobe"], in: app)
        try require(app.staticTexts["wardrobe-empty"].exists)
        XCUIDevice.shared.press(.home); app.terminate()
        app = try launch()
        try openItem(0, in: app)
        try tap(app.buttons["edit-item"], in: app)
        try require(app.buttons["choose-type"].waitForExistence(timeout: 5))
        try reveal(app.buttons["choose-type"], in: app)
        try require(app.buttons["cancel-item-edits"].isHittable)
        try capture("secondary-03-item-editor")
        try tap(app.buttons["choose-type"], in: app)
        try require(app.buttons["type-t_shirt"].waitForExistence(timeout: 5))
        try capture("secondary-04-type-picker")
        try nativeTap(app.buttons["type-t_shirt"], in: app)
        try nativeTap(app.buttons["cancel-item-edits"], in: app)
        try back(app)
        try nativeTap(app.buttons["settings"], in: app)
        try require(app.staticTexts["connection-status"].waitForExistence(timeout: 5))
        try capture("secondary-05-settings")
        try nativeTap(app.descendants(matching: .any).matching(identifier: "connection-settings").firstMatch, in: app)
        try require(app.textFields["backend-url"].waitForExistence(timeout: 5))
        try capture("secondary-06-connection-settings")
        XCUIDevice.shared.press(.home); app.terminate()
        try await control("offline")
        app = try launch("mixed-offline")
        try require(card(0, in: app).waitForExistence(timeout: 10))
        try capture("secondary-07-processing-grid")
        try openItem(1, in: app)
        try require(app.staticTexts["pending-status"].waitForExistence(timeout: 5), "Jeans remain pending while the transport is offline")
        try require(!(app.staticTexts["previous-result-notice"].exists), "A first processing attempt has no earlier cutout")
        try reveal(app.staticTexts["pending-status"], in: app)
        try capture("secondary-07b-pending-jeans")
        try back(app)
        try openItem(3, in: app)
        try require(app.staticTexts["pending-status"].waitForExistence(timeout: 5), "Replacement remains pending offline")
        try require(app.staticTexts["previous-result-notice"].waitForExistence(timeout: 5), "Replacement retains the previous result's context")
        try require(app.images["item-photo"].exists, "The previous footwear image remains available")
        try reveal(app.staticTexts["previous-result-notice"], in: app)
        try capture("secondary-07c-previous-result-footwear")
        try back(app)
        try openItem(2, in: app)
        try require(app.staticTexts["item-error"].waitForExistence(timeout: 5))
        try capture("secondary-08-failed-detail")
        XCUIDevice.shared.press(.home); app.terminate()
        app = try launch("unreadable-catalog")
        let error = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Не удалось открыть локальный гардероб'")).firstMatch
        try require(error.waitForExistence(timeout: 10))
        try require(app.staticTexts["wardrobe-unavailable"].waitForExistence(timeout: 5))
        try require(!(app.staticTexts["wardrobe-empty"].exists))
        try require(!(app.buttons["add-photo"].exists))
        try require(app.buttons["settings"].isHittable, "Storage failure must not cover access to settings")
        try nativeTap(app.buttons["settings"], in: app)
        try require(app.buttons["close-settings"].waitForExistence(timeout: 5))
        try require(app.descendants(matching: .any).matching(identifier: "connection-settings").firstMatch.isHittable)
        try nativeTap(app.buttons["close-settings"], in: app)
        try expectGone(app.buttons["close-settings"], "Closing settings returns to the unavailable catalog")
        try capture("secondary-09-storage-error-wardrobe")
        try selectTab("Луки", in: app)
        try require(error.waitForExistence(timeout: 5))
        try require(app.staticTexts["outfits-unavailable"].waitForExistence(timeout: 5))
        try require(!(app.staticTexts["Пока нет луков"].exists))
        try require(!(app.buttons["create-first-outfit"].exists))
        try require(!(app.buttons["create-outfit"].exists))
        try capture("secondary-10-storage-error-outfits")
        XCUIDevice.shared.press(.home); app.terminate()
        try await control("online")
        let after = try await activityCounts()
        try requireEqual(after, before, "Secondary fixture states must not reach upload or provider processing")
        let counts = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: ["before": before, "after": after], options: .sortedKeys), encoding: .utf8)!)
        counts.name = "\(profile)-secondary-no-ai-counters"
        counts.lifetime = .keepAlways
        add(counts)
    }
}
