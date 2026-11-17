import SwiftUI
import UIKit
import AVFoundation
import Observation

/// Chef d'orchestre. L'écoute (AudioCapture) et la traduction (GeminiClient) sont découplées :
/// chaque phrase captée part aussitôt en traduction, en parallèle des précédentes,
/// pendant que le micro continue d'écouter. Aucun moment de la conversation n'est sauté.
@MainActor
@Observable
final class TranslatorModel {
    static let shared = TranslatorModel()

    private(set) var lines: [Line] = []
    private(set) var isListening = false
    private(set) var level: Float = 0
    private(set) var inputName = ""
    private(set) var inFlight = 0
    /// Change à chaque mise à jour de texte (sert au défilement automatique).
    private(set) var updateTick = 0
    /// Change quand une menace est détectée (vibration).
    private(set) var threatTick = 0

    var errorMessage: String?
    var showSettings = false
    var settings = AppSettings()

    var showError: Bool {
        get { errorMessage != nil }
        set { if !newValue { errorMessage = nil } }
    }

    var statusText: String {
        guard isListening else { return "En pause" }
        return inFlight > 0 ? "\(inputName) · \(inFlight) en cours" : inputName
    }

    private let capture = AudioCapture()
    private let gemini = GeminiClient()

    private init() {
        // Les rappels du micro arrivent sur le thread audio : on repasse sur le thread principal,
        // dans l'ordre d'arrivée (file principale = FIFO).
        capture.onSegment = { [weak self] segment in
            guard let self else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.enqueue(segment) }
            }
        }
        capture.onLevel = { [weak self] level in
            guard let self else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.level = level }
            }
        }
        capture.onStatus = { [weak self] status in
            guard let self else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.inputName = status }
            }
        }
        if settings.apiKey.isEmpty { showSettings = true }
    }

    // MARK: - Écoute

    func toggle() async {
        if isListening {
            stop()
        } else {
            await start()
        }
    }

    func start() async {
        guard !isListening else { return }
        guard !settings.apiKey.isEmpty else {
            showSettings = true
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            errorMessage = "Accès au micro refusé. Autorisez-le dans Réglages › Thông Dịch › Micro."
            return
        }
        guard !isListening else { return }
        do {
            try capture.start(source: settings.micSource)
            isListening = true
            inputName = capture.currentInputName
            UIApplication.shared.isIdleTimerDisabled = true
            warmUp()
        } catch {
            errorMessage = "Impossible de démarrer le micro : \(error.localizedDescription)"
        }
    }

    func stop() {
        guard isListening else { return }
        capture.stop() // envoie aussi la phrase en cours
        isListening = false
        level = 0
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func micSourceChanged() {
        capture.switchSource(settings.micSource)
        if isListening { inputName = capture.currentInputName }
    }

    /// Ouvre la connexion vers Google à l'avance : la première phrase ne paie pas la poignée de main.
    func warmUp() {
        guard !settings.apiKey.isEmpty else { return }
        let key = settings.apiKey
        let model = settings.model
        Task.detached(priority: .utility) { [gemini] in
            _ = await gemini.checkKey(apiKey: key, model: model)
        }
    }

    // MARK: - Traduction

    func retry(_ line: Line) {
        translate(line)
    }

    func clear() {
        lines.removeAll()
        updateTick &+= 1
    }

    private func enqueue(_ segment: CapturedSegment) {
        let line = Line(segment: segment)
        lines.append(line)
        translate(line)
    }

    private func translate(_ line: Line) {
        guard let wav = line.wav else { return }
        let request = TranslationRequest(
            wav: wav,
            context: recentContext(before: line),
            apiKey: settings.apiKey,
            model: settings.model,
            priority: settings.priority
        )
        line.status = .waiting
        line.autoRetry = false
        inFlight += 1
        updateTick &+= 1

        Task {
            defer { inFlight -= 1 }
            var latest = ""
            do {
                for try await text in gemini.translate(request) {
                    latest = text
                    let parsed = ResponseParser.parse(text)
                    line.vietnamese = parsed.vietnamese
                    line.french = parsed.french
                    if line.status != .streaming { line.status = .streaming }
                    updateTick &+= 1
                }
                finish(line, raw: latest)
                retryFailedLines()
            } catch {
                line.status = .failed(GeminiError.message(for: error))
                line.autoRetry = GeminiError.isTransient(error)
                updateTick &+= 1
            }
        }
    }

    private func finish(_ line: Line, raw: String) {
        let parsed = ResponseParser.parse(raw)
        guard !parsed.isNoSpeech else {
            // Bruit, musique, silence : la ligne disparaît.
            lines.removeAll { $0 === line }
            updateTick &+= 1
            return
        }
        line.vietnamese = parsed.vietnamese
        line.french = parsed.french.isEmpty ? "(pas de traduction)" : parsed.french
        line.tone = parsed.tone.flatMap(Tone.init(rawValue:))
        line.status = .done
        line.wav = nil
        if line.tone == .threat { threatTick &+= 1 }
        updateTick &+= 1
    }

    /// Le réseau est revenu : on relance les phrases perdues pendant la coupure.
    private func retryFailedLines() {
        for line in lines where line.autoRetry {
            if case .failed = line.status { translate(line) }
        }
    }

    /// Jusqu'à 4 répliques déjà traduites dans les 2 dernières minutes, envoyées en texte seulement.
    private func recentContext(before line: Line) -> [ContextLine] {
        guard let index = lines.lastIndex(where: { $0 === line }) else { return [] }
        let cutoff = line.createdAt.addingTimeInterval(-120)
        var result: [ContextLine] = []
        var cursor = index - 1
        while cursor >= 0, result.count < 4 {
            let previous = lines[cursor]
            if previous.createdAt < cutoff { break }
            if previous.status == .done, !previous.french.isEmpty {
                result.insert(ContextLine(vietnamese: previous.vietnamese, french: previous.french), at: 0)
            }
            cursor -= 1
        }
        return result
    }

    // MARK: - Clé API

    /// Enregistre la clé puis la vérifie auprès de Google. Renvoie un message d'erreur, ou nil si tout va bien.
    func saveKey(_ key: String) async -> String? {
        settings.apiKey = key
        switch await gemini.checkKey(apiKey: key, model: settings.model) {
        case .ok, .unreachable:
            return nil
        case .invalidKey:
            return "Clé refusée par Google. Vérifiez qu'elle a été copiée en entier."
        case .unknownModel:
            return "Ce modèle n'est pas accessible avec cette clé : choisissez-en un autre."
        }
    }
}
