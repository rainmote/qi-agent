import Cocoa

// Disposable, self-contained desktop oracle. Only the UI action writes result.json.
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(frame: NSRect(x: 30, y: 145, width: 440, height: 32))
    let status = NSTextField(labelWithString: "Waiting for computer use")
    let output = CommandLine.arguments[1]
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 500, height: 260),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Qi LCU E2E"
        let label = NSTextField(labelWithString: "Enter the verification marker, then click Verify")
        label.frame = NSRect(x: 30, y: 205, width: 440, height: 25)
        field.placeholderString = "Verification marker"
        field.setAccessibilityIdentifier("marker-input")
        let button = NSButton(title: "Verify", target: self, action: #selector(verify))
        button.frame = NSRect(x: 30, y: 85, width: 150, height: 36)
        button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("verify-button")
        status.frame = NSRect(x: 30, y: 30, width: 440, height: 40)
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(status)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        try? "ready".write(toFile: output + ".ready", atomically: true, encoding: .utf8)
    }
    @objc func verify() {
        status.stringValue = "Verified: " + field.stringValue
        let result: [String: Any] = ["marker": field.stringValue, "clicked": true]
        if let data = try? JSONSerialization.data(withJSONObject: result) {
            try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let fixture = Fixture()
app.delegate = fixture
app.setActivationPolicy(.regular)
app.run()
