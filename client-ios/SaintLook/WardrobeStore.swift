import Foundation
import Combine
import UIKit

@MainActor
final class WardrobeStore: ObservableObject {
    @Published private(set) var items: [WardrobeItem] = []
    @Published private(set) var settings = ConnectionSettings(baseURL: "http://127.0.0.1:8787", token: "")
    @Published var notice: String?
    @Published private(set) var storageAvailable = false

    private var directory: URL?
    private var tasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]

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
        settings = newSettings
        resumePendingItems()
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
            start(item.id, submitting: true)
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
        for item in items where item.status == .pending {
            start(item.id, submitting: !item.uploadStarted)
        }
    }

    func stopObserving() {
        for entry in tasks.values { entry.task.cancel() }
        tasks.removeAll()
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

    private func start(_ id: UUID, submitting: Bool) {
        guard tasks[id] == nil else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.process(id, submitting: submitting)
            if self.tasks[id]?.generation == generation { self.tasks[id] = nil }
        }
        tasks[id] = (generation, task)
    }

    private func process(_ id: UUID, submitting: Bool) async {
        guard var item = items.first(where: { $0.id == id }), let directory else { return }
        do {
            let client = BackendClient(settings: settings)
            _ = try settings.validatedURL()
            let response: ItemResponse
            if submitting {
                // Persist that the request may reach the server before performing network I/O.
                item.uploadStarted = true
                item.errorMessage = nil
                try replace(item)
                let photo = try Data(contentsOf: directory.appendingPathComponent(item.directoryName).appendingPathComponent("upload.png"))
                response = try await client.submit(item, photo: photo)
            } else {
                response = try await client.status(item)
            }
            var current = response
            for _ in 0..<120 {
                try Task.checkCancellation()
                if current.status == .failed {
                    item.status = .failed
                    item.errorMessage = "Обработка не удалась. Исходное фото сохранено."
                    try replace(item)
                    return
                }
                if current.status == .ready {
                    guard let type = current.type, !type.isEmpty, !current.colors.isEmpty else {
                        throw ClientError.invalidResponse
                    }
                    let imageData = try await client.result(item, response: current)
                    guard imageData.count <= 10 * 1024 * 1024, UIImage(data: imageData) != nil else {
                        throw ClientError.invalidResponse
                    }
                    try Task.checkCancellation()
                    try imageData.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent("result.png"), options: .atomic)
                    item.type = type
                    item.colors = current.colors
                    item.status = .ready
                    item.errorMessage = nil
                    try replace(item)
                    return
                }
                try await Task.sleep(nanoseconds: 500_000_000)
                current = try await client.status(item)
            }
            item.errorMessage = "Обработка ещё идёт. Проверьте результат при следующем открытии приложения."
            try replace(item)
        } catch {
            guard !Task.isCancelled else { return }
            item.errorMessage = (error as? ClientError)?.localizedDescription
                ?? "Не удалось связаться с backend. Фото сохранено на устройстве."
            #if DEBUG
            if ProcessInfo.processInfo.environment["SAINT_LOOK_UI_TESTING"] == "1" {
                let diagnostic = error as NSError
                item.errorMessage = (item.errorMessage ?? "") + " [DEBUG-ingestion: \(diagnostic.domain) \(diagnostic.code)]"
            }
            #endif
            do { try replace(item) }
            catch { notice = "Не удалось сохранить состояние карточки. Исходное фото сохранено." }
        }
    }
}
