import SwiftUI

@main
@MainActor
struct SaintLookApp: App {
    @StateObject private var store = WardrobeStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            TabView {
                WardrobeView(store: store)
                    .tabItem { Label("Гардероб", systemImage: "tshirt") }
                OutfitsView(store: store)
                    .tabItem { Label("Луки", systemImage: "square.grid.2x2") }
            }
                .task { store.resumePendingItems() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { store.resumePendingItems() }
                    if phase == .background { store.stopObserving() }
                }
        }
    }
}
