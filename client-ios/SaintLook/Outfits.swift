import Foundation

enum OutfitZone: String, Codable, CaseIterable {
    case head, body, bottom, shoes

    var title: String {
        switch self {
        case .head: return "Голова"
        case .body: return "Тело"
        case .bottom: return "Низ"
        case .shoes: return "Обувь"
        }
    }
}

struct OutfitSlot: Codable, Identifiable, Equatable {
    let id: UUID
    let zone: OutfitZone
    var itemID: UUID?
    var needsReplacement = false

    init(id: UUID = UUID(), zone: OutfitZone, itemID: UUID? = nil) {
        self.id = id
        self.zone = zone
        self.itemID = itemID
    }
}

struct Outfit: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    let createdAt: Date
    var slots: [OutfitSlot]

    init(id: UUID = UUID(), name: String = "", createdAt: Date = Date(), slots: [OutfitSlot]? = nil) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.slots = slots ?? OutfitZone.allCases.map { OutfitSlot(zone: $0) }
    }

    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Лук без названия" : trimmed
    }
}

extension OutfitZone {
    func accepts(_ item: WardrobeItem, taxonomy: WardrobeTaxonomy) -> Bool {
        guard let type = taxonomy.types.first(where: { $0.label == item.displayedType })?.id else { return false }
        switch self {
        case .head: return type == "headwear"
        case .body: return ["t_shirt", "polo", "shirt", "blouse", "top", "sweater", "cardigan", "sweatshirt", "hoodie", "vest", "blazer", "jacket", "coat", "raincoat"].contains(type)
        case .bottom: return ["jeans", "trousers", "shorts", "skirt"].contains(type)
        case .shoes: return ["sneakers", "shoes", "boots", "sandals", "slippers"].contains(type)
        }
    }
}

/// Full picker/cycle pools and small UI availability questions share admission.
/// Availability remains a fresh caller-owned file/artifact check, never a cache.
enum OutfitCandidates {
    private static func admits(_ item: WardrobeItem, zone: OutfitZone, excluding selectedIDs: Set<UUID>,
                               taxonomy: WardrobeTaxonomy, available: (WardrobeItem) -> Bool) -> Bool {
        item.hasPreparedVersion && !selectedIDs.contains(item.id)
            && zone.accepts(item, taxonomy: taxonomy) && available(item)
    }

    static func sorted(_ items: [WardrobeItem], zone: OutfitZone, excluding selectedIDs: Set<UUID>,
                       taxonomy: WardrobeTaxonomy, available: (WardrobeItem) -> Bool) -> [WardrobeItem] {
        items.filter { admits($0, zone: zone, excluding: selectedIDs, taxonomy: taxonomy, available: available) }
            .sorted { $0.id.uuidString < $1.id.uuidString }
    }

    static func count(_ items: [WardrobeItem], upTo limit: Int, zone: OutfitZone, excluding selectedIDs: Set<UUID>,
                      taxonomy: WardrobeTaxonomy, available: (WardrobeItem) -> Bool) -> Int {
        guard limit > 0 else { return 0 }
        var count = 0
        for item in items where admits(item, zone: zone, excluding: selectedIDs, taxonomy: taxonomy, available: available) {
            count += 1
            if count == limit { return count }
        }
        return count
    }
}

extension Outfit {
    var selectedIDs: Set<UUID> { Set(slots.compactMap(\.itemID)) }

    @discardableResult
    mutating func addBodyLayer() -> UUID {
        let slot = OutfitSlot(zone: .body)
        let insertion = slots.lastIndex(where: { $0.zone == .body }).map { $0 + 1 }
            ?? slots.firstIndex(where: { $0.zone == .bottom }) ?? slots.count
        slots.insert(slot, at: insertion)
        return slot.id
    }

    mutating func removeBodyLayer(_ slotID: UUID) {
        guard let index = slots.firstIndex(where: { $0.id == slotID && $0.zone == .body }) else { return }
        if slots.filter({ $0.zone == .body }).count == 1 {
            selectItem(nil, for: slotID)
        } else {
            slots.remove(at: index)
        }
    }

