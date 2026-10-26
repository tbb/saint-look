import SwiftUI

@main
@MainActor
struct SaintLookApp: App {
    @StateObject private var store = WardrobeStore()
    @State private var selectedTab = AppTab.wardrobe
    @Environment(\.scenePhase) private var scenePhase

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
                .safeAreaInset(edge: .top, spacing: 0) { AppNoticeView(store: store) }
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
