import Foundation

/// Réglages du découpage de la parole en phrases. Durées en secondes, niveaux en dBFS.
/// C'est ici qu'on règle le compromis réactivité / phrases complètes.
struct SegmenterTuning: Sendable {
    /// Silence qui clôt une phrase. Plus court = traductions plus rapides mais phrases plus hachées.
    var endSilence: Double = 0.45
    /// Durée maximale d'un extrait pendant un long monologue : au-delà, on coupe au point le plus calme
    /// pour que les traductions continuent d'arriver pendant que la personne parle.
    var maxSegment: Double = 5.0
    /// Fenêtre (en fin d'extrait) où l'on cherche ce point calme.
    var cutSearchWindow: Double = 1.5
    /// Audio conservé avant le début détecté de la parole (évite de manger la première syllabe).
    var preRoll: Double = 0.4
    /// Silence conservé à la fin d'une phrase.
    var tailKeep: Double = 0.3
    /// En dessous de cette durée de parole effective, l'extrait est ignoré (claquement, klaxon bref).
    var minVoiced: Double = 0.2
    /// Marges au-dessus du bruit de fond pour déclencher puis maintenir la détection de parole.
    var startMarginDB: Float = 8
    var keepMarginDB: Float = 5
    /// Niveau absolu sous lequel rien n'est considéré comme de la parole.
    var absoluteFloorDB: Float = -58
    /// Fenêtre glissante d'estimation du bruit de fond (rue, motos, ventilation…).
    var noiseWindow: Double = 2.5
}

/// Un extrait de parole, 16 kHz mono.
struct SpeechSegment: Sendable {
    let samples: [Float]
    var duration: Double { Double(samples.count) / Double(SpeechSegmenter.sampleRate) }
}

/// Détecteur de parole par énergie, avec bruit de fond adaptatif (percentile glissant).
/// Code pur, sans dépendance iOS : il tourne sur le thread audio et ne bloque jamais.
struct SpeechSegmenter {
    static let sampleRate = 16_000
    /// 20 ms par trame.
    static let frameLength = 320
    private static let startFrames = 3
    private static let calibrationFrames = 10

    /// Niveau du micro pour l'interface (0…1).
    private(set) var level: Float = 0

    private let tuning: SegmenterTuning
    private let endSilenceFrames: Int
    private let maxFrames: Int
    private let cutWindowFrames: Int
    private let idleCapacity: Int
    private let tailKeepFrames: Int
    private let minVoicedFrames: Int
    private let historySize: Int

    private var pending: [Float] = []
    private var history: [Float] = []
    private var historyCursor = 0
    private var noiseFloor: Float = -60
    private var framesSeen = 0

    // Hors parole : dernières trames gardées pour le pré-roll.
    private var idleSamples: [Float] = []
    private var idleEnergies: [Float] = []
    private var idleVoiced: [Bool] = []
    private var speechRun = 0

    // Phrase en cours.
    private var inSpeech = false
    private var samples: [Float] = []
    private var energies: [Float] = []
    private var voiced: [Bool] = []
    private var silenceRun = 0

    init(tuning: SegmenterTuning = SegmenterTuning()) {
        self.tuning = tuning
        let frameDuration = Double(Self.frameLength) / Double(Self.sampleRate)
        endSilenceFrames = max(1, Int((tuning.endSilence / frameDuration).rounded()))
        maxFrames = max(20, Int((tuning.maxSegment / frameDuration).rounded()))
        cutWindowFrames = min(maxFrames - 1, max(1, Int((tuning.cutSearchWindow / frameDuration).rounded())))
        idleCapacity = max(0, Int((tuning.preRoll / frameDuration).rounded())) + Self.startFrames
        tailKeepFrames = max(0, Int((tuning.tailKeep / frameDuration).rounded()))
        minVoicedFrames = max(1, Int((tuning.minVoiced / frameDuration).rounded()))
        historySize = max(25, Int((tuning.noiseWindow / frameDuration).rounded()))
    }

    /// Ajoute des échantillons (16 kHz mono) et renvoie les phrases terminées.
    mutating func process(_ input: UnsafeBufferPointer<Float>) -> [SpeechSegment] {
        pending.append(contentsOf: input)
        var output: [SpeechSegment] = []
        var peak: Float = -1
        var offset = 0
        let frameLength = Self.frameLength
        while pending.count - offset >= frameLength {
            let frame = Array(pending[offset ..< offset + frameLength])
            let (segment, frameLevel) = handleFrame(frame)
            if let segment { output.append(segment) }
            peak = max(peak, frameLevel)
            offset += frameLength
        }
        if offset > 0 { pending.removeFirst(offset) }
        if peak >= 0 { level = peak }
        return output
    }

    /// À l'arrêt de l'écoute : rend la phrase en cours, même incomplète.
    mutating func flush() -> SpeechSegment? {
        defer {
            resetSegment()
            speechRun = 0
            idleSamples.removeAll()
            idleEnergies.removeAll()
            idleVoiced.removeAll()
            pending.removeAll()
        }
        guard inSpeech else { return nil }
        let end = energies.count - silenceRun + min(silenceRun, tailKeepFrames)
        return makeSegment(frameCount: end)
    }

