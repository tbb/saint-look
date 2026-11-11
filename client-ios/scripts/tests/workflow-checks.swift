import Foundation

func ingestionChecks(prepared: WardrobeItem, file: WardrobeCatalogFile) throws {
    var item = prepared
    item.status = .pending
    item.manualType = "Рубашка"
    item.manualColors = ["Красный"]
    item.preparationRevision = 19
    item.automaticallyIllustrate = true
    let intent = IllustrationRequest(operationID: UUID(), photoVersionID: item.photoVersionID,
        sourceSetVersionID: item.sourceSetVersionID, revision: 20, manualType: item.manualType, manualColors: item.manualColors)
    item.illustration = intent
    item.downloadedIllustration = PendingItemPublication(publication: item.publishedVersion!, request: intent, preparedPhotos: item.preparedPhotos)
    let original = item
    let response = ItemResponse(itemId: item.id, operationId: item.operationID, photoVersionId: item.photoVersionID,
        status: .ready, mode: .live, revision: item.revision, type: "Футболка", colors: ["Синий"],
        resultPath: nil, error: nil, resultSHA256: String(repeating: "a", count: 64))
    let otherAck = ResultAcknowledgement(itemID: UUID(), operationID: UUID())
    var catalog = WardrobeCatalog(items: [item], pendingAcknowledgements: [otherAck])
    try catalog.applyIngestion(.uploadStarted, for: item.id, operationID: item.operationID)
    precondition(catalog.items[0].uploadStarted)
    try catalog.applyIngestion(.received(response, resultFilename: "new-result.png"), for: item.id, operationID: item.operationID)
    let ack = ResultAcknowledgement(itemID: item.id, operationID: item.operationID)
    precondition(catalog.pendingAcknowledgements == [ack, otherAck])
    precondition(catalog.items[0].status == .ready && catalog.items[0].resultSHA256 == response.resultSHA256)
    precondition(catalog.items[0].type == "Футболка" && catalog.items[0].colors == ["Синий"])
    precondition(catalog.items[0].manualType == original.manualType && catalog.items[0].manualColors == original.manualColors)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    // Check the independent state as a whole, including the last prepared packet
    // and the newer illustration intent that existed when the old response arrived.
    var preserved = catalog.items[0]
    preserved.status = original.status; preserved.uploadStarted = original.uploadStarted
    preserved.type = original.type; preserved.colors = original.colors
    preserved.resultFilename = original.resultFilename; preserved.resultMode = original.resultMode
    preserved.resultSHA256 = original.resultSHA256; preserved.mode = original.mode
    let preservedBytes = try encoder.encode(preserved), originalBytes = try encoder.encode(original)
    precondition(preservedBytes == originalBytes)
    try file.save(catalog)
    let restored = try file.load()
    precondition(restored.pendingAcknowledgements == [ack, otherAck])
    precondition(restored.items[0].resultFilename == "new-result.png")
    try catalog.applyIngestion(.received(response, resultFilename: "new-result.png"), for: item.id, operationID: item.operationID)
    precondition(catalog.pendingAcknowledgements?.count == 2, "Replayed delivery keeps one acknowledgement")
    let before = try encoder.encode(catalog)
    do {
        try catalog.applyIngestion(.uploadStarted, for: item.id, operationID: UUID())
        fatalError("A superseded attempt must not update the item")
    } catch is CancellationError { }
    do {
        try catalog.applyIngestion(.received(response, resultFilename: nil), for: item.id, operationID: item.operationID)
        fatalError("An undelivered result must not publish or enqueue an acknowledgement")
    } catch ClientError.invalidResponse { }
    let after = try encoder.encode(catalog)
    precondition(after == before)
    catalog.removeItem(item.id)
    do {
        try catalog.applyIngestion(.received(response, resultFilename: "late.png"), for: item.id, operationID: item.operationID)
        fatalError("Late delivery must not revive a deleted item")
    } catch is CancellationError { }
    precondition(catalog.items.isEmpty && catalog.pendingAcknowledgements == [otherAck])
    print("PASS: ingestion updates preserve independent state, persist result/ack together, and reject stale or undelivered results")
}

@MainActor
private final class HeldRecommendations: RecommendationTransport {
    enum Request {
        case single(SingleRecommendationRequest, CheckedContinuation<SingleRecommendationResponse, Error>)
        case composition(ComposeRecommendationRequest, CheckedContinuation<ComposeRecommendationResponse, Error>)
    }
    let requests: AsyncStream<Request>
    private let arrivals: AsyncStream<Request>.Continuation

    init() { (requests, arrivals) = AsyncStream.makeStream() }

    func recommendSingle(_ request: SingleRecommendationRequest) async throws -> SingleRecommendationResponse {
        // Intentionally ignore cancellation to exercise transports with late replies.
        try await withCheckedThrowingContinuation { arrivals.yield(.single(request, $0)) }
    }
    func compose(_ request: ComposeRecommendationRequest) async throws -> ComposeRecommendationResponse {
        try await withCheckedThrowingContinuation { arrivals.yield(.composition(request, $0)) }
    }
}

