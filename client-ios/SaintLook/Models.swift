import Foundation

struct WardrobeItem: Codable, Identifiable {
    enum Status: String, Codable { case pending, ready, failed }

    let id: UUID
    let operationID: UUID
    let photoVersionID: UUID
    var status: Status = .pending
    var uploadStarted = false
    var type: String?
    var colors: [String] = []
    var errorMessage: String?

    var directoryName: String { id.uuidString.lowercased() }
}

struct ItemResponse: Decodable {
    let itemId: UUID
    let operationId: UUID
    let photoVersionId: UUID
    let status: String
    let mode: String
    let type: String?
    let colors: [String]
    let resultPath: String?
    let error: String?

    func validate(for item: WardrobeItem) throws {
        guard itemId == item.id, operationId == item.operationID,
              photoVersionId == item.photoVersionID, mode == "demo",
              ["pending", "ready", "failed"].contains(status) else {
            throw ClientError.invalidResponse
        }
    }
}

enum ClientError: LocalizedError {
    case invalidSettings, invalidPhoto, oversizedPhoto, invalidResponse, server(Int), keychain

    var errorDescription: String? {
        switch self {
        case .invalidSettings: return "Укажите адрес backend и токен владельца в настройках."
        case .invalidPhoto: return "Не удалось прочитать фотографию. Выберите другой снимок."
        case .oversizedPhoto: return "Фотография слишком большая. Выберите снимок до 20 МБ."
        case .invalidResponse: return "Backend вернул неподходящий результат. Исходное фото сохранено."
        case .server(401): return "Backend не принял токен владельца. Проверьте настройки."
        case .server: return "Обработка недоступна. Исходное фото сохранено."
        case .keychain: return "Не удалось сохранить токен в защищённом хранилище."
        }
    }
}
