import Foundation
import Combine
import UIKit

@MainActor
final class WardrobeStore: ObservableObject {
    @Published private(set) var items: [WardrobeItem] = []
    @Published private(set) var settings = ConnectionSettings(baseURL: "http://127.0.0.1:8787", token: "")
    @Published private(set) var backendMode: ProcessingMode?
    @Published var notice: String?
    @Published private(set) var storageAvailable = false

    private var directory: URL?
    private var tasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
    private var modeTask: Task<Void, Never>?
    private var observing = false

    init() {
        do { settings = try ConnectionSettings.load() }
        catch { notice = error.localizedDescription }
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let root = support.appendingPathComponent("wardrobe", isDirectory: true)
            #if DEBUG
            let env = ProcessInfo.processInfo.environment
            if env["SAINT_LOOK_UI_TESTING"] == "1", env["SAINT_LOOK_RESET_DATA"] == "1",
               FileManager.default.fileExists(atPath: root.path) {
                try FileManager.default.removeItem(at: root)
            }
            #endif
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            directory = root
            let catalog = root.appendingPathComponent("catalog.json")
            if FileManager.default.fileExists(atPath: catalog.path) {
                items = try JSONDecoder().decode([WardrobeItem].self, from: Data(contentsOf: catalog))
            }
            storageAvailable = true
        } catch {
            notice = "Не удалось открыть локальный гардероб. Существующие данные сохранены."
        }
    }

    var isConnected: Bool { (try? settings.validatedURL()) != nil }

    func saveSettings(_ newSettings: ConnectionSettings) throws {
        try newSettings.save()
        let wasObserving = observing
        stopObserving()
        settings = newSettings
        backendMode = nil
        if wasObserving { resumePendingItems() }
    }

    func addPhoto(_ original: Data) {
        guard storageAvailable, let directory else { return }
        do {
            let upload = try PhotoData.uploadCopy(of: original)
            let item = WardrobeItem(id: UUID(), operationID: UUID(), photoVersionID: UUID())
            let itemDirectory = directory.appendingPathComponent(item.directoryName, isDirectory: true)
            try FileManager.default.createDirectory(at: itemDirectory, withIntermediateDirectories: true)
            try original.write(to: itemDirectory.appendingPathComponent("original.photo"), options: .atomic)
            try upload.write(to: itemDirectory.appendingPathComponent("upload.png"), options: .atomic)
            let updated = [item] + items
            try persist(updated)
            items = updated
            if observing { start(item.id) }
        } catch {
            notice = (error as? ClientError)?.localizedDescription ?? "Не удалось сохранить фото на устройстве. Загрузка не началась."
        }
    }

    func displayImage(for item: WardrobeItem) -> UIImage? {
        guard let directory else { return nil }
        let filename = item.status == .ready ? "result.png" : "upload.png"
        let path = directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename)
        return UIImage(contentsOfFile: path.path)
    }

    func resumePendingItems() {
        observing = true
        discoverMode()
        for item in items where item.status == .pending { start(item.id) }
    }

    func stopObserving() {
        observing = false
        for entry in tasks.values { entry.task.cancel() }
        tasks.removeAll()
        modeTask?.cancel()
        modeTask = nil
    }

    private func discoverMode() {
        guard modeTask == nil, backendMode == nil, isConnected else { return }
        let client = BackendClient(settings: settings)
        modeTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let mode = try await client.mode()
                    try Task.checkCancellation()
                    self?.backendMode = mode
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) }
                    catch { return }
                }
            }
        }
    }

    private func persist(_ updated: [WardrobeItem]) throws {
        guard let directory, storageAvailable else { throw CocoaError(.fileWriteUnknown) }
        try JSONEncoder().encode(updated).write(to: directory.appendingPathComponent("catalog.json"), options: .atomic)
    }

    private func replace(_ item: WardrobeItem) throws {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        var updated = items
        updated[index] = item
        try persist(updated)
        items = updated
    }

    private func start(_ id: UUID) {
        guard tasks[id] == nil else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.process(id)
            if self.tasks[id]?.generation == generation { self.tasks[id] = nil }
        }
        tasks[id] = (generation, task)
    }

    private func response(for item: inout WardrobeItem, client: BackendClient, directory: URL) async throws -> ItemResponse {
        if item.uploadStarted {
            do { return try await client.status(item) }
            catch ClientError.server(404) {
                // The previous POST may never have arrived. Reuse the same operation and photo.
            }
        }
        try Task.checkCancellation()
        if !item.uploadStarted {
            item.uploadStarted = true
            try replace(item)
        }
        let photo = try Data(contentsOf: directory.appendingPathComponent(item.directoryName).appendingPathComponent("upload.png"))
        return try await client.submit(item, photo: photo)
    }

    private func process(_ id: UUID) async {
        guard let directory else { return }
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled {
            guard var item = items.first(where: { $0.id == id }), item.status == .pending else { return }
            do {
                _ = try settings.validatedURL()
                let client = BackendClient(settings: settings)
                let current = try await response(for: &item, client: client, directory: directory)
                try Task.checkCancellation()
                let pendingChanged = item.mode != current.mode || item.errorMessage != nil
                backendMode = current.mode
                item.mode = current.mode
                if current.status == .failed {
                    item.status = .failed
                    item.errorMessage = ProcessingFailure.message(for: current.error)
                    try replace(item)
                    return
                }
                if current.status == .ready {
                    guard let type = current.type, !type.isEmpty, !current.colors.isEmpty else { throw ClientError.invalidResponse }
                    let imageData = try await client.result(item, response: current)
                    guard imageData.count <= 10 * 1024 * 1024, UIImage(data: imageData) != nil else { throw ClientError.invalidResponse }
                    try Task.checkCancellation()
                    try imageData.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent("result.png"), options: .atomic)
                    item.type = type
                    item.colors = current.colors
                    item.status = .ready
                    item.errorMessage = nil
                    try replace(item)
                    return
                }
                item.errorMessage = nil
                if pendingChanged { try replace(item) }
                retrySeconds = 1
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                guard !Task.isCancelled else { return }
                let retryable: Bool
                if let serverError = error as? ClientError {
                    switch serverError {
                    case .server(let status): retryable = status >= 500 || status == 408 || status == 429
                    default: retryable = false
                    }
                } else {
                    retryable = error is URLError
                }
                item.errorMessage = retryable
                    ? "Связи с сервером пока нет. Фото сохранено; отправка продолжится автоматически."
                    : (error as? ClientError)?.localizedDescription ?? "Не удалось сохранить результат. Исходное фото сохранено."
                do { try replace(item) }
                catch { notice = "Не удалось сохранить состояние карточки. Исходное фото сохранено."; return }
                guard retryable else { return }
                do { try await Task.sleep(nanoseconds: retrySeconds * 1_000_000_000) }
                catch { return }
                retrySeconds = min(retrySeconds * 2, 10)
            }
        }
    }
}