    // MARK: - Trame par trame

    private mutating func handleFrame(_ frame: [Float]) -> (SpeechSegment?, Float) {
        let db = Self.decibels(frame)
        let uiLevel = min(1, max(0, (db + 60) / 50))
        framesSeen += 1
        pushHistory(db)

        // Calibration : les premières trames servent à estimer le bruit ambiant.
        if framesSeen <= Self.calibrationFrames {
            noiseFloor = percentileFloor()
            pushIdle(frame, db, false)
            return (nil, uiLevel)
        }

        let isStart = db > max(noiseFloor + tuning.startMarginDB, tuning.absoluteFloorDB)
        let isKeep = db > max(noiseFloor + tuning.keepMarginDB, tuning.absoluteFloorDB)
        noiseFloor = noiseFloor * 0.8 + percentileFloor() * 0.2

        if !inSpeech {
            pushIdle(frame, db, isKeep)
            speechRun = isStart ? speechRun + 1 : 0
            if speechRun >= Self.startFrames {
                // Début de parole : la phrase démarre avec le pré-roll.
                inSpeech = true
                samples = idleSamples
                energies = idleEnergies
                voiced = idleVoiced
                idleSamples.removeAll(keepingCapacity: true)
                idleEnergies.removeAll(keepingCapacity: true)
                idleVoiced.removeAll(keepingCapacity: true)
                silenceRun = 0
                speechRun = 0
            }
            return (nil, uiLevel)
        }

        samples.append(contentsOf: frame)
        energies.append(db)
        voiced.append(isKeep)
        silenceRun = isKeep ? 0 : silenceRun + 1

        // Fin de phrase : assez de silence.
        if silenceRun >= endSilenceFrames {
            let total = energies.count
            let end = total - silenceRun + min(silenceRun, tailKeepFrames)
            let segment = makeSegment(frameCount: end)
            // Le silence de fin sert de pré-roll à la phrase suivante.
            let keepFrom = max(end, total - idleCapacity)
            idleSamples = Array(samples[(keepFrom * Self.frameLength)...])
            idleEnergies = Array(energies[keepFrom...])
            idleVoiced = Array(voiced[keepFrom...])
            resetSegment()
            return (segment, uiLevel)
        }

        // Monologue trop long : coupe au point le plus calme des dernières secondes.
        if energies.count >= maxFrames {
            let total = energies.count
            var cut = total - cutWindowFrames
            for index in cut ..< total where energies[index] < energies[cut] {
                cut = index
            }
            let end = cut + 1
            let segment = makeSegment(frameCount: end)
            samples.removeFirst(end * Self.frameLength)
            energies.removeFirst(end)
            voiced.removeFirst(end)
            silenceRun = voiced.reversed().prefix(while: { !$0 }).count
            return (segment, uiLevel)
        }

        return (nil, uiLevel)
    }

    private func makeSegment(frameCount: Int) -> SpeechSegment? {
        let count = min(max(frameCount, 0), energies.count)
        guard voiced.prefix(count).lazy.filter({ $0 }).count >= minVoicedFrames else { return nil }
        return SpeechSegment(samples: Array(samples.prefix(count * Self.frameLength)))
    }

    private mutating func resetSegment() {
        inSpeech = false
        samples.removeAll(keepingCapacity: true)
        energies.removeAll(keepingCapacity: true)
        voiced.removeAll(keepingCapacity: true)
        silenceRun = 0
    }

    private mutating func pushIdle(_ frame: [Float], _ db: Float, _ isVoiced: Bool) {
        idleSamples.append(contentsOf: frame)
        idleEnergies.append(db)
        idleVoiced.append(isVoiced)
        let excess = idleEnergies.count - idleCapacity
        if excess > 0 {
            idleSamples.removeFirst(excess * Self.frameLength)
            idleEnergies.removeFirst(excess)
            idleVoiced.removeFirst(excess)
        }
    }

    private mutating func pushHistory(_ db: Float) {
        if history.count < historySize {
            history.append(db)
        } else {
            history[historyCursor] = db
            historyCursor = (historyCursor + 1) % historySize
        }
    }

    /// Bruit de fond = 15e percentile des niveaux récents : la parole a toujours des creux,
    /// le bruit ambiant fixe le plancher.
    private func percentileFloor() -> Float {
        guard !history.isEmpty else { return -60 }
        let sorted = history.sorted()
        let value = sorted[sorted.count * 15 / 100]
        return min(max(value, -85), -25)
    }

    static func decibels(_ frame: [Float]) -> Float {
        guard !frame.isEmpty else { return -120 }
        var sum: Float = 0
        for sample in frame { sum += sample * sample }
        let rms = (sum / Float(frame.count)).squareRoot()
        return 20 * log10(max(rms, 1e-6))
    }
}
