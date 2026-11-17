import SwiftUI

@main
struct ThongDichApp: App {
    @State private var model = TranslatorModel.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
        }
    }
}