@MainActor
func recommendationWorkflowChecks(shirt: WardrobeItem, jeans: WardrobeItem) async throws {
    var alternative = WardrobeItem(id: UUID(), operationID: UUID(), photoVersionID: UUID())
    alternative.status = .ready; alternative.type = "Футболка"; alternative.resultFilename = "alternative.png"
    alternative = try OutfitCoreChecks.preparedFixture(alternative)
    let items = [shirt, jeans, alternative]
    let packets = try items.map { try RecommendationItem(item: $0, representationJSON: $0.publishedVersion!.representation!.response.representationJSON!) }
    var draft = Outfit(name: "Тест")
    draft.selectItem(shirt.id, for: draft.slots[1].id)
    draft.selectItem(jeans.id, for: draft.slots[2].id)
    let slotID = draft.slots[1].id
    var context = OutfitRecommendations.Context(draft: draft, history: .init(), pinnedSlotIDs: [],
        items: items, preparedItems: packets, savedOutfit: nil, activeSpaceID: "controlled-fixture-space")
    let runner = OutfitRecommendations(), transport = HeldRecommendations()
    var requests = transport.requests.makeAsyncIterator()
    let (events, outcomes) = AsyncStream<Bool>.makeStream()
    var completions = events.makeAsyncIterator()
    var applications = 0, failures = 0
    func start(_ action: OutfitRecommendations.Action = .single(slotID: slotID, intent: .complement)) {
        runner.start(action, transport: transport, context: { context }, apply: { updated, history in
            context.draft = updated; context.history = history
            applications += 1; outcomes.yield(true)
        }, onFailure: { _ in failures += 1; outcomes.yield(false) })
    }
    func proposal(_ request: SingleRecommendationRequest) -> SingleRecommendationResponse {
        SingleRecommendationResponse(requestId: request.requestId, snapshotId: request.snapshotId,
            targetSlotId: request.targetSlotId, outcome: .proposed,
            proposal: .init(itemId: alternative.id, publishedVersionId: alternative.publishedVersion!.versionID),
            spaceID: "controlled-fixture-space", mode: "controlled", policyVersion: "outfit-placement-v1",
            reason: nil, conflictingSlotIds: [])
    }
    start()
    guard case .single(let first, let reply) = await requests.next() else { fatalError("Expected single request") }
    precondition(runner.hasPending && runner.slotID == slotID)
    reply.resume(returning: proposal(first))
    let applied = await completions.next()
    precondition(applied == true && !runner.hasPending && context.history.canUndo)
    precondition(context.draft.slots[1].itemID == alternative.id && runner.message?.hasPrefix("Тестовый подбор.") == true)
    var undoHistory = context.history, undoDraft = context.draft
    undoHistory.undo(in: &undoDraft, availableItemIDs: Set(items.map(\.id)))
    context.history = undoHistory; context.draft = undoDraft
    precondition(context.draft == draft)

    // Re-read the current draft/config even if a UI observer has not cancelled yet.
    for change in ["draft", "space"] {
        start()
        guard case .single(let request, let response) = await requests.next() else { fatalError() }
        if change == "draft" { context.draft.name = "Новое название" }
        else { context.activeSpaceID = "next-space" }
        let current = context.draft
        response.resume(returning: proposal(request))
        let failed = await completions.next()
        precondition(failed == false && context.draft == current && !runner.hasPending)
        context.draft = draft; context.activeSpaceID = "controlled-fixture-space"
    }

    // An old failure must neither clear nor report an error for a newer request.
    start()
    guard case .single(_, let cancelled) = await requests.next() else { fatalError() }
    runner.cancel(message: "Отменено")
    precondition(!runner.hasPending && runner.message == "Отменено")
    start(.composition(.fillEmpty))
    guard case .composition(let composition, let composed) = await requests.next() else { fatalError() }
    precondition(runner.isComposing && runner.slotID == nil)
    cancelled.resume(throwing: URLError(.notConnectedToInternet))
    composed.resume(returning: ComposeRecommendationResponse(requestId: composition.requestId, snapshotId: composition.snapshotId,
        mode: composition.mode, outcome: .unchanged, modelMode: "controlled", placements: nil,
        spaceID: "controlled-fixture-space", policyVersion: "outfit-placement-v1", reason: "nothing_to_fill", conflictingSlotIds: []))
    let composedResult = await completions.next()
    precondition(composedResult == true && applications == 2 && failures == 2 && !runner.hasPending)
    precondition(context.draft == draft && !context.history.canUndo)

    // A late success after replacement cannot add a second undo or overwrite it.
    start()
    guard case .single(let late, let lateReply) = await requests.next() else { fatalError() }
    start()
    guard case .single(let latest, let latestReply) = await requests.next() else { fatalError() }
    lateReply.resume(returning: proposal(late))
    latestReply.resume(returning: proposal(latest))
    let latestResult = await completions.next()
    precondition(latestResult == true && applications == 3 && failures == 2)
    undoHistory = context.history; undoDraft = context.draft
    undoHistory.undo(in: &undoDraft, availableItemIDs: Set(items.map(\.id)))
    context.history = undoHistory; context.draft = undoDraft
    precondition(context.draft == draft && !context.history.canUndo)

    start()
    guard case .single(_, let failedReply) = await requests.next() else { fatalError() }
    failedReply.resume(throwing: URLError(.notConnectedToInternet))
    let networkFailure = await completions.next()
    precondition(networkFailure == false && failures == 3 && !runner.hasPending && context.draft == draft)
    print("PASS: recommendation transport, current-context validation, cancellation, late replies, composition, undo and network failure")
}
