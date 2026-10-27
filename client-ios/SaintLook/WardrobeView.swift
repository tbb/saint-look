import PhotosUI
import SwiftUI
import UIKit

@MainActor
struct WardrobeView: View {
    @ObservedObject var store: WardrobeStore
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showSettings = false
    @State private var importing = false
    #if DEBUG
    @State private var trialImported = false
    #endif

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    collectionStatus
                    #if DEBUG
                    testPhotoActions
                    #endif
                    if !store.storageAvailable {
                        ContentUnavailableView {
                            Label {
                                Text("Гардероб недоступен").accessibilityIdentifier("wardrobe-unavailable")
                            } icon: { Image(systemName: "exclamationmark.triangle") }
                        } description: {
                            Text("Не удалось прочитать данные на устройстве. Попробуйте открыть приложение снова.")
                        }
                        .padding(.vertical, 32)
                    } else if store.items.isEmpty {
                        ContentUnavailableView {
                            Label {
                                Text("Гардероб пока пуст").accessibilityIdentifier("wardrobe-empty")
                            } icon: { Image(systemName: "tshirt") }
                        } description: {
                            Text("Добавьте фото одной вещи, не на человеке. Пара обуви — одна вещь.")
                        } actions: {
                            photoPicker
                                .buttonStyle(.borderedProminent)
                        }
                        .padding(.vertical, 32)
                    } else {
                        LazyVGrid(columns: SaintLookStyle.columns(accessibilitySize: typeSize.isAccessibilitySize), spacing: 20) {
                            ForEach(store.items) { item in
                                NavigationLink(value: item.id) {
                                    WardrobeItemTile(item: item, image: store.displayImage(for: item))
                                }
                                .buttonStyle(.plain)
                                .accessibilityElement(children: .contain)
                                .accessibilityIdentifier("wardrobe-item-\(item.id)")
                                .accessibilityValue(item.status == .ready ? "Готово" : item.status == .pending ? "Обрабатывается" : "Ошибка обработки")
                            }
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: SaintLookStyle.contentWidth)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .top, spacing: 0) { AppNoticeView(store: store) }
            .background(SaintLookStyle.canvas)
            .navigationTitle("Гардероб")
            .navigationDestination(for: UUID.self) { id in ItemDetailView(store: store, itemID: id) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Настройки")
                        .accessibilityIdentifier("settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if store.storageAvailable && !store.items.isEmpty { photoPicker.labelStyle(.iconOnly) }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView(store: store) }
            .onChange(of: selectedPhoto) { _, photo in
                guard let photo else { return }
                importing = true
                Task {
                    defer { importing = false; selectedPhoto = nil }
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else { throw ClientError.invalidPhoto }
                        store.addPhoto(data)
                    } catch { store.notice = "Не удалось получить фотографию. Выберите снимок ещё раз." }
                }
            }
        }
    }

    private var photoPicker: some View {
        PhotosPicker(selection: $selectedPhoto, matching: .images) {
            Label("Добавить фото", systemImage: "plus")
        }
        .accessibilityIdentifier("add-photo")
        .disabled(importing || !store.storageAvailable)
    }

    private var collectionStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            let pending = store.items.filter { $0.status == .pending }.count
            let ready = store.items.filter { $0.status == .ready }.count
            if !store.items.isEmpty {
                Text(pending > 0 ? "\(itemCountTitle) · в обработке: \(pending)" : itemCountTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Всего: \(store.items.count). Готово: \(ready). Ожидают: \(pending).")
                    .accessibilityIdentifier("wardrobe-summary")
            }
            if store.backendMode == .demo {
                Text("Демо · обработка без AI")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("demo-notice")
            }
            if !store.isConnected {
                Button("Настроить обработку фото") { showSettings = true }
                    .font(.subheadline)
                    .accessibilityIdentifier("configure-processing")
            }
            if importing { ProgressView("Сохраняем фото…") }
        }
    }

    private var itemCountTitle: String {
        let count = store.items.count
        let suffix = (11...14).contains(count % 100) ? "вещей" : count % 10 == 1 ? "вещь" : (2...4).contains(count % 10) ? "вещи" : "вещей"
        return "\(count) \(suffix)"
    }

    #if DEBUG
    @ViewBuilder private var testPhotoActions: some View {
        if ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TESTING"] == "1" {
            if ProcessInfo.processInfo.environment["SAINT_LOOK_LIVE_TRIAL"] == "1" {
                Button("Добавить фото пробы") {
                    do {
                        let photo = try PhotoData.trialPhoto()
                        trialImported = true
                        store.addPhoto(photo)
                    } catch { store.notice = "Не удалось прочитать фото пробы." }
                }
                .accessibilityIdentifier("add-trial-photo")
                .disabled(trialImported || !store.storageAvailable)
            } else if ProcessInfo.processInfo.environment["SAINT_LOOK_VISUAL_SCENARIO"] == nil {
                Button("Добавить тестовое фото") { store.addPhoto(PhotoData.demoPhoto()) }
                    .accessibilityIdentifier("add-demo-photo")
                    .disabled(!store.storageAvailable)
            }
        }
    }
    #endif
}

