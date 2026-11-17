import SwiftUI

struct ContentView: View {
    @Environment(TranslatorModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var follow = true
    @State private var confirmClear = false

    private static let bottomID = "bottom"

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            Divider().opacity(0.5)
            conversation
            controlBar
        }
        .background(Color(.systemBackground))
        .sheet(isPresented: $model.showSettings) {
            SettingsView()
        }
        .alert("Problème", isPresented: $model.showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .confirmationDialog("Effacer toute la conversation ?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Effacer", role: .destructive) { model.clear() }
        }
        .sensoryFeedback(.warning, trigger: model.threatTick)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.warmUp() }
        }
    }

    // MARK: - En-tête

    private var header: some View {
        HStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Thông Dịch")
                    .font(.headline)
                HStack(spacing: 6) {
                    Circle()
                        .fill(model.isListening ? Color.red : Color.secondary.opacity(0.5))
                        .frame(width: 8, height: 8)
                    Text(model.statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button {
                confirmClear = true
            } label: {
                Image(systemName: "trash")
                    .font(.title3)
            }
            .disabled(model.lines.isEmpty)
            .accessibilityLabel("Effacer la conversation")
            Button {
                model.showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.title3)
            }
            .accessibilityLabel("Réglages")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Conversation

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if model.lines.isEmpty {
                        EmptyStateView(isListening: model.isListening)
                            .padding(.top, 70)
                    }
                    ForEach(model.lines) { line in
                        LineRow(line: line, showVietnamese: model.settings.showVietnamese) {
                            model.retry(line)
                        }
                        .id(line.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .onScrollPhaseChange { _, newPhase, context in
                switch newPhase {
                case .interacting:
                    follow = false
                case .idle:
                    let geometry = context.geometry
                    follow = geometry.visibleRect.maxY >= geometry.contentSize.height - 80
                default:
                    break
                }
            }
            .onChange(of: model.updateTick) {
                guard follow else { return }
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            .onChange(of: model.lines.count) {
                guard follow else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !follow && !model.lines.isEmpty {
                    Button {
                        follow = true
                        withAnimation(.easeOut(duration: 0.25)) {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    } label: {
                        Label("En direct", systemImage: "arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(.thinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(14)
                }
            }
        }
    }

    // MARK: - Bouton d'écoute

    private var controlBar: some View {
        VStack(spacing: 4) {
            Button {
                Task { await model.toggle() }
            } label: {
                ZStack {
                    Circle()
                        .stroke(buttonColor.opacity(0.35), lineWidth: 6)
                        .frame(width: 92, height: 92)
                        .scaleEffect(1 + CGFloat(model.level) * 0.3)
                        .opacity(model.isListening ? 1 : 0)
                    Circle()
                        .fill(buttonColor)
                        .frame(width: 80, height: 80)
                        .shadow(color: buttonColor.opacity(0.35), radius: 10, y: 4)
                    Image(systemName: model.isListening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 124, height: 124)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .animation(.easeOut(duration: 0.12), value: model.level)
            .sensoryFeedback(.impact(weight: .medium), trigger: model.isListening)
            .accessibilityLabel(model.isListening ? "Arrêter l'écoute" : "Écouter")

            Text(model.isListening ? "En écoute · toucher pour arrêter" : "Toucher pour écouter")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .background(.bar)
    }

    private var buttonColor: Color {
        model.isListening ? .red : .accentColor
    }
}

// MARK: - Une réplique

struct LineRow: View {
    let line: Line
    let showVietnamese: Bool
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let badge {
                Text(badge.label)
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(badge.color)
            }
            french
            if showVietnamese, !ParsedTranslation.isBlank(line.vietnamese) {
                Text(line.vietnamese)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .padding(.leading, 17)
        .padding(.trailing, 12)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(toneColor)
                .frame(width: 5)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var french: some View {
        switch line.status {
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                Button("Réessayer", action: onRetry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        default:
            if line.french.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Traduction…")
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(line.french)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }
        }
    }

    private var toneColor: Color {
        switch line.tone {
        case .tense?: return .yellow
        case .hostile?: return .orange
        case .threat?: return .red
        default: return Color.secondary.opacity(0.25)
        }
    }

    private var badge: (label: String, color: Color)? {
        switch line.tone {
        case .hostile?: return ("HOSTILE", .orange)
        case .threat?: return ("⚠︎ MENACE", .red)
        default: return nil
        }
    }
}

// MARK: - Écran vide

struct EmptyStateView: View {
    let isListening: Bool

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: isListening ? "waveform" : "mic")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
                .symbolEffect(.variableColor.iterative, isActive: isListening)
            Text(isListening ? "J'écoute…" : "Appuyez sur le micro pour commencer")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Chaque phrase entendue s'affiche ici, traduite en français. L'écoute continue pendant que les traductions arrivent.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 28)
    }
}
