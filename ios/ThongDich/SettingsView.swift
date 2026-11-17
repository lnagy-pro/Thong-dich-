import SwiftUI

struct SettingsView: View {
    @Environment(TranslatorModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var keyDraft = ""
    @State private var checking = false
    @State private var keyError: String?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    SecureField("Clé API Gemini", text: $keyDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    PasteButton(payloadType: String.self) { strings in
                        if let first = strings.first {
                            keyDraft = first.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    }
                    if let url = URL(string: "https://aistudio.google.com/apikey") {
                        Link("Créer une clé sur Google AI Studio", destination: url)
                    }
                    if let keyError {
                        Text(keyError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Clé API")
                } footer: {
                    Text("Stockée uniquement dans le trousseau de cet iPhone. Conseil : activer la facturation sur le projet Google de la clé (quotas suffisants pour une conversation continue, données non utilisées par Google pour entraîner ses modèles).")
                }

                Section {
                    Picker("Modèle", selection: $model.settings.model) {
                        ForEach(GeminiModel.allCases) { option in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title)
                                Text(option.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(option)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    Toggle("Mode prioritaire", isOn: $model.settings.priority)
                } header: {
                    Text("Traduction")
                } footer: {
                    Text("Le mode prioritaire de Gemini réduit et stabilise la latence aux heures chargées, pour un coût 75 à 100 % plus élevé.")
                }

                Section {
                    Picker("Micro", selection: $model.settings.micSource) {
                        ForEach(MicSource.allCases) { source in
                            Text(source.label).tag(source)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Micro")
                } footer: {
                    Text("Le micro de l'iPhone capte bien mieux les voix environnantes. Ceux des AirPods sont conçus pour la voix de la personne qui les porte.")
                }

                Section {
                    Toggle("Afficher le texte vietnamien", isOn: $model.settings.showVietnamese)
                }
            }
            .navigationTitle("Réglages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if checking {
                        ProgressView()
                    } else {
                        Button("OK") {
                            Task { await save() }
                        }
                        .disabled(trimmedKey.isEmpty)
                    }
                }
            }
            .onAppear { keyDraft = model.settings.apiKey }
            .onChange(of: model.settings.micSource) {
                model.micSourceChanged()
            }
        }
        .interactiveDismissDisabled(model.settings.apiKey.isEmpty)
    }

    private var trimmedKey: String {
        keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() async {
        let key = trimmedKey
        guard !key.isEmpty else { return }
        checking = true
        keyError = nil
        if key == model.settings.apiKey {
            checking = false
            dismiss()
            return
        }
        keyError = await model.saveKey(key)
        checking = false
        if keyError == nil {
            model.warmUp()
            dismiss()
        }
    }
}
