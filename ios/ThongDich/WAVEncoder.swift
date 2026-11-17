import Foundation

/// Encodage WAV PCM 16 bits mono, le format le plus simple accepté par Gemini.
enum WAVEncoder {
    /// - Parameters:
    ///   - samples: échantillons Float (-1…1) à 16 kHz mono.
    ///   - normalize: remonte les voix lointaines (gain plafonné à ×8).
    static func encode(_ samples: [Float], sampleRate: Int = 16_000, normalize: Bool = true) -> Data {
        var gain: Float = 1
        if normalize {
            var peak: Float = 0
            for sample in samples { peak = max(peak, abs(sample)) }
            if peak > 0.0005 { gain = min(0.89 / peak, 8) }
        }

        var pcm = [Int16](repeating: 0, count: samples.count)
        for index in samples.indices {
            let value = max(-1, min(1, samples[index] * gain))
            pcm[index] = Int16((value * 32_767).rounded()).littleEndian
        }

        let dataSize = pcm.count * 2
        var data = Data(capacity: 44 + dataSize)
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + dataSize), to: &data)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        append(UInt32(16), to: &data)                 // taille du bloc fmt
        append(UInt16(1), to: &data)                  // PCM
        append(UInt16(1), to: &data)                  // mono
        append(UInt32(sampleRate), to: &data)
        append(UInt32(sampleRate * 2), to: &data)     // octets par seconde
        append(UInt16(2), to: &data)                  // octets par trame
        append(UInt16(16), to: &data)                 // bits par échantillon
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(dataSize), to: &data)
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
}
