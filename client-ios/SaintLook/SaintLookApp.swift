import SwiftUI
#if DEBUG
import UIKit
#endif

@main
@MainActor
struct SaintLookApp: App {
    @StateObject private var store = WardrobeStore()
    @State private var selectedTab = AppTab.wardrobe
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG
        NameSelectionTrace.shared.start()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            TabView(selection: $selectedTab) {
                WardrobeView(store: store)
                    .tabItem { Label("Гардероб", systemImage: "tshirt") }
                    .tag(AppTab.wardrobe)
                OutfitsView(store: store) { selectedTab = .wardrobe }
                    .tabItem { Label("Луки", systemImage: "square.grid.2x2") }
                    .tag(AppTab.outfits)
            }
                .tint(SaintLookStyle.accent)
                .task { store.resumePendingItems() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { store.resumePendingItems() }
                    if phase == .background { store.stopObserving() }
                }
        }
    }
}

private enum AppTab: Hashable {
    case wardrobe, outfits
}

#if DEBUG
// Temporary #53 read-only probe. No view modifiers or changes to focus, selection or text.
@MainActor
private final class NameSelectionTrace: NSObject {
    static let shared = NameSelectionTrace()
    private var timer: Timer?
    private var deadline = Date.distantPast
    private var previous = ""

    func start() {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SAINT_LOOK_UI_TESTING"] == "1",
              environment["SAINT_LOOK_NAME_TRACE"] == "1", timer == nil else { return }
        deadline = Date().addingTimeInterval(600)
        let probe = Timer(timeInterval: 0.1, target: self, selector: #selector(sample), userInfo: nil, repeats: true)
        timer = probe
        RunLoop.main.add(probe, forMode: .common)
        NotificationCenter.default.addObserver(self, selector: #selector(stop),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        NSLog("[DEBUG-name-range] started interval=0.1s limit=600s")
    }

    @objc private func stop() {
        timer?.invalidate()
        timer = nil
        NotificationCenter.default.removeObserver(self)
        NSLog("[DEBUG-name-range] stopped")
    }

    private func fields(in view: UIView) -> [UITextField] {
        let own = (view as? UITextField).map { [$0] } ?? []
        return own + view.subviews.flatMap { fields(in: $0) }
    }

    @objc private func sample() {
        guard Date() < deadline else { stop(); return }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
        let names = windows.flatMap { fields(in: $0) }.filter {
            $0.accessibilityIdentifier == "outfit-name" || $0.placeholder == "Название — необязательно"
        }
        var samples: [String] = []
        for field in names {
            let selection: String
            if let range = field.selectedTextRange {
                let start = field.offset(from: field.beginningOfDocument, to: range.start)
                let end = field.offset(from: field.beginningOfDocument, to: range.end)
                selection = "\(start)..\(end)"
            } else { selection = "nil" }
            let identity = String(describing: ObjectIdentifier(field))
            let className = String(describing: type(of: field))
            let length = field.text?.utf16.count ?? 0
            let language = field.textInputMode?.primaryLanguage ?? "nil"
            let marked = field.markedTextRange != nil
            let frame = field.convert(field.bounds, to: nil)
            let focus = "first=\(field.isFirstResponder) length=\(length) selected=\(selection)"
            let context = "marked=\(marked) language=\(language) frame=\(frame)"
            samples.append("id=\(identity) class=\(className) " + focus + " " + context)
        }
        let state = samples.joined(separator: " | ")
        let line = state.isEmpty ? "no-name-field" : state
        if line != previous {
            previous = line
            NSLog("[DEBUG-name-range] %@", line)
        }
    }
}
#endif