private struct WardrobeItemTile: View {
    let item: WardrobeItem
    let image: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GarmentPhoto(image: image).aspectRatio(0.85, contentMode: .fit)
            if let type = item.displayedType {
                Text(type).font(.headline).accessibilityIdentifier("item-type")
            } else {
                Text("Новая вещь").font(.headline)
            }
            if !item.displayedColors.isEmpty {
                Text(item.displayedColors.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("item-colors")
            }
            ItemProcessingStatus(item: item, compact: true)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
    }
}

private struct ItemProcessingStatus: View {
    let item: WardrobeItem
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch item.status {
            case .pending:
                Text(item.uploadStarted ? "Обработка" : "Ожидает отправки")
                    .accessibilityIdentifier("pending-status")
            case .ready:
                if item.mode == .demo {
                    Text("Тестовая вырезка")
                        .accessibilityIdentifier("ready-status")
                }
            case .failed:
                Text("Не удалось обработать")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("failed-status")
            }
            if item.status != .ready, item.resultFilename != nil {
                Text(item.resultMode == .demo
                     ? "Пока показана предыдущая тестовая вырезка. Новая ещё не готова."
                     : "Пока показана предыдущая вырезка. Новая ещё не готова.")
                    .accessibilityIdentifier("previous-result-notice")
            }
            if let error = item.errorMessage {
                Text(error)
                    .lineLimit(compact ? 2 : nil)
                    .accessibilityIdentifier("item-error")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

@MainActor
private struct ItemDetailView: View {
    @ObservedObject var store: WardrobeStore
    let itemID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var editingItem: WardrobeItem?
    @State private var confirmingDeletion = false
    @State private var showingRecovery = false
    @State private var showingPhotoPicker = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var importing = false

    private var item: WardrobeItem? { store.items.first { $0.id == itemID } }

    var body: some View {
        Group {
            if let item {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        GarmentPhoto(image: store.displayImage(for: item))
                            .aspectRatio(1, contentMode: .fit)
                        if !item.displayedColors.isEmpty {
                            HStack(spacing: 6) {
                                ForEach(item.displayedColors, id: \.self) { WardrobeColorSwatch(label: $0, size: 16) }
                                Text(item.displayedColors.joined(separator: ", "))
                                    .font(.subheadline)
                                    .accessibilityIdentifier("item-colors")
                            }
                        }
                        Button { editingItem = item } label: {
                            Label("Изменить тип и цвета", systemImage: "slider.horizontal.3")
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("edit-item")
                        .disabled(!store.storageAvailable)
                        ItemProcessingStatus(item: item)
                        if item.status == .failed || showingRecovery { recovery(for: item) }
                        if importing { ProgressView("Сохраняем фото…") }
                    }
                    .padding(16)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .safeAreaInset(edge: .top, spacing: 0) { AppNoticeView(store: store) }
                .background(SaintLookStyle.canvas)
                .navigationTitle(item.displayedType ?? "Вещь")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { actions(for: item) }
                }
                .alert("Удалить вещь?", isPresented: $confirmingDeletion) {
                    Button("Удалить вещь", role: .destructive) {
                        store.deleteItem(itemID)
                        if self.item == nil { dismiss() }
                    }
                    .accessibilityIdentifier("confirm-delete-item")
                    Button("Отмена", role: .cancel) { }
                        .accessibilityIdentifier("cancel-delete-item")
                } message: {
                    Text("Вещь исчезнет из гардероба. В сохранённых луках её места останутся пустыми.")
                }
                .onChange(of: item.operationID) { _, _ in showingRecovery = false }
            }
        }
        .sheet(item: $editingItem) { ItemEditView(store: store, item: $0) }
        .photosPicker(isPresented: $showingPhotoPicker, selection: $selectedPhoto, matching: .images)
        .onChange(of: selectedPhoto) { _, photo in
            guard let photo else { return }
            importing = true
            Task {
                defer { importing = false; selectedPhoto = nil }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self) else { throw ClientError.invalidPhoto }
                    store.replacePhoto(itemID, with: data)
                } catch { store.notice = "Не удалось получить новое фото. Предыдущая карточка сохранена." }
            }
        }
    }

    private func actions(for item: WardrobeItem) -> some View {
        Menu {
            Button("Заменить фото", systemImage: "photo") { showingPhotoPicker = true }
                .accessibilityIdentifier("replace-photo")
            if item.status == .ready {
                Button("Проблема с вырезкой", systemImage: "questionmark.circle") { showingRecovery = true }
                    .accessibilityIdentifier("cutout-problem")
            }
            if item.status != .pending && !ProcessingFailure.needsAnotherPhoto(item.errorCode) {
                Button("Повторить обработку", systemImage: "arrow.clockwise") { store.retryProcessing(itemID) }
                    .accessibilityIdentifier("retry-processing")
            }
            #if DEBUG
            if ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TESTING"] == "1",
               ProcessInfo.processInfo.environment["SAINT_LOOK_VISUAL_SCENARIO"] == nil {
                Button("Заменить тестовым фото") { store.replacePhoto(itemID, with: PhotoData.demoPhoto(replacement: true)) }
                    .accessibilityIdentifier("replace-demo-photo")
            }
            #endif
            Divider()
            Button("Удалить вещь", systemImage: "trash", role: .destructive) { confirmingDeletion = true }
                .accessibilityIdentifier("delete-item")
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("Действия с вещью")
        .accessibilityIdentifier("item-actions")
        .disabled(importing || !store.storageAvailable)
    }

    @ViewBuilder private func recovery(for item: WardrobeItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if ProcessingFailure.needsAnotherPhoto(item.errorCode) {
                Text("Замените снимок: на фото должна быть одна вещь вне человека.")
                    .font(.footnote)
                    .accessibilityIdentifier("replace-photo-hint")
            } else if item.status != .pending {
                Button("Повторить обработку") { store.retryProcessing(itemID) }
                    .accessibilityIdentifier("retry-processing")
            }
            Button("Заменить фото") { showingPhotoPicker = true }
                .accessibilityIdentifier("replace-photo")
        }
        .disabled(importing || !store.storageAvailable)
    }
}

