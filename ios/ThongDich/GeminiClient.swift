import Foundation

/// Modèles proposés. Tous acceptent l'audio en entrée et un raisonnement minimal (= réponse immédiate).
enum GeminiModel: String, CaseIterable, Identifiable, Sendable {
    case fast = "gemini-3.5-flash-lite"
    case balanced = "gemini-3.6-flash"
    case precise = "gemini-3.8-flash"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fast: return "Ultra-rapide"
        case .balanced: return "Équilibré"
        case .precise: return "Précis"
        }
    }

    var subtitle: String {
        switch self {
        case .fast: return "Gemini 3.5 Flash-Lite · latence minimale"
        case .balanced: return "Gemini 3.6 Flash · rapide et fiable (recommandé)"
        case .precise: return "Gemini 3.8 Flash · plus fin sur les accents, un peu plus lent"
        }
    }

    /// Niveau de raisonnement le plus bas accepté par chaque modèle.
    var thinkingLevel: String {
        self == .precise ? "low" : "minimal"
    }
}

struct ContextLine: Sendable {
    let vietnamese: String
    let french: String
}

struct TranslationRequest: Sendable {
    let wav: Data
    let context: [ContextLine]
    let apiKey: String
    let model: GeminiModel
    let priority: Bool
}

enum KeyCheck: Sendable {
    case ok
    case invalidKey
    case unknownModel
    case unreachable
}

enum GeminiError: LocalizedError {
    case http(status: Int, message: String)
    case stream(String)
    case emptyResponse

    var errorDescription: String? {
        switch self {
        case .http(let status, let message):
            switch status {
            case 400 where message.localizedCaseInsensitiveContains("api key"):
                return "Clé API invalide : vérifiez-la dans les réglages."
            case 401, 403:
                return "Clé API refusée : vérifiez-la dans les réglages."
            case 404:
                return "Modèle introuvable : choisissez-en un autre dans les réglages."
            case 429:
                return "Quota Gemini atteint. Activez la facturation sur le projet de la clé (Google AI Studio)."
            case 500...599:
                return "Gemini est momentanément indisponible."
            default:
                return "Erreur Gemini \(status) : \(message)"
            }
        case .stream(let message):
            return "Gemini : \(message)"
        case .emptyResponse:
            return "Réponse vide de Gemini."
        }
    }

    /// Erreur 400 qui ne concerne pas la clé : sans doute un paramètre refusé par ce modèle ou ce niveau de compte.
    var isCompatibilityIssue: Bool {
        if case .http(400, let message) = self {
            return !message.localizedCaseInsensitiveContains("api key")
        }
        return false
    }

    var isQuota: Bool {
        if case .http(429, _) = self { return true }
        return false
    }

    static func isTransient(_ error: Error) -> Bool {
        if let error = error as? GeminiError {
            switch error {
            case .http(let status, _):
                return status == 408 || status == 429 || (500...599).contains(status)
            case .stream, .emptyResponse:
                return true
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed:
                return true
            default:
                return false
            }
        }
        return false
    }

    static func message(for error: Error) -> String {
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .dataNotAllowed, .networkConnectionLost:
                return "Pas de connexion. L'audio est gardé et repartira dès que le réseau revient."
            case .timedOut:
                return "Délai dépassé (réseau lent)."
            default:
                return "Réseau : \(error.localizedDescription)"
            }
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

/// Un seul appel par phrase : l'audio part avec la consigne, Gemini renvoie en streaming
/// la transcription puis la traduction. Les appels sont indépendants et tournent en parallèle.
final class GeminiClient: @unchecked Sendable {
    private static let base = "https://generativelanguage.googleapis.com/v1beta"

    /// Une seule session : la connexion HTTP/2 vers Google reste ouverte et sert à tous les appels
    /// (pas de nouvelle poignée de main TLS à chaque phrase).
    private let session: URLSession
    private let lock = NSLock()
    private var compatibilityMode = false

