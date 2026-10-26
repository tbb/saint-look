import SwiftUI

@MainActor
struct OutfitsView: View {
    @ObservedObject var store: WardrobeStore
    @State private var creating = false

    var body: some View {
        NavigationStack {
            Group {
                if store.outfits.isEmpty {
                    ContentUnavailableView {
                        Label("Ваши луки", systemImage: "square.grid.2x2")
                    } description: {
                        Text("Соберите сочетание из вещей гардероба. Оно сохранится на этом устройстве и будет доступно без сети.")
                    } actions: {
                        Button("Собрать первый лук") { creating = true }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("create-first-outfit")
                            .disabled(!store.storageAvailable)
                    }
                } else {
                    List(store.outfits) { outfit in
                        NavigationLink {
                            OutfitDetailView(store: store, outfitID: outfit.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(outfit.displayName).font(.headline)
                                HStack(spacing: 8) {
                                    ForEach(outfit.slots) { slot in
                                        OutfitThumbnail(store: store, slot: slot)
                                            .frame(width: 58, height: 64)
                                    }
                                }
                                Text("Вещей: \(outfit.selectedIDs.count)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 8)
                        }
                        .accessibilityIdentifier("outfit-card-\(outfit.id)")
                    }
                }
            }
            .navigationTitle("Луки")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Создать", systemImage: "plus") { creating = true }
                        .accessibilityIdentifier("create-outfit")
                        .disabled(!store.storageAvailable)
                }
            }
            .sheet(isPresented: $creating) {
                OutfitEditorView(store: store, draft: Outfit())
            }
        }
    }
}

@MainActor
struct OutfitDetailView: View {
    @ObservedObject var store: WardrobeStore
    let outfitID: UUID
    @State private var repairing = false

    private var outfit: Outfit? { store.outfits.first { $0.id == outfitID } }

    var body: some View {
        Group {
            if let outfit {
                List {
                    ForEach(outfit.slots) { slot in
                        Section(slot.zone.title) {
                            OutfitSlotContent(store: store, slot: slot)
                            if slot.needsReplacement {
                                Button("Подобрать замену") { repairing = true }
                                    .accessibilityIdentifier("repair-slot-\(slot.id)")
                            }
                        }
                    }
                }
                .navigationTitle(outfit.displayName)
                .navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: $repairing) {
                    OutfitEditorView(store: store, draft: outfit)
                }
            }
        }
    }
}

@MainActor
struct OutfitEditorView: View {
    @ObservedObject var store: WardrobeStore
    @State var draft: Outfit
    @Environment(\.dismiss) private var dismiss
    @State private var choosingSlot: OutfitSlot?
    @State private var errorMessage: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Название — необязательно", text: $draft.name)
                        .accessibilityIdentifier("outfit-name")
                }
                ForEach(draft.slots) { slot in
                    Section(slot.zone.title) {
                        Button { choosingSlot = slot } label: {
                            OutfitSlotContent(store: store, slot: slot)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("outfit-slot-\(slot.zone.rawValue)-\(slot.id)")
                        .accessibilityLabel("\(slot.zone.title). \(itemLabel(slot))")
                        if slot.itemID != nil {
                            Button("Очистить", role: .destructive) { select(nil, for: slot.id) }
                                .accessibilityIdentifier("clear-slot-\(slot.id)")
                        }
                    }
                }
                Section {
                    Text("Для сохранения выберите хотя бы две разные вещи. Остальные зоны можно оставить пустыми.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                            .accessibilityIdentifier("outfit-save-error")
                    }
                }
            }
            .navigationTitle("Собрать лук")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }.accessibilityIdentifier("cancel-outfit")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") { save() }
                        .disabled(draft.selectedIDs.count < 2 || saving || !store.storageAvailable)
                        .accessibilityIdentifier("save-outfit")
                }
            }
            .sheet(item: $choosingSlot) { slot in
                OutfitPickerView(store: store, zone: slot.zone,
                                 excluding: draft.selectedIDs.subtracting(slot.itemID.map { [$0] } ?? [])) { itemID in
                    select(itemID, for: slot.id)
                    choosingSlot = nil
                }
            }
            .onChange(of: store.items.map(\.id)) { old, current in
                for id in Set(old).subtracting(current) { draft = draft.removingItem(id) }
            }
        }
    }

    private func itemLabel(_ slot: OutfitSlot) -> String {
        if let item = store.items.first(where: { $0.id == slot.itemID }) {
            return ([item.displayedType ?? "Вещь"] + item.displayedColors).joined(separator: ", ")
        }
        return slot.needsReplacement ? "Вещь удалена. Выберите замену" : "Выбрать вещь"
    }

    private func select(_ itemID: UUID?, for slotID: UUID) {
        guard let index = draft.slots.firstIndex(where: { $0.id == slotID }) else { return }
        draft.slots[index].itemID = itemID
        draft.slots[index].needsReplacement = false
        errorMessage = nil
    }

    private func save() {
        guard !saving else { return }
        saving = true
        do {
            try store.saveOutfit(draft)
            dismiss()
        } catch {
            errorMessage = (error as? OutfitError)?.localizedDescription
                ?? "Не удалось сохранить лук на устройстве. Ваш выбор сохранён в черновике — попробуйте ещё раз."
            saving = false
        }
    }
}

