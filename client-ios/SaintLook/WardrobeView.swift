import PhotosUI
import SwiftUI
import UIKit

@MainActor
struct WardrobeView: View {
    @ObservedObject var store: WardrobeStore
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showSettings = false
    @State private var importing = false

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
                Text(item.type ?? "Вещь").font(.headline)
                Text(item.colors.joined(separator: ", "))
            case .failed:
                Text("Не удалось обработать")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("failed-status")
            }
            if let error = item.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("item-error")
            }
        }
        .padding(.vertical, 6)
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
