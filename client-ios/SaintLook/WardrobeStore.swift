import Foundation
import Combine
import UIKit
import CryptoKit

@MainActor
final class WardrobeStore: ObservableObject {
    @Published private(set) var items: [WardrobeItem] = []
    @Published private(set) var outfits: [Outfit] = []
    @Published private(set) var settings = ConnectionSettings(baseURL: "http://127.0.0.1:8787", token: "")
    @Published private(set) var backendMode: ProcessingMode?
    @Published private(set) var illustrationAvailable: Bool?
    private var illustrationTasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
    @Published var notice: String?
    @Published private(set) var storageAvailable = false

    private var directory: URL?
    private var tasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
    private var pendingDeletionIDs: Set<UUID> = []
    private var deletionTasks: [UUID: (generation: UUID, task: Task<Void, Never>)] = [:]
    private var pendingAcknowledgements: Set<ResultAcknowledgement> = []
    private var acknowledgementTasks: [ResultAcknowledgement: (generation: UUID, task: Task<Void, Never>)] = [:]
    private var modeTask: Task<Void, Never>?
    private var observing = false

    init() {
        do { settings = try ConnectionSettings.load() }
        catch { notice = error.localizedDescription }
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            var root = support.appendingPathComponent("wardrobe", isDirectory: true)
            #if DEBUG
            let env = ProcessInfo.processInfo.environment
            if let visualRoot = try VisualFixtures.prepare(environment: env, support: support,
                                                           resources: Bundle.main.bundleURL, taxonomy: .shared) {
                root = visualRoot
            } else if env["SAINT_LOOK_UI_TESTING"] == "1", env["SAINT_LOOK_RESET_DATA"] == "1",
               FileManager.default.fileExists(atPath: root.path) {
                try FileManager.default.removeItem(at: root)
            }
            #endif
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            directory = root
            let saved = try WardrobeCatalogFile(directory: root).load()
            items = saved.items
            outfits = saved.outfits
            pendingDeletionIDs = saved.pendingDeletionIDs
            pendingAcknowledgements = saved.pendingAcknowledgements ?? []
            let needsAcknowledgementMigration = saved.pendingAcknowledgements == nil
            storageAvailable = true
            for id in pendingDeletionIDs {
                // Cleanup does not depend on valid credentials or a working connection.
                try? removeLocalFiles(for: id)
            }
            if needsAcknowledgementMigration {
                let acknowledgements = Set(items.compactMap { item -> ResultAcknowledgement? in
                    guard item.status == .ready, let filename = item.resultFilename,
                          UIImage(contentsOfFile: root.appendingPathComponent(item.directoryName).appendingPathComponent(filename).path) != nil else { return nil }
                    return ResultAcknowledgement(itemID: item.id, operationID: item.operationID)
                })
                // A legacy ready card is acknowledged only when its local image is usable,
                // and only after the inferred delivery intent itself has been saved.
                try persist(items, pendingAcknowledgements: acknowledgements)
                pendingAcknowledgements = acknowledgements
            }
        } catch {
            storageAvailable = false
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
        illustrationAvailable = nil
        if wasObserving { resumePendingItems() }
    }