@MainActor
private struct ItemEditView: View {
    @ObservedObject var store: WardrobeStore
    let item: WardrobeItem
    @Environment(\.dismiss) private var dismiss
    @State private var type: String
    @State private var colors: [String]
    @State private var error: String?
    @State private var confirmingDiscard = false

    private var dirty: Bool {
        type != (item.displayedType ?? "") || Set(colors) != Set(item.displayedColors)
    }

    private var invalidColors: Bool {
        !paletteIsValid(colors, comparedTo: item.displayedColors)
    }

    init(store: WardrobeStore, item: WardrobeItem) {
        self.store = store
        self.item = item
        _type = State(initialValue: item.displayedType ?? "")
        _colors = State(initialValue: item.displayedColors)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    GarmentPhoto(image: store.displayImage(for: item), accessibilityIdentifier: "editing-item-photo")
                        .frame(height: 140)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                        .listRowBackground(Color.clear)
                }
                Section {
                    NavigationLink {
                        TypeSelectionView(selection: $type)
                    } label: {
                        LabeledContent("Тип вещи", value: type.isEmpty ? "Выбрать" : type)
                    }
                    .accessibilityIdentifier("choose-type")
                    NavigationLink {
                        ColorSelectionView(selection: $colors, originalSelection: item.displayedColors)
                    } label: {
                        LabeledContent("Цвета", value: colors.isEmpty ? "Выбрать" : colors.joined(separator: ", "))
                    }
                    .accessibilityIdentifier("choose-colors")
                } footer: {
                    Text("Правки сохраняются на устройстве без интернета. Повторная обработка фото не нужна.")
                }
                if invalidColors {
                    Text("Выберите от одного до пяти цветов, чтобы сохранить правки.")
                        .foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Тип и цвета")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        if dirty { confirmingDiscard = true } else { dismiss() }
                    } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("Отмена")
                    .accessibilityIdentifier("cancel-item-edits")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") { save() }
                        .accessibilityIdentifier("save-item-edits")
                        .disabled(invalidColors)
                }
            }
            .interactiveDismissDisabled(dirty)
            .alert("Отбросить изменения?", isPresented: $confirmingDiscard) {
                Button("Отбросить изменения", role: .destructive) { dismiss() }
                    .accessibilityIdentifier("discard-item-changes")
                Button("Остаться", role: .cancel) { }
                    .accessibilityLabel("Продолжить редактирование")
                    .accessibilityIdentifier("continue-item-editing")
            }
        }
    }

    private func save() {
        // Untouched fields stay automatic, including when a result arrives with the editor open.
        // Legacy labels are retained until the user explicitly replaces that field.
        let changedType = type != (item.displayedType ?? "")
        let changedColors = Set(colors) != Set(item.displayedColors)
        guard paletteIsValid(colors, comparedTo: item.displayedColors) else {
            error = "Выберите от одного до пяти цветов."
            return
        }
        do {
            try store.saveEdits(for: item.id, type: changedType ? type : nil, colors: changedColors ? colors : nil)
            dismiss()
        } catch {
            self.error = "Не удалось сохранить правки на устройстве. Попробуйте ещё раз."
        }
    }
}

