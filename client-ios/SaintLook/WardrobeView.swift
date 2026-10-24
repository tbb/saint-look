import PhotosUI
import SwiftUI
import UIKit

@MainActor
struct WardrobeView: View {
    @ObservedObject var store: WardrobeStore
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showSettings = false
    @State private var importing = false
    @State private var editingItem: WardrobeItem?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if store.backendMode == .demo {
                        Text("Тестовый режим: вырезка и признаки демонстрационные, AI не вызывается.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("demo-notice")
                    } else {
                        Text("Результат обработки сохранится на устройстве.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Text("Всего: \(store.items.count). Готово: \(store.items.filter { $0.status == .ready }.count). Ожидают: \(store.items.filter { $0.status == .pending }.count).")
                        .font(.footnote)
                        .accessibilityIdentifier("wardrobe-summary")
                    Text("Одна вещь на фото, не на человеке. Пара обуви — одна вещь; пиджак и брюки добавляйте отдельно.")
                        .font(.footnote)
                    if !store.isConnected {
                        Button("Подключить локальный backend") { showSettings = true }
                    }
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Добавить фото", systemImage: "plus")
                    }
                    .accessibilityIdentifier("add-photo")
                    .disabled(importing || !store.storageAvailable)
                    #if DEBUG
                    Button("Добавить тестовое фото") { store.addPhoto(PhotoData.demoPhoto()) }
                        .accessibilityIdentifier("add-demo-photo")
                        .disabled(!store.storageAvailable)
                    #endif
                    if importing { ProgressView("Сохраняем фото…") }
                }
                if let notice = store.notice {
                    Section {
                        Text(notice).foregroundStyle(.red)
                        Button("Понятно") { store.notice = nil }
                    }
                }
                if store.items.isEmpty {
                    ContentUnavailableView("Гардероб пока пуст", systemImage: "tshirt", description: Text("Добавьте фотографию своей вещи."))
                }
                ForEach(store.items) { item in
                    Section {
                        ItemCard(item: item, image: store.displayImage(for: item))
                        Button("Изменить тип и цвета") { editingItem = item }
                            .accessibilityIdentifier("edit-item")
                            .disabled(!store.storageAvailable)
                        ItemRecoveryActions(store: store, item: item)
                        Button("Удалить вещь", role: .destructive) { store.deleteItem(item.id) }
                            .buttonStyle(.borderless)
                            .accessibilityIdentifier("delete-item")
                            .disabled(!store.storageAvailable)
                    }
                }
            }
            .navigationTitle("Saint Look")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Настройки", systemImage: "gearshape") { showSettings = true }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView(store: store) }
            .sheet(item: $editingItem) { item in ItemEditView(store: store, item: item) }
            .onChange(of: selectedPhoto) { _, photo in
                guard let photo else { return }
                importing = true
                Task {
                    defer { importing = false; selectedPhoto = nil }
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else {
                            throw ClientError.invalidPhoto
                        }
                        store.addPhoto(data)
                    } catch {
                        store.notice = "Не удалось получить фотографию. Выберите снимок ещё раз."
                    }
                }
            }
        }
    }
}

private struct ItemCard: View {
    let item: WardrobeItem
    let image: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 220)
                    .accessibilityLabel("Фотография вещи")
                    .accessibilityIdentifier("item-photo")
            }
            switch item.status {
            case .pending:
                Text(item.uploadStarted ? "Обработка" : "Ожидает отправки")
                    .accessibilityIdentifier("pending-status")
            case .ready:
                Text(item.mode == .demo ? "Готово · тестовый результат" : "Готово")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ready-status")
            case .failed:
                Text("Не удалось обработать")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("failed-status")
            }
            if item.status != .ready, item.resultFilename != nil {
                Text(item.resultMode == .demo
                    ? "Пока показана предыдущая тестовая вырезка. Новая ещё не готова."
                    : "Пока показана предыдущая вырезка. Новая ещё не готова.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("previous-result-notice")
            }
            if let type = item.displayedType { Text(type).font(.headline) }
            if !item.displayedColors.isEmpty { Text(item.displayedColors.joined(separator: ", ")) }
            if let error = item.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("item-error")
            }
        }
        .padding(.vertical, 6)
    }
}