    mutating func selectItem(_ itemID: UUID?, for slotID: UUID) {
        guard let index = slots.firstIndex(where: { $0.id == slotID }) else { return }
        if let itemID, slots.contains(where: { $0.id != slotID && $0.itemID == itemID }) { return }
        slots[index].itemID = itemID
        slots[index].needsReplacement = false
    }

    /// Candidates are refreshed by the caller for every gesture; only IDs survive between gestures.
    mutating func cycleItem(for slotID: UUID, among candidateIDs: [UUID], forward: Bool) {
        guard let slot = slots.first(where: { $0.id == slotID }) else { return }
        let occupied = Set(slots.filter { $0.id != slotID }.compactMap(\.itemID))
        let candidates = candidateIDs.filter { !occupied.contains($0) }
        guard !candidates.isEmpty else { return }
        let next: UUID
        if let itemID = slot.itemID, let current = candidates.firstIndex(of: itemID) {
            let offset = forward ? 1 : candidates.count - 1
            next = candidates[(current + offset) % candidates.count]
        } else {
            next = forward ? candidates[0] : candidates[candidates.count - 1]
        }
        selectItem(next, for: slotID)
    }

    func removingItem(_ id: UUID) -> Outfit {
        var updated = self
        for index in updated.slots.indices where updated.slots[index].itemID == id {
            updated.slots[index].itemID = nil
            updated.slots[index].needsReplacement = true
        }
        return updated
    }
}

enum OutfitError: LocalizedError {
    case tooFewItems, duplicateItem, unavailableItem

    var errorDescription: String? {
        switch self {
        case .tooFewItems: return "Добавьте хотя бы две разные вещи."
        case .duplicateItem: return "Одна вещь может быть в луке только один раз."
        case .unavailableItem: return "Эта вещь больше недоступна для выбора. Выберите другую."
        }
    }
}

extension WardrobeCatalog {
    mutating func saveOutfit(_ draft: Outfit, taxonomy: WardrobeTaxonomy, availableCutouts: Set<UUID>) throws {
        let ids = draft.slots.compactMap(\.itemID)
        guard Set(ids).count == ids.count else { throw OutfitError.duplicateItem }
        let previous = outfits.first { $0.id == draft.id }
        guard ids.count >= 2 || previous?.slots == draft.slots else { throw OutfitError.tooFewItems }
        for slot in draft.slots {
            guard let itemID = slot.itemID else { continue }
            guard let item = items.first(where: { $0.id == itemID }) else { throw OutfitError.unavailableItem }
            // Existing references remain valid during retries or manual type corrections.
            let unchanged = previous?.slots.contains { $0.id == slot.id && $0.itemID == itemID && $0.zone == slot.zone } == true
            if !unchanged {
                guard item.hasPreparedVersion, item.displayedCutoutFilename != nil,
                      availableCutouts.contains(itemID), slot.zone.accepts(item, taxonomy: taxonomy) else {
                    throw OutfitError.unavailableItem
                }
            }
        }
        var saved = draft
        saved.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let index = outfits.firstIndex(where: { $0.id == draft.id }) { outfits[index] = saved }
        else { outfits.insert(saved, at: 0) }
    }

    mutating func removeOutfit(_ id: UUID) {
        outfits.removeAll { $0.id == id }
    }

    mutating func removeItem(_ id: UUID) {
        items.removeAll { $0.id == id }
        pendingDeletionIDs.insert(id)
        pendingAcknowledgements = pendingAcknowledgements.map { Set($0.filter { $0.itemID != id }) }
        outfits = outfits.map { $0.removingItem(id) }
    }
}

/// Editor-only history. Names and pins are intentionally outside composition snapshots.
struct OutfitCompositionHistory {
    private var previous: [[OutfitSlot]] = []
    var canUndo: Bool { !previous.isEmpty }

    mutating func recordChange(from before: Outfit, to after: Outfit) {
        guard before.slots != after.slots else { return }
        previous.append(before.slots)
        if previous.count > 100 { previous.removeFirst() }
    }

    mutating func undo(in outfit: inout Outfit, availableItemIDs: Set<UUID>) {
        while var slots = previous.popLast() {
            for index in slots.indices {
                if let id = slots[index].itemID, !availableItemIDs.contains(id) {
                    slots[index].itemID = nil
                    slots[index].needsReplacement = true
                }
            }
            guard slots != outfit.slots else { continue }
            outfit.slots = slots
            return
        }
    }
}

