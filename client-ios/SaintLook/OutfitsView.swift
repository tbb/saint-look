import SwiftUI

@MainActor
struct OutfitsView: View {
    @ObservedObject var store: WardrobeStore
    let openWardrobe: () -> Void
    @State private var creating = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        NavigationStack {
            Group {
                if store.outfits.isEmpty {
                    ContentUnavailableView {
                        Label("Пока нет луков", systemImage: "square.grid.2x2")
                    } description: {
                        Text(eligibleCount < 2
                             ? "Для сохранения лука нужны хотя бы две вещи с готовой вырезкой и известным типом."
                             : "Соедините вещи из гардероба. Сохранённые сочетания будут доступны без сети.")
                    } actions: {
                        if eligibleCount < 2 {
                            Button("В гардероб", action: openWardrobe)
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("open-wardrobe")
                            Button("Открыть конструктор") { creating = true }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("create-first-outfit")
                                .disabled(!store.storageAvailable)
                        } else {
                            Button("Собрать первый лук") { creating = true }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("create-first-outfit")
                                .disabled(!store.storageAvailable)
                        }
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
                                .accessibilityLabel(outfit.displayName)
                                .accessibilityValue(compositionDescription(outfit))
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
            .safeAreaInset(edge: .top, spacing: 0) {
                if !store.outfits.isEmpty && eligibleCount < 2 {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Для нового лука нужны хотя бы две готовые вещи.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("В гардероб", action: openWardrobe)
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("open-wardrobe")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .background(.bar)
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

    private var eligibleCount: Int {
        Set(OutfitZone.allCases.flatMap { store.outfitCandidates(for: $0, excluding: []).map(\.id) }).count
    }

    private func compositionDescription(_ outfit: Outfit) -> String {
        let selection = outfit.slots.compactMap { slot -> String? in
            let zone = outfitSlotTitle(slot, in: outfit)
            if let item = store.items.first(where: { $0.id == slot.itemID }) {
                return "\(zone): " + ([item.displayedType ?? "Вещь"] + item.displayedColors).joined(separator: ", ")
            }
            return slot.needsReplacement ? "\(zone): нужна замена" : nil
        }
        return (["Вещей: \(outfit.selectedIDs.count)"] + selection).joined(separator: ". ")
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
    @State private var editorRequest: OutfitEditorRequest?
    @State private var repairingSlot: OutfitSlot?
    @State private var queuedEditor: OutfitEditorRequest?
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
                        OutfitComposition(store: store, outfit: outfit) { repairingSlot = $0 }
                    }
                    .padding(16)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                }
                .background(SaintLookStyle.canvas)
                .navigationTitle("Лук")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { editorRequest = OutfitEditorRequest(draft: outfit, initial: outfit) } label: {
                            Image(systemName: "pencil").frame(minWidth: 44, minHeight: 44)
                        }
                        .accessibilityLabel("Изменить лук")
                        .accessibilityIdentifier("edit-outfit")
                        Menu { deleteAction } label: {
                            Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                        }
                        .accessibilityLabel("Действия с луком")
                        .accessibilityIdentifier("outfit-actions")
                    }
                }
                .alert("Удалить лук?", isPresented: $confirmingDeletion) {
                    Button("Удалить лук", role: .destructive) { delete() }
                        .accessibilityIdentifier("confirm-delete-outfit")
                    Button("Отмена", role: .cancel) { }
                        .accessibilityIdentifier("cancel-delete-outfit")
                } message: {
                    Text("Вещи останутся в гардеробе.")
                }
                .alert("Лук не удалён", isPresented: Binding(get: { deletionError != nil }, set: { if !$0 { deletionError = nil } })) {
                    Button("Понятно", role: .cancel) { deletionError = nil }
                } message: {
                    Text(deletionError ?? "")
                }
                .sheet(item: $repairingSlot, onDismiss: {
                    if let queuedEditor {
                        editorRequest = queuedEditor
                        self.queuedEditor = nil
                    }
                }) { slot in
                    OutfitPickerView(store: store, zone: slot.zone, selectedItemID: nil,
                                     excluding: outfit.selectedIDs.subtracting(slot.itemID.map { [$0] } ?? [])) { itemID in
                        replace(itemID, in: slot.id)
                    }
                }
                .sheet(item: $editorRequest) { request in
                    OutfitEditorView(store: store, draft: request.draft, initial: request.initial,
                                     errorMessage: request.errorMessage)
                }
            }
        }
    }
    private func replace(_ itemID: UUID, in slotID: UUID) {
        guard let current = outfit,
              let slot = current.slots.first(where: { $0.id == slotID && $0.needsReplacement }) else {
            repairingSlot = nil
            return
        }
        let occupied = Set(current.slots.filter { $0.id != slotID }.compactMap(\.itemID))
        guard store.outfitCandidates(for: slot.zone, excluding: occupied).contains(where: { $0.id == itemID }) else {
            queuedEditor = OutfitEditorRequest(draft: current, initial: current,
                                               errorMessage: "Эта вещь больше недоступна. Выберите другую.")
            repairingSlot = nil
            return
        }
        var repaired = current
        repaired.selectItem(itemID, for: slotID)
        do {
            try store.saveOutfit(repaired)
        } catch {
            let message: String?
            if let error = error as? OutfitError, case .tooFewItems = error {
                // The editor explains the missing second thing; the selection remains a dirty draft.
                message = nil
            } else {
                message = (error as? OutfitError)?.localizedDescription
                    ?? "Не удалось сохранить замену. Ваш выбор остался в черновике — попробуйте ещё раз."
            }
            queuedEditor = OutfitEditorRequest(draft: repaired, initial: current, errorMessage: message)
        }
        repairingSlot = nil
    }

