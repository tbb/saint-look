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

extension Outfit {
    var selectedIDs: Set<UUID> { Set(slots.compactMap(\.itemID)) }

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
        guard ids.count >= 2 else { throw OutfitError.tooFewItems }
        let previous = outfits.first { $0.id == draft.id }
        for slot in draft.slots {
            guard let itemID = slot.itemID else { continue }
            guard let item = items.first(where: { $0.id == itemID }) else { throw OutfitError.unavailableItem }
            // Existing references remain valid during retries or manual type corrections.
            let unchanged = previous?.slots.contains { $0.id == slot.id && $0.itemID == itemID && $0.zone == slot.zone } == true
            if !unchanged {
                guard item.status == .ready, item.resultFilename != nil,
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

    mutating func removeItem(_ id: UUID) {
        items.removeAll { $0.id == id }
        pendingDeletionIDs.insert(id)
        pendingAcknowledgements = pendingAcknowledgements.map { Set($0.filter { $0.itemID != id }) }
        outfits = outfits.map { $0.removingItem(id) }
    }
}
