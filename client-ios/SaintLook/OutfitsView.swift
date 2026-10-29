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
                if !store.storageAvailable {
                    ContentUnavailableView {
                        Label {
                            Text("Луки недоступны").accessibilityIdentifier("outfits-unavailable")
                        } icon: { Image(systemName: "exclamationmark.triangle") }
                    } description: {
                        Text("Не удалось прочитать данные на устройстве. Попробуйте открыть приложение снова.")
                    }
                } else if store.outfits.isEmpty {
                    ContentUnavailableView {
                        Label("Пока нет луков", systemImage: "square.grid.2x2")
                    } description: {
                        Text(eligibleCount < 2
                             ? "Для сохранения лука нужны хотя бы две полностью подготовленные вещи."
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
            .safeAreaInset(edge: .top, spacing: 0) { AppNoticeView(store: store) }
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.storageAvailable && !store.outfits.isEmpty && eligibleCount < 2 {
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
                    if store.storageAvailable {
                        Button("Создать", systemImage: "plus") { creating = true }
                            .accessibilityIdentifier("create-outfit")
                    }
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
                .safeAreaInset(edge: .top, spacing: 0) { AppNoticeView(store: store) }
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
        // A collection card shows each item once. A file that cannot be decoded still
        // needs its photo fallback, just like a missing illustration.
        let illustratedSlotIDs = Set(visibleSlots.filter { slot in
            guard let item = store.items.first(where: { $0.id == slot.itemID }),
                  let url = store.illustrationURL(for: item) else { return false }
            return UIImage(contentsOfFile: url.path) != nil
        }.map(\.id))
        let showsCanvas = !compact || !illustratedSlotIDs.isEmpty
        let photoSlots = compact ? visibleSlots.filter { !illustratedSlotIDs.contains($0.id) } : visibleSlots
        VStack(spacing: compact ? 12 : 24) {
            if showsCanvas {
                FittingRoomCanvas(store: store, outfit: outfit)
                    .frame(maxWidth: compact ? 300 : 460)
            }
            if showsCanvas && photoSlots.contains(where: { slot in
                guard let item = store.items.first(where: { $0.id == slot.itemID }) else { return false }
                return compact || store.illustrationURL(for: item) == nil
            }) {
                Text("Фото вещей без иллюстраций — ниже")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(photoSlots) { slot in
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
                            if let message = item.illustrationStatusMessage {
                                Text(message).font(.footnote).foregroundStyle(.secondary)
                            }
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
    @State private var activeSlotID: UUID?
    @State private var activeBodySlotID: UUID?
    @State private var pinnedSlotIDs: Set<UUID> = []
    @State private var compositionHistory = OutfitCompositionHistory()
    @State private var recommendation = OutfitRecommendationSession()
    @State private var recommendationTask: Task<Void, Never>?
    @State private var recommendationSlotID: UUID?
    @State private var recommendationMessage: String?

    @State private var actionMessage: String?
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

    private var activeSlot: OutfitSlot? { draft.slots.first { $0.id == activeSlotID } ?? draft.slots.first { $0.zone == .body } }
    private var dirty: Bool { draft != initial }
    private var editingExisting: Bool { store.outfits.contains { $0.id == draft.id } }

    var body: some View {
        NavigationStack { editorObservedContent }
    }

    private var editorObservedContent: some View {
        editorDraftObservation
            .onDisappear { cancelRecommendation() }
            .onChange(of: connectionIdentity) { _, _ in cancelRecommendation() }
            .onChange(of: store.preparationConfiguration?.encoder.activeSpaceID) { _, _ in
                cancelRecommendation(message: RecommendationError.preparationRequired.localizedDescription)
            }
            .onChange(of: currentItemIDs) { old, current in
                removeDeletedItems(previous: old, current: current)
            }
    }

    private var editorDraftObservation: some View {
        editorPresentation
            .onChange(of: draft) { _, _ in
                if recommendation.pending != nil { cancelRecommendation(message: RecommendationError.stale.localizedDescription) }
            }
            .onChange(of: pinnedSlotIDs) { _, _ in cancelRecommendation(message: RecommendationError.stale.localizedDescription) }
            .onChange(of: currentInventory) { _, _ in cancelRecommendation(message: RecommendationError.stale.localizedDescription) }
            .onChange(of: store.outfits) { _, _ in cancelRecommendation(message: RecommendationError.stale.localizedDescription) }
    }

    private var currentItemIDs: [UUID] { store.items.map(\.id) }
    private var currentInventory: [OutfitRecommendationSession.ItemIdentity] { OutfitRecommendationSession.inventory(store.items) }
    private var connectionIdentity: [String] { [store.settings.baseURL, store.settings.token] }

    private var editorPresentation: some View {
        editorLayout
            .interactiveDismissDisabled(dirty)
            .alert("Отбросить изменения?", isPresented: $confirmingDiscard) { discardActions }
            .sheet(item: $choosingSlot) { slot in editorPicker(for: slot) }
    }

    private var editorLayout: some View {
        ScrollView { editorSections }
            .background(SaintLookStyle.canvas)
            .safeAreaInset(edge: .top, spacing: 0) { saveErrorFeedback }
            .navigationTitle(editingExisting ? "Изменить лук" : "Собрать лук")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { editorToolbar }
    }

    private var editorSections: some View {
        VStack(alignment: .leading, spacing: 16) {
            saveExplanationFeedback
            fittingPreview
            nameField
            swipeInstruction
            ForEach(draft.slots) { slot in editorSlotRow(slot) }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var saveExplanationFeedback: some View {
        if errorMessage == nil, let message = saveExplanation {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("outfit-save-explanation")
        }
    }

    private var nameBinding: Binding<String> {
        Binding<String>(get: { draft.name }, set: { value in
            cancelRecommendation()
            draft.name = value
        })
    }

    private var nameField: some View {
        TextField("Название — необязательно", text: nameBinding)
            .focused($naming)
            .submitLabel(.done)
            .onSubmit { naming = false }
            .padding(.vertical, 12)
            .accessibilityIdentifier("outfit-name")
    }

    @ViewBuilder
    private var swipeInstruction: some View {
        if !swipeDiscovered {
            Label("Смахните вещь влево или вправо, чтобы сравнить варианты", systemImage: "hand.draw")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var saveErrorFeedback: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.footnote)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
                .accessibilityIdentifier("outfit-save-error")
        }
    }

    @ViewBuilder
    private var discardActions: some View {
        Button("Отбросить изменения", role: .destructive) { cancelRecommendation(); dismiss() }
            .accessibilityIdentifier("discard-outfit-changes")
        Button("Остаться", role: .cancel) { }
            .accessibilityLabel("Продолжить редактирование")
            .accessibilityIdentifier("continue-outfit-editing")
    }

    private func editorPicker(for slot: OutfitSlot) -> OutfitPickerView {
        let excluded: Set<UUID> = draft.selectedIDs.subtracting(slot.itemID.map { [$0] } ?? [])
        return OutfitPickerView(store: store, zone: slot.zone, selectedItemID: slot.itemID, excluding: excluded) { itemID in
            select(itemID, for: slot.id)
            choosingSlot = nil
        }
    }

    private func removeDeletedItems(previous: [UUID], current: [UUID]) {
        for id in Set(previous).subtracting(current) {
            draft = draft.removingItem(id)
            initial = initial.removingItem(id)
        }
    }

    private var lastBodySlotID: UUID? { draft.slots.last(where: { $0.zone == .body })?.id }

    @ViewBuilder
    private func editorSlotRow(_ slot: OutfitSlot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                Text(outfitSlotTitle(slot, in: draft))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                pinButton(slot)
                slotMenu(slot)
            }
            slotSelection(slot)
            recommendationFeedback(for: slot.id)
            if slot.id == lastBodySlotID {
                Button("Добавить слой", systemImage: "plus") { addBodyLayer() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("add-body-layer")
            }
        }
        if slot.id != draft.slots.last?.id { Divider() }
    }

    @ViewBuilder
    private func recommendationFeedback(for slotID: UUID) -> some View {
        if recommendationSlotID == slotID {
            if recommendation.pending != nil {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { recommendationProgress }
                    VStack(alignment: .leading, spacing: 8) { recommendationProgress }
                }
            }
            if let recommendationMessage {
                Text(recommendationMessage).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("recommendation-message")
            }
        }
    }

    @ViewBuilder
    private var compositionActions: some View {
        Button("Перемешать", systemImage: "shuffle", action: shuffle)
            .frame(minHeight: 44)
            .accessibilityIdentifier("fitting-shuffle")
        Button("Отменить", systemImage: "arrow.uturn.backward", action: undoComposition)
            .frame(minHeight: 44)
            .disabled(!compositionHistory.canUndo)
            .accessibilityLabel("Отменить изменение состава")
            .accessibilityIdentifier("fitting-undo")
    }

    private var fittingPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { compositionActions }
                VStack(alignment: .leading, spacing: 8) { compositionActions }
            }
            if let actionMessage {
                Text(actionMessage).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("fitting-action-message")
            }
            FittingRoomCanvas(store: store, outfit: draft)
                .frame(maxWidth: 460)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    guard let slot = activeSlot,
                          abs(value.translation.width) > 40,
                          abs(value.translation.width) > abs(value.translation.height) * 1.3 else { return }
                    cycle(slot.id, forward: value.translation.width < 0)
                })
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: 8) {
                ForEach(OutfitZone.allCases, id: \.rawValue) { zone in
                    Button {
                        if zone == .body, let remembered = activeBodySlotID,
                           draft.slots.contains(where: { $0.id == remembered }) {
                            activeSlotID = remembered
                        } else {
                            activeSlotID = draft.slots.first { $0.zone == zone }?.id
                        }
                    } label: {
                        HStack {
                            Text(zone.title)
                            if activeSlot?.zone == zone { Image(systemName: "checkmark") }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .tint(activeSlot?.zone == zone ? SaintLookStyle.accent : .secondary)
                    .accessibilityAddTraits(activeSlot?.zone == zone ? .isSelected : [])
                    .accessibilityIdentifier("fitting-zone-\(zone.rawValue)")
                }
            }
            if activeSlot?.zone == .body {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: 8) {
                    ForEach(draft.slots.filter { $0.zone == .body }) { layer in
                        Button { activate(layer) } label: {
                            HStack {
                                Text(outfitSlotTitle(layer, in: draft))
                                if activeSlot?.id == layer.id { Image(systemName: "checkmark") }
                            }.frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityAddTraits(activeSlot?.id == layer.id ? .isSelected : [])
                        .accessibilityIdentifier("fitting-layer-\(layer.id)")
                    }
                    Button("Добавить слой", systemImage: "plus", action: addBodyLayer)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("fitting-add-layer")
                }
                Text("Слои идут изнутри наружу. Свайп меняет только выбранный слой.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let slot = activeSlot {
                if pinnedSlotIDs.contains(slot.id) {
                    Label("Закреплено при подборе", systemImage: "pin.fill")
                        .font(.footnote).foregroundStyle(SaintLookStyle.accent)
                }
                HStack {
                    Button { cycle(slot.id, forward: false) } label: {
                        Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Предыдущая вещь: \(outfitSlotTitle(slot, in: draft))")
                    .disabled(!canCycle(slot))
                    Button { choosingSlot = slot } label: {
                        VStack(spacing: 4) {
                            Text(outfitSlotTitle(slot, in: draft)).font(.subheadline)
                            Text(itemLabel(slot)).font(.headline)
                        }.frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .accessibilityIdentifier("fitting-choose-active")
                    Button { cycle(slot.id, forward: true) } label: {
                        Image(systemName: "chevron.right").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Следующая вещь: \(outfitSlotTitle(slot, in: draft))")
                    .disabled(!canCycle(slot))
                }
                if candidates(for: slot).count < 2 {
                    Text(candidates(for: slot).isEmpty ? "Нет доступных вещей для этой зоны." : "В этой зоне один вариант. Его можно выбрать нажатием.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if draft.selectedIDs.isEmpty {
                Text("Выберите вещи по зонам. Иллюстрации появятся на манекене; фотографии доступны ниже.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("fitting-empty-preview")
            } else if draft.slots.contains(where: { slot in
                guard let item = store.items.first(where: { $0.id == slot.itemID }) else { return false }
                return store.illustrationURL(for: item) == nil
            }) {
                Text("Не для всех вещей готова иллюстрация. Их фотографии показаны в составе ниже, а не на манекене.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("fitting-missing-illustration")
            }
        }
    }

    private func pinButton(_ slot: OutfitSlot) -> some View {
        let pinned = pinnedSlotIDs.contains(slot.id)
        return Button {
            cancelRecommendation()
            if pinned { pinnedSlotIDs.remove(slot.id) } else { pinnedSlotIDs.insert(slot.id) }
            actionMessage = nil
        } label: {
            Image(systemName: pinned ? "pin.fill" : "pin")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("\(pinned ? "Открепить" : "Закрепить"): \(outfitSlotTitle(slot, in: draft))")
        .accessibilityAddTraits(pinned ? .isSelected : [])
        .accessibilityIdentifier("pin-slot-\(slot.id)")
    }

    private func shuffle() {
        cancelRecommendation()
        guard draft.slots.contains(where: { !pinnedSlotIDs.contains($0.id) }) else {
            actionMessage = "Все зоны закреплены. Открепите одну, чтобы перемешать."
            return
        }
        let previous = draft
        let pools = Dictionary(uniqueKeysWithValues: OutfitZone.allCases.map {
            ($0, store.outfitCandidates(for: $0, excluding: []).map(\.id))
        })
        draft.shuffle(pinnedSlotIDs: pinnedSlotIDs, candidates: pools)
        compositionHistory.recordChange(from: previous, to: draft)
        actionMessage = previous.slots == draft.slots ? "Для незакреплённых зон нет других доступных вариантов." : nil
        errorMessage = nil
    }

    private func undoComposition() {
        cancelRecommendation()
        compositionHistory.undo(in: &draft, availableItemIDs: Set(store.items.map(\.id)))
        if !draft.slots.contains(where: { $0.id == activeSlotID }) {
            activeSlotID = draft.slots.first { $0.zone == .body }?.id
            activeBodySlotID = activeSlotID
        }
        actionMessage = nil
        errorMessage = nil
    }

    private func activate(_ slot: OutfitSlot) {
        activeSlotID = slot.id
        if slot.zone == .body { activeBodySlotID = slot.id }
    }

    private func addBodyLayer() {
        cancelRecommendation()
        let previous = draft
        let id = draft.addBodyLayer()
        compositionHistory.recordChange(from: previous, to: draft)
        activeSlotID = id
        activeBodySlotID = id
        errorMessage = nil
    }

    private func slotSelection(_ slot: OutfitSlot) -> some View {
        OutfitSlotContent(store: store, slot: slot)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            // A Button in a List can activate on release after a simultaneous drag.
            // TapGesture fails when the finger moves; the drag still coexists with scrolling.
            .onTapGesture { activate(slot); choosingSlot = slot }
            .simultaneousGesture(slotDrag(slot.id))
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { activate(slot); choosingSlot = slot }
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
            Button(slot.itemID == nil ? "Подобрать вещь" : "Другое сочетание", systemImage: "sparkle") {
                recommend(slot)
            }
            .disabled(pinnedSlotIDs.contains(slot.id) || recommendation.pending != nil)
            .accessibilityIdentifier("recommend-slot-\(slot.id)")
            if slot.itemID != nil {
                Button("Похожая замена", systemImage: "arrow.triangle.2.circlepath") {
                    recommend(slot, intent: .similar)
                }
                .disabled(pinnedSlotIDs.contains(slot.id) || recommendation.pending != nil)
                .accessibilityIdentifier("similar-slot-\(slot.id)")
            }
            if pinnedSlotIDs.contains(slot.id) { Text("Открепите это место для подбора") }
            Button("Выбрать вручную", systemImage: "square.grid.2x2") { choosingSlot = slot }
            Button("Следующая вещь", systemImage: "chevron.right") { cycle(slot.id, forward: true) }
                .disabled(!canCycle(slot))
                .accessibilityIdentifier("next-slot-\(slot.id)")
            Button("Предыдущая вещь", systemImage: "chevron.left") { cycle(slot.id, forward: false) }
                .disabled(!canCycle(slot))
                .accessibilityIdentifier("previous-slot-\(slot.id)")
            if slot.itemID != nil || slot.needsReplacement {
                Button("Очистить", systemImage: "xmark") { select(nil, for: slot.id) }
                    .accessibilityLabel("Очистить: \(outfitSlotTitle(slot, in: draft))")
                    .accessibilityIdentifier("clear-slot-\(slot.id)")
            }
            if slot.zone == .body {
                Button("Убрать слой", systemImage: "minus") {
                    cancelRecommendation()
                    let previous = draft
                    draft.removeBodyLayer(slot.id)
                    compositionHistory.recordChange(from: previous, to: draft)
                    if !draft.slots.contains(where: { $0.id == activeSlotID }) {
                        activeSlotID = draft.slots.first { $0.zone == .body }?.id
                        activeBodySlotID = activeSlotID
                    }
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
                cancelRecommendation()
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
        cancelRecommendation()
        guard let slot = draft.slots.first(where: { $0.id == slotID }) else { return }
        if let itemID, !candidates(for: slot).contains(where: { $0.id == itemID }) { return }
        let previous = draft
        draft.selectItem(itemID, for: slotID)
        compositionHistory.recordChange(from: previous, to: draft)
        actionMessage = nil
        errorMessage = nil
    }

    private func canCycle(_ slot: OutfitSlot) -> Bool {
        let available = candidates(for: slot)
        return available.contains { $0.id != slot.itemID }
    }

    private func candidates(for slot: OutfitSlot) -> [WardrobeItem] {
        let occupied = Set(draft.slots.filter { $0.id != slot.id }.compactMap(\.itemID))
        return store.outfitCandidates(for: slot.zone, excluding: occupied)
    }

    private func cycle(_ slotID: UUID, forward: Bool) {
        cancelRecommendation()
        guard let slot = draft.slots.first(where: { $0.id == slotID }) else { return }
        activate(slot)
        let previous = draft
        draft.cycleItem(for: slotID, among: candidates(for: slot).map(\.id), forward: forward)
        compositionHistory.recordChange(from: previous, to: draft)
        actionMessage = nil
        if draft.slots.first(where: { $0.id == slotID })?.itemID != slot.itemID { swipeDiscovered = true }
        errorMessage = nil
    }

    @ViewBuilder
    private var recommendationProgress: some View {
        ProgressView("Подбираем…")
            .accessibilityIdentifier("recommendation-pending")
        Button("Остановить подбор") { cancelRecommendation(message: "Подбор остановлен. Состав сохранён.") }
            .frame(minHeight: 44)
            .accessibilityIdentifier("cancel-recommendation")
    }

    private func cancelRecommendation(message: String? = nil) {
        let wasPending = recommendation.pending != nil
        recommendation.cancel()
        recommendationTask?.cancel()
        recommendationTask = nil
        recommendationMessage = wasPending ? (message ?? RecommendationError.stale.localizedDescription) : nil
    }

    private func recommend(_ slot: OutfitSlot, intent: RecommendationIntent = .complement) {
        cancelRecommendation()
        activate(slot)
        recommendationSlotID = slot.id
        recommendationMessage = nil
        let started = Date()
        do {
            let packets = try store.recommendationItems(excluding: intent == .complement ? slot.itemID : nil)
            let request = try recommendation.begin(draft: draft, targetSlotID: slot.id, intent: intent, pinnedSlotIDs: pinnedSlotIDs,
                items: store.items, preparedItems: packets, savedOutfit: store.outfits.first { $0.id == draft.id },
                activeSpaceID: store.preparationConfiguration?.encoder.activeSpaceID)
            let client = BackendClient(settings: store.settings)
            recommendationTask = Task { @MainActor in
                do {
                    let response = try await client.recommendSingle(request)
                    try Task.checkCancellation()
                    guard recommendation.pending?.request.requestId == request.requestId else { return }
                    let currentPackets = try store.recommendationItems(excluding: intent == .complement ? slot.itemID : nil)
                    let savedOutfit = store.outfits.first { $0.id == draft.id }
                    let message = try recommendation.apply(response, to: &draft, history: &compositionHistory,
                        pinnedSlotIDs: pinnedSlotIDs, items: store.items, preparedItems: currentPackets,
                        savedOutfit: savedOutfit, taxonomy: .shared)
                    recommendationMessage = response.mode == "controlled" ? "Тестовый подбор. " + message : message
                    recommendationTask = nil
                    #if DEBUG
                    print("single_recommendation_applied_ms=\(Int(Date().timeIntervalSince(started) * 1000)) outcome=\(response.outcome.rawValue)")
                    #endif
                } catch {
                    guard !Task.isCancelled,
                          recommendation.pending == nil || recommendation.pending?.request.requestId == request.requestId else { return }
                    recommendation.cancel()
                    recommendationTask = nil
                    recommendationMessage = RecommendationError.message(for: error)
                    await store.refreshPreparationConfiguration(after: error)
                }
            }
        } catch { recommendationMessage = RecommendationError.message(for: error) }
    }

    private func save() {
        cancelRecommendation()
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
        return "Нужны подготовленные вещи подходящего типа. Проверьте вещи в гардеробе; эту зону можно оставить пустой."
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
                        Text(store.illustrationURL(for: item) == nil ? "Фото · без иллюстрации" : "Иллюстрация на манекене")
                            .font(.footnote).foregroundStyle(.secondary)
                        if let status = item.illustrationStatusMessage {
                            Text(status).font(.footnote).foregroundStyle(.secondary)
                        }
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