    private var deleteAction: some View {
        Button("Удалить лук", role: .destructive) { confirmingDeletion = true }
            .accessibilityIdentifier("delete-outfit")
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

private struct OutfitEditorRequest: Identifiable {
    let id = UUID()
    let draft: Outfit
    let initial: Outfit
    var errorMessage: String?
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
    @AppStorage("outfit-swipe-discovered") private var swipeDiscovered = false
    @FocusState private var naming: Bool

    init(store: WardrobeStore, draft: Outfit, initial: Outfit? = nil, errorMessage: String? = nil) {
        self.store = store
        _draft = State(initialValue: draft)
        _initial = State(initialValue: initial ?? draft)
        _errorMessage = State(initialValue: errorMessage)
    }

    private var dirty: Bool { draft != initial }
    private var editingExisting: Bool { store.outfits.contains { $0.id == draft.id } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField("Название — необязательно", text: $draft.name)
                        .focused($naming)
                        .submitLabel(.done)
                        .onSubmit { naming = false }
                        .padding(.vertical, 12)
                        .accessibilityIdentifier("outfit-name")
                    if !swipeDiscovered {
                        Label("Смахните вещь влево или вправо, чтобы сравнить варианты", systemImage: "hand.draw")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(draft.slots) { slot in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 12) {
                                Text(outfitSlotTitle(slot, in: draft))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                slotMenu(slot)
                            }
                            slotSelection(slot)
                            if slot.id == draft.slots.last(where: { $0.zone == .body })?.id {
                                Button("Добавить слой", systemImage: "plus") {
                                    draft.addBodyLayer()
                                    errorMessage = nil
                                }
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("add-body-layer")
                            }
                        }
                        if slot.id != draft.slots.last?.id { Divider() }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background(SaintLookStyle.canvas)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let message = errorMessage ?? saveExplanation {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(errorMessage == nil ? Color.secondary : Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(.bar)
                        .accessibilityIdentifier(errorMessage == nil ? "outfit-save-explanation" : "outfit-save-error")
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
                OutfitPickerView(store: store, zone: slot.zone, selectedItemID: slot.itemID,
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

    private func slotSelection(_ slot: OutfitSlot) -> some View {
        OutfitSlotContent(store: store, slot: slot)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
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

    private func slotMenu(_ slot: OutfitSlot) -> some View {
        Menu {
            Button("Выбрать вещь", systemImage: "square.grid.2x2") { choosingSlot = slot }
            Button("Следующая вещь", systemImage: "chevron.right") { cycle(slot.id, forward: true) }
                .disabled(candidates(for: slot).count < 2)
                .accessibilityIdentifier("next-slot-\(slot.id)")
            Button("Предыдущая вещь", systemImage: "chevron.left") { cycle(slot.id, forward: false) }
                .disabled(candidates(for: slot).count < 2)
                .accessibilityIdentifier("previous-slot-\(slot.id)")
            if slot.itemID != nil || slot.needsReplacement {
                Button("Очистить", systemImage: "xmark") { select(nil, for: slot.id) }
                    .accessibilityLabel("Очистить: \(outfitSlotTitle(slot, in: draft))")
                    .accessibilityIdentifier("clear-slot-\(slot.id)")
            }
            if slot.zone == .body {
                Button("Убрать слой", systemImage: "minus") {
                    draft.removeBodyLayer(slot.id)
                    errorMessage = nil
                }
                .accessibilityLabel("Убрать: \(outfitSlotTitle(slot, in: draft))")
                .accessibilityIdentifier("remove-body-layer-\(slot.id)")
            }
        } label: {
            Image(systemName: "ellipsis")
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Действия: \(outfitSlotTitle(slot, in: draft))")
        .accessibilityIdentifier("outfit-slot-menu-\(slot.id)")
    }

    private var saveExplanation: String? {
        if !store.storageAvailable { return "Сохранение на устройстве сейчас недоступно." }
        if !store.canSaveOutfit(draft) {
            if draft.selectedIDs.isEmpty { return "Выберите хотя бы две разные вещи. Зоны можно оставить пустыми." }
            if draft.selectedIDs.count == 1 { return "Выберите ещё одну вещь." }
            return "Проверьте выбранные вещи: некоторые больше недоступны."
        }
        if !dirty { return "Измените название или состав, чтобы сохранить." }
        if editingExisting && draft.selectedIDs.count < 2 {
            return "Состав неполный. Сейчас можно сохранить название; для нового состава нужны две вещи."
        }
        return nil
    }

    @ToolbarContentBuilder
    private var editorToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button {
                if dirty { confirmingDiscard = true } else { dismiss() }
            } label: {
                Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("Отмена")
            .accessibilityIdentifier("cancel-outfit")
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
        if draft.slots.first(where: { $0.id == slotID })?.itemID != slot.itemID { swipeDiscovered = true }
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
    let selectedItemID: UUID?
    let excluding: Set<UUID>
    let choose: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var selectedType: String?

    private var candidates: [WardrobeItem] { store.outfitCandidates(for: zone, excluding: excluding) }
    private var types: [WardrobeTaxonomy.Option] {
        let labels = Set(candidates.compactMap(\.displayedType))
        return WardrobeTaxonomy.shared.types.filter { labels.contains($0.label) }
    }
    private var currentType: WardrobeTaxonomy.Option? { types.first { $0.id == selectedType } }
    private var filteredCandidates: [WardrobeItem] {
        guard let currentType else { return candidates }
        return candidates.filter { $0.displayedType == currentType.label }
    }

    var body: some View {
        NavigationStack {
            Group {
                if candidates.isEmpty {
                    ContentUnavailableView(emptyTitle, systemImage: "tshirt", description: Text(emptyDescription))
                        .accessibilityIdentifier("outfit-picker-empty")
                } else {
                    ScrollView {
                        LazyVGrid(columns: SaintLookStyle.columns(accessibilitySize: dynamicTypeSize.isAccessibilitySize), spacing: 20) {
                            ForEach(filteredCandidates) { item in
                                candidateButton(item)
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: SaintLookStyle.contentWidth)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .background(SaintLookStyle.canvas)
            .navigationTitle(zone.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Отмена")
                    .accessibilityIdentifier("cancel-outfit-picker")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if types.count > 1 { typeFilter }
                }
            }
            .onChange(of: types.map(\.id)) { _, available in
                if let selectedType, !available.contains(selectedType) { self.selectedType = nil }
            }
        }
    }

    private var allEligibleAreUsed: Bool {
        !store.outfitCandidates(for: zone, excluding: []).isEmpty
    }

    private var awaitingCandidates: Bool {
        store.items.contains {
            $0.status == .pending && ($0.displayedType == nil || zone.accepts($0, taxonomy: .shared))
        }
    }

    private var emptyTitle: String {
        if allEligibleAreUsed { return "Все подходящие вещи уже выбраны" }
        if awaitingCandidates { return "Вещи ещё обрабатываются" }
        return "Нет вещей для этой зоны"
    }

    private var emptyDescription: String {
        if allEligibleAreUsed { return "Одна вещь может быть только в одном слое. Выберите другой слой или очистите его." }
        if awaitingCandidates { return "После обработки здесь появятся вещи, подходящие этой зоне." }
        return "Нужны готовая вырезка и подходящий тип. Проверьте вещи в гардеробе; эту зону можно оставить пустой."
    }

    private var typeFilter: some View {
        Menu {
            Button { selectedType = nil } label: {
                if currentType == nil { Label("Все типы", systemImage: "checkmark") }
                else { Text("Все типы") }
            }
            .accessibilityIdentifier("outfit-filter-all")
            ForEach(types) { type in
                Button { selectedType = type.id } label: {
                    if currentType?.id == type.id { Label(type.label, systemImage: "checkmark") }
                    else { Text(type.label) }
                }
                .accessibilityIdentifier("outfit-filter-\(type.id)")
            }
        } label: {
            Label(currentType?.label ?? "Все типы", systemImage: "line.3.horizontal.decrease")
                .labelStyle(.titleAndIcon)
                .frame(minHeight: 44)
        }
        .accessibilityLabel("Тип: \(currentType?.label ?? "Все типы")")
        .accessibilityIdentifier("outfit-type-filter")
    }

    private func candidateButton(_ item: WardrobeItem) -> some View {
        let selected = item.id == selectedItemID
        return Button { choose(item.id) } label: {
            VStack(alignment: .leading, spacing: 8) {
                GarmentPhoto(image: store.displayImage(for: item), accessibilityIdentifier: "outfit-candidate-photo-\(item.id)")
                    .aspectRatio(1, contentMode: .fit)
                    .overlay(alignment: .topTrailing) {
                        if selected {
                            Image(systemName: "checkmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, SaintLookStyle.accent)
                                .font(.title2)
                                .padding(10)
                                .accessibilityHidden(true)
                        }
                    }
                Text(item.displayedType ?? "Вещь")
                    .font(.headline).foregroundStyle(.primary)
                if !item.displayedColors.isEmpty {
                    Text(item.displayedColors.joined(separator: ", "))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(([item.displayedType ?? "Вещь"] + item.displayedColors).joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("outfit-candidate-\(item.id)")
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
        Group {
            if let item = store.items.first(where: { $0.id == slot.itemID }) {
                layout {
                    OutfitThumbnail(store: store, slot: slot)
                        .frame(width: dynamicTypeSize.isAccessibilitySize ? 200 : 128,
                               height: slot.zone == .bottom ? 152 : 124)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.displayedType ?? "Вещь").font(.headline)
                        if !item.displayedColors.isEmpty {
                            Text(item.displayedColors.joined(separator: ", "))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(spacing: 12) {
                    Image(systemName: slot.needsReplacement ? "arrow.triangle.2.circlepath" : "plus")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                        .foregroundStyle(SaintLookStyle.accent)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(slot.needsReplacement ? "Выбрать замену" : "Выбрать вещь")
                            .font(.body)
                        Text(slot.needsReplacement ? "Вещь удалена" : "Необязательно")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("outfit-content-\(slot.id)")
    }
}

@MainActor
struct OutfitThumbnail: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var store: WardrobeStore
    let slot: OutfitSlot

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: SaintLookStyle.cornerRadius).fill(SaintLookStyle.photoSurface)
            if let item = store.items.first(where: { $0.id == slot.itemID }),
               let image = store.displayImage(for: item) {
                Image(uiImage: image).resizable().scaledToFit().padding(10)
                    .id(slot.itemID)
                    .transition(.opacity)
            } else {
                Image(systemName: slot.needsReplacement ? "arrow.triangle.2.circlepath" : "plus")
                    .font(.title3).foregroundStyle(.tertiary)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: slot.itemID)
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
