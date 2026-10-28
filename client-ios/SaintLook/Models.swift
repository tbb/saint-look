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
    }

    var displayedType: String? { manualType ?? type }
    var displayedColors: [String] { manualColors ?? colors }
    var directoryName: String { id.uuidString.lowercased() }
}

struct ResultAcknowledgement: Codable, Hashable {
    let itemID: UUID
    let operationID: UUID
    // Optional preserves legacy acknowledgements without migrating old items.
    var illustration: Bool? = nil
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

    func validate(for item: WardrobeItem) throws {
        guard itemId == item.id, operationId == item.operationID,
              photoVersionId == item.photoVersionID, (revision ?? 0) == item.revision else {
            throw ClientError.invalidResponse
        }
    }
}

enum ClientError: LocalizedError {
    case invalidSettings, invalidAttributes, invalidPhoto, oversizedPhoto, invalidResponse, server(Int), resultUnavailable(String), keychain

    var errorDescription: String? {
        switch self {
        case .invalidSettings: return "Укажите адрес backend и токен владельца в настройках."
        case .invalidAttributes: return "Выберите тип и от одного до пяти цветов из списка."
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
    var illustrationIsStale: Bool {
        guard let result = illustrationResult else { return false }
        return result.response.photoVersionId != photoVersionID || result.response.sourceSetVersionId != sourceSetVersionID
            || result.response.manualType != manualType || result.response.manualColors != manualColors
    }

    var illustrationStatusMessage: String? {
        if illustration?.status == .pending { return "Иллюстрация готовится. Можно продолжать пользоваться гардеробом." }
        if let error = illustration?.error { return IllustrationFailure.message(for: error) }
        if illustrationIsStale { return "Фото или признаки изменились. Иллюстрацию можно обновить отдельно." }
        return illustrationResult == nil ? "Иллюстрация ещё не создана." : nil
    }
}

enum IllustrationFailure {
    static func message(for code: String) -> String {
        switch code {
        case "illustration_unavailable": return "Создание иллюстраций пока недоступно. Фото и вырезка сохранены."
        case "illustration_payload_too_large": return "Фото вместе с сохранёнными вырезками слишком большие для отправки. Уберите дополнительный ракурс или замените снимок меньшим."
        case "prepared_source_missing": return "Не удалось прочитать сохранённую вырезку исходного фото. Замените этот снимок и повторите обновление."
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
