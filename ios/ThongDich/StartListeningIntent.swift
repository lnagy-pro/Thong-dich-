import AppIntents

/// Raccourci « Écouter » : à assigner au bouton Action (Réglages › Bouton Action › Raccourci)
/// pour ouvrir l'app et lancer l'écoute d'une seule pression.
struct StartListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "Écouter et traduire"
    static let description = IntentDescription("Ouvre Thông Dịch et lance l'écoute immédiatement.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await TranslatorModel.shared.start()
        return .result()
    }
}

struct ThongDichShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartListeningIntent(),
            phrases: [
                "Écouter avec \(.applicationName)",
                "Traduire avec \(.applicationName)"
            ],
            shortTitle: "Écouter",
            systemImageName: "waveform"
        )
    }
}
