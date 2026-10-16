import XCTest

/// Signs in to the panel CI seeded (ios/ci/seed-panel.mjs), walks every screen and saves a
/// screenshot of each to $SCREENSHOT_DIR (set as TEST_RUNNER_SCREENSHOT_DIR for xcodebuild).
final class ScreenshotTour: XCTestCase {
    private var app: XCUIApplication!
    private var shot = 0

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
    }

    func testTour() {
        snap("sign-in")

        let address = app.textFields["192.168.1.20:8420"]
        XCTAssertTrue(address.waitForExistence(timeout: 15), "address field")
        address.tap()
        address.typeText(ProcessInfo.processInfo.environment["PANEL_ADDRESS"] ?? "127.0.0.1:8420")
        let user = app.textFields["Username"]
        user.tap()
        user.typeText("demo")
        let pass = app.secureTextFields["Password"]
        pass.tap()
        pass.typeText("demo-password-123")
        snap("sign-in-filled")
        app.buttons["Sign in"].firstMatch.tap()

        let server = app.staticTexts["Survival SMP"]
        XCTAssertTrue(server.waitForExistence(timeout: 20), "server list after sign-in")
        sleep(2)
        snap("servers")

        server.tap()
        sleep(3)
        snap("server-console")

        let field = app.textFields["Send a command"]
        if field.waitForExistence(timeout: 5) {
            field.tap()
            field.typeText("say hi from the iPhone\n")
            sleep(5)
            snap("server-console-command")
        }

        for section in ["Players", "Graphs", "Backups", "Files", "Mods"] {
            let button = app.buttons[section].firstMatch
            if !button.isHittable { app.scrollViews.firstMatch.swipeLeft() }
            if button.waitForExistence(timeout: 5) {
                button.tap()
                sleep(3)
                snap("server-\(section.lowercased())")
            }
        }

        let files = app.staticTexts["server.properties"]
        if app.buttons["Files"].firstMatch.exists {
            app.buttons["Files"].firstMatch.tap()
            if files.waitForExistence(timeout: 5) {
                files.tap()
                sleep(2)
                snap("file-editor")
                app.navigationBars.buttons.firstMatch.tap()
            }
        }

        app.navigationBars.buttons.firstMatch.tap()
        sleep(1)
        app.tabBars.buttons["Alerts"].tap()
        sleep(2)
        snap("alerts")
        app.tabBars.buttons["Settings"].tap()
        sleep(1)
        snap("settings")
    }

    private func snap(_ name: String) {
        shot += 1
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent(String(format: "%02d-%@.png", shot, name))
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? image.pngRepresentation.write(to: url)
    }
}
