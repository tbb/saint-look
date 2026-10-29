import Foundation

enum ProcessingMode: String, Codable { case demo, live }

struct WardrobeItem: Codable, Identifiable {
    enum Status: String, Codable { case pending, ready, failed }

    enum AttemptAction: String, Codable { case create, retry, replace }

    let id: UUID
    var operationID: UUID
    var photoVersionID: UUID
    var revision = 0
    var action: AttemptAction = .create
    var originalFilename = "original.photo"
    var uploadFilename = "upload.png"
    var resultFilename: String?
    var resultMode: ProcessingMode?
    var status: Status = .pending
    var uploadStarted = false
    var type: String?
    var colors: [String] = []
    var manualType: String?
    var manualColors: [String]?
    var errorMessage: String?
    var errorCode: String?
    var mode: ProcessingMode?
    var sourceSetVersionID: UUID
    var illustration: IllustrationRequest?
    var illustrationResult: IllustrationResult?
    var automaticallyIllustrate = false
    var additionalPhotos: [IllustrationSourcePhoto] = []
    var preparedPhotos: [IllustrationPreparedPhoto] = []
    var publishedVersion: ItemPublication?
    var pendingPublication: PendingItemPublication?
    var photosLocked = false
    var downloadedIllustration: PendingItemPublication?
    var preparation: ItemPreparation?
    var preparationRevision = 0
    var resultSHA256: String?

    init(id: UUID, operationID: UUID, photoVersionID: UUID) {
        self.id = id
        self.operationID = operationID
        self.photoVersionID = photoVersionID
        self.sourceSetVersionID = photoVersionID
    }

