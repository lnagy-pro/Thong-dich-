import Foundation
import Observation

/// Niveau de tension estimé par Gemini pour une réplique.
enum Tone: Int, Sendable {
    case calm = 0
    case tense = 1
    case hostile = 2
    case threat = 3
}

/// Une phrase captée : son audio (gardé jusqu'à ce que la traduction réussisse),
/// sa transcription vietnamienne et sa traduction française.
@MainActor
@Observable
final class Line: Identifiable {
    enum Status: Equatable {
        case waiting
        case streaming
        case done
        case failed(String)
    }

    let id = UUID()
    let createdAt = Date()
    let duration: TimeInterval

    var vietnamese = ""
    var french = ""
    var tone: Tone?
    var status: Status = .waiting

    /// Audio WAV de la phrase, conservé tant que la traduction n'a pas réussi.
    @ObservationIgnored var wav: Data?
    /// Échec réseau : la phrase sera relancée automatiquement dès qu'une traduction repasse.
    @ObservationIgnored var autoRetry = false

    init(segment: CapturedSegment) {
        duration = segment.duration
        wav = segment.wav
    }
}
