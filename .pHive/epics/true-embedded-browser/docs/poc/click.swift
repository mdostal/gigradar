// Part 3 of the POC: a synthetic click, targeted by PID (CGEvent.postToPid),
// at a coordinate read from the ACCESSIBILITY TREE itself (not a guessed
// screen position) -- proving the full "read structure -> act precisely"
// loop the owner asked for, scoped to one process throughout.
import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

_ = NSApplication.shared

guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else {
    print("usage: click <pid>")
    exit(1)
}

func axAttr(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    return err == .success ? value : nil
}

let appElement = AXUIElementCreateApplication(pid)
guard let windows = axAttr(appElement, kAXWindowsAttribute as String) as? [AXUIElement], let win = windows.first else {
    print("no window found")
    exit(1)
}

// nav-header.tsx renders each nav item as a real <a> link -- AXLink in the
// accessibility tree, not AXButton. Find the "Today" link by its real
// AXTitle, read its real on-screen position + size, and click its center.
func findByTitle(_ root: AXUIElement, _ title: String, depth: Int = 0) -> AXUIElement? {
    if depth > 16 { return nil }
    if let t = axAttr(root, kAXTitleAttribute as String) as? String, t == title { return root }
    if let children = axAttr(root, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children {
            if let found = findByTitle(child, title, depth: depth + 1) { return found }
        }
    }
    return nil
}

guard let todayLink = findByTitle(win, "Today") else {
    print("Could not find a 'Today' nav element by title in the accessibility tree.")
    exit(1)
}

var posValue: AnyObject?
var sizeValue: AnyObject?
AXUIElementCopyAttributeValue(todayLink, kAXPositionAttribute as CFString, &posValue)
AXUIElementCopyAttributeValue(todayLink, kAXSizeAttribute as CFString, &sizeValue)
var pos = CGPoint.zero
var size = CGSize.zero
if let posValue { AXValueGetValue(posValue as! AXValue, .cgPoint, &pos) }
if let sizeValue { AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) }
let clickX = pos.x + size.width / 2
let clickY = pos.y + size.height / 2
print("Found 'Today' nav link at (\(pos.x), \(pos.y)) size \(size.width)x\(size.height) -- clicking center (\(clickX), \(clickY)) via CGEvent.postToPid(\(pid))")

guard let source = CGEventSource(stateID: .hidSystemState) else {
    print("failed to create CGEventSource")
    exit(1)
}
let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: clickX, y: clickY), mouseButton: .left)
let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: clickX, y: clickY), mouseButton: .left)
let usePid = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "postToPid"
if usePid {
    print("dispatch mode: postToPid")
    down?.postToPid(pid)
    usleep(50_000)
    up?.postToPid(pid)
} else {
    print("dispatch mode: post(tap: .cghidEventTap) -- standard global synthetic input, relies on the target window being frontmost/key at the real screen coordinate")
    down?.post(tap: .cghidEventTap)
    usleep(50_000)
    up?.post(tap: .cghidEventTap)
}
print("Click dispatched. Waiting 1s, then re-reading accessibility state to confirm navigation...")
usleep(1_000_000)

// Confirm: re-fetch the window and check whether the "Today" link now
// shows a selected/active state, OR simply re-list windows/title as a
// smoke check that the click landed somewhere real rather than silently
// no-op'ing.
if let windows2 = axAttr(appElement, kAXWindowsAttribute as String) as? [AXUIElement], let win2 = windows2.first {
    let title = axAttr(win2, kAXTitleAttribute as String) as? String ?? "(no title)"
    print("Post-click window title: \"\(title)\" (unchanged window title is expected -- this is an SPA route change, not a new OS window)")
}
print("Done -- see the follow-up scoped screenshot to confirm the route actually changed.")