    private enum CodingKeys: String, CodingKey {
        case id, operationID, photoVersionID, status, uploadStarted, type, colors, errorMessage, mode, manualType, manualColors
        case revision, action, originalFilename, uploadFilename, resultFilename, resultMode, errorCode
        case sourceSetVersionID, illustration, illustrationResult, automaticallyIllustrate, additionalPhotos, preparedPhotos
        case publishedVersion, pendingPublication, photosLocked, preparation, preparationRevision, resultSHA256, downloadedIllustration
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        operationID = try values.decode(UUID.self, forKey: .operationID)
        photoVersionID = try values.decode(UUID.self, forKey: .photoVersionID)
        sourceSetVersionID = try values.decodeIfPresent(UUID.self, forKey: .sourceSetVersionID) ?? photoVersionID
        preparedPhotos = try values.decodeIfPresent([IllustrationPreparedPhoto].self, forKey: .preparedPhotos) ?? []
        additionalPhotos = try values.decodeIfPresent([IllustrationSourcePhoto].self, forKey: .additionalPhotos) ?? []
        illustration = try values.decodeIfPresent(IllustrationRequest.self, forKey: .illustration)
        illustrationResult = try values.decodeIfPresent(IllustrationResult.self, forKey: .illustrationResult)
        automaticallyIllustrate = try values.decodeIfPresent(Bool.self, forKey: .automaticallyIllustrate) ?? false
        status = try values.decode(Status.self, forKey: .status)
        revision = try values.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        action = try values.decodeIfPresent(AttemptAction.self, forKey: .action) ?? .create
        originalFilename = try values.decodeIfPresent(String.self, forKey: .originalFilename) ?? "original.photo"
        uploadFilename = try values.decodeIfPresent(String.self, forKey: .uploadFilename) ?? "upload.png"
        resultFilename = try values.decodeIfPresent(String.self, forKey: .resultFilename)
            ?? (status == .ready ? "result.png" : nil)
        errorCode = try values.decodeIfPresent(String.self, forKey: .errorCode)
        uploadStarted = try values.decodeIfPresent(Bool.self, forKey: .uploadStarted) ?? false
        type = try values.decodeIfPresent(String.self, forKey: .type)
        colors = try values.decodeIfPresent([String].self, forKey: .colors) ?? []
        manualType = try values.decodeIfPresent(String.self, forKey: .manualType)
        manualColors = try values.decodeIfPresent([String].self, forKey: .manualColors)
        errorMessage = try values.decodeIfPresent(String.self, forKey: .errorMessage)
        // Ready cards written by the first demo-only version had no mode field.
        mode = try values.decodeIfPresent(ProcessingMode.self, forKey: .mode)
            ?? (status == .ready ? .demo : nil)
        resultMode = try values.decodeIfPresent(ProcessingMode.self, forKey: .resultMode)
            ?? (resultFilename != nil ? mode : nil)
        publishedVersion = try values.decodeIfPresent(ItemPublication.self, forKey: .publishedVersion)
        pendingPublication = try values.decodeIfPresent(PendingItemPublication.self, forKey: .pendingPublication)
        photosLocked = try values.decodeIfPresent(Bool.self, forKey: .photosLocked) ?? false
        downloadedIllustration = try values.decodeIfPresent(PendingItemPublication.self, forKey: .downloadedIllustration)
        preparation = try values.decodeIfPresent(ItemPreparation.self, forKey: .preparation)
        preparationRevision = try values.decodeIfPresent(Int.self, forKey: .preparationRevision) ?? 0
        resultSHA256 = try values.decodeIfPresent(String.self, forKey: .resultSHA256)
        if publishedVersion == nil, let filename = resultFilename {
            // Migration preserves the actual image/feature pairing. A stale legacy
            // illustration cannot describe a newly replaced photograph.
            let matching = illustrationResult.flatMap { result in
                result.response.photoVersionId == photoVersionID && result.response.sourceSetVersionId == sourceSetVersionID ? result : nil
            }
            publishedVersion = ItemPublication(versionID: matching?.response.operationId ?? operationID,
                photoVersionID: photoVersionID, sourceSetVersionID: sourceSetVersionID,
                cutoutFilename: filename, cutoutMode: resultMode, illustration: matching,
                type: matching?.response.effectiveFeatures?.type ?? manualType ?? type,
                colors: matching?.response.effectiveFeatures?.colors ?? manualColors ?? colors,
                completeness: matching == nil ? .legacyImage : .legacyIllustration)
            if let matching, var candidate = publishedVersion {
                // v2 published before delivery acknowledgement. Preserve its visible
                // snapshot, but reconcile the original receipt before claiming a lock.
                let expectedSources = Set([photoVersionID] + additionalPhotos.map(\.id))
                if preparedPhotos.count == expectedSources.count && Set(preparedPhotos.map(\.photoID)) == expectedSources {
                    candidate.completeness = .illustrated
                }
                let response = matching.response
                let request = IllustrationRequest(operationID: response.operationId, photoVersionID: response.photoVersionId,
                    sourceSetVersionID: response.sourceSetVersionId, revision: response.revision,
                    manualType: response.manualType, manualColors: response.manualColors, status: .ready, submitted: true)
                pendingPublication = PendingItemPublication(publication: candidate, request: request,
                    preparedPhotos: preparedPhotos, legacyReconciliation: true)
            }
        }
        if let candidate = pendingPublication, candidate.legacyReconciliation != true,
           candidate.publication.completeness != .prepared {
            downloadedIllustration = candidate
            pendingPublication = nil
            illustration = candidate.request
        }
        photosLocked = photosLocked || publishedVersion?.completeness == .illustrated || publishedVersion?.completeness == .prepared
    }

    var hasPreparedVersion: Bool {
        guard let publication = publishedVersion, publication.completeness == .prepared,
              let illustration = publication.illustration, let representation = publication.representation,
              let features = try? CanonicalItemFeatures(displayType: publication.type, colors: publication.colors),
              illustration.response.effectiveFeatures?.isValid == true,
              illustration.response.observedFeatures?.isValid == true,
              illustration.response.effectiveFeatures?.type == publication.type,
              illustration.response.effectiveFeatures?.colors == publication.colors else { return false }
        let response = representation.response
        return response.status == .ready && response.operationId == publication.versionID
            && response.photoVersionId == publication.photoVersionID && response.sourceSetVersionId == publication.sourceSetVersionID
            && response.illustrationOperationId == illustration.response.operationId && response.effectiveFeatures == features
            && response.representationJSON?.isEmpty == false && response.representationSHA256?.count == 64
            && response.artifacts != nil && response.input != nil
    }
    var isPreparing: Bool { status == .pending || illustration?.status == .pending || preparation?.status == .pending || pendingPublication != nil || (downloadedIllustration != nil && preparation == nil) }
    var isReconcilingLegacyPublication: Bool { pendingPublication?.legacyReconciliation == true }
    var canEditPhotos: Bool { !photosLocked && pendingPublication == nil }
    var canEditAttributes: Bool { pendingPublication == nil }
    var editedType: String? { manualType ?? publishedVersion?.type ?? type }
    var editedColors: [String] { manualColors ?? publishedVersion?.colors ?? colors }
    var displayedType: String? { if let publishedVersion { return publishedVersion.type }; return editedType }
    var displayedColors: [String] { publishedVersion?.colors ?? editedColors }
    var displayedCutoutFilename: String? { publishedVersion?.cutoutFilename ?? resultFilename }
    var displayedIllustration: IllustrationResult? { if let publishedVersion { return publishedVersion.illustration }; return illustrationResult }
    var hasUsableImageVersion: Bool { publishedVersion != nil || (status == .ready && resultFilename != nil) }

