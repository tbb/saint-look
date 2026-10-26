import SwiftUI

@MainActor
struct OutfitsView: View {
    @ObservedObject var store: WardrobeStore
    @State private var creating = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                    ScrollView {
                        LazyVGrid(columns: collectionColumns, spacing: 24) {
                            ForEach(store.outfits) { outfit in
                                NavigationLink {
                                    OutfitDetailView(store: store, outfitID: outfit.id)
                                } label: {
                                    VStack(alignment: .leading, spacing: 12) {
                                        OutfitComposition(store: store, outfit: outfit, compact: true)
                                        Text(outfit.displayName)
                                            .font(.headline)
                                            .foregroundStyle(.primary)
                                            .fixedSize(horizontal: false, vertical: true)
                                        if outfit.slots.contains(where: \.needsReplacement) {
                                            Label("Нужна замена", systemImage: "arrow.triangle.2.circlepath")
                                                .font(.subheadline)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(outfit.displayName)
                                .accessibilityValue(outfit.slots.contains(where: \.needsReplacement)
                                                    ? "Вещей: \(outfit.selectedIDs.count). Нужна замена"
                                                    : "Вещей: \(outfit.selectedIDs.count)")
                                .accessibilityIdentifier("outfit-card-\(outfit.id)")
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: SaintLookStyle.contentWidth)
                        .frame(maxWidth: .infinity)
                    }
                    .background(SaintLookStyle.canvas)
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

    private var collectionColumns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.adaptive(minimum: 280, maximum: 440), spacing: 24)]
    }
}

@MainActor
struct OutfitDetailView: View {
    @ObservedObject var store: WardrobeStore
    let outfitID: UUID
    @State private var showingEditor = false
    @State private var confirmingDeletion = false
    @State private var deletionError: String?
    @Environment(\.dismiss) private var dismiss

    private var outfit: Outfit? { store.outfits.first { $0.id == outfitID } }

    var body: some View {
        Group {
            if let outfit {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(outfit.displayName)
                            .font(.title2.bold())
                            .fixedSize(horizontal: false, vertical: true)
                        OutfitComposition(store: store, outfit: outfit) { _ in showingEditor = true }
                        deleteAction
                            .frame(minHeight: 44)
                    }
                    .padding(16)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                }
                .background(SaintLookStyle.canvas)
                .navigationTitle("Лук")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Изменить") { showingEditor = true }
                            .accessibilityIdentifier("edit-outfit")
                    }
                }
                .alert("Лук не удалён", isPresented: Binding(get: { deletionError != nil }, set: { if !$0 { deletionError = nil } })) {
                    Button("Понятно", role: .cancel) { deletionError = nil }
                } message: {
                    Text(deletionError ?? "")
                }
                .sheet(isPresented: $showingEditor) {
                    OutfitEditorView(store: store, draft: outfit)
                }
            }
        }
    }
    private var deleteAction: some View {
        Button("Удалить лук", role: .destructive) { confirmingDeletion = true }
            .accessibilityIdentifier("delete-outfit")
            .alert("Удалить лук?", isPresented: $confirmingDeletion) {
                Button("Удалить лук", role: .destructive) { delete() }
                    .accessibilityIdentifier("confirm-delete-outfit")
                Button("Отмена", role: .cancel) { }
                    .accessibilityIdentifier("cancel-delete-outfit")
            } message: {
                Text("Вещи останутся в гардеробе.")
            }
    }

    private func delete() {
        do {
            try store.deleteOutfit(outfitID)
            dismiss()
        } catch {
            deletionError = "Не удалось удалить лук с устройства. Он сохранён — попробуйте ещё раз."
        }
    }
}

/// The same ordered zones form a readable preview in the collection and detail.
/// Ordinary empty zones are omitted; deleted references retain a visible replacement place.
@MainActor
private struct OutfitComposition: View {
    @ObservedObject var store: WardrobeStore
    let outfit: Outfit
    var compact = false
    var repair: ((OutfitSlot) -> Void)?

    private var visibleSlots: [OutfitSlot] {
        outfit.slots.filter { $0.itemID != nil || $0.needsReplacement }
    }