// A recommendation transports only committed, cached representations. Tensor
// contents belong to the server adapter; the client preserves the exact string.
enum RecommendationIntent: String, Codable { case complement, similar }

/// Published observable attributes are copied verbatim. The backend verifies
/// their canonical digest and owns the soft similarity policy.
struct RecommendationEffectiveFeatures: Codable, Equatable {
    let version: String
    let type: String
    let colors: [String]
    let traits: [String: String]

    init(_ features: IllustrationFeatures) {
        version = features.version; type = features.type; colors = features.colors; traits = features.traits
    }
}

struct RecommendationItem: Codable, Equatable {
    let itemId: UUID
    let publishedVersionId: UUID
    let photoVersionId: UUID
    let sourceSetVersionId: UUID
    let features: CanonicalItemFeatures
    let effectiveFeatures: RecommendationEffectiveFeatures
    let representationJSON: String
    let representationSHA256: String

    init(item: WardrobeItem, representationJSON: String) throws {
        guard item.hasPreparedVersion, let publication = item.publishedVersion,
              let representation = publication.representation,
              let publishedFeatures = publication.illustration?.response.effectiveFeatures, publishedFeatures.isValid,
              representationJSON == representation.response.representationJSON,
              let digest = representation.response.representationSHA256,
              representationJSON.utf8.count <= 8 * 1024 else { throw RecommendationError.preparationRequired }
        itemId = item.id; publishedVersionId = publication.versionID
        photoVersionId = publication.photoVersionID; sourceSetVersionId = publication.sourceSetVersionID
        features = try CanonicalItemFeatures(displayType: publication.type, colors: publication.colors)
        effectiveFeatures = RecommendationEffectiveFeatures(publishedFeatures)
        self.representationJSON = representationJSON; representationSHA256 = digest
    }
}

struct SingleRecommendationRequest: Codable, Equatable {
    struct Slot: Codable, Equatable {
        let slotId: UUID
        let zone: OutfitZone
        let itemId: UUID?
        let publishedVersionId: UUID?

        // Explicit nulls keep the wire meaning of an empty place unambiguous.
        enum CodingKeys: String, CodingKey { case slotId, zone, itemId, publishedVersionId }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(slotId, forKey: .slotId); try values.encode(zone, forKey: .zone)
            try values.encode(itemId, forKey: .itemId); try values.encode(publishedVersionId, forKey: .publishedVersionId)
        }
    }
    let requestId: UUID
    let snapshotId: UUID
    let targetSlotId: UUID
    var intent: RecommendationIntent = .complement
    let orderedSlots: [Slot]
    let pinnedSlotIds: [UUID]
    let excludedItemIds: [UUID]
    let items: [RecommendationItem]
}

struct SingleRecommendationResponse: Codable {
    enum Outcome: String, Codable { case proposed, no_alternative, constraints_conflict, empty_context }
    struct Proposal: Codable { let itemId: UUID; let publishedVersionId: UUID }
    let requestId: UUID
    let snapshotId: UUID
    let targetSlotId: UUID
    let outcome: Outcome
    var intent: RecommendationIntent? = nil
    var rankingVersion: String? = nil
    let proposal: Proposal?
    let spaceID: String?
    let mode: String
    let policyVersion: String
    let reason: String?
    let conflictingSlotIds: [UUID]

    var message: String {
        switch outcome {
        case .proposed: return intent == .similar
            ? "Предложена похожая замена. Сохраните лук, если результат подходит."
            : "Предложена другая вещь. Сохраните лук, если результат подходит."
        case .no_alternative: return "Другой подходящей вещи пока нет. Добавьте вещи в гардероб или измените состав."
        case .empty_context: return RecommendationError.emptyContext.localizedDescription
        case .constraints_conflict:
            if reason == "target_pinned" { return RecommendationError.targetPinned.localizedDescription }
            if reason == "fixed_layer_order" { return "Текущий порядок слоёв не подходит для подбора. Измените порядок вещей. Состав сохранён." }
            return "Не удалось подобрать с текущими ограничениями. Проверьте места и закрепления. Состав сохранён."
        }
    }
}