    mutating func publishIngestion() {
        guard status == .ready, let filename = resultFilename,
              publishedVersion?.illustration == nil else { return }
        publishedVersion = ItemPublication(versionID: operationID, photoVersionID: photoVersionID,
            sourceSetVersionID: sourceSetVersionID, cutoutFilename: filename, cutoutMode: resultMode,
            illustration: nil, type: manualType ?? type, colors: manualColors ?? colors, completeness: .legacyImage,
            cutoutOperationID: operationID)
    }
    var directoryName: String { id.uuidString.lowercased() }
}

/// A single publication is the consumer boundary. Neither legacy image data nor
/// an illustrated package proves encoder readiness; #68 adds that required result here.
struct ItemPublication: Codable {
    enum Completeness: String, Codable { case legacyImage, legacyIllustration, illustrated, prepared }
    let versionID: UUID
    let photoVersionID: UUID
    let sourceSetVersionID: UUID
    let cutoutFilename: String
    let cutoutMode: ProcessingMode?
    let illustration: IllustrationResult?
    let type: String?
    let colors: [String]
    var completeness: Completeness
    var representation: StoredRepresentation? = nil
    var cutoutOperationID: UUID? = nil
}

/// Durable candidate saved before the server publication commit. It remains hidden
/// until that same operation's acknowledgement succeeds, including after restart.
struct PendingItemPublication: Codable {
    var publication: ItemPublication
    let request: IllustrationRequest
    let preparedPhotos: [IllustrationPreparedPhoto]
    var legacyReconciliation: Bool? = nil
    var error: String? = nil

    // Historical ready results may predate durable artifact digests. Their actual
    // final files must be imported before encoder preparation and the full commit.
    var preparationMode: ItemPreparation.Mode {
        legacyReconciliation == true ? .legacyImport : .fromIllustration
    }

    // CPU-upgrading the old visible snapshot may coexist with a newer manual
    // draft. It may never consume or replace a different illustration operation.
    func canPrepare(for item: WardrobeItem) -> Bool {
        item.photoVersionID == publication.photoVersionID && item.sourceSetVersionID == publication.sourceSetVersionID
            && item.illustration?.operationID == request.operationID
            && (legacyReconciliation == true
                || (item.manualType == request.manualType && item.manualColors == request.manualColors))
    }
}

struct ResultAcknowledgement: Codable, Hashable {
    let itemID: UUID
    let operationID: UUID
    // Optional preserves legacy acknowledgements without migrating old items.
    var illustration: Bool? = nil
    var preparationOperationID: UUID? = nil
}

struct ItemResponse: Decodable {
    let itemId: UUID
    let operationId: UUID
    let photoVersionId: UUID
    let status: WardrobeItem.Status
    let mode: ProcessingMode
    let revision: Int?
    let type: String?
    let colors: [String]
    let resultPath: String?
    let error: String?
    var resultSHA256: String? = nil

    func validate(for item: WardrobeItem) throws {
        guard itemId == item.id, operationId == item.operationID,
              photoVersionId == item.photoVersionID, (revision ?? 0) == item.revision else {
            throw ClientError.invalidResponse
        }
    }
}

enum ClientError: LocalizedError {
    case invalidSettings, invalidAttributes, invalidPhoto, oversizedPhoto, invalidResponse, photosLocked, publicationInProgress, server(Int), resultUnavailable(String), keychain

