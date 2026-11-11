import Foundation
import Observation

@MainActor
protocol RecommendationTransport {
    func recommendSingle(_ request: SingleRecommendationRequest) async throws -> SingleRecommendationResponse
    func compose(_ request: ComposeRecommendationRequest) async throws -> ComposeRecommendationResponse
}

/// Owns one recommendation from admission to application. Context is read again
/// after the network await; a response can never apply to the captured old draft.
@MainActor
@Observable
final class OutfitRecommendations {
    enum Action {
        case single(slotID: UUID, intent: RecommendationIntent)
        case composition(ComposeMode)
    }

    struct Context {
        var draft: Outfit
        var history: OutfitCompositionHistory
        var pinnedSlotIDs: Set<UUID>
        var items: [WardrobeItem]
        var preparedItems: [RecommendationItem]
        var savedOutfit: Outfit?
        var activeSpaceID: String?
    }

    private(set) var hasPending = false
    private(set) var slotID: UUID?
    private(set) var message: String?
    var isComposing: Bool { hasPending && slotID == nil }

    @ObservationIgnored private var session = OutfitRecommendationSession()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation: UUID?

    func cancel(message: String? = nil) {
        let wasPending = hasPending
        generation = nil
        task?.cancel()
        task = nil
        session.cancel()
        hasPending = false
        self.message = wasPending ? (message ?? RecommendationError.stale.localizedDescription) : nil
    }

    func start(_ action: Action, transport: any RecommendationTransport,
               context: @escaping () throws -> Context,
               apply: @escaping (Outfit, OutfitCompositionHistory) -> Void,
               onFailure: @escaping (Error) async -> Void) {
        let started = Date()
        cancel()
        switch action {
        case .single(let id, _): slotID = id
        case .composition: slotID = nil
        }
        do {
            let initial = try context()
            let request: Request
            switch action {
            case .single(let id, let intent):
                request = .single(try session.begin(draft: initial.draft, targetSlotID: id, intent: intent,
                    pinnedSlotIDs: initial.pinnedSlotIDs, items: initial.items, preparedItems: initial.preparedItems,
                    savedOutfit: initial.savedOutfit, activeSpaceID: initial.activeSpaceID))
            case .composition(let mode):
                request = .composition(try session.beginComposition(draft: initial.draft, mode: mode,
                    pinnedSlotIDs: initial.pinnedSlotIDs, items: initial.items, preparedItems: initial.preparedItems,
                    savedOutfit: initial.savedOutfit, activeSpaceID: initial.activeSpaceID))
            }
            let activeSpaceID = initial.activeSpaceID
            let token = UUID()
            generation = token
            hasPending = true
            task = Task { [weak self] in
                do {
                    let response = try await request.send(using: transport)
                    try Task.checkCancellation()
                    guard let self, self.generation == token else { return }
                    var current = try context()
                    // Config can change before SwiftUI delivers its onChange callback.
                    guard current.activeSpaceID == activeSpaceID else { throw RecommendationError.stale }
                    let feedback: String
                    switch response {
                    case .single(let value):
                        feedback = try self.session.apply(value, to: &current.draft, history: &current.history,
                            pinnedSlotIDs: current.pinnedSlotIDs, items: current.items, preparedItems: current.preparedItems,
                            savedOutfit: current.savedOutfit, taxonomy: .shared)
                    case .composition(let value):
                        feedback = try self.session.applyComposition(value, to: &current.draft, history: &current.history,
                            pinnedSlotIDs: current.pinnedSlotIDs, items: current.items, preparedItems: current.preparedItems,
                            savedOutfit: current.savedOutfit, taxonomy: .shared)
                    }
                    self.finish()
                    self.message = response.controlled ? "Тестовый подбор. " + feedback : feedback
                    apply(current.draft, current.history)
                    #if DEBUG
                    print("\(response.metric)_recommendation_applied_ms=\(Int(Date().timeIntervalSince(started) * 1000)) outcome=\(response.outcome)")
                    #endif
                } catch {
                    guard !Task.isCancelled, let self, self.generation == token else { return }
                    self.finish()
                    self.message = RecommendationError.message(for: error)
                    await onFailure(error)
                }
            }
        } catch { message = RecommendationError.message(for: error) }
    }

    private func finish() {
        session.cancel()
        generation = nil
        task = nil
        hasPending = false
    }

    private enum Request {
        case single(SingleRecommendationRequest)
        case composition(ComposeRecommendationRequest)

        func send(using transport: any RecommendationTransport) async throws -> Response {
            switch self {
            case .single(let request): return .single(try await transport.recommendSingle(request))
            case .composition(let request): return .composition(try await transport.compose(request))
            }
        }
    }

    private enum Response {
        case single(SingleRecommendationResponse)
        case composition(ComposeRecommendationResponse)

        var controlled: Bool {
            switch self {
            case .single(let value): return value.mode == "controlled"
            case .composition(let value): return value.modelMode == "controlled"
            }
        }
        var metric: String {
            switch self { case .single: return "single"; case .composition: return "compose" }
        }
        var outcome: String {
            switch self {
            case .single(let value): return value.outcome.rawValue
            case .composition(let value): return value.outcome.rawValue
            }
        }
    }
}
