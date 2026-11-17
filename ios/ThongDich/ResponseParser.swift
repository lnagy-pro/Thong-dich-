import Foundation

struct ParsedTranslation: Equatable, Sendable {
    var vietnamese = ""
    var french = ""
    var tone: Int?

    /// Vrai quand Gemini n'a entendu aucune parole intelligible.
    var isNoSpeech: Bool {
        Self.isBlank(vietnamese) && Self.isBlank(french)
    }

    /// Vide ou seulement de la ponctuation (« - », « […] », « … »).
    static func isBlank(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { blankScalars.contains($0) }
    }

    private static let blankScalars = CharacterSet(charactersIn: "-–—.…[]()?").union(.whitespacesAndNewlines)
}

/// Lit la réponse de Gemini (« VI: … / FR: … / TON: … »), y compris partielle pendant le streaming.
enum ResponseParser {
    static func parse(_ raw: String) -> ParsedTranslation {
        enum Field { case none, vietnamese, french, tone }
        var field = Field.none
        var vietnamese: [String] = []
        var french: [String] = []
        var toneText = ""

        for rawLine in raw.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let line = rawLine
                .replacingOccurrences(of: "**", with: "")
                .trimmingCharacters(in: .whitespaces)
            if let rest = value(of: "VI", in: line) {
                field = .vietnamese
                vietnamese.append(rest)
            } else if let rest = value(of: "FR", in: line) {
                field = .french
                french.append(rest)
            } else if let rest = value(of: "TON", in: line) {
                field = .tone
                toneText += rest
            } else if !line.isEmpty {
                switch field {
                case .vietnamese: vietnamese.append(line)
                case .french: french.append(line)
                case .tone, .none: break
                }
            }
        }

        var result = ParsedTranslation()
        result.vietnamese = join(vietnamese)
        result.french = join(french)
        if let digit = toneText.first(where: \.isNumber),
           let value = Int(String(digit)),
           (0...3).contains(value) {
            result.tone = value
        }
        return result
    }

    private static func join(_ parts: [String]) -> String {
        parts.filter { !$0.isEmpty }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// « VI: texte », « vi : texte » ou « VI: » → le contenu après les deux-points.
    private static func value(of label: String, in line: String) -> String? {
        guard line.count >= label.count,
              line.prefix(label.count).uppercased() == label else { return nil }
        let rest = line.dropFirst(label.count).drop(while: { $0 == " " })
        guard let colon = rest.first, colon == ":" || colon == "：" else { return nil }
        return String(rest.dropFirst()).trimmingCharacters(in: .whitespaces)
    }
}