    var errorDescription: String? {
        switch self {
        case .invalidSettings: return "Укажите адрес backend и токен владельца в настройках."
        case .invalidAttributes: return "Выберите тип и от одного до пяти цветов из списка."
        case .publicationInProgress: return "Завершаем сохранение вещи. Изменения будут доступны после подтверждения сервера."
        case .photosLocked: return "Фотографии готовой вещи не меняются. Для другого снимка добавьте новую вещь."
        case .invalidPhoto: return "Не удалось прочитать фотографию. Выберите другой снимок."
        case .oversizedPhoto: return "Фотография слишком большая. Выберите снимок до 20 МБ."
        case .invalidResponse: return "Backend вернул неподходящий результат. Исходное фото сохранено."
        case .resultUnavailable(let code): return ProcessingFailure.message(for: code)
        case .server(401): return "Backend не принял токен владельца. Проверьте настройки."
        case .server: return "Обработка недоступна. Исходное фото сохранено."
        case .keychain: return "Не удалось сохранить токен в защищённом хранилище."
        }
    }
}


enum ProcessingFailure {
    static func needsAnotherPhoto(_ code: String?) -> Bool {
        ["photo_on_person", "photo_multiple_items", "photo_no_item", "photo_unclear", "inappropriate_photo", "image_too_large"].contains(code ?? "")
    }

    static func message(for code: String?) -> String {
        switch code {
        case "photos_locked": return ClientError.photosLocked.localizedDescription
        case "photo_on_person": return "Вещь нужно сфотографировать отдельно, не на человеке. Исходник сохранён."
        case "photo_multiple_items": return "На фото несколько вещей. Для карточки нужна одна вещь. Исходник сохранён."
        case "photo_no_item": return "На фото не удалось найти вещь. Исходник сохранён."
        case "photo_unclear": return "Вещь плохо различима на фото. Исходник сохранён."
        case "image_too_large": return "Фото слишком большое для обработки. Исходник сохранён."
        case "inappropriate_photo": return "Фото не подходит: нужна одна вещь вне человека. Исходник сохранён."
        case "provider_quota_exceeded": return "Лимит обработки исчерпан. Исходное фото сохранено."
        case "provider_not_configured", "provider_preflight_required", "provider_unauthorized":
            return "Сервис обработки пока не настроен. Исходное фото сохранено."
        case "result_expired":
            return "Срок хранения результата на сервере истёк. Фото сохранено на устройстве. Повторите обработку."
        case "result_delivered":
            return "Серверная копия результата уже очищена. Фото сохранено на устройстве. Повторите обработку."
        case "processing_unknown":
            return "Не удалось подтвердить результат обработки. Автоматический повтор остановлен; исходник сохранён."
        case "invalid_provider_response": return "Обработчик вернул неполный результат. Исходное фото сохранено."
        case "provider_configuration_changed": return "Настройки обработки изменились. Исходное фото сохранено."
        default: return "Обработка не удалась. Исходное фото сохранено."
        }
    }
}

struct IllustrationFeatures: Codable {
    let version: String
    let type: String
    let colors: [String]
    let traits: [String: String]

    var isValid: Bool {
        guard version == "fitting-observable-v2-photoroom-sandbox",
              WardrobeTaxonomy.shared.contains(type: type),
              colors.isEmpty || WardrobeTaxonomy.shared.contains(colors: colors) else { return false }
        let options: [String: Set<String>] = [
            "silhouette": ["fitted", "straight", "relaxed", "unknown", "not_applicable"],
            "body_length": ["cropped", "regular", "long", "unknown", "not_applicable"],
            "sleeves": ["sleeveless", "short", "long", "unknown", "not_applicable"],
            "pattern": ["plain", "stripes", "checks", "graphic", "mixed", "unknown"],
            "pattern_location": ["center", "left_chest", "right_chest", "sleeves", "all_over", "none", "unknown"],
            "pattern_size": ["small", "medium", "large", "none", "unknown"],
            "neckline": ["round", "v_neck", "collar", "high", "hood", "unknown", "not_applicable"],
            "fastening": ["none", "buttons", "zip", "mixed", "unknown", "not_applicable"],
            "surface": ["smooth", "knitted", "fuzzy", "glossy", "mixed", "unknown"],
            "hood": ["yes", "no", "unknown"], "kangaroo_pocket": ["yes", "no", "unknown"],
            "patch_pockets": ["yes", "no", "unknown"], "dropped_shoulders": ["yes", "no", "unknown"],
            "contrast_cuffs": ["yes", "no", "unknown"], "lettering": ["yes", "no", "unknown"]
        ]
        return Set(traits.keys) == Set(options.keys) && traits.allSatisfy { options[$0.key]?.contains($0.value) == true }
    }
}