@MainActor
struct OutfitPickerView: View {
    @ObservedObject var store: WardrobeStore
    let zone: OutfitZone
    let excluding: Set<UUID>
    let choose: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss

    private var candidates: [WardrobeItem] { store.outfitCandidates(for: zone, excluding: excluding) }

    var body: some View {
        NavigationStack {
            Group {
                if candidates.isEmpty {
                    ContentUnavailableView("Подходящих вещей пока нет", systemImage: "tshirt",
                        description: Text("Здесь появятся вещи для этой зоны с готовой вырезкой и известным типом. Уже выбранные вещи не повторяются."))
                        .accessibilityIdentifier("outfit-picker-empty")
                } else {
                    List(candidates) { item in
                        Button { choose(item.id) } label: {
                            OutfitSlotContent(store: store, slot: OutfitSlot(zone: zone, itemID: item.id))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("outfit-candidate-\(item.id)")
                    }
                }
            }
            .navigationTitle(zone.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }.accessibilityIdentifier("cancel-outfit-picker")
                }
            }
        }
    }
}

@MainActor
struct OutfitSlotContent: View {
    @ObservedObject var store: WardrobeStore
    let slot: OutfitSlot

    var body: some View {
        HStack(spacing: 16) {
            OutfitThumbnail(store: store, slot: slot).frame(width: 80, height: 90)
            VStack(alignment: .leading, spacing: 5) {
                if let item = store.items.first(where: { $0.id == slot.itemID }) {
                    Text(item.displayedType ?? "Вещь").font(.headline)
                    Text(item.displayedColors.joined(separator: ", ")).font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Text(slot.needsReplacement ? "Вещь удалена" : "Пустая зона").font(.headline)
                    Text(slot.needsReplacement ? "Выберите замену из гардероба" : "Можно оставить пустой")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("outfit-content-\(slot.id)")
    }
}

@MainActor
struct OutfitThumbnail: View {
    @ObservedObject var store: WardrobeStore
    let slot: OutfitSlot

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color(uiColor: .secondarySystemGroupedBackground))
            if let item = store.items.first(where: { $0.id == slot.itemID }),
               let image = store.displayImage(for: item) {
                Image(uiImage: image).resizable().scaledToFit().padding(4)
            } else {
                Image(systemName: slot.needsReplacement ? "arrow.triangle.2.circlepath" : "plus")
                    .font(.title3).foregroundStyle(.tertiary)
            }
        }
        .accessibilityHidden(true)
    }
}