enum ComposeMode: String, Codable { case fillEmpty, rebuild }

struct ComposeRecommendationRequest: Codable, Equatable {
    let requestId: UUID
    let snapshotId: UUID
    let mode: ComposeMode
    let orderedSlots: [SingleRecommendationRequest.Slot]
    let pinnedSlotIds: [UUID]
    let excludedItemIds: [UUID]
    let items: [RecommendationItem]
}

struct ComposeRecommendationResponse: Codable {
    enum Outcome: String, Codable { case proposed, partial, unchanged, no_solution, constraints_conflict }
    struct Placement: Codable {
        let slotId: UUID
        let itemId: UUID?
        let publishedVersionId: UUID?
    }
    let requestId: UUID
    let snapshotId: UUID
    let mode: ComposeMode
    let outcome: Outcome
    let modelMode: String
    let placements: [Placement]?
    let spaceID: String?
    let policyVersion: String
    let reason: String?
    let conflictingSlotIds: [UUID]

    var message: String {
        if reason == "all_pinned" { return "Все места закреплены. Открепите место, чтобы изменить лук." }
        if reason == "nothing_to_fill" { return "Свободных мест нет." }
        if reason == "preparation_required" { return RecommendationError.preparationRequired.localizedDescription }
        switch outcome {
        case .proposed: return "Лук подобран. Сохраните его, если результат подходит."
        case .partial: return "Для некоторых мест не удалось подобрать вещи. Вы можете заполнить их вручную."
        case .unchanged: return "Другой подходящий состав не найден. Текущий лук сохранён."
        case .no_solution: return "Не удалось подобрать лук из доступных вещей. Текущий лук сохранён."
        case .constraints_conflict: return "Не удалось подобрать с текущими ограничениями. Проверьте места и закрепления. Состав сохранён."
        }
    }
}

enum RecommendationError: LocalizedError {
    case compositionTooLarge, stale, targetPinned, emptyContext, preparationRequired, similaritySourceRequired, contextTooLarge, wardrobeTooLarge, invalidResponse
    var errorDescription: String? {
        switch self {
        case .stale: return "Лук или гардероб изменился. Запустите подбор снова."
        case .targetPinned: return "Открепите это место для подбора."
        case .emptyContext: return "Добавьте хотя бы одну вещь в другое место, чтобы подобрать сочетание."
        case .similaritySourceRequired: return "Для похожей замены нужно завершить подготовку исходной вещи. Откройте её в гардеробе."
        case .preparationRequired: return "Для подбора нужно завершить или обновить подготовку вещей. Откройте гардероб."
        case .compositionTooLarge: return "Подбор лука доступен для структуры до 32 мест. Ручная сборка остаётся доступна."
        case .contextTooLarge: return "Подбор одной вещи доступен для контекста до 32 вещей. Ручная сборка остаётся доступна."
        case .wardrobeTooLarge: return "Этот подбор поддерживает до 300 подготовленных вещей. Состав сохранён."
        case .invalidResponse: return "Не удалось применить предложение. Состав сохранён. Попробуйте ещё раз."
        }
    }

    static func message(for error: Error) -> String {
        if let error = error as? RecommendationError { return error.localizedDescription }
        if let error = error as? URLError {
            return error.code == .timedOut ? "Подбор занял слишком много времени. Состав сохранён. Попробуйте ещё раз."
                : "Нет связи с сервером. Состав сохранён. Попробуйте ещё раз при подключении."
        }
        if case ClientError.resultUnavailable(let code) = error {
            switch code {
            case "snapshot_stale": return RecommendationError.stale.localizedDescription
            case "incompatible_representations", "representation_space_changed", "similarity_features_required": return RecommendationError.preparationRequired.localizedDescription
            case "similarity_source_required": return RecommendationError.similaritySourceRequired.localizedDescription
            case "model_unavailable": return "Подбор временно недоступен. Состав сохранён. Попробуйте позже."
            case "model_failed": return "Модель не смогла выполнить подбор. Состав сохранён. Попробуйте ещё раз."
            case "context_too_large": return RecommendationError.contextTooLarge.localizedDescription
            default: break
            }
        }
        if case ClientError.server(401) = error { return "Проверьте токен владельца в настройках. Состав сохранён." }
        return "Не удалось подобрать. Состав сохранён. Попробуйте ещё раз."
    }
}