    /// Mode dégradé activé si l'API refuse un paramètre optionnel (niveau prioritaire, réglages de sécurité…).
    private var compatMode: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return compatibilityMode
        }
        set {
            lock.lock()
            compatibilityMode = newValue
            lock.unlock()
        }
    }

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    /// Vérifie la clé et le modèle ; sert aussi à « préchauffer » la connexion avant la première phrase.
    func checkKey(apiKey: String, model: GeminiModel) async -> KeyCheck {
        guard let url = URL(string: "\(Self.base)/models/\(model.rawValue)") else { return .unreachable }
        var request = URLRequest(url: url)
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.timeoutInterval = 10
        do {
            let (_, response) = try await session.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200, 429: return .ok
            case 400, 401, 403: return .invalidKey
            case 404: return .unknownModel
            default: return .unreachable
            }
        } catch {
            return .unreachable
        }
    }

    /// Flux du texte cumulé (« VI: … FR: … ») au fil de la génération. Réessaie seul sur les erreurs passagères.
    func translate(_ request: TranslationRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var attempt = 0
                while !Task.isCancelled {
                    attempt += 1
                    do {
                        try await self.streamOnce(request, compat: self.compatMode, continuation: continuation)
                        continuation.finish()
                        return
                    } catch let error as GeminiError where error.isCompatibilityIssue && !self.compatMode {
                        self.compatMode = true
                    } catch {
                        guard attempt < 3, GeminiError.isTransient(error), !Task.isCancelled else {
                            continuation.finish(throwing: error)
                            return
                        }
                        let isQuota = (error as? GeminiError)?.isQuota ?? false
                        let delay = isQuota ? 1.5 * Double(attempt) : 0.4 * Double(attempt)
                        try? await Task.sleep(for: .seconds(delay))
                    }
                }
                continuation.finish(throwing: CancellationError())
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Requête

    private func streamOnce(_ request: TranslationRequest,
                            compat: Bool,
                            continuation: AsyncThrowingStream<String, Error>.Continuation) async throws {
        let urlRequest = try makeRequest(request, compat: compat)
        let (bytes, response) = try await session.bytes(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw GeminiError.stream("réponse invalide")
        }
        guard http.statusCode == 200 else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > 16_384 { break }
            }
            throw GeminiError.http(status: http.statusCode, message: Self.errorMessage(from: body))
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        var text = ""
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let event = try? decoder.decode(StreamEvent.self, from: data) else { continue }
            switch event.eventType {
            case "step.start":
                // Le début du texte peut arriver dans l'ouverture de l'étape, avant le premier delta.
                if event.step?.type != "thought", let items = event.step?.content {
                    let piece = items.filter { $0.type == "text" }.compactMap(\.text).joined()
                    if !piece.isEmpty {
                        text += piece
                        continuation.yield(text)
                    }
                }
            case "step.delta":
                if event.delta?.type == "text", let piece = event.delta?.text, !piece.isEmpty {
                    text += piece
                    continuation.yield(text)
                }
            case "error":
                throw GeminiError.stream(event.error?.message ?? "erreur inconnue")
            case "interaction.completed":
                if event.interaction?.status == "failed" {
                    throw GeminiError.stream("échec de la génération")
                }
            default:
                break
            }
        }
        if text.isEmpty { throw GeminiError.emptyResponse }
    }

    private func makeRequest(_ request: TranslationRequest, compat: Bool) throws -> URLRequest {
        let body = InteractionBody(
            model: request.model.rawValue,
            systemInstruction: TranslationPrompt.system,
            input: [
                .init(type: "text", text: TranslationPrompt.userText(context: request.context)),
                .init(type: "audio", data: request.wav.base64EncodedString(), mimeType: "audio/wav")
            ],
            generationConfig: .init(
                thinkingLevel: compat ? nil : request.model.thinkingLevel,
                maxOutputTokens: 1_024
            ),
            safetySettings: compat ? nil : InteractionBody.permissiveSafety,
            serviceTier: request.priority && !compat ? "priority" : nil,
            store: false,
            stream: true
        )
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.withoutEscapingSlashes]

        guard let url = URL(string: "\(Self.base)/interactions") else { throw URLError(.badURL) }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 20
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        urlRequest.setValue(request.apiKey, forHTTPHeaderField: "x-goog-api-key")
        urlRequest.httpBody = try encoder.encode(body)
        return urlRequest
    }

    private static func errorMessage(from body: Data) -> String {
        let json = try? JSONSerialization.jsonObject(with: body)
        if let object = json as? [String: Any] {
            if let error = object["error"] as? [String: Any], let message = error["message"] as? String {
                return message
            }
            if let message = object["message"] as? String { return message }
        }
        if let list = json as? [[String: Any]],
           let error = list.first?["error"] as? [String: Any],
           let message = error["message"] as? String {
            return message
        }
        return String(decoding: body.prefix(300), as: UTF8.self)
    }
}

// MARK: - Format de l'Interactions API (v1beta)

private struct InteractionBody: Encodable {
    struct Item: Encodable {
        let type: String
        var text: String? = nil
        var data: String? = nil
        var mimeType: String? = nil
    }

    struct GenerationConfig: Encodable {
        let thinkingLevel: String?
        let maxOutputTokens: Int
    }

    struct Safety: Encodable, Sendable {
        let type: String
        let threshold: String
    }

    /// Une dispute contient des insultes et des menaces : elles doivent être traduites, pas filtrées.
    static let permissiveSafety: [Safety] = ["harassment", "hate_speech", "sexually_explicit", "dangerous_content"]
        .map { Safety(type: $0, threshold: "off") }

    let model: String
    let systemInstruction: String
    let input: [Item]
    let generationConfig: GenerationConfig
    let safetySettings: [Safety]?
    let serviceTier: String?
    /// Rien n'est conservé chez Google.
    let store: Bool
    let stream: Bool
}

private struct StreamEvent: Decodable {
    struct Delta: Decodable {
        let type: String?
        let text: String?
    }

    struct Failure: Decodable {
        let message: String?
    }

    struct Interaction: Decodable {
        let status: String?
    }

    struct Step: Decodable {
        let type: String?
        let content: [Delta]?
    }

    let eventType: String?
    let step: Step?
    let delta: Delta?
    let error: Failure?
    let interaction: Interaction?
}
