// true-embedded-browser epic proof-of-concept, 2026-09-06.
// Validates PID/window-SCOPED screen capture + accessibility reads --
// the safe alternative to the coordinate-region `screencapture` mistake
// made earlier tonight (which captured unrelated windows). Every API
// call here is scoped to ONE specific process (gigradar's own real PID,
// passed as argv[1]) by construction -- there is no code path in this
// file that can read/capture any other process's window.
import ApplicationServices
import AppKit
import CoreGraphics
import ScreenCaptureKit
import Foundation

// Bare command-line Swift tools never trigger AppKit/CoreGraphics' lazy
// WindowServer-connection init the way a real .app bundle does --
// referencing NSApplication.shared forces that init before any
// ScreenCaptureKit/CGS-backed call below, avoiding the
// "CGS_REQUIRE_INIT: did_initialize" crash a bare CLI process hits
// otherwise.
_ = NSApplication.shared

guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else {
    print("usage: poc <pid>")
    exit(1)
}
print("=== gigradar embedded-browser POC -- scoped to PID \(pid) only ===\n")

// --- Part 1: Accessibility (AXUIElement), scoped to this PID only -----
print("--- Part 1: Accessibility tree, scoped to PID \(pid) ---")
let appElement = AXUIElementCreateApplication(pid)

func axAttr(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    return err == .success ? value : nil
}

if let windows = axAttr(appElement, kAXWindowsAttribute as String) as? [AXUIElement] {
    print("Found \(windows.count) window(s) for PID \(pid) via AXUIElementCreateApplication.")
    for (i, win) in windows.enumerated() {
        let title = axAttr(win, kAXTitleAttribute as String) as? String ?? "(no title)"
        var posValue: AnyObject?
        var sizeValue: AnyObject?
        AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posValue)
        AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sizeValue)
        var pos = CGPoint.zero
        var size = CGSize.zero
        if let posValue { AXValueGetValue(posValue as! AXValue, .cgPoint, &pos) }
        if let sizeValue { AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) }
        print("  window[\(i)] \"\(title)\" at (\(pos.x), \(pos.y)) size \(size.width)x\(size.height)")

        // Walk one level of children to prove real UI-element enumeration
        // (buttons/links), not just the window shell itself.
        if let children = axAttr(win, kAXChildrenAttribute as String) as? [AXUIElement] {
            var counted = 0
            for child in children.prefix(40) {
                let role = axAttr(child, kAXRoleAttribute as String) as? String ?? "?"
                counted += 1
                if counted <= 8 {
                    let label = (axAttr(child, kAXTitleAttribute as String) as? String)
                        ?? (axAttr(child, "AXDescription") as? String)
                        ?? ""
                    print("    - child role=\(role) label=\"\(label)\"")
                }
            }
            print("    (\(children.count) direct children total)")
        }
    }
} else {
    print("No windows returned -- likely missing Accessibility permission for this terminal/process.")
    print("Grant it: System Settings -> Privacy & Security -> Accessibility -> add the app running this binary (Terminal/iTerm).")
}

// --- Part 2: ScreenCaptureKit, scoped to this PID's window only -------
print("\n--- Part 2: ScreenCaptureKit, scoped to PID \(pid)'s window only ---")

let preflight = CGPreflightScreenCaptureAccess()
print("CGPreflightScreenCaptureAccess() = \(preflight)")

let semaphore = DispatchSemaphore(value: 0)

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let targetWindows = content.windows.filter { $0.owningApplication?.processID == pid }
        print("SCShareableContent found \(content.windows.count) total on-screen windows system-wide; \(targetWindows.count) belong to PID \(pid).")

        guard let window = targetWindows.first else {
            print("No SCWindow found for PID \(pid) -- either no permission yet, or gigradar's window isn't currently on-screen.")
            semaphore.signal()
            return
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        if let data = bitmap.representation(using: .png, properties: [:]) {
            let outPath = "/tmp/gigradar-embed-poc/scoped-capture.png"
            try data.write(to: URL(fileURLWithPath: outPath))
            print("SUCCESS: wrote a real, window-scoped capture (\(image.width)x\(image.height)) to \(outPath)")
            print("This image can ONLY contain PID \(pid)'s own window content -- SCContentFilter(desktopIndependentWindow:) excludes every other window/app by construction.")
        }
    } catch {
        print("ScreenCaptureKit capture FAILED: \(error)")
        print("If CGPreflightScreenCaptureAccess() was false above, this is the expected/known failure -- Screen Recording permission not yet granted to this binary's calling process, OR (per tonight's research) ad-hoc-signed binaries may be silently rejected on this macOS version even after granting.")
    }
    semaphore.signal()
}

semaphore.wait()
print("\n=== POC complete ===")
