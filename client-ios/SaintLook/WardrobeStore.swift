import Foundation
import Combine
import UIKit

private struct WardrobeCatalog: Codable {
    let items: [WardrobeItem]
    let pendingDeletionIDs: Set<UUID>
}

@MainActor
final class WardrobeStore: ObservableObject {
    @Published private(set) var items: [WardrobeItem] = []
    @Published private(set) var settings = ConnectionSettings(baseURL: "http://127.0.0.1:8787", token: "")
    @Published private(set) var backendMode: ProcessingMode?
    @Published var notice: String?
    @Published private(set) var storageAvailable = false

    private var directory: URL?
    private var tasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
    private var pendingDeletionIDs: Set<UUID> = []
    private var deletionTasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
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
                let data = try Data(contentsOf: catalog)
                if let legacyItems = try? JSONDecoder().decode([WardrobeItem].self, from: data) {
                    items = legacyItems
                } else {
                    let saved = try JSONDecoder().decode(WardrobeCatalog.self, from: data)
                    items = saved.items
                    pendingDeletionIDs = saved.pendingDeletionIDs
                }
            }
            storageAvailable = true
            for id in pendingDeletionIDs {
                // Cleanup does not depend on valid credentials or a working connection.
                try? removeLocalFiles(for: id)
            }
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

    func saveEdits(for id: UUID, type: String?, colors: [String]?) throws {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        var updated = items
        if let type { updated[index].manualType = type }
        if let colors { updated[index].manualColors = colors }
        try persist(updated)
        items = updated
    }

    func deleteItem(_ id: UUID) {
        guard storageAvailable, items.contains(where: { $0.id == id }) else { return }
        let updated = items.filter { $0.id != id }
        var deletions = pendingDeletionIDs
        deletions.insert(id)
        do {
            // Hide only after both the removal and its delivery/cleanup intent are durable.
            try persist(updated, pendingDeletions: deletions)
            pendingDeletionIDs = deletions
            items = updated
            tasks[id]?.task.cancel()
            tasks[id] = nil
            try? removeLocalFiles(for: id)
            if observing { startDeletion(id) }
        } catch {
            notice = "Не удалось сохранить удаление. Вещь осталась в гардеробе."
        }
    }

    func retryProcessing(_ id: UUID) {
        beginAttempt(id, original: nil)
    }

    func replacePhoto(_ id: UUID, with original: Data) {
        beginAttempt(id, original: original)
    }

    private func beginAttempt(_ id: UUID, original: Data?) {
        guard let directory, storageAvailable,
              let index = items.firstIndex(where: { $0.id == id }) else { return }
        var item = items[index]
        guard original != nil || item.status != .pending else { return }
        guard item.revision < 9_007_199_254_740_991 else {
            notice = "Не удалось создать новую попытку обработки. Текущая карточка сохранена."
            return
        }
        do {
            if let original {
                let upload = try PhotoData.uploadCopy(of: original)
                item.photoVersionID = UUID()
                let version = item.photoVersionID.uuidString.lowercased()
                item.originalFilename = "photo-\(version).original"
                item.uploadFilename = "photo-\(version).png"
                let folder = directory.appendingPathComponent(item.directoryName)
                try original.write(to: folder.appendingPathComponent(item.originalFilename), options: .atomic)
                try upload.write(to: folder.appendingPathComponent(item.uploadFilename), options: .atomic)
                item.action = .replace
            } else {
                item.action = .retry
            }
            item.operationID = UUID()
            item.revision += 1
            item.status = .pending
            item.uploadStarted = false
            item.errorMessage = nil
            item.errorCode = nil
            var updated = items
            updated[index] = item
            try persist(updated)
            items = updated
            tasks[id]?.task.cancel()
            tasks[id] = nil
            if observing { start(id) }
        } catch {
            notice = (error as? ClientError)?.localizedDescription
                ?? "Не удалось сохранить новую попытку. Предыдущая карточка и фото сохранены."
        }
    }

    func displayImage(for item: WardrobeItem) -> UIImage? {
        guard let directory else { return nil }
        let filename = item.resultFilename ?? item.uploadFilename
        let path = directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename)
        return UIImage(contentsOfFile: path.path)
    }

    func resumePendingItems() {
        observing = true
        discoverMode()
        for id in pendingDeletionIDs { startDeletion(id) }
        for item in items where item.status == .pending { start(item.id) }
    }

    func stopObserving() {
        observing = false
        for entry in tasks.values { entry.task.cancel() }
        tasks.removeAll()
        for entry in deletionTasks.values { entry.task.cancel() }
        deletionTasks.removeAll()
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

    private func persist(_ updated: [WardrobeItem], pendingDeletions: Set<UUID>? = nil) throws {
        guard let directory, storageAvailable else { throw CocoaError(.fileWriteUnknown) }
        let catalog = WardrobeCatalog(items: updated, pendingDeletionIDs: pendingDeletions ?? pendingDeletionIDs)
        try JSONEncoder().encode(catalog).write(to: directory.appendingPathComponent("catalog.json"), options: .atomic)
    }

    private func removeLocalFiles(for id: UUID) throws {
        guard let directory else { throw CocoaError(.fileWriteUnknown) }
        let folder = directory.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
        do { try FileManager.default.removeItem(at: folder) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
    }

    private func startDeletion(_ id: UUID) {
        guard deletionTasks[id] == nil, pendingDeletionIDs.contains(id) else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.deliverDeletion(id)
            if self.deletionTasks[id]?.generation == generation { self.deletionTasks[id] = nil }
        }
        deletionTasks[id] = (generation, task)
    }

    private func deliverDeletion(_ id: UUID) async {
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled && pendingDeletionIDs.contains(id) {
            // Retry local cleanup even while offline; keep the intent if either side fails.
            try? removeLocalFiles(for: id)
            do {
                try await BackendClient(settings: settings).deleteItem(id)
                try Task.checkCancellation()
                guard pendingDeletionIDs.contains(id) else { return }
                try removeLocalFiles(for: id)
                // Network awaits allow other additions, edits and deletions. Merge into
                // current state; never save a catalog captured before the request.
                var remaining = pendingDeletionIDs
                remaining.remove(id)
                try persist(items, pendingDeletions: remaining)
                pendingDeletionIDs = remaining
                return
            } catch {
                guard !Task.isCancelled else { return }
                do { try await Task.sleep(nanoseconds: retrySeconds * 1_000_000_000) }
                catch { return }
                retrySeconds = min(retrySeconds * 2, 10)
            }
        }
    }

    private func replace(_ item: WardrobeItem) throws {
        guard let index = items.firstIndex(where: { $0.id == item.id }),
              items[index].operationID == item.operationID else { throw CancellationError() }
        var updated = items
        updated[index] = item
        // A response may have awaited the network while this thing was edited locally.
        // Processing updates never own manual values, including pending and failure updates.
        updated[index].manualType = items[index].manualType
        updated[index].manualColors = items[index].manualColors
        try persist(updated)
        items = updated
    }

    private func start(_ id: UUID) {
        guard tasks[id] == nil else { return }
        guard let operationID = items.first(where: { $0.id == id })?.operationID else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.process(id, operationID: operationID)
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
        guard isCurrent(item) else { throw CancellationError() }
        if !item.uploadStarted {
            item.uploadStarted = true
            try replace(item)
        }
        let photo = try Data(contentsOf: directory.appendingPathComponent(item.directoryName).appendingPathComponent(item.uploadFilename))
        return try await client.submit(item, photo: photo)
    }

    private func isCurrent(_ item: WardrobeItem) -> Bool {
        items.contains { $0.id == item.id && $0.operationID == item.operationID }
    }

    private func process(_ id: UUID, operationID: UUID) async {
        guard let directory else { return }
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled {
            guard var item = items.first(where: { $0.id == id }), item.operationID == operationID, item.status == .pending else { return }
            do {
                _ = try settings.validatedURL()
                let client = BackendClient(settings: settings)
                let current = try await response(for: &item, client: client, directory: directory)
                try Task.checkCancellation()
                guard isCurrent(item) else { return }
                let pendingChanged = item.mode != current.mode || item.errorMessage != nil
                backendMode = current.mode
                item.mode = current.mode
                if current.status == .failed {
                    item.status = .failed
                    item.errorCode = current.error
                    item.errorMessage = ProcessingFailure.message(for: current.error)
                    try replace(item)
                    return
                }
                if current.status == .ready {
                    guard let type = current.type, !type.isEmpty, !current.colors.isEmpty else { throw ClientError.invalidResponse }
                    let imageData = try await client.result(item, response: current)
                    guard imageData.count <= 10 * 1024 * 1024, UIImage(data: imageData) != nil else { throw ClientError.invalidResponse }
                    try Task.checkCancellation()
                    guard isCurrent(item) else { return }
                    let filename = "result-\(item.operationID.uuidString.lowercased()).png"
                    try imageData.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename), options: .atomic)
                    var completed = item
                    completed.resultFilename = filename
                    completed.resultMode = current.mode
                    completed.type = type
                    completed.colors = current.colors
                    completed.status = .ready
                    completed.errorMessage = nil
                    completed.errorCode = nil
                    try replace(completed)
                    return
                }
                item.errorMessage = nil
                if pendingChanged { try replace(item) }
                retrySeconds = 1
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                guard !Task.isCancelled, isCurrent(item) else { return }
                let retryable: Bool
                if let serverError = error as? ClientError {
                    switch serverError {
                    case .server(let status): retryable = status >= 500 || status == 408 || status == 429
                    default: retryable = false
                    }
                } else {
                    retryable = error is URLError
                }
                if !retryable { item.status = .failed }
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