/// An editor-owned request capability. Cancelling it, including an edit followed
/// by undo, permanently invalidates the old response. Nothing here persists a look.
struct OutfitRecommendationSession {
    struct ItemIdentity: Equatable {
        let id: UUID
        let publication: UUID?
        let prepared: Bool
        let representationDigest: String?
    }
    struct Snapshot {
        let request: SingleRecommendationRequest
        let draft: Outfit
        let inventory: [ItemIdentity]
        let savedOutfit: Outfit?
        let spaceID: String
    }
    struct CompositionSnapshot {
        let request: ComposeRecommendationRequest
        let draft: Outfit
        let inventory: [ItemIdentity]
        let savedOutfit: Outfit?
        let spaceID: String?
    }
    private(set) var pending: Snapshot?
    private(set) var pendingComposition: CompositionSnapshot?
    var hasPending: Bool { pending != nil || pendingComposition != nil }

    static func inventory(_ items: [WardrobeItem]) -> [ItemIdentity] {
        items.map { ItemIdentity(id: $0.id, publication: $0.publishedVersion?.versionID,
            prepared: $0.hasPreparedVersion, representationDigest: $0.publishedVersion?.representation?.response.representationSHA256) }
            .sorted { $0.id.uuidString < $1.id.uuidString }
    }

    mutating func cancel() { pending = nil; pendingComposition = nil }

    mutating func begin(draft: Outfit, targetSlotID: UUID, intent: RecommendationIntent = .complement, pinnedSlotIDs: Set<UUID>, excludedItemIDs: Set<UUID> = [],
                        items: [WardrobeItem], preparedItems: [RecommendationItem], savedOutfit: Outfit?, activeSpaceID: String?) throws -> SingleRecommendationRequest {
        cancel()
        guard draft.slots.contains(where: { $0.id == targetSlotID }) else { throw RecommendationError.stale }
        guard !pinnedSlotIDs.contains(targetSlotID) else { throw RecommendationError.targetPinned }
        let context = draft.slots.filter { $0.id != targetSlotID && $0.itemID != nil }
        guard intent == .similar || !context.isEmpty else { throw RecommendationError.emptyContext }
        guard context.count <= 32 else { throw RecommendationError.contextTooLarge }
        let targetItemID = draft.slots.first(where: { $0.id == targetSlotID })?.itemID
        if intent == .similar {
            guard let targetItemID, preparedItems.contains(where: { $0.itemId == targetItemID }) else {
                throw RecommendationError.similaritySourceRequired
            }
        }
        let transmittedItems = preparedItems.filter { intent == .similar || $0.itemId != targetItemID }
        guard transmittedItems.count <= 300 else { throw RecommendationError.wardrobeTooLarge }
        let usable = Dictionary(uniqueKeysWithValues: transmittedItems.map { ($0.itemId, $0) })
        guard context.allSatisfy({ usable[$0.itemID!] != nil }) else { throw RecommendationError.preparationRequired }
        let spaces = Set(transmittedItems.compactMap { packet in
            items.first(where: { $0.id == packet.itemId })?.publishedVersion?.representation?.response.spaceID
        })
        guard spaces.count == 1, let space = spaces.first,
              activeSpaceID == nil || activeSpaceID == space else { throw RecommendationError.preparationRequired }
        let slots = try draft.slots.map { slot -> SingleRecommendationRequest.Slot in
            let item = items.first { $0.id == slot.itemID }
            guard slot.itemID == nil || item != nil else { throw RecommendationError.stale }
            // An unprepared original target is only an exclusion/reference, never context.
            return .init(slotId: slot.id, zone: slot.zone, itemId: slot.itemID,
                         publishedVersionId: item?.publishedVersion?.versionID)
        }
        let request = SingleRecommendationRequest(requestId: UUID(), snapshotId: UUID(), targetSlotId: targetSlotID, intent: intent,
            orderedSlots: slots, pinnedSlotIds: pinnedSlotIDs.sorted { $0.uuidString < $1.uuidString },
            excludedItemIds: excludedItemIDs.sorted { $0.uuidString < $1.uuidString },
            items: transmittedItems.sorted { $0.itemId.uuidString < $1.itemId.uuidString })
        pending = Snapshot(request: request, draft: draft, inventory: Self.inventory(items), savedOutfit: savedOutfit, spaceID: space)
        return request
    }

