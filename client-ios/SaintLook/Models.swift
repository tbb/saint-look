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

    init(id: UUID, operationID: UUID, photoVersionID: UUID) {
        self.id = id
        self.operationID = operationID
        self.photoVersionID = photoVersionID
    }

    private enum CodingKeys: String, CodingKey {
        case id, operationID, photoVersionID, status, uploadStarted, type, colors, errorMessage, mode, manualType, manualColors
        case revision, action, originalFilename, uploadFilename, resultFilename, resultMode, errorCode
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        operationID = try values.decode(UUID.self, forKey: .operationID)
        photoVersionID = try values.decode(UUID.self, forKey: .photoVersionID)
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
    case invalidSettings, invalidPhoto, oversizedPhoto, invalidResponse, server(Int), resultUnavailable(String), keychain

    var errorDescription: String? {
        switch self {
        case .invalidSettings: return "Укажите адрес backend и токен владельца в настройках."
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
