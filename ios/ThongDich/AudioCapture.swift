import AVFoundation

/// Source micro choisie dans les réglages.
enum MicSource: String, CaseIterable, Identifiable, Sendable {
    case iPhone
    case bluetooth

    var id: String { rawValue }

    var label: String {
        switch self {
        case .iPhone: return "iPhone"
        case .bluetooth: return "AirPods / Bluetooth"
        }
    }
}

/// Une phrase prête à partir en traduction.
struct CapturedSegment: Sendable {
    let wav: Data
    let duration: TimeInterval
}

/// Drapeau partagé avec le bloc d'entrée du convertisseur (bloc @Sendable : pas de `var` capturée).
private final class ConverterFeed: @unchecked Sendable {
    var supplied = false
}

enum CaptureError: LocalizedError {
    case noInput
    case unsupportedFormat

    var errorDescription: String? {
        switch self {
        case .noInput: return "Aucun micro disponible."
        case .unsupportedFormat: return "Format audio du micro non pris en charge."
        }
    }
}

/// Capture continue du micro → 16 kHz mono → découpage en phrases → WAV.
/// Tout se passe sur le thread audio, sans jamais attendre le réseau : l'écoute est
/// totalement indépendante de la traduction, aucune parole n'est perdue pendant qu'on traduit.
final class AudioCapture: @unchecked Sendable {
    /// Appelé hors du thread principal à chaque phrase détectée.
    var onSegment: (@Sendable (CapturedSegment) -> Void)?
    /// Appelé hors du thread principal environ 12 fois par seconde (niveau 0…1).
    var onLevel: (@Sendable (Float) -> Void)?
    /// Nom du micro réellement utilisé, ou message d'état (interruption, erreur).
    var onStatus: (@Sendable (String) -> Void)?

    private var engine = AVAudioEngine()
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                             sampleRate: Double(SpeechSegmenter.sampleRate),
                                             channels: 1,
                                             interleaved: false)!

    // Partagé avec le thread audio, protégé par `lock`.
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var segmenter = SpeechSegmenter()
    // Utilisé uniquement sur le thread audio.
    private var lastLevelReport: CFAbsoluteTime = 0

    // Utilisés uniquement sur le thread principal.
    private var running = false
    private var source: MicSource = .iPhone
    private var observers: [NSObjectProtocol] = []

    var currentInputName: String {
        guard let input = AVAudioSession.sharedInstance().currentRoute.inputs.first else { return "Micro" }
        return input.portType == .builtInMic ? "Micro de l'iPhone" : input.portName
    }

    // MARK: - Démarrage / arrêt (thread principal)

    func start(source: MicSource) throws {
        guard !running else { return }
        self.source = source
        try configureSession()
        try startEngine()
        running = true
        addObservers()
    }

    func stop() {
        guard running else { return }
        running = false
        removeObservers()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        lock.lock()
        let last = segmenter.flush()
        segmenter = SpeechSegmenter()
        converter = nil
        lock.unlock()

        if let last { onSegment?(Self.package(last)) }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func switchSource(_ newSource: MicSource) {
        source = newSource
        restart()
    }

    // MARK: - Session audio

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        switch source {
        case .iPhone:
            try session.setCategory(.record, mode: .measurement, options: [])
        case .bluetooth:
            do {
                try session.setCategory(.record, mode: .measurement, options: Self.bluetoothOptions(highQuality: true))
            } catch {
                try session.setCategory(.record, mode: .measurement, options: Self.bluetoothOptions(highQuality: false))
            }
        }
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)

        let wanted: AVAudioSession.Port = source == .iPhone ? .builtInMic : .bluetoothHFP
        if let port = session.availableInputs?.first(where: { $0.portType == wanted }) {
            try? session.setPreferredInput(port)
        }
    }

    private static func bluetoothOptions(highQuality: Bool) -> AVAudioSession.CategoryOptions {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            // iOS 26 : enregistrement haute qualité des AirPods, HFP en secours.
            return highQuality ? [.allowBluetoothHFP, .bluetoothHighQualityRecording] : [.allowBluetoothHFP]
        }
        #endif
        return [.allowBluetooth]
    }

    // MARK: - Moteur audio

    private func startEngine() throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noInput }
        guard let newConverter = AVAudioConverter(from: format, to: targetFormat) else {
            throw CaptureError.unsupportedFormat
        }
        newConverter.downmix = true

        lock.lock()
        converter = newConverter
        lock.unlock()

        input.installTap(onBus: 0, bufferSize: 1_600, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// Thread audio : conversion, découpage, encodage. Quelques millisecondes au plus.
    private func process(_ buffer: AVAudioPCMBuffer) {
        var finished: [SpeechSegment] = []
        var level: Float = 0

        lock.lock()
        if let converter, buffer.frameLength > 0 {
            let ratio = targetFormat.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
            if let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) {
                // Le convertisseur réclame des données jusqu'à ce qu'on réponde « plus rien pour l'instant ».
                let feed = ConverterFeed()
                var error: NSError?
                let status = converter.convert(to: output, error: &error) { _, inputStatus in
                    if feed.supplied {
                        inputStatus.pointee = .noDataNow
                        return nil
                    }
                    feed.supplied = true
                    inputStatus.pointee = .haveData
                    return buffer
                }
                if status != .error, output.frameLength > 0, let channel = output.floatChannelData {
                    let samples = UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength))
                    finished = segmenter.process(samples)
                    level = segmenter.level
                }
            }
        }
        lock.unlock()

        for segment in finished {
            onSegment?(Self.package(segment))
        }
        let now = CFAbsoluteTimeGetCurrent()
        if now - lastLevelReport > 0.08 {
            lastLevelReport = now
            onLevel?(level)
        }
    }

    private static func package(_ segment: SpeechSegment) -> CapturedSegment {
        CapturedSegment(wav: WAVEncoder.encode(segment.samples), duration: segment.duration)
    }

    // MARK: - Interruptions, changements de micro (thread principal)

    private func restart() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do {
            try configureSession()
            try startEngine()
            onStatus?(currentInputName)
        } catch {
            onStatus?("Micro indisponible : \(error.localizedDescription)")
        }
    }

    private func addObservers() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                            object: session, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange,
                                            object: nil, queue: .main) { [weak self] note in
            guard let self, (note.object as? AVAudioEngine) === self.engine, !self.engine.isRunning else { return }
            self.restart()
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                            object: session, queue: .main) { [weak self] _ in
            guard let self, self.running else { return }
            // Après un reset des services média, il faut un moteur neuf.
            self.engine = AVAudioEngine()
            self.restart()
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
                                            object: session, queue: .main) { [weak self] _ in
            guard let self, self.running else { return }
            self.onStatus?(self.currentInputName)
        })
    }

    private func removeObservers() {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            onStatus?("Micro interrompu (appel ?)")
        case .ended:
            restart()
        @unknown default:
            break
        }
    }
}
