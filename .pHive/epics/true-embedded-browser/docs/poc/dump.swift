import ApplicationServices
import AppKit
import Foundation
_ = NSApplication.shared
guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else { exit(1) }
func axAttr(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    return err == .success ? value : nil
}
func dump(_ el: AXUIElement, depth: Int, maxDepth: Int) {
    if depth > maxDepth { return }
    let role = axAttr(el, kAXRoleAttribute as String) as? String ?? "?"
    let title = axAttr(el, kAXTitleAttribute as String) as? String ?? ""
    let desc = axAttr(el, "AXDescription") as? String ?? ""
    let value = axAttr(el, kAXValueAttribute as String) as? String ?? ""
    let indent = String(repeating: "  ", count: depth)
    print("\(indent)role=\(role) title=\"\(title)\" desc=\"\(desc)\" value=\"\(value)\"")
    if let children = axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
        for c in children.prefix(20) { dump(c, depth: depth + 1, maxDepth: maxDepth) }
    }
}
let appElement = AXUIElementCreateApplication(pid)
if let windows = axAttr(appElement, kAXWindowsAttribute as String) as? [AXUIElement], let win = windows.first {
    dump(win, depth: 0, maxDepth: 16)
}
