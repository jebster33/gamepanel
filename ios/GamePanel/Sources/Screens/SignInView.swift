import SwiftUI

/// Add a panel, or sign in again to one whose session ran out.
struct SignInView: View {
    var reauth: SavedPanel?

    @EnvironmentObject private var panels: PanelStore
    @Environment(\.dismiss) private var dismiss

    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""
    @State private var ticket: String?
    @State private var client: APIClient?
    @State private var busy = false
    @State private var error: String?
    @FocusState private var field: Field?

    enum Field { case address, username, password, code }

    /// The Simulator screenshot tour turns AutoFill off: its "Save Password?" sheet covers the app.
    private static let autofill = !ProcessInfo.processInfo.arguments.contains("-ui-tour")

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(ticket == nil ? (reauth == nil ? "Add your panel" : "Sign in again") : "Two-factor code")
                        .font(.display(32))
                    Text(ticket == nil
                         ? (reauth == nil ? "The address you open GamePanel at in a browser." : "Your session on \(reauth!.name) ended.")
                         : "Enter the 6-digit code from your authenticator app, or a recovery code.")
                        .foregroundStyle(Palette.moss)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 24, leading: 4, bottom: 8, trailing: 4))
            }

            if ticket == nil {
                if reauth == nil {
                    Section("Panel address") {
                        TextField("192.168.1.20:8420", text: $address)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.URL)
                            .focused($field, equals: .address)
                            .submitLabel(.next)
                            .onSubmit { field = .username }
                    }
                }
                Section("Account") {
                    TextField("Username", text: $username)
                        .textContentType(Self.autofill ? .username : nil)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($field, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { field = .password }
                    SecureField("Password", text: $password)
                        .textContentType(Self.autofill ? .password : nil)
                        .focused($field, equals: .password)
                        .submitLabel(.go)
                        .onSubmit(submit)
                }
            } else {
                Section {
                    TextField("000000", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.system(size: 28, weight: .medium, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .focused($field, equals: .code)
                        .onChange(of: code) { _, value in
                            // Send as soon as iOS fills the code in.
                            if value.count == 6, value.allSatisfy(\.isNumber) { submit() }
                        }
                }
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(Palette.ember)
                }
            }

            Section {
                Button(action: submit) {
                    HStack {
                        Spacer()
                        if busy { ProgressView().tint(Palette.limeInk) } else { Text(ticket == nil ? "Sign in" : "Verify").bold() }
                        Spacer()
                    }
                    .frame(minHeight: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.lime)
                .foregroundStyle(Palette.limeInk)
                .disabled(busy || !canSubmit)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            if reauth != nil {
                Section {
                    Button("Remove this panel", role: .destructive) {
                        if let reauth { panels.remove(reauth.id) }
                    }
                }
            }
        }
        .panelBackground()
        .onAppear {
            if let reauth { username = reauth.username; field = .password } else { field = .address }
        }
        .toolbar {
            if panels.panels.count > 0 && reauth == nil {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private var canSubmit: Bool {
        ticket != nil ? !code.isEmpty : (!username.isEmpty && !password.isEmpty && (reauth != nil || !address.isEmpty))
    }

    /// Accepts "1.2.3.4", "1.2.3.4:8420", "panel.example.com" or a full URL.
    private func panelURL() -> URL? {
        if let reauth { return reauth.baseURL }
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.contains("://") {
            let hasPort = text.split(separator: ":").count > 1
            let looksLocal = text.first?.isNumber == true || text.hasSuffix(".local") || !text.contains(".")
            text = (looksLocal ? "http://" : "https://") + text + (hasPort || !looksLocal ? "" : ":8420")
        }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    private func submit() {
        guard canSubmit, !busy else { return }
        error = nil
        guard let url = panelURL() else { error = "That address doesn't look right. Try something like 192.168.1.20:8420."; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let api = client ?? APIClient(baseURL: url, token: nil)
                client = api
                let result = ticket == nil
                    ? try await api.login(username: username.trimmingCharacters(in: .whitespaces), password: password)
                    : try await api.loginCode(ticket: ticket!, code: code.replacingOccurrences(of: " ", with: ""))
                switch result {
                case .needsCode(let t):
                    ticket = t
                    field = .code
                case .signedIn(let user, let token):
                    Haptics.success()
                    let panel = SavedPanel(id: reauth?.id ?? UUID(), name: reauth?.name ?? url.host ?? "Panel", baseURL: url, username: user.username)
                    panels.add(panel, token: token)
                    dismiss()
                }
            } catch let e as URLError {
                error = e.code == .cannotConnectToHost || e.code == .timedOut || e.code == .cannotFindHost
                    ? "Can't reach \(url.host ?? "the panel"). Check the address and that your phone is on the same network."
                    : e.localizedDescription
                Haptics.error()
            } catch {
                self.error = error.localizedDescription
                code = ""
                Haptics.error()
            }
        }
    }
}