    mutating func apply(_ response: SingleRecommendationResponse, to draft: inout Outfit,
                        history: inout OutfitCompositionHistory, pinnedSlotIDs: Set<UUID>, excludedItemIDs: Set<UUID> = [],
                        items: [WardrobeItem], preparedItems: [RecommendationItem], savedOutfit: Outfit?, taxonomy: WardrobeTaxonomy) throws -> String {
        guard let snapshot = pending,
              snapshot.request.requestId == response.requestId, snapshot.request.snapshotId == response.snapshotId,
              snapshot.request.targetSlotId == response.targetSlotId else { throw RecommendationError.stale }
        defer { cancel() }
        let targetItemID = snapshot.request.orderedSlots.first(where: { $0.slotId == response.targetSlotId })?.itemId
        let transmittedItems = preparedItems.filter { snapshot.request.intent == .similar || $0.itemId != targetItemID }
        guard snapshot.draft == draft, snapshot.savedOutfit == savedOutfit, snapshot.inventory == Self.inventory(items),
              Set(snapshot.request.pinnedSlotIds) == pinnedSlotIDs, Set(snapshot.request.excludedItemIds) == excludedItemIDs,
              snapshot.request.items == transmittedItems.sorted(by: { $0.itemId.uuidString < $1.itemId.uuidString }) else {
            throw RecommendationError.stale
        }
        guard response.policyVersion == "outfit-placement-v1", ["real", "controlled"].contains(response.mode) else { throw RecommendationError.invalidResponse }
        guard (response.intent ?? .complement) == snapshot.request.intent,
              snapshot.request.intent != .similar || response.rankingVersion == "observable-context-v1" else {
            throw RecommendationError.invalidResponse
        }
        guard response.outcome == .proposed else {
            guard response.proposal == nil else { throw RecommendationError.invalidResponse }
            return response.message
        }
        guard let proposal = response.proposal, response.spaceID == snapshot.spaceID,
              let slot = draft.slots.first(where: { $0.id == response.targetSlotId }), !pinnedSlotIDs.contains(slot.id),
              !draft.selectedIDs.contains(proposal.itemId), !excludedItemIDs.contains(proposal.itemId),
              let packet = preparedItems.first(where: { $0.itemId == proposal.itemId }), packet.publishedVersionId == proposal.publishedVersionId,
              let item = items.first(where: { $0.id == proposal.itemId }), item.hasPreparedVersion,
              slot.zone.accepts(item, taxonomy: taxonomy) else { throw RecommendationError.invalidResponse }
        let previous = draft
        draft.selectItem(proposal.itemId, for: slot.id)
        history.recordChange(from: previous, to: draft)
        return response.message
    }
}

extension OutfitRecommendationSession {
    mutating func beginComposition(draft: Outfit, mode: ComposeMode, pinnedSlotIDs: Set<UUID>, excludedItemIDs: Set<UUID> = [],
                                  items: [WardrobeItem], preparedItems: [RecommendationItem], savedOutfit: Outfit?, activeSpaceID: String?) throws -> ComposeRecommendationRequest {
        cancel()
        guard draft.slots.count <= 32 else { throw RecommendationError.compositionTooLarge }
        guard preparedItems.count <= 300 else { throw RecommendationError.wardrobeTooLarge }
        let packets = Dictionary(uniqueKeysWithValues: preparedItems.map { ($0.itemId, $0) })
        let spaces = Set(preparedItems.compactMap { packet in
            items.first(where: { $0.id == packet.itemId })?.publishedVersion?.representation?.response.spaceID
        })
        guard spaces.count <= 1, spaces.first == nil || activeSpaceID == nil || spaces.first == activeSpaceID else {
            throw RecommendationError.preparationRequired
        }
        let slots = try draft.slots.map { slot -> SingleRecommendationRequest.Slot in
            let item = items.first { $0.id == slot.itemID }
            guard slot.itemID == nil || item != nil else { throw RecommendationError.stale }
            if let itemID = slot.itemID, mode == .fillEmpty || pinnedSlotIDs.contains(slot.id) {
                guard packets[itemID] != nil else { throw RecommendationError.preparationRequired }
            }
            return .init(slotId: slot.id, zone: slot.zone, itemId: slot.itemID, publishedVersionId: item?.publishedVersion?.versionID)
        }
        let request = ComposeRecommendationRequest(requestId: UUID(), snapshotId: UUID(), mode: mode, orderedSlots: slots,
            pinnedSlotIds: pinnedSlotIDs.sorted { $0.uuidString < $1.uuidString },
            excludedItemIds: excludedItemIDs.sorted { $0.uuidString < $1.uuidString },
            items: preparedItems.sorted { $0.itemId.uuidString < $1.itemId.uuidString })
        pendingComposition = CompositionSnapshot(request: request, draft: draft, inventory: Self.inventory(items),
            savedOutfit: savedOutfit, spaceID: spaces.first)
        return request
    }