struct IllustrationRequest: Codable {
    let operationID: UUID
    let photoVersionID: UUID
    let sourceSetVersionID: UUID
    let revision: Int
    let manualType: String?
    let manualColors: [String]?
    var status: WardrobeItem.Status = .pending
    var submitted = false
    var readyForDelivery: Bool? = nil
    var error: String?
    var processing: [String: String] = [:]
}

struct IllustrationResult: Codable {
    let filename: String
    let response: IllustrationResponse
}

struct IllustrationResponse: Codable {
    let itemId: UUID
    let operationId: UUID
    let photoVersionId: UUID
    let sourceSetVersionId: UUID
    let revision: Int
    let status: WardrobeItem.Status
    let mode: String
    let processing: [String: String]
    let observedFeatures: IllustrationFeatures?
    let effectiveFeatures: IllustrationFeatures?
    let manualType: String?
    let manualColors: [String]?
    let modelVersion: String
    let templateVersion: String
    let geometryVersion: String
    let resultPath: String?
    let error: String?
    var preparedSources: [IllustrationPreparedSource]? = nil
    var resultSHA256: String? = nil
    var observedFeaturesSHA256: String? = nil
    var effectiveFeaturesSHA256: String? = nil

    func validate(for item: WardrobeItem, request: IllustrationRequest) throws {
        guard itemId == item.id, operationId == request.operationID,
              photoVersionId == request.photoVersionID, sourceSetVersionId == request.sourceSetVersionID,
              revision == request.revision, manualType == request.manualType, manualColors == request.manualColors,
              ["live", "test"].contains(mode), modelVersion == "fal-ai/nano-banana-pro/edit",
              templateVersion == "front-360x560-proposed-v1", geometryVersion == "fitting-square-1024-v1" else {
            throw ClientError.invalidResponse
        }
        if status == .ready {
            let expectedSources = Set([item.photoVersionID] + item.additionalPhotos.map(\.id))
            guard let preparedSources, preparedSources.count == expectedSources.count,
                  Set(preparedSources.map(\.photoId)) == expectedSources,
                  let features = effectiveFeatures, let observed = observedFeatures, features.isValid, observed.isValid,
                  request.manualType == nil || features.type == request.manualType,
                  request.manualColors == nil || features.colors == request.manualColors else { throw ClientError.invalidResponse }
        }
    }
}

extension WardrobeItem {
    var canResumeIllustrationDelivery: Bool {
        if pendingPublication != nil { return true }
        guard let request = illustration, request.status == .failed, request.readyForDelivery == true else { return false }
        return request.photoVersionID == photoVersionID && request.sourceSetVersionID == sourceSetVersionID
            && request.manualType == manualType && request.manualColors == manualColors
    }

    var illustrationIsStale: Bool {
        guard let result = illustrationResult else { return false }
        return result.response.photoVersionId != photoVersionID || result.response.sourceSetVersionId != sourceSetVersionID
            || result.response.manualType != manualType || result.response.manualColors != manualColors
    }

    var illustrationStatusMessage: String? {
        if pendingPublication == nil, let preparation {
            if let error = preparation.error { return PreparationFailure.message(for: error) }
            if preparation.status == .pending {
                return hasPreparedVersion ? "Обновляем вещь. В луках пока используется предыдущая версия." : "Завершаем подготовку вещи…"
            }
        }
        if pendingPublication?.error == "confirmation_failed" {
            return "Не удалось подтвердить сохранение. Проверьте подключение к серверу. Изображение и луки сохранены."
        }
        if pendingPublication != nil {
            let progress = (pendingPublication?.error ?? illustration?.error) == "offline" ? "Завершаем сохранение. Продолжим при подключении."
                : "Сохраняем готовую вещь…"
            return progress + (photosLocked ? " В луках пока используется предыдущая версия." : "")
        }
        if publishedVersion?.completeness == .legacyIllustration && !photosLocked {
            return "Не удалось подтвердить старую версию на сервере. Изображение и луки сохранены на устройстве."
        }
        if illustration?.status == .pending {
            return photosLocked ? "Обновляем вещь. В луках пока используется предыдущая версия."
                : "Иллюстрация готовится. Можно продолжать пользоваться гардеробом."
        }
        if let error = illustration?.error {
            let detail = IllustrationFailure.message(for: error)
            return photosLocked ? "Не удалось обновить вещь. Предыдущая версия сохранена. " + detail : detail
        }
        if illustrationIsStale { return "Признаки изменились. Обновите иллюстрацию, чтобы использовать их в луках. Пока используется предыдущая версия." }
        return hasPreparedVersion ? nil : "Нужно завершить подготовку. Фото и сохранённые луки доступны на устройстве."
    }
}

