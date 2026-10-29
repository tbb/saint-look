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

    private func send(_ request: URLRequest, expectedStatus: Int? = nil) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        if response.statusCode == 410 || response.statusCode == 503 || response.statusCode == 409 {
            struct Failure: Decodable { let error: String }
            if let failure = try? JSONDecoder().decode(Failure.self, from: data),
               ["result_expired", "result_delivered", "illustration_unavailable", "processing_in_progress", "photos_locked", "operation_superseded", "item_deleted", "encoder_unavailable", "encoder_failed", "preparation_required", "preparation_incomplete", "incompatible_representations", "representation_space_changed", "identity_conflict"].contains(failure.error) {
                throw ClientError.resultUnavailable(failure.error)
            }
        }
        guard (200..<300).contains(response.statusCode) else { throw ClientError.server(response.statusCode) }
        if let expectedStatus, response.statusCode != expectedStatus { throw ClientError.invalidResponse }
        return data
    }

    func acknowledge(_ acknowledgement: ResultAcknowledgement) async throws {
        let resource = acknowledgement.illustration == true ? "illustrations" : "operations"
        let path = "v1/items/\(acknowledgement.itemID.uuidString.lowercased())/\(resource)/\(acknowledgement.operationID.uuidString.lowercased())/ack"
        let body = try acknowledgement.preparationOperationID.map {
            try JSONSerialization.data(withJSONObject: ["publicationProtocol": "prepared-item-v1", "preparationOperationId": $0.uuidString.lowercased()])
        }
        _ = try await send(request(path: path, method: "POST", body: body), expectedStatus: 204)
    }

    func deleteItem(_ id: UUID) async throws {
        _ = try await send(request(path: "v1/items/\(id.uuidString.lowercased())", method: "DELETE"), expectedStatus: 204)
    }

    func mode() async throws -> ProcessingMode {
        struct Health: Decodable { let mode: ProcessingMode }
        let data = try await send(request(path: "health"))
        return try JSONDecoder().decode(Health.self, from: data).mode
    }

    func submit(_ item: WardrobeItem, photo: Data) async throws -> ItemResponse {
        var payload: [String: Any] = [
            "itemId": item.id.uuidString.lowercased(),
            "operationId": item.operationID.uuidString.lowercased(),
            "photoVersionId": item.photoVersionID.uuidString.lowercased(),
            "imageBase64": photo.base64EncodedString()
        ]
        let path: String
        if item.revision == 0 {
            path = "v1/items"
        } else {
            path = "v1/items/\(item.directoryName)/attempts"
            payload["action"] = item.action.rawValue
            payload["revision"] = item.revision
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let data = try await send(request(path: path, method: "POST", body: body))
        let result = try JSONDecoder().decode(ItemResponse.self, from: data)
        try result.validate(for: item)
        return result
    }

    func status(_ item: WardrobeItem) async throws -> ItemResponse {
        let data = try await send(request(path: "v1/items/\(item.directoryName)/operations/\(item.operationID.uuidString.lowercased())"))
        let result = try JSONDecoder().decode(ItemResponse.self, from: data)
        try result.validate(for: item)
        return result
    }

    func result(_ item: WardrobeItem, response: ItemResponse) async throws -> Data {
        try response.validate(for: item)
        let path = "v1/items/\(item.directoryName)/operations/\(item.operationID.uuidString.lowercased())/result"
        guard response.status == .ready, response.resultPath == "/" + path else {
            throw ClientError.invalidResponse
        }
        return try await send(request(path: path))
    }
    struct Health: Decodable {
        let mode: ProcessingMode
        let illustrationAvailable: Bool?
    }

    func health() async throws -> Health {
        try JSONDecoder().decode(Health.self, from: await send(request(path: "health")))
    }

    func submitIllustration(_ item: WardrobeItem, request intent: IllustrationRequest, photos: [[String: String]]) async throws -> IllustrationResponse {
        var payload: [String: Any] = [
            "operationId": intent.operationID.uuidString.lowercased(),
            "photoVersionId": intent.photoVersionID.uuidString.lowercased(),
            "sourceSetVersionId": intent.sourceSetVersionID.uuidString.lowercased(),
            "revision": intent.revision, "photos": photos
        ]
        if let type = intent.manualType { payload["manualType"] = type }
        if let colors = intent.manualColors { payload["manualColors"] = colors }
        if let previous = item.publishedVersion, let result = previous.illustration,
           result.response.photoVersionId == item.photoVersionID,
           result.response.sourceSetVersionId == item.sourceSetVersionID,
           let observed = result.response.observedFeatures {
            var reuse: [String: Any] = [
                "previousIllustrationOperationId": result.response.operationId.uuidString.lowercased(),
                "sourceSetVersionId": item.sourceSetVersionID.uuidString.lowercased(),
                "observedFeatures": try JSONSerialization.jsonObject(with: JSONEncoder().encode(observed))
            ]
            if let digest = previous.representation?.response.artifacts?.observedFeaturesSHA256 ?? result.response.observedFeaturesSHA256 {
                reuse["observedFeaturesSHA256"] = digest
            } else { reuse["legacyImport"] = true }
            payload["reuseObserved"] = reuse
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        guard body.count <= 16 * 1024 * 1024 else { throw ClientError.resultUnavailable("illustration_payload_too_large") }
        let data = try await send(request(path: "v1/items/\(item.directoryName)/illustrations", method: "POST", body: body))
        let response = try JSONDecoder().decode(IllustrationResponse.self, from: data)
        try response.validate(for: item, request: intent)
        return response
    }

    func illustrationStatus(_ item: WardrobeItem, request intent: IllustrationRequest) async throws -> IllustrationResponse {
        let data = try await send(request(path: "v1/items/\(item.directoryName)/illustrations/\(intent.operationID.uuidString.lowercased())"))
        let response = try JSONDecoder().decode(IllustrationResponse.self, from: data)
        try response.validate(for: item, request: intent)
        return response
    }

    func illustrationResult(_ item: WardrobeItem, request intent: IllustrationRequest, response: IllustrationResponse) async throws -> Data {
        try response.validate(for: item, request: intent)
        let path = "v1/items/\(item.directoryName)/illustrations/\(intent.operationID.uuidString.lowercased())/result"
        guard response.status == .ready, response.resultPath == "/" + path else { throw ClientError.invalidResponse }
        return try await send(request(path: path))
    }

    func preparedIllustrationSource(_ item: WardrobeItem, request intent: IllustrationRequest,
                                    response: IllustrationResponse, source: IllustrationPreparedSource) async throws -> Data {
        try response.validate(for: item, request: intent)
        let path = "v1/items/\(item.directoryName)/illustrations/\(intent.operationID.uuidString.lowercased())/sources/\(source.photoId.uuidString.lowercased())/prepared"
        guard response.status == .ready, source.preparedPath == "/" + path else { throw ClientError.invalidResponse }
        return try await send(request(path: path))
    }

}

extension BackendClient {
    func recommendationConfiguration() async throws -> RecommendationConfiguration {
        let config = try JSONDecoder().decode(RecommendationConfiguration.self,
            from: await send(request(path: "v1/recommendations/config")))
        guard config.protocolVersion == 1, config.publicationProtocol == "prepared-item-v1",
              config.preparationRequired, config.representationEncoding == "opaque-json-string-v1" else { throw ClientError.invalidResponse }
        if config.encoder.available {
            guard let active = config.encoder.activeSpaceID, config.encoder.supportedSpaceIDs.contains(active),
                  ["real", "controlled"].contains(config.encoder.mode) else { throw ClientError.invalidResponse }
        }
        return config
    }

    func submitPreparation(_ item: WardrobeItem, intent: ItemPreparation, original: Data,
                           legacyCutout: Data?, legacyIllustration: Data?) async throws -> PreparationResponse {
        var payload: [String: Any] = [
            "operationId": intent.operationID.uuidString.lowercased(), "revision": intent.revision,
            "photoVersionId": intent.publication.photoVersionID.uuidString.lowercased(),
            "sourceSetVersionId": intent.publication.sourceSetVersionID.uuidString.lowercased(),
            "illustrationOperationId": intent.request.operationID.uuidString.lowercased(),
            "cutoutOperationId": intent.cutoutOperationID.uuidString.lowercased(),
            "spaceID": intent.spaceID, "mode": intent.mode.rawValue,
            "imageBase64": original.base64EncodedString(),
            "features": try JSONSerialization.jsonObject(with: JSONEncoder().encode(intent.features))
        ]
        if intent.mode == .reusePublication {
            payload["reuse"] = ["publicationId": intent.publication.versionID.uuidString.lowercased(),
                "artifacts": try JSONSerialization.jsonObject(with: JSONEncoder().encode(intent.artifacts))]
        } else if intent.mode == .legacyImport {
            guard let legacyCutout, let legacyIllustration, let illustration = intent.publication.illustration else {
                throw ClientError.resultUnavailable("local_artifact_missing")
            }
            payload["legacy"] = [
                "cutout": ["imageBase64": legacyCutout.base64EncodedString(), "mode": intent.publication.cutoutMode?.rawValue ?? "demo"],
                "illustration": ["imageBase64": legacyIllustration.base64EncodedString(),
                    "response": try JSONSerialization.jsonObject(with: JSONEncoder().encode(illustration.response))],
                "preparedPhotos": intent.preparedPhotos.map { photo in
                    ["photoId": photo.photoID.uuidString.lowercased(), "sourceSHA256": photo.sourceDigest,
                     "preparedSHA256": photo.preparedDigest,
                     "versions": ["modelVersion": photo.modelVersion, "templateVersion": photo.templateVersion, "geometryVersion": photo.geometryVersion]] as [String: Any]
                }
            ]
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        guard original.count <= 5 * 1024 * 1024,
              body.count <= (intent.mode == .legacyImport ? 36 : 8) * 1024 * 1024 else { throw ClientError.oversizedPhoto }
        let data = try await send(request(path: "v1/items/\(item.directoryName)/preparations", method: "POST", body: body))
        let response = try JSONDecoder().decode(PreparationResponse.self, from: data)
        try response.validate(for: item.id, intent: intent)
        return response
    }

    func preparationStatus(_ item: WardrobeItem, intent: ItemPreparation) async throws -> PreparationResponse {
        let data = try await send(request(path: "v1/items/\(item.directoryName)/preparations/\(intent.operationID.uuidString.lowercased())"))
        let response = try JSONDecoder().decode(PreparationResponse.self, from: data)
        try response.validate(for: item.id, intent: intent)
        return response
    }
}
