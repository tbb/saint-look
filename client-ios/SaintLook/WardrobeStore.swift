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
    #if DEBUG
    private var usesVisualFixtures = false
    #endif
    @Published private(set) var preparationConfiguration: RecommendationConfiguration?
    private var preparationTask: (itemID: UUID, generation: UUID, task: Task<Void, Never>)?

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
                usesVisualFixtures = true
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
                }).union(saved.legacyPublicationAcknowledgements)
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
        preparationConfiguration = nil
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
        var updated = catalog
        try updated.editAttributes(for: id, type: type, colors: colors, taxonomy: .shared)
        try persist(updated.items)
        items = updated.items
        if preparationTask?.itemID == id { preparationTask?.task.cancel(); preparationTask = nil }
        startNextPreparation()
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
            if preparationTask?.itemID == id { preparationTask?.task.cancel(); preparationTask = nil }
            illustrationTasks[id]?.task.cancel()
            illustrationTasks[id] = nil
            tasks[id]?.task.cancel()
            tasks[id] = nil
            try? removeLocalFiles(for: id)
            if observing { startDeletion(id); startNextPreparation() }
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
        guard item.pendingPublication == nil else {
            notice = ClientError.publicationInProgress.localizedDescription
            return
        }
        guard original == nil || !item.photosLocked else {
            notice = ClientError.photosLocked.localizedDescription
            return
        }
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
                item.preparation = nil
                item.downloadedIllustration = nil
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
        let filename = item.displayedCutoutFilename ?? item.uploadFilename
        let path = directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename)
        return UIImage(contentsOfFile: path.path)
    }

    private var catalog: WardrobeCatalog {
        WardrobeCatalog(items: items, pendingDeletionIDs: pendingDeletionIDs,
                        pendingAcknowledgements: pendingAcknowledgements, outfits: outfits)
    }

    func outfitCandidates(for zone: OutfitZone, excluding selectedIDs: Set<UUID>) -> [WardrobeItem] {
        items.filter {
            $0.hasPreparedVersion && !selectedIDs.contains($0.id)
                && zone.accepts($0, taxonomy: .shared) && preparedFilesAvailable(for: $0)
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
            selectedIDs.contains($0.id) && preparedFilesAvailable(for: $0)
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
        for item in items where !item.isReconcilingLegacyPublication && item.pendingPublication == nil && item.preparation == nil && item.illustration?.status == .pending { startIllustration(item.id) }
        startNextPreparation()
    }

    func stopObserving() {
        observing = false
        preparationTask?.task.cancel()
        preparationTask = nil
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

    /// A foreground recommendation can discover a deployment before lifecycle
    /// resume. Schedule the existing config/preparation queue without touching a look.
    func refreshPreparationConfiguration(after error: Error) async {
        guard case ClientError.resultUnavailable(let code) = error,
              ["incompatible_representations", "representation_space_changed"].contains(code) else { return }
        discoverMode()
    }

    private func discoverMode() {
        guard modeTask == nil, isConnected else { return }
        let client = BackendClient(settings: settings)
        modeTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let health = try await client.health()
                    try Task.checkCancellation()
                    self?.backendMode = health.mode
                    self?.illustrationAvailable = health.illustrationAvailable ?? false
                    let config = try await client.recommendationConfiguration()
                    try Task.checkCancellation()
                    self?.preparationConfiguration = config
                    try self?.restartPreparationAfterSpaceChange(config)
                    self?.startNewItemIllustrations()
                    self?.startNextPreparation()
                    self?.modeTask = nil
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
                var updated = catalog
                try updated.reconcileLegacyPublication(acknowledgement, committed: true)
                var remaining = updated.pendingAcknowledgements ?? pendingAcknowledgements
                remaining.remove(acknowledgement)
                // Reconcile only the migrated snapshot; preserve newer manual inputs,
                // in-flight requests, other commands and saved outfit references.
                try persist(updated.items, pendingAcknowledgements: remaining)
                items = updated.items
                pendingAcknowledgements = remaining
                startNextPreparation()
                if observing, items.first(where: { $0.id == acknowledgement.itemID })?.illustration?.status == .pending {
                    startIllustration(acknowledgement.itemID)
                }
                return
            } catch {
                guard !Task.isCancelled else { return }
                let refused: Bool
                if case ClientError.resultUnavailable(let code) = error {
                    refused = ["operation_superseded", "item_deleted", "result_expired", "preparation_required"].contains(code)
                } else if case ClientError.server(404) = error { refused = true }
                else { refused = false }
                if let index = items.firstIndex(where: { $0.id == acknowledgement.itemID }),
                   items[index].pendingPublication?.legacyReconciliation == true,
                   items[index].pendingPublication?.request.operationID == acknowledgement.operationID {
                    do {
                        var updated = catalog
                        if refused {
                            let requiresPreparation: Bool
                            if case ClientError.resultUnavailable("preparation_required") = error { requiresPreparation = true }
                            else { requiresPreparation = false }
                            try updated.reconcileLegacyPublication(acknowledgement, committed: false,
                                                                   requiresPreparation: requiresPreparation)
                        }
                        else { updated.items[index].pendingPublication?.error = error is URLError ? "offline" : "confirmation_failed" }
                        try persist(updated.items, pendingAcknowledgements: updated.pendingAcknowledgements ?? [])
                        items = updated.items
                        pendingAcknowledgements = updated.pendingAcknowledgements ?? []
                    } catch { notice = "Не удалось сохранить подтверждение старой версии вещи."; return }
                    if refused {
                        startNextPreparation()
                        // Reconciliation held back the newer persisted intent during
                        // startup. Resume that operation after either terminal outcome.
                        if observing, items.first(where: { $0.id == acknowledgement.itemID })?.illustration?.status == .pending {
                            startIllustration(acknowledgement.itemID)
                        }
                        return
                    }
                } else if acknowledgement.illustration == true && refused {
                    // An obsolete legacy receipt may coexist with a newer one. Its
                    // authoritative refusal must not leave an endless background retry.
                    var remaining = pendingAcknowledgements
                    remaining.remove(acknowledgement)
                    do { try persist(items, pendingAcknowledgements: remaining); pendingAcknowledgements = remaining }
                    catch { notice = "Не удалось сохранить состояние доставки." }
                    return
                }
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
        updated[index].pendingPublication = items[index].pendingPublication
        updated[index].publishedVersion = items[index].publishedVersion
        updated[index].photosLocked = items[index].photosLocked
        updated[index].preparation = items[index].preparation
        updated[index].preparationRevision = items[index].preparationRevision
        updated[index].downloadedIllustration = items[index].downloadedIllustration
        updated[index].publishIngestion()
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
                    guard let type = current.type, WardrobeTaxonomy.shared.contains(type: type),
                          current.colors.isEmpty || WardrobeTaxonomy.shared.contains(colors: current.colors) else { throw ClientError.invalidResponse }
                    let imageData = try await client.result(item, response: current)
                    guard imageData.count <= 10 * 1024 * 1024, UIImage(data: imageData) != nil else { throw ClientError.invalidResponse }
                    if let expected = current.resultSHA256, photoDigest(imageData) != expected { throw ClientError.invalidResponse }
                    try Task.checkCancellation()
                    guard isCurrent(item) else { return }
                    let filename = "result-\(item.operationID.uuidString.lowercased()).png"
                    try imageData.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename), options: .atomic)
                    var completed = item
                    completed.resultFilename = filename
                    completed.resultMode = current.mode
                    completed.resultSHA256 = current.resultSHA256
                    completed.type = type
                    completed.colors = current.colors
                    completed.status = .ready
                    completed.errorMessage = nil
                    completed.errorCode = nil
                    try replace(completed, acknowledgement: ResultAcknowledgement(itemID: item.id, operationID: item.operationID))
                    startNewItemIllustrations()
                    startNextPreparation()
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
        guard let directory, let result = item.displayedIllustration else { return nil }
        let url = directory.appendingPathComponent(item.directoryName).appendingPathComponent(result.filename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func requestIllustration(_ id: UUID) {
        guard storageAvailable, let index = items.firstIndex(where: { $0.id == id }),
              !items[index].isReconcilingLegacyPublication, items[index].pendingPublication == nil,
              items[index].status == .ready, items[index].illustration?.status != .pending else { return }
        var updated = items
        let item = updated[index]
        if var delivery = item.illustration, item.canResumeIllustrationDelivery {
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
        updated[index].preparation = nil
        updated[index].downloadedIllustration = nil
        do {
            try persist(updated)
            items = updated
            illustrationTasks[id]?.task.cancel()
            illustrationTasks[id] = nil
            if preparationTask?.itemID == id { preparationTask?.task.cancel(); preparationTask = nil }
            if observing { startIllustration(id) }
        } catch { notice = "Не удалось сохранить запрос. Иллюстрация не отправлена." }
    }

    private func startNewItemIllustrations() {
        guard let illustrationAvailable, preparationConfiguration != nil else { return }
        for item in items where item.automaticallyIllustrate && item.status == .ready {
            if illustrationAvailable && preparationConfiguration?.newItemPreparation.available == true {
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
              let item = items.first(where: { $0.id == id }), !item.isReconcilingLegacyPublication,
              item.pendingPublication == nil, item.preparation == nil,
              let operationID = item.illustration?.operationID else { return }
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

    private func saveIllustration(_ id: UUID, request: IllustrationRequest, discardCandidate: Bool = false) throws {
        guard let index = items.firstIndex(where: { $0.id == id }),
              illustrationIsCurrent(items[index], request: request) else { throw CancellationError() }
        var updated = items
        updated[index].illustration = request
        if discardCandidate { updated[index].pendingPublication = nil }
        try persist(updated)
        items = updated
    }

    private func commitPublication(_ item: WardrobeItem, client: BackendClient, directory: URL) async throws {
        guard let candidate = item.pendingPublication,
              let stored = candidate.publication.representation,
              let expectedArtifacts = stored.response.artifacts else { throw CancellationError() }
        if item.preparation?.mode == .fromIllustration {
            guard verifiedPreparedPhotos(candidate.preparedPhotos, for: item, publication: candidate.publication).count == item.additionalPhotos.count + 1 else {
                throw ClientError.resultUnavailable("prepared_source_missing")
            }
        }
        let candidateFolder = directory.appendingPathComponent(item.directoryName)
        let representation = try Data(contentsOf: candidateFolder.appendingPathComponent(stored.filename))
        let original = try Data(contentsOf: candidateFolder.appendingPathComponent(item.uploadFilename))
        guard photoDigest(representation) == stored.response.representationSHA256,
              representation == stored.response.representationJSON.map({ Data($0.utf8) }),
              photoDigest(original) == stored.response.input?.sourceSHA256,
              try publicationArtifacts(candidate.publication, item: item, preparedPhotos: candidate.preparedPhotos) == expectedArtifacts else {
            throw ClientError.resultUnavailable("local_artifact_missing")
        }
        // Artifacts and candidate are durable first. The server atomically fixes the
        // source set and acknowledges delivery before this version becomes visible.
        try await client.acknowledge(ResultAcknowledgement(itemID: item.id,
            operationID: candidate.request.operationID, illustration: true,
            preparationOperationID: candidate.publication.representation?.response.operationId))
        try Task.checkCancellation()
        var updated = catalog
        try updated.confirmPublication(for: item.id, operationID: candidate.request.operationID)
        try persist(updated.items)
        items = updated.items
        let folder = directory.appendingPathComponent(item.directoryName)
        for cached in item.preparedPhotos where !candidate.preparedPhotos.contains(where: { $0.filename == cached.filename }) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(cached.filename))
        }
        if let previous = item.publishedVersion?.illustration?.filename,
           previous != candidate.publication.illustration?.filename {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(previous))
        }
        if let previous = item.publishedVersion?.representation?.filename,
           previous != candidate.publication.representation?.filename {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(previous))
        }
    }

    private func processIllustration(_ id: UUID, operationID: UUID) async {
        guard let directory else { return }
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled {
            guard let item = items.first(where: { $0.id == id }), var intent = item.illustration,
                  intent.operationID == operationID, (intent.status == .pending || item.pendingPublication != nil) else { return }
            guard illustrationIsCurrent(item, request: intent) else { return }
            do {
                let client = BackendClient(settings: settings)
                if item.pendingPublication != nil {
                    try await commitPublication(item, client: client, directory: directory)
                    return
                }
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
                    if let expected = response.resultSHA256, photoDigest(data) != expected { throw ClientError.invalidResponse }
                    try Task.checkCancellation()
                    guard illustrationIsCurrent(item, request: intent) else { return }
                    let filename = "illustration-\(operationID.uuidString.lowercased()).png"
                    try data.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename), options: .atomic)
                    var completed = intent
                    completed.status = .ready
                    completed.readyForDelivery = false
                    var updated = catalog
                    try updated.stageIllustration(for: id, request: completed,
                        result: IllustrationResult(filename: filename, response: response), preparedPhotos: prepared)
                    try persist(updated.items)
                    items = updated.items
                    startNextPreparation()
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
                var discardCandidate = false
                if item.pendingPublication != nil {
                    if case ClientError.resultUnavailable(let code) = error {
                        discardCandidate = ["operation_superseded", "item_deleted", "result_expired"].contains(code)
                    } else if case ClientError.server(404) = error { discardCandidate = true }
                }
                do { try saveIllustration(id, request: intent, discardCandidate: discardCandidate) }
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
                $0.matchesPreparationContract(photoID: source.id)
            }) {
                guard cached.sourceDigest == photoDigest(data) else { throw ClientError.resultUnavailable("source_changed") }
                if let prepared = try? Data(contentsOf: folder.appendingPathComponent(cached.filename)),
                   cached.preparedDigest == photoDigest(prepared), UIImage(data: prepared) != nil {
                    photo["preparedBase64"] = prepared.base64EncodedString()
                }
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
        guard items[index].pendingPublication == nil else { throw ClientError.publicationInProgress }
        guard !items[index].photosLocked else { throw ClientError.photosLocked }
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
        updated[index].preparation = nil
        updated[index].downloadedIllustration = nil
        updated[index].automaticallyIllustrate = false
        if updated[index].illustration?.status == .pending {
            updated[index].illustration?.status = .failed
            updated[index].illustration?.error = "source_changed"
        }
        try persist(updated)
        items = updated
        if preparationTask?.itemID == id { preparationTask?.task.cancel(); preparationTask = nil }
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

extension WardrobeStore {
    /// The same complete local packet backs both picker admission and saved versions.
    func preparedFilesAvailable(for item: WardrobeItem) -> Bool {
        guard item.hasPreparedVersion, let publication = item.publishedVersion, let directory,
              let stored = publication.representation, let expected = stored.response.artifacts,
              let bytes = try? Data(contentsOf: directory.appendingPathComponent(item.directoryName).appendingPathComponent(stored.filename)),
              photoDigest(bytes) == stored.response.representationSHA256,
              bytes == stored.response.representationJSON.map({ Data($0.utf8) }),
              let actual = try? publicationArtifacts(publication, item: item, preparedPhotos: item.preparedPhotos), actual == expected else { return false }
        return true
    }

    func finishPreparation(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }), !items[index].isReconcilingLegacyPublication else { return }
        if items[index].pendingPublication != nil {
            do {
                var updated = catalog
                try updated.resumePreparation(for: id)
                try persist(updated.items); items = updated.items
                startNextPreparation()
            } catch { notice = "Не удалось сохранить повтор подтверждения." }
            return
        }
        if var intent = items[index].preparation, intent.matches(items[index]) {
            // A completed encoder failure gets a new CPU-only operation. A transport
            // failure reuses its already durable operation identity.
            if intent.needsNewAttempt {
                var updated = items; updated[index].preparation = nil
                do { try persist(updated); items = updated } catch { notice = "Не удалось сохранить повтор подготовки."; return }
            } else {
                intent.status = .pending; intent.error = nil
                do { var updated = catalog; try updated.savePreparation(for: id, intent: intent); try persist(updated.items); items = updated.items }
                catch { notice = "Не удалось сохранить повтор подготовки."; return }
            }
        } else if items[index].downloadedIllustration == nil && items[index].publishedVersion?.illustration == nil {
            requestIllustration(id)
            return
        }
        startNextPreparation(explicitItemID: id)
    }

    private func publicationArtifacts(_ publication: ItemPublication, item: WardrobeItem,
                                      preparedPhotos: [IllustrationPreparedPhoto]) throws -> PreparationArtifacts {
        guard let directory, let illustration = publication.illustration,
              let observed = illustration.response.observedFeatures, observed.isValid,
              let effective = illustration.response.effectiveFeatures, effective.isValid,
              effective.type == publication.type, effective.colors == publication.colors else { throw ClientError.invalidResponse }
        let folder = directory.appendingPathComponent(item.directoryName)
        guard let cutout = try? Data(contentsOf: folder.appendingPathComponent(publication.cutoutFilename)),
              cutout.count <= 10 * 1024 * 1024, UIImage(data: cutout) != nil,
              let image = try? Data(contentsOf: folder.appendingPathComponent(illustration.filename)),
              image.count <= 10 * 1024 * 1024, let cg = UIImage(data: image)?.cgImage,
              cg.width == 1024, cg.height == 1024,
              [.first, .last, .premultipliedFirst, .premultipliedLast].contains(cg.alphaInfo) else {
            throw ClientError.resultUnavailable("local_artifact_missing")
        }
        return PreparationArtifacts(cutoutSHA256: photoDigest(cutout), illustrationSHA256: photoDigest(image),
            observedFeaturesSHA256: publication.representation?.response.artifacts?.observedFeaturesSHA256 ?? illustration.response.observedFeaturesSHA256 ?? "",
            effectiveFeaturesSHA256: publication.representation?.response.artifacts?.effectiveFeaturesSHA256 ?? illustration.response.effectiveFeaturesSHA256 ?? "")
    }

    private func restartPreparationAfterSpaceChange(_ config: RecommendationConfiguration) throws {
        guard config.encoder.available else { return }
        var updated = catalog
        if updated.clearRejectedPreparationSpace(activeSpaceID: config.encoder.activeSpaceID) { try persist(updated.items); items = updated.items }
    }

    private func verifiedPreparedPhotos(_ photos: [IllustrationPreparedPhoto], for item: WardrobeItem,
                                        publication: ItemPublication) -> [IllustrationPreparedPhoto] {
        guard let directory, let illustration = publication.illustration else { return [] }
        let folder = directory.appendingPathComponent(item.directoryName)
        let sources = illustrationSources(for: item)
        return photos.filter { saved in
            guard let source = sources.first(where: { $0.id == saved.photoID }),
                  saved.modelVersion == illustration.response.modelVersion,
                  saved.templateVersion == illustration.response.templateVersion,
                  saved.geometryVersion == illustration.response.geometryVersion,
                  let original = try? Data(contentsOf: folder.appendingPathComponent(source.filename)), photoDigest(original) == saved.sourceDigest,
                  let prepared = try? Data(contentsOf: folder.appendingPathComponent(saved.filename)), photoDigest(prepared) == saved.preparedDigest,
                  UIImage(data: prepared) != nil else { return false }
            return true
        }
    }

    private func makePreparation(for item: WardrobeItem, spaceID: String) throws -> ItemPreparation {
        guard let directory, item.pendingPublication == nil, !item.isReconcilingLegacyPublication else { throw CancellationError() }
        let publication: ItemPublication
        let request: IllustrationRequest
        let prepared: [IllustrationPreparedPhoto]
        let mode: ItemPreparation.Mode
        if let downloaded = item.downloadedIllustration {
            publication = downloaded.publication; request = downloaded.request; prepared = downloaded.preparedPhotos
            guard downloaded.canPrepare(for: item) else { throw CancellationError() }
            mode = downloaded.preparationMode
        } else {
            guard let previous = item.publishedVersion, let result = previous.illustration,
                  result.response.photoVersionId == item.photoVersionID,
                  result.response.sourceSetVersionId == item.sourceSetVersionID,
                  item.illustration?.status != .pending else { throw CancellationError() }
            let folder = directory.appendingPathComponent(item.directoryName)
            if !FileManager.default.fileExists(atPath: folder.appendingPathComponent(previous.cutoutFilename).path),
               item.status == .ready, let replacement = item.resultFilename, replacement != previous.cutoutFilename,
               FileManager.default.fileExists(atPath: folder.appendingPathComponent(replacement).path) {
                // The user explicitly retried the missing cutout through ingestion.
                // Reuse the intact illustration/traits; import the new same-photo
                // cutout receipt instead of regenerating those unchanged stages.
                publication = ItemPublication(versionID: previous.versionID, photoVersionID: previous.photoVersionID,
                    sourceSetVersionID: previous.sourceSetVersionID, cutoutFilename: replacement, cutoutMode: item.resultMode,
                    illustration: previous.illustration, type: previous.type, colors: previous.colors,
                    completeness: .legacyIllustration, cutoutOperationID: item.operationID)
            } else { publication = previous }
            request = IllustrationRequest(operationID: result.response.operationId, photoVersionID: result.response.photoVersionId,
                sourceSetVersionID: result.response.sourceSetVersionId, revision: result.response.revision,
                manualType: result.response.manualType, manualColors: result.response.manualColors, status: .ready, submitted: true)
            prepared = item.preparedPhotos
            mode = publication.representation == nil ? .legacyImport : .reusePublication
        }
        let folder = directory.appendingPathComponent(item.directoryName)
        let source = try Data(contentsOf: folder.appendingPathComponent(item.uploadFilename))
        let availablePrepared = verifiedPreparedPhotos(prepared, for: item, publication: publication)
        if mode == .fromIllustration {
            guard availablePrepared.count == item.additionalPhotos.count + 1,
                  Set(availablePrepared.map(\.photoID)) == Set([item.photoVersionID] + item.additionalPhotos.map(\.id)) else {
                throw ClientError.resultUnavailable("prepared_source_missing")
            }
        }
        let artifacts = try publicationArtifacts(publication, item: item, preparedPhotos: availablePrepared)
        if let previousArtifacts = publication.representation?.response.artifacts, artifacts != previousArtifacts { throw ClientError.invalidResponse }
        if publication.cutoutFilename == item.resultFilename, let cutoutHash = item.resultSHA256, artifacts.cutoutSHA256 != cutoutHash { throw ClientError.invalidResponse }
        guard item.preparationRevision < 9_007_199_254_740_991 else { throw ClientError.invalidResponse }
        return ItemPreparation(operationID: UUID(), revision: item.preparationRevision + 1, spaceID: spaceID,
            mode: mode, cutoutOperationID: publication.cutoutOperationID ?? item.operationID, publication: publication, request: request,
            preparedPhotos: availablePrepared, features: try CanonicalItemFeatures(displayType: publication.type, colors: publication.colors),
            sourceSHA256: photoDigest(source), artifacts: artifacts,
            provenance: mode == .reusePublication ? "reused" : mode == .legacyImport ? "legacyImport" : "pipeline",
            manualType: item.manualType, manualColors: item.manualColors)
    }

    /// One-at-a-time also bounds legacy import memory. Existing illustrations and
    /// observations are reused; this queue never starts a paid provider operation.
    private func startNextPreparation(explicitItemID: UUID? = nil) {
        guard observing, storageAvailable, preparationTask == nil else { return }
        #if DEBUG
        // Existing isolated visual catalogs have no server delivery receipts.
        if usesVisualFixtures && explicitItemID == nil { return }
        #endif
        let candidate = items.first { $0.pendingPublication?.publication.completeness == .prepared
            && $0.preparation?.matches($0) == true && $0.preparation?.status != .failed }
        let pending = items.first { $0.preparation?.status == .pending && $0.preparation?.matches($0) == true && $0.pendingPublication == nil }
        var selected = candidate ?? pending
        if selected == nil, let config = preparationConfiguration, config.encoder.available,
           let space = config.encoder.activeSpaceID {
            let candidates = items.filter { item in
                !item.isReconcilingLegacyPublication && item.pendingPublication == nil && item.preparation == nil
                    && item.illustration?.status != .pending
                    && (explicitItemID == nil || explicitItemID == item.id)
                    && (item.downloadedIllustration != nil || (item.publishedVersion?.illustration != nil
                        && item.publishedVersion?.representation?.response.spaceID != space))
            }
            for item in candidates {
                do {
                    let intent = try makePreparation(for: item, spaceID: space)
                    var updated = catalog
                    try updated.beginPreparation(for: item.id, intent: intent)
                    try persist(updated.items); items = updated.items
                    selected = items.first { $0.id == item.id }
                    break
                } catch {
                    // Preserve the local packet; no automatic paid repair of missing files.
                    if explicitItemID == item.id { notice = (error as? ClientError)?.localizedDescription ?? PreparationFailure.message(for: "local_artifact_missing") }
                }
            }
        }
        guard let item = selected else { return }
        let generation = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.processPreparation(item.id)
            if self.preparationTask?.generation == generation {
                self.preparationTask = nil
                self.startNextPreparation()
            }
        }
        preparationTask = (item.id, generation, task)
    }

    private func processPreparation(_ id: UUID) async {
        guard let directory else { return }
        var retrySeconds: UInt64 = 1
        while observing && !Task.isCancelled {
            guard let item = items.first(where: { $0.id == id }), var intent = item.preparation,
                  intent.matches(item) else { return }
            do {
                let client = BackendClient(settings: settings)
                if item.pendingPublication?.publication.completeness == .prepared {
                    try await commitPublication(item, client: client, directory: directory)
                    return
                }
                let response: PreparationResponse
                if intent.submitted {
                    do { response = try await client.preparationStatus(item, intent: intent) }
                    catch ClientError.server(404) { response = try await submitPreparation(item, intent: intent, client: client) }
                } else {
                    intent.submitted = true
                    var updated = catalog; try updated.savePreparation(for: id, intent: intent)
                    try persist(updated.items); items = updated.items
                    response = try await submitPreparation(item, intent: intent, client: client)
                }
                try Task.checkCancellation()
                guard let current = items.first(where: { $0.id == id }), intent.matches(current),
                      current.preparation?.operationID == intent.operationID else { return }
                if response.status == .failed {
                    intent.status = .failed; intent.error = response.error ?? "encoder_failed"
                    intent.terminalFailure = true
                    var updated = catalog; try updated.savePreparation(for: id, intent: intent)
                    try persist(updated.items); items = updated.items
                    // Restarting into a different model terminates queued work for
                    // the old space. Only fresh config can authorize a new intent.
                    if intent.error == "encoder_unavailable" { discoverMode() }
                    return
                }
                if response.status == .ready {
                    guard let json = response.representationJSON, let expected = response.representationSHA256 else { throw ClientError.invalidResponse }
                    let data = Data(json.utf8)
                    guard photoDigest(data) == expected else { throw ClientError.invalidResponse }
                    if intent.mode == .fromIllustration {
                        guard verifiedPreparedPhotos(intent.preparedPhotos, for: current, publication: intent.publication).count == current.additionalPhotos.count + 1 else {
                            throw ClientError.resultUnavailable("prepared_source_missing")
                        }
                    }
                    let actualArtifacts = try publicationArtifacts(intent.publication, item: current, preparedPhotos: intent.preparedPhotos)
                    let original = try Data(contentsOf: directory.appendingPathComponent(item.directoryName).appendingPathComponent(item.uploadFilename))
                    let filename = "representation-\(intent.operationID.uuidString.lowercased()).json"
                    try data.write(to: directory.appendingPathComponent(item.directoryName).appendingPathComponent(filename), options: .atomic)
                    var updated = catalog
                    try updated.stagePreparation(for: id, response: response, representationFilename: filename,
                        representationDigest: photoDigest(data), actualArtifacts: actualArtifacts, actualSourceDigest: photoDigest(original))
                    try persist(updated.items); items = updated.items
                    continue
                }
                retrySeconds = 1
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                guard !Task.isCancelled, let current = items.first(where: { $0.id == id }), intent.matches(current),
                      current.preparation?.operationID == intent.operationID else { return }
                var retryable = error is URLError
                if case ClientError.server(let status) = error { retryable = status >= 500 || status == 408 || status == 429 }
                let code: String
                if case ClientError.resultUnavailable(let reason) = error { code = reason }
                else { code = retryable ? "offline" : "invalid_provider_response" }
                intent.error = code; intent.status = retryable ? .pending : .failed
                intent.terminalFailure = false
                var updated = catalog
                do {
                    try updated.savePreparation(for: id, intent: intent)
                    if let index = updated.items.firstIndex(where: { $0.id == id }), updated.items[index].pendingPublication != nil {
                        let definitive = ["operation_superseded", "item_deleted", "result_expired", "incompatible_representations", "representation_space_changed"].contains(code)
                            || (error as? ClientError).map { if case .server(404) = $0 { return true }; return false } == true
                        if definitive { updated.items[index].pendingPublication = nil }
                        else { updated.items[index].pendingPublication?.error = retryable ? "offline" : "confirmation_failed" }
                    }
                    try persist(updated.items); items = updated.items
                } catch { notice = "Не удалось сохранить состояние подготовки."; return }
                if code == "representation_space_changed" || code == "incompatible_representations" { discoverMode() }
                guard retryable else { return }
                do { try await Task.sleep(nanoseconds: retrySeconds * 1_000_000_000) } catch { return }
                retrySeconds = min(retrySeconds * 2, 10)
            }
        }
    }

    private func submitPreparation(_ item: WardrobeItem, intent: ItemPreparation, client: BackendClient) async throws -> PreparationResponse {
        guard let directory, let current = items.first(where: { $0.id == item.id }), intent.matches(current),
              current.preparation?.operationID == intent.operationID else { throw CancellationError() }
        let folder = directory.appendingPathComponent(item.directoryName)
        let original = try Data(contentsOf: folder.appendingPathComponent(item.uploadFilename))
        if intent.mode == .fromIllustration {
            guard verifiedPreparedPhotos(intent.preparedPhotos, for: item, publication: intent.publication).count == item.additionalPhotos.count + 1 else {
                throw ClientError.resultUnavailable("prepared_source_missing")
            }
        }
        guard photoDigest(original) == intent.sourceSHA256,
              try publicationArtifacts(intent.publication, item: item, preparedPhotos: intent.preparedPhotos) == intent.artifacts else { throw ClientError.invalidResponse }
        let cutout = intent.mode == .legacyImport ? try Data(contentsOf: folder.appendingPathComponent(intent.publication.cutoutFilename)) : nil
        let illustration = intent.mode == .legacyImport ? try intent.publication.illustration.map { try Data(contentsOf: folder.appendingPathComponent($0.filename)) } : nil
        return try await client.submitPreparation(item, intent: intent, original: original, legacyCutout: cutout, legacyIllustration: illustration)
    }
}


extension WardrobeStore {
    /// Read only the small persisted representation; image bytes and encoders are
    /// not part of recommendation requests. Final image availability is still required.
    func recommendationItems(excluding targetItemID: UUID? = nil) throws -> [RecommendationItem] {
        guard let directory, storageAvailable else { throw RecommendationError.preparationRequired }
        return try items.compactMap { item in
            guard item.id != targetItemID, item.hasPreparedVersion, let publication = item.publishedVersion,
                  let illustration = publication.illustration, let stored = publication.representation else { return nil }
            let folder = directory.appendingPathComponent(item.directoryName)
            guard [item.uploadFilename, publication.cutoutFilename, illustration.filename, stored.filename].allSatisfy({
                FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path)
            }) else { return nil }
            let url = folder.appendingPathComponent(stored.filename)
            guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 8 * 1024 else {
                throw RecommendationError.preparationRequired
            }
            let bytes = try Data(contentsOf: url)
            guard photoDigest(bytes) == stored.response.representationSHA256,
                  let json = String(data: bytes, encoding: .utf8), Data(json.utf8) == bytes else {
                throw RecommendationError.preparationRequired
            }
            return try RecommendationItem(item: item, representationJSON: json)
        }
    }
}
