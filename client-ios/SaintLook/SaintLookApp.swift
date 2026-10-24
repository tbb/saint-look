import SwiftUI

@main
@MainActor
struct SaintLookApp: App {
    @StateObject private var store = WardrobeStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WardrobeView(store: store)
                .task { store.resumePendingItems() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { store.resumePendingItems() }
                    if phase == .background { store.stopObserving() }
                }
        }
    }
}