    mutating func applyComposition(_ response: ComposeRecommendationResponse, to draft: inout Outfit,
                                  history: inout OutfitCompositionHistory, pinnedSlotIDs: Set<UUID>, excludedItemIDs: Set<UUID> = [],
                                  items: [WardrobeItem], preparedItems: [RecommendationItem], savedOutfit: Outfit?, taxonomy: WardrobeTaxonomy) throws -> String {
        guard let snapshot = pendingComposition, snapshot.request.requestId == response.requestId,
              snapshot.request.snapshotId == response.snapshotId else { throw RecommendationError.stale }
        defer { cancel() }
        guard snapshot.draft == draft, snapshot.savedOutfit == savedOutfit, snapshot.inventory == Self.inventory(items),
              Set(snapshot.request.pinnedSlotIds) == pinnedSlotIDs, Set(snapshot.request.excludedItemIds) == excludedItemIDs,
              snapshot.request.items == preparedItems.sorted(by: { $0.itemId.uuidString < $1.itemId.uuidString }) else {
            throw RecommendationError.stale
        }
        guard response.mode == snapshot.request.mode, response.policyVersion == "outfit-placement-v1",
              ["real", "controlled"].contains(response.modelMode) else { throw RecommendationError.invalidResponse }
        guard response.outcome == .proposed || response.outcome == .partial else {
            guard response.placements == nil else { throw RecommendationError.invalidResponse }
            return response.message
        }
        guard let placements = response.placements, placements.map(\.slotId) == draft.slots.map(\.id),
              response.spaceID == snapshot.spaceID, snapshot.spaceID != nil else { throw RecommendationError.invalidResponse }
        let ids = placements.compactMap(\.itemId)
        guard Set(ids).count == ids.count, ids.count >= draft.slots.compactMap(\.itemID).count else { throw RecommendationError.invalidResponse }
        var proposed = draft
        for (index, placement) in placements.enumerated() {
            let slot = draft.slots[index], original = snapshot.request.orderedSlots[index]
            let fixed = pinnedSlotIDs.contains(slot.id) || (snapshot.request.mode == .fillEmpty && slot.itemID != nil)
            if fixed {
                guard placement.itemId == original.itemId, placement.publishedVersionId == original.publishedVersionId else {
                    throw RecommendationError.invalidResponse
                }
            } else if let id = placement.itemId {
                guard !excludedItemIDs.contains(id), let packet = preparedItems.first(where: { $0.itemId == id }),
                      packet.publishedVersionId == placement.publishedVersionId,
                      let item = items.first(where: { $0.id == id }), item.hasPreparedVersion,
                      slot.zone.accepts(item, taxonomy: taxonomy) else { throw RecommendationError.invalidResponse }
            } else if placement.publishedVersionId != nil { throw RecommendationError.invalidResponse }
            proposed.slots[index].itemID = placement.itemId
            if placement.itemId != slot.itemID || placement.itemId != nil { proposed.slots[index].needsReplacement = false }
        }
        guard proposed.slots != draft.slots else { throw RecommendationError.invalidResponse }
        let before = draft
        draft = proposed
        history.recordChange(from: before, to: draft)
        return response.message
    }
}