@MainActor
private struct ItemRecoveryActions: View {
    @ObservedObject var store: WardrobeStore
    let item: WardrobeItem
    @State private var showingOptions = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var importing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if item.status == .ready && !showingOptions {
                Button("Проблема с вырезкой") { showingOptions = true }
                    .accessibilityIdentifier("cutout-problem")
            } else {
                if ProcessingFailure.needsAnotherPhoto(item.errorCode) {
                    Text("Замените снимок: на фото должна быть одна вещь вне человека.")
                        .font(.footnote)
                        .accessibilityIdentifier("replace-photo-hint")
                } else if item.status != .pending {
                    Button("Повторить обработку") { store.retryProcessing(item.id) }
                        .accessibilityIdentifier("retry-processing")
                }
                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    Label("Заменить фото", systemImage: "photo")
                }
                .accessibilityIdentifier("replace-photo")
                #if DEBUG
                Button("Заменить тестовым фото") {
                    store.replacePhoto(item.id, with: PhotoData.demoPhoto(replacement: true))
                }
                .accessibilityIdentifier("replace-demo-photo")
                #endif
                if importing { ProgressView("Сохраняем фото…") }
            }
        }
        // These controls share one List row. Automatic row buttons can trigger each other,
        // including presenting PhotosPicker when the user taps retry or the debug photo.
        .buttonStyle(.borderless)
        .disabled(importing || !store.storageAvailable)
        .onChange(of: item.operationID) { _, _ in showingOptions = false }
        .onChange(of: selectedPhoto) { _, photo in
            guard let photo else { return }
            importing = true
            Task {
                defer { importing = false; selectedPhoto = nil }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self) else {
                        throw ClientError.invalidPhoto
                    }
                    store.replacePhoto(item.id, with: data)
                } catch {
                    store.notice = "Не удалось получить новое фото. Предыдущая карточка сохранена."
                }
            }
        }
    }
}

@MainActor
private struct ItemEditView: View {
    @ObservedObject var store: WardrobeStore
    let item: WardrobeItem
    @Environment(\.dismiss) private var dismiss
    @State private var type: String
    @State private var colors: String
    @State private var error: String?

    init(store: WardrobeStore, item: WardrobeItem) {
        self.store = store
        self.item = item
        _type = State(initialValue: item.displayedType ?? "")
        _colors = State(initialValue: item.displayedColors.joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Тип вещи", text: $type)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("edit-type")
                    TextField("Цвета через запятую", text: $colors)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("edit-colors")
                } footer: {
                    Text("Правки сохраняются на устройстве без интернета. Повторная обработка фото не нужна.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Тип и цвета")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") { save() }
                        .accessibilityIdentifier("save-item-edits")
                }
            }
        }
    }

    private func save() {
        let editedType = type.trimmingCharacters(in: .whitespacesAndNewlines)
        let editedColors = colors.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
        // An untouched field must remain automatic, even if a result arrived with the editor open.
        let changedType = type != (item.displayedType ?? "")
        let changedColors = colors != item.displayedColors.joined(separator: ", ")
        guard !changedType || !editedType.isEmpty else {
            error = "Укажите тип вещи или отмените изменение."
            return
        }
        guard !changedColors || !editedColors.isEmpty else {
            error = "Укажите хотя бы один цвет или отмените изменение."
            return
        }
        do {
            try store.saveEdits(for: item.id, type: changedType ? editedType : nil, colors: changedColors ? editedColors : nil)
            dismiss()
        } catch {
            self.error = "Не удалось сохранить правки на устройстве. Попробуйте ещё раз."
        }
    }
}

@MainActor
private struct SettingsView: View {
    @ObservedObject var store: WardrobeStore
    @Environment(\.dismiss) private var dismiss
    @State private var baseURL = ""
    @State private var token = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Локальный dev-backend") {
                    TextField("Адрес backend", text: $baseURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Токен владельца", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Токен доступа к вашему backend сохраняется в Keychain. Ключи AI-провайдеров здесь не нужны.")
                        .font(.footnote)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Подключение")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") {
                        do {
                            try store.saveSettings(ConnectionSettings(baseURL: baseURL, token: token))
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                }
            }
            .onAppear { baseURL = store.settings.baseURL; token = store.settings.token }
        }
    }
}
