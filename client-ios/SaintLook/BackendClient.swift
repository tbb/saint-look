import Foundation

struct BackendClient {
    let settings: ConnectionSettings

    private func request(path: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        let base = try settings.validatedURL()
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw ClientError.server(response.statusCode) }
        return data
    }

    func submit(_ item: WardrobeItem, photo: Data) async throws -> ItemResponse {
        let body = try JSONSerialization.data(withJSONObject: [
            "itemId": item.id.uuidString.lowercased(),
            "operationId": item.operationID.uuidString.lowercased(),
            "photoVersionId": item.photoVersionID.uuidString.lowercased(),
            "imageBase64": photo.base64EncodedString()
        ])
        let data = try await send(request(path: "v1/items", method: "POST", body: body))
        let result = try JSONDecoder().decode(ItemResponse.self, from: data)
        try result.validate(for: item)
        return result
    }

    func status(_ item: WardrobeItem) async throws -> ItemResponse {
        let data = try await send(request(path: "v1/items/\(item.directoryName)"))
        let result = try JSONDecoder().decode(ItemResponse.self, from: data)
        try result.validate(for: item)
        return result
    }

    func result(_ item: WardrobeItem, response: ItemResponse) async throws -> Data {
        try response.validate(for: item)
        let path = "v1/items/\(item.directoryName)/result"
        guard response.status == "ready", response.resultPath == "/" + path else {
            throw ClientError.invalidResponse
        }
        return try await send(request(path: path))
    }
}