enum IllustrationFailure {
    static func message(for code: String) -> String {
        switch code {
        case "illustration_unavailable": return "Создание иллюстраций пока недоступно. Фото и вырезка сохранены."
        case "illustration_payload_too_large": return "Фото вместе с сохранёнными вырезками слишком большие для отправки. Уберите дополнительный ракурс или замените снимок меньшим."
        case "prepared_source_missing": return "Не удалось прочитать сохранённую вырезку исходного фото. Предыдущая версия сохранена; для другого снимка добавьте новую вещь."
        case "processing_in_progress": return "Предыдущая подготовка ещё идёт. Повторите обновление позже."
        case "source_changed": return "Фото или признаки изменились. Создайте иллюстрацию для новой версии."
        case "processing_unknown": return "Исход генерации неизвестен. Автоматический повтор остановлен. Предыдущее изображение сохранено."
        case "offline": return "Нет связи. Отправка продолжится при подключении к интернету."
        default: return ProcessingFailure.message(for: code)
        }
    }
}


struct IllustrationSourcePhoto: Codable, Identifiable {
    let id: UUID
    var role: String
    let originalFilename: String
    let uploadFilename: String
}

struct IllustrationPhotoDraft: Identifiable {
    let id: UUID
    var role: String
    let original: Data?
    let saved: IllustrationSourcePhoto?
}


struct IllustrationPreparedSource: Codable {
    let photoId: UUID
    let preparedPath: String
}

struct IllustrationPreparedPhoto: Codable {
    let photoID: UUID
    let filename: String
    let sourceDigest: String
    let preparedDigest: String
    let modelVersion: String
    let templateVersion: String
    let geometryVersion: String
}

struct RecommendationConfiguration: Decodable {
    struct Availability: Decodable { let available: Bool; let reason: String? }
    struct Encoder: Decodable {
        let available: Bool
        let mode: String
        let activeSpaceID: String?
        let supportedSpaceIDs: [String]
        let reason: String?
    }
    let protocolVersion: Int
    let publicationProtocol: String
    let preparationRequired: Bool
    let representationEncoding: String
    let encoder: Encoder
    let newItemPreparation: Availability
    let encoderRefresh: Availability
}

struct CanonicalItemFeatures: Codable, Equatable {
    let type: String
    let colors: [String]

    init(type: String, colors: [String]) { self.type = type; self.colors = colors.sorted() }
    init(displayType: String?, colors: [String], taxonomy: WardrobeTaxonomy = .shared) throws {
        guard let type = taxonomy.types.first(where: { $0.label == displayType })?.id,
              colors.count <= 5, Set(colors).count == colors.count else { throw ClientError.invalidAttributes }
        self.type = type
        self.colors = try colors.map { label in
            guard let id = taxonomy.colors.first(where: { $0.label == label })?.id else { throw ClientError.invalidAttributes }
            return id
        }.sorted()
    }
}

struct PreparationArtifacts: Codable, Equatable {
    let cutoutSHA256: String
    let illustrationSHA256: String
    let observedFeaturesSHA256: String
    let effectiveFeaturesSHA256: String
}

struct PreparationResponse: Codable {
    struct Input: Codable { let sourceSHA256: String; let textSHA256: String }
    let itemId: UUID
    let operationId: UUID
    let revision: Int
    let photoVersionId: UUID
    let sourceSetVersionId: UUID
    let illustrationOperationId: UUID
    let cutoutOperationId: UUID
    let spaceID: String
    let status: WardrobeItem.Status
    let mode: String
    let imageMode: String?
    let provenance: String?
    let effectiveFeatures: CanonicalItemFeatures?
    let representationJSON: String?
    let representationSHA256: String?
    let input: Input?
    let artifacts: PreparationArtifacts?
    let error: String?