    func addPhoto(_ original: Data) {
        guard storageAvailable, let directory else { return }
        do {
            let upload = try PhotoData.uploadCopy(of: original)
            var item = WardrobeItem(id: UUID(), operationID: UUID(), photoVersionID: UUID())
            item.automaticallyIllustrate = true
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
        if let type, !WardrobeTaxonomy.shared.contains(type: type) { throw ClientError.invalidAttributes }
        if let colors, !WardrobeTaxonomy.shared.contains(colors: colors) { throw ClientError.invalidAttributes }
        var updated = items
        if let type { updated[index].manualType = type }
        if let colors { updated[index].manualColors = colors }
        if updated[index].manualType != items[index].manualType || updated[index].manualColors != items[index].manualColors {
            if updated[index].illustration?.status == .pending {
                updated[index].illustration?.status = .failed
                updated[index].illustration?.error = "source_changed"
            }
        }
        try persist(updated)
        items = updated
    }

    func deleteItem(_ id: UUID) {
        guard storageAvailable, items.contains(where: { $0.id == id }) else { return }
        var updatedCatalog = catalog
        updatedCatalog.removeItem(id)
        let updated = updatedCatalog.items
        let deletions = updatedCatalog.pendingDeletionIDs
        let acknowledgements = updatedCatalog.pendingAcknowledgements ?? []
        do {
            // Hide only after both the removal and its delivery/cleanup intent are durable.
            try persist(updated, pendingDeletions: deletions, pendingAcknowledgements: acknowledgements, outfits: updatedCatalog.outfits)
            outfits = updatedCatalog.outfits
            pendingAcknowledgements = acknowledgements
            for acknowledgement in Array(acknowledgementTasks.keys) where acknowledgement.itemID == id {
                acknowledgementTasks[acknowledgement]?.task.cancel()
                acknowledgementTasks[acknowledgement] = nil
            }
            pendingDeletionIDs = deletions
            items = updated
            illustrationTasks[id]?.task.cancel()
            illustrationTasks[id] = nil
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
                let previousPhotoID = item.photoVersionID
                item.preparedPhotos.removeAll { $0.photoID == previousPhotoID }
                item.photoVersionID = UUID()
                item.sourceSetVersionID = UUID()
                item.automaticallyIllustrate = false
                if item.illustration?.status == .pending {
                    item.illustration?.status = .failed
                    item.illustration?.error = "source_changed"
                }
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
            let removedPrepared = items[index].preparedPhotos.filter { cached in !item.preparedPhotos.contains(where: { $0.filename == cached.filename }) }
            try persist(updated)
            items = updated
            for cached in removedPrepared {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(item.directoryName).appendingPathComponent(cached.filename))
            }
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

    private var catalog: WardrobeCatalog {
        WardrobeCatalog(items: items, pendingDeletionIDs: pendingDeletionIDs,
                        pendingAcknowledgements: pendingAcknowledgements, outfits: outfits)
    }

    func outfitCandidates(for zone: OutfitZone, excluding selectedIDs: Set<UUID>) -> [WardrobeItem] {
        items.filter {
            $0.status == .ready && $0.resultFilename != nil && !selectedIDs.contains($0.id)
                && zone.accepts($0, taxonomy: .shared) && displayImage(for: $0) != nil
        }.sorted { $0.id.uuidString < $1.id.uuidString }
    }

    func canSaveOutfit(_ draft: Outfit) -> Bool {
        (try? validatedCatalog(saving: draft)) != nil
    }

    func deleteOutfit(_ id: UUID) throws {
        var updated = catalog
        updated.removeOutfit(id)
        try persist(items, outfits: updated.outfits)
        outfits = updated.outfits
    }

    func saveOutfit(_ draft: Outfit) throws {
        let updated = try validatedCatalog(saving: draft)
        try persist(items, outfits: updated.outfits)
        outfits = updated.outfits
    }

    private func validatedCatalog(saving draft: Outfit) throws -> WardrobeCatalog {
        var updated = catalog
        let selectedIDs = draft.selectedIDs
        let cutouts = Set(items.filter {
            selectedIDs.contains($0.id) && $0.resultFilename != nil && displayImage(for: $0) != nil
        }.map(\.id))
        try updated.saveOutfit(draft, taxonomy: .shared, availableCutouts: cutouts)
        return updated
    }

    func resumePendingItems() {
        guard storageAvailable else { return }
        observing = true
        discoverMode()
        for id in pendingDeletionIDs { startDeletion(id) }
        for acknowledgement in pendingAcknowledgements { startAcknowledgement(acknowledgement) }
        for item in items where item.status == .pending { start(item.id) }
        for item in items where item.illustration?.status == .pending { startIllustration(item.id) }
    }

    func stopObserving() {
        observing = false
        for entry in tasks.values { entry.task.cancel() }
        tasks.removeAll()
        for entry in illustrationTasks.values { entry.task.cancel() }
        illustrationTasks.removeAll()
        for entry in deletionTasks.values { entry.task.cancel() }
        deletionTasks.removeAll()
        for entry in acknowledgementTasks.values { entry.task.cancel() }
        acknowledgementTasks.removeAll()
        modeTask?.cancel()
        modeTask = nil
    }

    private func discoverMode() {
        guard modeTask == nil, backendMode == nil, isConnected else { return }
        let client = BackendClient(settings: settings)
        modeTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let health = try await client.health()
                    try Task.checkCancellation()
                    self?.backendMode = health.mode
                    self?.illustrationAvailable = health.illustrationAvailable ?? false
                    self?.startNewItemIllustrations()
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) }
                    catch { return }
                }
            }
        }
    }

    private func persist(_ updated: [WardrobeItem], pendingDeletions: Set<UUID>? = nil,
                         pendingAcknowledgements acknowledgements: Set<ResultAcknowledgement>? = nil,
                         outfits updatedOutfits: [Outfit]? = nil) throws {
        guard let directory, storageAvailable else { throw CocoaError(.fileWriteUnknown) }
        let catalog = WardrobeCatalog(items: updated, pendingDeletionIDs: pendingDeletions ?? pendingDeletionIDs,
                                      pendingAcknowledgements: acknowledgements ?? pendingAcknowledgements,
                                      outfits: updatedOutfits ?? outfits)
        try WardrobeCatalogFile(directory: directory).save(catalog)
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

    private func startAcknowledgement(_ acknowledgement: ResultAcknowledgement) {
        guard acknowledgementTasks[acknowledgement] == nil, pendingAcknowledgements.contains(acknowledgement) else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.deliverAcknowledgement(acknowledgement)
            if self.acknowledgementTasks[acknowledgement]?.generation == generation {
                self.acknowledgementTasks[acknowledgement] = nil
            }
        }
        acknowledgementTasks[acknowledgement] = (generation, task)
    }

    private func deliverAcknowledgement(_ acknowledgement: ResultAcknowledgement) async {
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled && pendingAcknowledgements.contains(acknowledgement) {
            do {
                try await BackendClient(settings: settings).acknowledge(acknowledgement)
                try Task.checkCancellation()
                guard pendingAcknowledgements.contains(acknowledgement) else { return }
                var remaining = pendingAcknowledgements
                remaining.remove(acknowledgement)
                // Keep edits, replacements and other commands made during the request.
                try persist(items, pendingAcknowledgements: remaining)
                pendingAcknowledgements = remaining
                return
            } catch {
                guard !Task.isCancelled else { return }
                do { try await Task.sleep(nanoseconds: retrySeconds * 1_000_000_000) }
                catch { return }
                retrySeconds = min(retrySeconds * 2, 10)
            }
        }
    }

    private func replace(_ item: WardrobeItem, acknowledgement: ResultAcknowledgement? = nil) throws {
        guard let index = items.firstIndex(where: { $0.id == item.id }),
              items[index].operationID == item.operationID else { throw CancellationError() }
        var updated = items
        updated[index] = item
        // A response may have awaited the network while this thing was edited locally.
        // Processing updates never own manual values, including pending and failure updates.
        updated[index].manualType = items[index].manualType
        updated[index].manualColors = items[index].manualColors
        updated[index].illustration = items[index].illustration
        updated[index].illustrationResult = items[index].illustrationResult
        updated[index].sourceSetVersionID = items[index].sourceSetVersionID
        updated[index].automaticallyIllustrate = items[index].automaticallyIllustrate
        updated[index].additionalPhotos = items[index].additionalPhotos
        updated[index].preparedPhotos = items[index].preparedPhotos
        var acknowledgements = pendingAcknowledgements
        if let acknowledgement { acknowledgements.insert(acknowledgement) }
        try persist(updated, pendingAcknowledgements: acknowledgements)
        items = updated
        pendingAcknowledgements = acknowledgements
        if let acknowledgement, observing { startAcknowledgement(acknowledgement) }
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
                    try replace(completed, acknowledgement: ResultAcknowledgement(itemID: item.id, operationID: item.operationID))
                    startNewItemIllustrations()
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
                if let clientError = error as? ClientError, case .resultUnavailable(let code) = clientError {
                    item.errorCode = code
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


extension WardrobeStore {
    func originalImage(for item: WardrobeItem) -> UIImage? {
        guard let directory else { return nil }
        return UIImage(contentsOfFile: directory.appendingPathComponent(item.directoryName).appendingPathComponent(item.originalFilename).path)
    }

    func illustrationURL(for item: WardrobeItem) -> URL? {
        guard let directory, let result = item.illustrationResult else { return nil }
        let url = directory.appendingPathComponent(item.directoryName).appendingPathComponent(result.filename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func requestIllustration(_ id: UUID) {
        guard storageAvailable, let index = items.firstIndex(where: { $0.id == id }),
              items[index].status == .ready, items[index].illustration?.status != .pending else { return }
        var updated = items
        let item = updated[index]
        if var delivery = item.illustration, delivery.status == .failed, delivery.readyForDelivery == true,
           illustrationIsCurrent(item, request: delivery) {
            // Retry downloading the already generated operation, never pay to regenerate
            // because a cache download or local file write failed.
            delivery.status = .pending
            delivery.error = nil
            updated[index].illustration = delivery
        } else {
            let revision = (item.illustration?.revision ?? 0) + 1
            guard revision <= 9_007_199_254_740_991 else { return }
            updated[index].illustration = IllustrationRequest(operationID: UUID(), photoVersionID: item.photoVersionID,
                sourceSetVersionID: item.sourceSetVersionID, revision: revision,
                manualType: item.manualType, manualColors: item.manualColors)
        }
        updated[index].automaticallyIllustrate = false
        do {
            try persist(updated)
            items = updated
            illustrationTasks[id]?.task.cancel()
            illustrationTasks[id] = nil
            if observing { startIllustration(id) }
        } catch { notice = "Не удалось сохранить запрос. Иллюстрация не отправлена." }
    }

    private func startNewItemIllustrations() {
        guard let illustrationAvailable else { return }
        for item in items where item.automaticallyIllustrate && item.status == .ready {
            if illustrationAvailable {
                requestIllustration(item.id)
            } else if let index = items.firstIndex(where: { $0.id == item.id }) {
                var updated = items
                updated[index].automaticallyIllustrate = false
                do { try persist(updated); items = updated }
                catch { notice = "Не удалось сохранить состояние иллюстрации." }
            }
        }
    }

    private func startIllustration(_ id: UUID) {
        guard illustrationTasks[id] == nil,
              let operationID = items.first(where: { $0.id == id })?.illustration?.operationID else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.processIllustration(id, operationID: operationID)
            if self.illustrationTasks[id]?.generation == generation { self.illustrationTasks[id] = nil }
        }
        illustrationTasks[id] = (generation, task)
    }

    private func illustrationIsCurrent(_ item: WardrobeItem, request: IllustrationRequest) -> Bool {
        items.contains { $0.id == item.id && $0.illustration?.operationID == request.operationID
            && $0.photoVersionID == request.photoVersionID && $0.sourceSetVersionID == request.sourceSetVersionID
            && $0.manualType == request.manualType && $0.manualColors == request.manualColors }
    }

    private func saveIllustration(_ id: UUID, request: IllustrationRequest,
                                  result: IllustrationResult? = nil, preparedPhotos: [IllustrationPreparedPhoto]? = nil,
                                  acknowledge: Bool = false) throws {
        guard let index = items.firstIndex(where: { $0.id == id }),
              illustrationIsCurrent(items[index], request: request) else { throw CancellationError() }
        var updated = items
        updated[index].illustration = request
        if let result { updated[index].illustrationResult = result }
        if let preparedPhotos { updated[index].preparedPhotos = preparedPhotos }
        var acknowledgements = pendingAcknowledgements
        let acknowledgement = ResultAcknowledgement(itemID: id, operationID: request.operationID, illustration: true)
        if acknowledge { acknowledgements.insert(acknowledgement) }
        try persist(updated, pendingAcknowledgements: acknowledgements)
        items = updated
        pendingAcknowledgements = acknowledgements
        if acknowledge && observing { startAcknowledgement(acknowledgement) }
    }

    private func processIllustration(_ id: UUID, operationID: UUID) async {
        guard let directory else { return }
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled {
            guard let item = items.first(where: { $0.id == id }), var intent = item.illustration,
                  intent.operationID == operationID, intent.status == .pending else { return }
            guard illustrationIsCurrent(item, request: intent) else { return }
            do {
                let client = BackendClient(settings: settings)
                let response: IllustrationResponse
                if intent.submitted {
                    do { response = try await client.illustrationStatus(item, request: intent) }
                    catch ClientError.server(404) {
                        response = try await submitIllustration(item, intent: intent, client: client, directory: directory)
                    }
                } else {
                    intent.submitted = true
                    try saveIllustration(id, request: intent)
                    response = try await submitIllustration(item, intent: intent, client: client, directory: directory)
                }
                try Task.checkCancellation()
                guard illustrationIsCurrent(item, request: intent) else { return }
                intent.processing = response.processing
                intent.error = response.error
                intent.status = response.status
                if response.status == .ready {
                    intent.readyForDelivery = true
                    // Keep the public state pending until every required artifact is durable.
                    intent.status = .pending
                    try saveIllustration(id, request: intent)
                    let prepared = try await downloadPreparedPhotos(item, intent: intent, response: response, client: client, directory: directory)
                    let data = try await client.illustrationResult(item, request: intent, response: response)
                    guard data.count <= 10 * 1024 * 1024, let image = UIImage(data: data),
                          let cgImage = image.cgImage, cgImage.width == 1024, cgImage.height == 1024,
                          [.first, .last, .premultipliedFirst, .premultipliedLast].contains(cgImage.alphaInfo) else {
                        throw ClientError.invalidResponse
                    }
                    try Task.checkCancellation()
                    guard illustrationIsCurrent(item, request: intent) else { return }
                    let filename = "illustration-\(operationID.uuidString.lowercased()).png"
                    try data.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename), options: .atomic)
                    let previous = items.first(where: { $0.id == id })
                    let previousFilename = previous?.illustrationResult?.filename
                    intent.status = .ready
                    intent.readyForDelivery = false
                    try saveIllustration(id, request: intent, result: IllustrationResult(filename: filename, response: response), preparedPhotos: prepared, acknowledge: true)
                    for cached in previous?.preparedPhotos ?? [] where !prepared.contains(where: { $0.filename == cached.filename }) {
                        try? FileManager.default.removeItem(at: directory.appendingPathComponent(item.directoryName).appendingPathComponent(cached.filename))
                    }
                    if let previousFilename, previousFilename != filename {
                        try? FileManager.default.removeItem(at: directory.appendingPathComponent(item.directoryName).appendingPathComponent(previousFilename))
                    }
                    return
                }
                try saveIllustration(id, request: intent)
                if intent.status == .failed { return }
                retrySeconds = 1
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                guard !Task.isCancelled, illustrationIsCurrent(item, request: intent) else { return }
                let retryable: Bool
                if let error = error as? ClientError {
                    switch error {
                    case .server(let status): retryable = status >= 500 || status == 408 || status == 429
                    default: retryable = false
                    }
                } else { retryable = error is URLError }
                intent.status = retryable ? .pending : .failed
                if case ClientError.resultUnavailable(let code) = error {
                    intent.error = code
                    if ["result_expired", "result_delivered"].contains(code) { intent.readyForDelivery = false }
                }
                else if case ClientError.oversizedPhoto = error { intent.error = "image_too_large" }
                else { intent.error = retryable ? "offline" : "invalid_provider_response" }
                do { try saveIllustration(id, request: intent) }
                catch { notice = "Не удалось сохранить состояние иллюстрации."; return }
                guard retryable else { return }
                do { try await Task.sleep(nanoseconds: retrySeconds * 1_000_000_000) } catch { return }
                retrySeconds = min(retrySeconds * 2, 10)
            }
        }
    }

    private func submitIllustration(_ item: WardrobeItem, intent: IllustrationRequest,
                                    client: BackendClient, directory: URL) async throws -> IllustrationResponse {
        try Task.checkCancellation()
        guard illustrationIsCurrent(item, request: intent) else { throw CancellationError() }
        let folder = directory.appendingPathComponent(item.directoryName)
        let photos = try illustrationSources(for: item).map { source -> [String: String] in
            let data = try Data(contentsOf: folder.appendingPathComponent(source.filename))
            var photo = ["id": source.id.uuidString.lowercased(), "role": source.role, "imageBase64": data.base64EncodedString()]
            if let cached = item.preparedPhotos.first(where: {
                $0.photoID == source.id && $0.modelVersion == "fal-ai/nano-banana-pro/edit"
                    && $0.templateVersion == "front-360x560-proposed-v1" && $0.geometryVersion == "fitting-square-1024-v1"
            }) {
                guard cached.sourceDigest == photoDigest(data),
                      let prepared = try? Data(contentsOf: folder.appendingPathComponent(cached.filename)),
                      cached.preparedDigest == photoDigest(prepared) else {
                    throw ClientError.resultUnavailable("prepared_source_missing")
                }
                photo["preparedBase64"] = prepared.base64EncodedString()
            }
            return photo
        }
        return try await client.submitIllustration(item, request: intent, photos: photos)
    }

    private func illustrationSources(for item: WardrobeItem) -> [(id: UUID, role: String, filename: String)] {
        [(item.photoVersionID, "front", item.uploadFilename)] + item.additionalPhotos.map { ($0.id, $0.role, $0.uploadFilename) }
    }

    private func photoDigest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func downloadPreparedPhotos(_ item: WardrobeItem, intent: IllustrationRequest, response: IllustrationResponse,
                                        client: BackendClient, directory: URL) async throws -> [IllustrationPreparedPhoto] {
        guard let sources = response.preparedSources else { throw ClientError.invalidResponse }
        let folder = directory.appendingPathComponent(item.directoryName)
        var saved: [IllustrationPreparedPhoto] = []
        for source in sources {
            guard let original = illustrationSources(for: item).first(where: { $0.id == source.photoId }) else { throw ClientError.invalidResponse }
            let originalData = try Data(contentsOf: folder.appendingPathComponent(original.filename))
            let prepared = try await client.preparedIllustrationSource(item, request: intent, response: response, source: source)
            guard prepared.count <= 10 * 1024 * 1024,
                  prepared.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
                  let originalImage = UIImage(data: originalData)?.cgImage,
                  let image = UIImage(data: prepared)?.cgImage,
                  image.width == originalImage.width, image.height == originalImage.height,
                  [.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo) else {
                throw ClientError.invalidResponse
            }
            try Task.checkCancellation()
            guard illustrationIsCurrent(item, request: intent) else { throw CancellationError() }
            let filename = "prepared-\(source.photoId.uuidString.lowercased())-\(intent.operationID.uuidString.lowercased()).png"
            try prepared.write(to: folder.appendingPathComponent(filename), options: .atomic)
            saved.append(IllustrationPreparedPhoto(photoID: source.photoId, filename: filename,
                sourceDigest: photoDigest(originalData), preparedDigest: photoDigest(prepared), modelVersion: response.modelVersion,
                templateVersion: response.templateVersion, geometryVersion: response.geometryVersion))
        }
        return saved
    }

    func additionalPhotoImage(_ photo: IllustrationPhotoDraft, for item: WardrobeItem) -> UIImage? {
        if let original = photo.original { return UIImage(data: original) }
        guard let directory, let saved = photo.saved else { return nil }
        return UIImage(contentsOfFile: directory.appendingPathComponent(item.directoryName).appendingPathComponent(saved.uploadFilename).path)
    }

    func saveAdditionalPhotos(_ drafts: [IllustrationPhotoDraft], for id: UUID, primaryVersion: UUID) throws {
        guard let directory, storageAvailable, let index = items.firstIndex(where: { $0.id == id }),
              items[index].photoVersionID == primaryVersion else { throw ClientError.invalidPhoto }
        guard drafts.count <= 2, Set(drafts.map(\.id)).count == drafts.count,
              drafts.allSatisfy({ ["back", "detail"].contains($0.role) }) else { throw ClientError.invalidPhoto }
        let previous = items[index].additionalPhotos
        if drafts.count == previous.count, zip(drafts, previous).allSatisfy({ $0.id == $1.id && $0.role == $1.role }) { return }
        let folder = directory.appendingPathComponent(items[index].directoryName)
        var photos: [IllustrationSourcePhoto] = []
        for draft in drafts {
            if let original = draft.original {
                let upload = try PhotoData.uploadCopy(of: original)
                let name = draft.id.uuidString.lowercased()
                let source = IllustrationSourcePhoto(id: draft.id, role: draft.role,
                    originalFilename: "detail-\(name).original", uploadFilename: "detail-\(name).png")
                try original.write(to: folder.appendingPathComponent(source.originalFilename), options: .atomic)
                try upload.write(to: folder.appendingPathComponent(source.uploadFilename), options: .atomic)
                photos.append(source)
            } else if var saved = draft.saved, previous.contains(where: { $0.id == saved.id }) {
                saved.role = draft.role
                photos.append(saved)
            } else { throw ClientError.invalidPhoto }
        }
        var updated = items
        updated[index].additionalPhotos = photos
        let activePhotoIDs = Set([updated[index].photoVersionID] + photos.map(\.id))
        let removedPrepared = updated[index].preparedPhotos.filter { !activePhotoIDs.contains($0.photoID) }
        updated[index].preparedPhotos.removeAll { !activePhotoIDs.contains($0.photoID) }
        updated[index].sourceSetVersionID = UUID()
        updated[index].automaticallyIllustrate = false
        if updated[index].illustration?.status == .pending {
            updated[index].illustration?.status = .failed
            updated[index].illustration?.error = "source_changed"
        }
        try persist(updated)
        items = updated
        illustrationTasks[id]?.task.cancel()
        illustrationTasks[id] = nil
        for cached in removedPrepared {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(cached.filename))
        }
        for photo in previous where !photos.contains(where: { $0.id == photo.id }) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(photo.originalFilename))
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(photo.uploadFilename))
        }
    }

}