    var body: some View {
        VStack(spacing: compact ? 12 : 24) {
            ForEach(visibleSlots) { slot in
                VStack(spacing: 8) {
                    if let item = store.items.first(where: { $0.id == slot.itemID }) {
                        if let image = store.displayImage(for: item) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity)
                                .frame(height: photoHeight(for: slot.zone))
                                .accessibilityHidden(true)
                        } else {
                            Label("Фото недоступно", systemImage: "photo")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: photoHeight(for: slot.zone))
                        }
                        if !compact {
                            Text(item.displayedType ?? "Вещь")
                                .font(.headline)
                            if !item.displayedColors.isEmpty {
                                Text(item.displayedColors.joined(separator: ", "))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.title2)
                                .accessibilityHidden(true)
                            Text("Нужна замена").font(.subheadline)
                            if !compact {
                                Text(outfitSlotTitle(slot, in: outfit))
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                            if let repair {
                                Button("Подобрать замену") { repair(slot) }
                                    .buttonStyle(.bordered)
                                    .frame(minHeight: 44)
                                    .accessibilityLabel("Подобрать замену: \(outfitSlotTitle(slot, in: outfit))")
                                    .accessibilityIdentifier("repair-slot-\(slot.id)")
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: compact ? 64 : 100)
                    }
                }
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("outfit-content-\(slot.id)")
            }
        }
        .padding(compact ? 16 : 24)
        .frame(maxWidth: .infinity)
        .background(SaintLookStyle.photoSurface)
        .clipShape(RoundedRectangle(cornerRadius: SaintLookStyle.cornerRadius))
    }

    private func photoHeight(for zone: OutfitZone) -> CGFloat {
        switch zone {
        case .head: return compact ? 56 : 80
        case .body: return compact ? 112 : 160
        case .bottom: return compact ? 144 : 200
        case .shoes: return compact ? 72 : 104
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
    @State private var initial: Outfit
    @State private var confirmingDiscard = false
    @FocusState private var naming: Bool

    init(store: WardrobeStore, draft: Outfit) {
        self.store = store
        _draft = State(initialValue: draft)
        _initial = State(initialValue: draft)
    }

    private var dirty: Bool { draft != initial }
    private var editingExisting: Bool { store.outfits.contains { $0.id == draft.id } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Название — необязательно", text: $draft.name)
                        .focused($naming)
                        .submitLabel(.done)
                        .onSubmit { naming = false }
                        .accessibilityIdentifier("outfit-name")
                }
                ForEach(draft.slots) { slot in
                    Section(outfitSlotTitle(slot, in: draft)) {
                        slotSelection(slot)
                        slotControls(slot)
                    }
                }
                Section {
                    Text(editingExisting && draft.selectedIDs.count < 2
                         ? "Название можно изменить сейчас. Для изменения состава выберите хотя бы две разные вещи."
                         : "Для сохранения выберите хотя бы две разные вещи. Остальные зоны можно оставить пустыми.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                            .accessibilityIdentifier("outfit-save-error")
                    }
                }
            }
            .navigationTitle(editingExisting ? "Изменить лук" : "Собрать лук")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { editorToolbar }
            .interactiveDismissDisabled(dirty)
            .alert("Отбросить изменения?", isPresented: $confirmingDiscard) {
                Button("Отбросить изменения", role: .destructive) { dismiss() }
                    .accessibilityIdentifier("discard-outfit-changes")
                Button("Продолжить редактирование", role: .cancel) { }
                    .accessibilityIdentifier("continue-outfit-editing")
            }
            .sheet(item: $choosingSlot) { slot in
                OutfitPickerView(store: store, zone: slot.zone,
                                 excluding: draft.selectedIDs.subtracting(slot.itemID.map { [$0] } ?? [])) { itemID in
                    select(itemID, for: slot.id)
                    choosingSlot = nil
                }
            }
            .onChange(of: store.items.map(\.id)) { old, current in
                for id in Set(old).subtracting(current) {
                    draft = draft.removingItem(id)
                    initial = initial.removingItem(id)
                }
            }
        }
    }

    private func slotContent(_ slot: OutfitSlot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            OutfitSlotContent(store: store, slot: slot)
            if slot.itemID == nil && candidates(for: slot).isEmpty {
                Text("Нет доступных вещей для этой зоны. Нужны готовая вырезка и подходящий тип.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func slotSelection(_ slot: OutfitSlot) -> some View {
        slotContent(slot)
            .contentShape(Rectangle())
            // A Button in a List can activate on release after a simultaneous drag.
            // TapGesture fails when the finger moves; the drag still coexists with scrolling.
            .onTapGesture { choosingSlot = slot }
            .simultaneousGesture(slotDrag(slot.id))
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { choosingSlot = slot }
            .accessibilityIdentifier("outfit-slot-\(slot.zone.rawValue)-\(slot.id)")
            .accessibilityLabel("\(outfitSlotTitle(slot, in: draft)). \(itemLabel(slot))")
            .accessibilityValue(itemLabel(slot))
            .accessibilityHint("Нажмите для выбора. Смахните влево или вправо, чтобы сменить вещь.")
            .accessibilityAction(named: Text("Следующая вещь")) { cycle(slot.id, forward: true) }
            .accessibilityAction(named: Text("Предыдущая вещь")) { cycle(slot.id, forward: false) }
    }

    private func slotDrag(_ slotID: UUID) -> some Gesture {
        DragGesture(minimumDistance: 24).onEnded { value in
            let horizontal = value.translation.width
            guard abs(horizontal) > 40, abs(horizontal) > abs(value.translation.height) * 1.3 else { return }
            cycle(slotID, forward: horizontal < 0)
        }
    }

    @ViewBuilder
    private func slotControls(_ slot: OutfitSlot) -> some View {
        if slot.itemID != nil || slot.needsReplacement {
            Button("Очистить", role: .destructive) { select(nil, for: slot.id) }
                .accessibilityLabel("Очистить: \(outfitSlotTitle(slot, in: draft))")
                .accessibilityIdentifier("clear-slot-\(slot.id)")
        }
        if slot.zone == .body {
            Button("Убрать слой", role: .destructive) {
                draft.removeBodyLayer(slot.id)
                errorMessage = nil
            }
            .accessibilityLabel("Убрать: \(outfitSlotTitle(slot, in: draft))")
            .accessibilityIdentifier("remove-body-layer-\(slot.id)")
            if slot.id == draft.slots.reversed().first(where: { $0.zone == .body })?.id {
                Button("Добавить слой", systemImage: "plus") {
                    draft.addBodyLayer()
                    errorMessage = nil
                }
                .accessibilityIdentifier("add-body-layer")
            }
        }
    }

    @ToolbarContentBuilder
    private var editorToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Отмена") {
                if dirty { confirmingDiscard = true } else { dismiss() }
            }.accessibilityIdentifier("cancel-outfit")
        }
        ToolbarItem(placement: .confirmationAction) {
            Button("Сохранить") { save() }
                .disabled(!dirty || !store.canSaveOutfit(draft) || saving || !store.storageAvailable)
                .accessibilityIdentifier("save-outfit")
        }
    }

    private func itemLabel(_ slot: OutfitSlot) -> String {
        if let item = store.items.first(where: { $0.id == slot.itemID }) {
            return ([item.displayedType ?? "Вещь"] + item.displayedColors).joined(separator: ", ")
        }
        return slot.needsReplacement ? "Вещь удалена. Выберите замену" : "Выбрать вещь"
    }

    private func select(_ itemID: UUID?, for slotID: UUID) {
        guard let slot = draft.slots.first(where: { $0.id == slotID }) else { return }
        if let itemID, !candidates(for: slot).contains(where: { $0.id == itemID }) { return }
        draft.selectItem(itemID, for: slotID)
        errorMessage = nil
    }

    private func candidates(for slot: OutfitSlot) -> [WardrobeItem] {
        let occupied = Set(draft.slots.filter { $0.id != slot.id }.compactMap(\.itemID))
        return store.outfitCandidates(for: slot.zone, excluding: occupied)
    }

    private func cycle(_ slotID: UUID, forward: Bool) {
        guard let slot = draft.slots.first(where: { $0.id == slotID }) else { return }
        draft.cycleItem(for: slotID, among: candidates(for: slot).map(\.id), forward: forward)
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
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var store: WardrobeStore
    let slot: OutfitSlot

    private var layout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
            : AnyLayout(HStackLayout(spacing: 16))
    }

    var body: some View {
        layout {
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
            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, alignment: .leading)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
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

private func outfitSlotTitle(_ slot: OutfitSlot, in outfit: Outfit) -> String {
    guard slot.zone == .body,
          let index = outfit.slots.filter({ $0.zone == .body }).firstIndex(where: { $0.id == slot.id }) else {
        return slot.zone.title
    }
    return "Тело · слой \(index + 1)"
}