private func paletteIsValid(_ selection: [String], comparedTo original: [String]) -> Bool {
    Set(selection) == Set(original) || WardrobeTaxonomy.shared.contains(colors: selection)
}

private struct TypeSelectionView: View {
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss

    private let groups: [(String, [String])] = [
        ("Верх", ["t_shirt", "polo", "shirt", "blouse", "top", "sweater", "cardigan", "sweatshirt", "hoodie", "vest", "blazer", "jacket", "coat", "raincoat"]),
        ("Низ", ["jeans", "trousers", "shorts", "skirt"]),
        ("Платья и комбинезоны", ["dress", "jumpsuit"]),
        ("Обувь", ["sneakers", "shoes", "boots", "sandals", "slippers"]),
        ("Аксессуары", ["bag", "headwear", "scarf", "belt", "gloves", "socks"]),
        ("Другое", ["underwear", "swimwear", "unknown"])
    ]

    var body: some View {
        List {
            ForEach(groups, id: \.0) { title, ids in
                Section(title) {
                    ForEach(WardrobeTaxonomy.shared.types.filter { ids.contains($0.id) }) { option in
                        Button {
                            selection = option.label
                            dismiss()
                        } label: {
                            HStack {
                                Text(option.label).foregroundStyle(.primary)
                                Spacer()
                                if selection == option.label { Image(systemName: "checkmark").fontWeight(.semibold) }
                            }
                            .frame(minHeight: 32)
                            .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("type-\(option.id)")
                        .accessibilityValue(selection == option.label ? "Выбран" : "Не выбран")
                    }
                }
            }
        }
        .navigationTitle("Тип вещи")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ColorSelectionView: View {
    @Binding var selection: [String]
    let originalSelection: [String]
    @Environment(\.dismiss) private var dismiss
    private let taxonomy = WardrobeTaxonomy.shared

    var body: some View {
        List {
            Section {
                ForEach(taxonomy.colors) { option in
                    let selected = selection.contains(option.label)
                    Button {
                        // Selecting a new palette explicitly replaces any legacy free-form labels.
                        var labels = Set(selection.filter { label in taxonomy.colors.contains { $0.label == label } })
                        if selected { labels.remove(option.label) } else { labels.insert(option.label) }
                        selection = taxonomy.colors.filter { labels.contains($0.label) }.map(\.label)
                    } label: {
                        HStack(spacing: 12) {
                            WardrobeColorSwatch(label: option.label)
                            Text(option.label).foregroundStyle(.primary)
                            Spacer()
                            if selected { Image(systemName: "checkmark") }
                        }
                    }
                    .accessibilityIdentifier("color-\(option.id)")
                    .accessibilityValue(selected ? "Выбран" : "Не выбран")
                    .disabled(!selected && canonicalSelectionCount >= 5)
                }
            } header: {
                Text("Выберите от 1 до 5 цветов")
            } footer: {
                if selection.contains(where: { label in !taxonomy.colors.contains { $0.label == label } }) {
                    Text("Сохранённые цвета: \(selection.joined(separator: ", ")). Новый выбор заменит их цветами из списка.")
                }
            }
        }
        .navigationTitle("Цвета")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Text(invalidSelection ? "Выберите хотя бы один цвет." : "Готово применит выбор к черновику вещи.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(.bar)
                .accessibilityIdentifier("color-selection-requirement")
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Готово") { dismiss() }
                    .accessibilityIdentifier("done-colors")
                    .disabled(invalidSelection)
            }
        }
    }

    private var invalidSelection: Bool {
        !paletteIsValid(selection, comparedTo: originalSelection)
    }

    private var canonicalSelectionCount: Int {
        taxonomy.colors.filter { selection.contains($0.label) }.count
    }
}

@MainActor
private struct SettingsView: View {
    @ObservedObject var store: WardrobeStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(store.isConnected ? "Подключение настроено" : "Нужна настройка подключения",
                          systemImage: store.isConnected ? "checkmark.circle" : "network")
                        .accessibilityIdentifier("connection-status")
                    Text("Вещи и луки хранятся на этом устройстве. Интернет нужен для обработки новых фото.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if store.backendMode == .demo {
                        Text("Демонстрационный режим: вырезки и признаки тестовые, AI не вызывается.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    NavigationLink("Параметры подключения") { ConnectionSettingsView(store: store) }
                        .accessibilityIdentifier("connection-settings")
                } footer: {
                    Text("Настроенное подключение не означает, что сервер сейчас доступен.")
                }
            }
            .navigationTitle("Настройки")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Закрыть настройки")
                        .accessibilityIdentifier("close-settings")
                }
            }
        }
    }
}

@MainActor
private struct ConnectionSettingsView: View {
    @ObservedObject var store: WardrobeStore
    @Environment(\.dismiss) private var dismiss
    @State private var baseURL = ""
    @State private var token = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Адрес сервера", text: $baseURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityIdentifier("backend-url")
                SecureField("Токен владельца", text: $token)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("owner-token")
            } footer: {
                Text("Токен хранится в защищённом хранилище устройства. Ключи сервисов обработки фото здесь не нужны.")
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Подключение")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Сохранить") {
                    do {
                        try store.saveSettings(ConnectionSettings(baseURL: baseURL, token: token))
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }
                .accessibilityIdentifier("save-connection-settings")
            }
        }
        .onAppear { baseURL = store.settings.baseURL; token = store.settings.token }
    }
}