    func validate(for itemID: UUID, intent: ItemPreparation) throws {
        guard itemId == itemID, operationId == intent.operationID, revision == intent.revision,
              photoVersionId == intent.publication.photoVersionID,
              sourceSetVersionId == intent.publication.sourceSetVersionID,
              illustrationOperationId == intent.request.operationID, cutoutOperationId == intent.cutoutOperationID, spaceID == intent.spaceID,
              ["real", "controlled", "disabled"].contains(mode) else { throw ClientError.invalidResponse }
        if status == .ready {
            guard mode != "disabled", effectiveFeatures == intent.features,
                  let representationJSON, !representationJSON.isEmpty, representationJSON.utf8.count <= 64 * 1024,
                  representationSHA256?.count == 64, input?.sourceSHA256 == intent.sourceSHA256,
                  input?.textSHA256.count == 64, let artifacts,
                  artifacts.cutoutSHA256 == intent.artifacts.cutoutSHA256,
                  artifacts.illustrationSHA256 == intent.artifacts.illustrationSHA256,
                  artifacts.observedFeaturesSHA256.count == 64, artifacts.effectiveFeaturesSHA256.count == 64,
                  intent.artifacts.observedFeaturesSHA256.isEmpty || artifacts.observedFeaturesSHA256 == intent.artifacts.observedFeaturesSHA256,
                  intent.artifacts.effectiveFeaturesSHA256.isEmpty || artifacts.effectiveFeaturesSHA256 == intent.artifacts.effectiveFeaturesSHA256,
                  imageMode == intent.publication.illustration?.response.mode,
                  provenance == (intent.mode == .legacyImport ? "legacyImport" : intent.provenance) else {
                throw ClientError.invalidResponse
            }
        }
    }
}

struct StoredRepresentation: Codable {
    let filename: String
    let response: PreparationResponse
}

/// Downloaded artifacts and immutable request identity survive process/network loss.
/// This is not a publication: source/trait edits may still supersede it before staging.
struct ItemPreparation: Codable {
    enum Mode: String, Codable { case fromIllustration, reusePublication, legacyImport }
    let operationID: UUID
    let revision: Int
    let spaceID: String
    let mode: Mode
    let cutoutOperationID: UUID
    let publication: ItemPublication
    let request: IllustrationRequest
    let preparedPhotos: [IllustrationPreparedPhoto]
    let features: CanonicalItemFeatures
    let sourceSHA256: String
    let artifacts: PreparationArtifacts
    let provenance: String
    let manualType: String?
    let manualColors: [String]?
    var status: WardrobeItem.Status = .pending
    var submitted = false
    var error: String? = nil
    // Only a failed operation body proves the server accepted and terminated work.
    // A503 before acceptance remains a retry of the same durable request.
    var terminalFailure: Bool? = nil

    var needsNewAttempt: Bool {
        status == .failed && (["encoder_failed", "incompatible_representations", "representation_space_changed",
            "operation_superseded", "result_expired", "result_delivered"].contains(error ?? "")
            || (error == "encoder_unavailable" && terminalFailure == true))
    }

    func matches(_ item: WardrobeItem) -> Bool {
        item.photoVersionID == publication.photoVersionID && item.sourceSetVersionID == publication.sourceSetVersionID
            && item.manualType == manualType && item.manualColors == manualColors
            && ((mode != .fromIllustration && item.downloadedIllustration?.legacyReconciliation != true)
                || item.illustration?.operationID == request.operationID)
    }
}

enum PreparationFailure {
    static func message(for code: String) -> String {
        switch code {
        case "offline": return "Нет связи. Подготовка продолжится при подключении. Предыдущая версия сохранена."
        case "encoder_unavailable", "preparation_required": return "Подготовка вещей пока недоступна на сервере. Фото и предыдущая версия сохранены."
        case "incompatible_representations", "representation_space_changed": return "Для подбора нужно обновить вещь. Предыдущая версия доступна в ручных луках."
        case "prepared_source_missing", "local_artifact_missing": return "Не удалось прочитать сохранённый результат. Исходники и луки сохранены; нужна повторная подготовка недостающего результата."
        case "encoder_failed": return "Не удалось завершить подготовку. Предыдущая версия сохранена. Попробуйте ещё раз."
        default: return "Не удалось завершить подготовку. Фото и предыдущая версия сохранены."
        }
    }
}
