// Owns only test clipboard changes. Prior item/flavor bytes remain in RAM.
// --self-test uses only an in-memory backend and never accesses NSPasteboard.
// --stdio: capture, expect{text}, expect-json{expected}, claim, restore, quit.
import AppKit
import Foundation
import Dispatch
import Darwin

struct ClipboardFlavor: Equatable {
    let type: String
    let data: Data
}
struct ClipboardItemData: Equatable {
    let flavors: [ClipboardFlavor]
}
struct ClipboardSnapshot {
    let changeCount: Int
    let items: [ClipboardItemData]
    let text: String?
    func hasSameContents(as other: ClipboardSnapshot) -> Bool { items == other.items }
    func isUnchanged(from other: ClipboardSnapshot) -> Bool {
        changeCount == other.changeCount && hasSameContents(as: other)
    }
}
enum ClipboardGuardError: Error {
    case unstableClipboard, unmaterializedFlavor, snapshotTooLarge, unsupportedFlavor
    case noCapture, alreadyCaptured, expectedCopyMissing, expectedTextTooLarge, invalidRequest
}
enum ClipboardRestoreOutcome { case restored, changedByAnotherOwner, failed }
protocol ClipboardBackend: AnyObject {
    func read() throws -> ClipboardSnapshot
    func validateRestorable(_ snapshot: ClipboardSnapshot) throws
    func restore(_ snapshot: ClipboardSnapshot, onlyIfUnchangedFrom owned: ClipboardSnapshot) throws -> ClipboardRestoreOutcome
}

final class AppKitClipboard: ClipboardBackend {
    private lazy var board = NSPasteboard.general
    func read() throws -> ClipboardSnapshot {
        // A lazy/promised flavor that cannot materialize makes the entire
        // capture fail before any test is allowed to overwrite the clipboard.
        for _ in 0..<3 {
            let count = board.changeCount
            var items = [ClipboardItemData](), bytes = 0, flavors = 0
            for item in board.pasteboardItems ?? [] {
                var captured = [ClipboardFlavor]()
                for type in item.types {
                    guard let data = item.data(forType: type) else { throw ClipboardGuardError.unmaterializedFlavor }
                    bytes += data.count; flavors += 1
                    guard bytes <= 64 * 1024 * 1024 && flavors <= 512 else { throw ClipboardGuardError.snapshotTooLarge }
                    captured.append(ClipboardFlavor(type: type.rawValue, data: Data(data)))
                }
                items.append(ClipboardItemData(flavors: captured))
            }
            let text = board.string(forType: .string)
            if board.changeCount == count { return ClipboardSnapshot(changeCount: count, items: items, text: text) }
        }
        throw ClipboardGuardError.unstableClipboard
    }
    private func materializedItems(_ snapshot: ClipboardSnapshot) throws -> [NSPasteboardItem] {
        try snapshot.items.map { saved in
            let item = NSPasteboardItem()
            for flavor in saved.flavors {
                guard item.setData(flavor.data, forType: NSPasteboard.PasteboardType(flavor.type)) else {
                    throw ClipboardGuardError.unsupportedFlavor
                }
            }
            return item
        }
    }
    func validateRestorable(_ snapshot: ClipboardSnapshot) throws { _ = try materializedItems(snapshot) }
    func restore(_ snapshot: ClipboardSnapshot, onlyIfUnchangedFrom owned: ClipboardSnapshot) throws -> ClipboardRestoreOutcome {
        let items = try materializedItems(snapshot)
        guard try read().isUnchanged(from: owned) else { return .changedByAnotherOwner }
        let clearedCount = board.clearContents()
        // NSPasteboard has no atomic compare-and-swap. Recheck its generation
        // after clearing, then use a single writeObjects call for all items.
        // A foreign copy observed here always wins; do not overwrite it.
        guard board.changeCount == clearedCount else { return .changedByAnotherOwner }
        guard items.isEmpty || board.writeObjects(items) else { return .failed }
        return try read().hasSameContents(as: snapshot) ? .restored : .failed
    }
}

final class ClipboardGuard {
    private let backend: ClipboardBackend
    private var baseline: ClipboardSnapshot?
    private var owned: ClipboardSnapshot?
    private var expected: (matches: (String) -> Bool, changeCount: Int)?
    init(_ backend: ClipboardBackend) { self.backend = backend }
    private func clearSavedData() { baseline = nil; owned = nil; expected = nil }
    func capture() throws -> [String: Any] {
        guard baseline == nil else { throw ClipboardGuardError.alreadyCaptured }
        let snapshot = try backend.read()
        try backend.validateRestorable(snapshot)
        baseline = snapshot
        return ["ok": true, "status": "CAPTURED_IN_RAM", "items": snapshot.items.count,
                "flavors": snapshot.items.reduce(0) { $0 + $1.flavors.count }]
    }
    func expect(_ text: String) throws -> [String: Any] {
        guard text.utf8.count <= 4 * 1024 * 1024 else { throw ClipboardGuardError.expectedTextTooLarge }
        return try armExpectation { $0 == text }
    }
    func expectJson(_ fields: [String: Any]) throws -> [String: Any] {
        guard Set(fields.keys) == Set(["format", "version", "conversation"]),
              fields["format"] as? String == "mysti", fields["version"] as? Int == 1,
              fields["conversation"] is [String: Any],
              let bytes = try? JSONSerialization.data(withJSONObject: fields), bytes.count <= 4 * 1024 * 1024 else {
            throw ClipboardGuardError.invalidRequest
        }
        let armedAt = Date().timeIntervalSince1970 * 1000
        return try armExpectation { text in
            guard text.utf8.count <= 4 * 1024 * 1024,
                  var actual = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
                  Set(actual.keys) == Set(["format", "version", "conversation", "exportedAt"]),
                  let timestamp = actual.removeValue(forKey: "exportedAt") as? Double,
                  timestamp.rounded(.down) == timestamp,
                  timestamp >= armedAt.rounded(.down), timestamp <= Date().timeIntervalSince1970 * 1000,
                  timestamp - armedAt <= 30000 else { return false }
            return NSDictionary(dictionary: actual).isEqual(to: fields)
        }
    }
    private func armExpectation(_ predicate: @escaping (String) -> Bool) throws -> [String: Any] {
        guard let baseline else { throw ClipboardGuardError.noCapture }
        let current = try backend.read()
        guard current.isUnchanged(from: owned ?? baseline) else {
            return ["ok": false, "status": "NEWER_CLIPBOARD_CONTENT", "mayPerformCopy": false]
        }
        expected = (predicate, current.changeCount)
        return ["ok": true, "status": "EXPECTED_COPY_ARMED", "mayPerformCopy": true]
    }
    func claim() throws -> [String: Any] {
        guard baseline != nil else { throw ClipboardGuardError.noCapture }
        guard let expected else { throw ClipboardGuardError.expectedCopyMissing }
        let current = try backend.read()
        guard current.changeCount != expected.changeCount, let text = current.text, expected.matches(text) else {
            return ["ok": false, "status": "EXPECTED_COPY_NOT_OBSERVED"]
        }
        owned = current; self.expected = nil
        return ["ok": true, "status": "OWNED_COPY_CONFIRMED"]
    }
    func restore() throws -> [String: Any] {
        guard let baseline else { return ["ok": true, "status": "NO_CAPTURE", "restored": false] }
        // If the driver exits just after its known UI copy, claim that exact
        // expected copy before cleanup. Unknown/newer contents are never owned.
        if expected != nil { _ = try claim() }
        let current = try backend.read()
        guard let owned else {
            let unchanged = current.isUnchanged(from: baseline)
            clearSavedData()
            return ["ok": true, "status": unchanged ? "NO_OWNED_MUTATION" : "PRESERVED_NEWER_CLIPBOARD",
                    "restored": false, "preservedNewerClipboard": !unchanged]
        }
        guard current.isUnchanged(from: owned) else {
            clearSavedData()
            return ["ok": true, "status": "PRESERVED_NEWER_CLIPBOARD", "restored": false, "preservedNewerClipboard": true]
        }
        switch try backend.restore(baseline, onlyIfUnchangedFrom: owned) {
        case .restored:
            clearSavedData()
            return ["ok": true, "status": "RESTORED_EXACT_ITEM_DATA", "restored": true]
        case .changedByAnotherOwner:
            clearSavedData()
            return ["ok": true, "status": "PRESERVED_NEWER_CLIPBOARD", "restored": false, "preservedNewerClipboard": true]
        case .failed:
            // Retain the baseline in RAM. Do not blindly retry over clipboard
            // data whose ownership may have changed during a failed restore.
            return ["ok": false, "status": "RESTORE_FAILED", "restored": false]
        }
    }
    func handle(_ request: [String: Any]) throws -> [String: Any] {
        guard let action = request["action"] as? String else { throw ClipboardGuardError.invalidRequest }
        switch action {
        case "capture": return try capture()
        case "expect":
            guard let text = request["text"] as? String else { throw ClipboardGuardError.invalidRequest }
            return try expect(text)
        case "expect-json":
            guard let fields = request["expected"] as? [String: Any] else { throw ClipboardGuardError.invalidRequest }
            return try expectJson(fields)
        case "claim": return try claim()
        case "restore", "quit": return try restore()
        default: throw ClipboardGuardError.invalidRequest
        }
    }
}

final class MemoryClipboard: ClipboardBackend {
    var current: ClipboardSnapshot
    var reads = 0, restoreWrites = 0
    var materializationFails = false, validationFails = false, restorationFails = false
    init(_ snapshot: ClipboardSnapshot) { current = snapshot }
    func read() throws -> ClipboardSnapshot {
        reads += 1
        if materializationFails { throw ClipboardGuardError.unmaterializedFlavor }
        return current
    }
    func validateRestorable(_ snapshot: ClipboardSnapshot) throws {
        if validationFails { throw ClipboardGuardError.unsupportedFlavor }
    }
    func restore(_ snapshot: ClipboardSnapshot, onlyIfUnchangedFrom owned: ClipboardSnapshot) throws -> ClipboardRestoreOutcome {
        guard current.isUnchanged(from: owned) else { return .changedByAnotherOwner }
        if restorationFails { return .failed }
        restoreWrites += 1
        current = ClipboardSnapshot(changeCount: current.changeCount + 1, items: snapshot.items, text: snapshot.text)
        return .restored
    }
    func putText(_ text: String) {
        current = ClipboardSnapshot(changeCount: current.changeCount + 1,
            items: [ClipboardItemData(flavors: [ClipboardFlavor(type: "public.utf8-plain-text", data: Data(text.utf8))])], text: text)
    }
}

func selfTest() throws -> [String: Any] {
    // Binary, rich text and multiple items exercise complete flavor preservation.
    let original = ClipboardSnapshot(changeCount: 10, items: [
        ClipboardItemData(flavors: [ClipboardFlavor(type: "public.utf8-plain-text", data: Data("prior private text".utf8)),
                                   ClipboardFlavor(type: "public.rtf", data: Data([0, 255, 17, 33]))]),
        ClipboardItemData(flavors: [ClipboardFlavor(type: "public.png", data: Data([137, 80, 78, 71, 0, 255]))])], text: "prior private text")
    var checks = [String]()
    func require(_ condition: Bool, _ label: String) {
        if !condition { fatalError("Controlled clipboard guard check failed: " + label) }
    }
    func test(_ label: String, _ body: (MemoryClipboard, ClipboardGuard) throws -> Void) throws {
        let backend = MemoryClipboard(original)
        try body(backend, ClipboardGuard(backend)); checks.append(label)
    }
    try test("Restores every binary/rich-text flavor across multiple original items") { backend, state in
        _ = try state.capture(); _ = try state.expect("PC11 synthetic copy")
        backend.putText("PC11 synthetic copy"); _ = try state.claim()
        require(try state.restore()["restored"] as? Bool == true, "restored flag")
        require(backend.current.items == original.items && backend.restoreWrites == 1, "all original data")
    }
    try test("A newer user copy wins without restoration") { backend, state in
        _ = try state.capture(); _ = try state.expect("PC11 synthetic copy"); backend.putText("PC11 synthetic copy"); _ = try state.claim()
        backend.putText("new user content")
        require(try state.restore()["preservedNewerClipboard"] as? Bool == true, "newer preserved")
        require(backend.current.text == "new user content" && backend.restoreWrites == 0, "no overwrite")
    }
    try test("Same bytes written later by another owner still win by changeCount") { backend, state in
        _ = try state.capture(); _ = try state.expect("PC11 same text"); backend.putText("PC11 same text"); _ = try state.claim()
        backend.putText("PC11 same text"); _ = try state.restore()
        require(backend.restoreWrites == 0, "generation guard")
    }
    try test("A newer user copy aborts the next dependent test copy") { backend, state in
        _ = try state.capture(); backend.putText("user copied while test was preparing")
        require(try state.expect("next synthetic copy")["mayPerformCopy"] as? Bool == false, "next copy blocked")
        _ = try state.restore(); require(backend.restoreWrites == 0, "new copy remains")
    }
    try test("EOF-style cleanup recovers a known UI copy before explicit claim") { backend, state in
        _ = try state.capture(); _ = try state.expect("PC11 pending copy"); backend.putText("PC11 pending copy")
        require(try state.restore()["restored"] as? Bool == true, "pending claim recovery")
        require(backend.current.items == original.items, "pending original data")
    }
    try test("Unmaterialized original flavor fails before any mutation") { backend, state in
        backend.materializationFails = true
        do { _ = try state.capture(); fatalError("Expected materialization refusal") } catch ClipboardGuardError.unmaterializedFlavor { }
        require(backend.restoreWrites == 0 && backend.current.items == original.items, "capture read only")
    }
    try test("Unrestorable original flavor fails before any mutation") { backend, state in
        backend.validationFails = true
        do { _ = try state.capture(); fatalError("Expected validation refusal") } catch ClipboardGuardError.unsupportedFlavor { }
        require(backend.restoreWrites == 0, "restorability preflight")
    }
    try test("Unexpected clipboard data cannot be claimed as a test copy") { backend, state in
        _ = try state.capture(); _ = try state.expect("expected owned result"); backend.putText("unexpected user result")
        require(try state.claim()["ok"] as? Bool == false, "unexpected claim rejected")
        _ = try state.restore(); require(backend.restoreWrites == 0, "unexpected contents preserved")
    }
    try test("No mutation leaves the original clipboard untouched") { backend, state in
        _ = try state.capture(); _ = try state.restore()
        require(backend.restoreWrites == 0 && backend.current.changeCount == original.changeCount, "no-op cleanup")
    }
    try test("A failed restore stays a failure and retains the RAM snapshot for a safe retry") { backend, state in
        _ = try state.capture(); _ = try state.expect("PC11 retry copy"); backend.putText("PC11 retry copy"); _ = try state.claim()
        backend.restorationFails = true
        require(try state.restore()["ok"] as? Bool == false, "restore failure visible")
        backend.restorationFails = false
        require(try state.restore()["restored"] as? Bool == true, "safe retry retained baseline")
        require(backend.current.items == original.items, "retry original data")
    }
    try test("Full JSON fallback permits only current exportedAt beyond the exact owned conversation") { backend, state in
        let fields: [String: Any] = ["format": "mysti", "version": 1, "conversation": ["id": "owned", "messages": []]]
        _ = try state.capture(); _ = try state.expectJson(fields)
        var output = fields; output["exportedAt"] = floor(Date().timeIntervalSince1970 * 1000)
        let text = String(data: try JSONSerialization.data(withJSONObject: output), encoding: .utf8)!
        backend.putText(text); require(try state.claim()["ok"] as? Bool == true, "exact fallback claimed")
        require(try state.restore()["restored"] as? Bool == true, "fallback cleanup")
    }
    try test("JSON extra fields and altered conversations cannot be claimed") { backend, state in
        let fields: [String: Any] = ["format": "mysti", "version": 1, "conversation": ["id": "owned", "messages": []]]
        _ = try state.capture(); _ = try state.expectJson(fields)
        var output = fields; output["exportedAt"] = floor(Date().timeIntervalSince1970 * 1000); output["extra"] = true
        backend.putText(String(data: try JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
        require(try state.claim()["ok"] as? Bool == false, "extra rejected")
        output.removeValue(forKey: "extra"); output["conversation"] = ["id": "not-owned", "messages": []]
        backend.putText(String(data: try JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
        require(try state.claim()["ok"] as? Bool == false, "wrong owner rejected")
        _ = try state.restore(); require(backend.restoreWrites == 0, "unclaimed data preserved")
    }
    return ["status": "PASS_CONTROLLED_CLIPBOARD_GUARD", "checks": checks, "count": checks.count,
            "actualClipboardReads": 0, "actualClipboardWrites": 0, "originalClipboardDataLogged": false,
            "limits": ["AppKit real-pasteboard behavior remains untested until the authorized native run.",
                       "NSPasteboard has no atomic compare-and-swap; final generation checks narrow but cannot eliminate a concurrent-copy race inside the OS restore call."]]
}

func output(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}

if CommandLine.arguments.dropFirst().elementsEqual(["--self-test"]) {
    do { output(try selfTest()) } catch { output(["ok": false, "status": "CONTROLLED_CHECK_FAILED"]); exit(1) }
} else if CommandLine.arguments.dropFirst().elementsEqual(["--stdio"]) {
    let state = ClipboardGuard(AppKitClipboard()), lock = NSLock()
    func finish(_ reason: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        do {
            var result = try state.restore(); result["reason"] = reason; output(result)
            return result["ok"] as? Bool == true
        } catch { output(["ok": false, "status": "RESTORE_EXCEPTION", "reason": reason]); return false }
    }
    // Keep the persistent owner's normal EOF and termination cleanup symmetric.
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let sources = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: code, queue: .global())
        source.setEventHandler { exit(finish("signal") ? 0 : 1) }; source.resume(); return source
    }
    var explicitQuit = false
    while let line = readLine() {
        lock.lock()
        var requestId: String?
        do {
            guard line.utf8.count <= 6 * 1024 * 1024,
                  let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw ClipboardGuardError.invalidRequest }
            guard let id = request["requestId"] as? String, !id.isEmpty, id.utf8.count <= 64 else { throw ClipboardGuardError.invalidRequest }
            requestId = id
            var result = try state.handle(request); result["requestId"] = id; output(result)
            // A failed quit retains the private RAM snapshot and stays alive
            // for an explicit safe retry; it cannot silently claim cleanup.
            explicitQuit = request["action"] as? String == "quit" && result["ok"] as? Bool == true
        } catch {
            // Error enum names contain no clipboard bytes, texts or type names.
            var result: [String: Any] = ["ok": false, "status": "REQUEST_REFUSED", "reason": String(describing: error as? ClipboardGuardError ?? .invalidRequest)]
            if let requestId { result["requestId"] = requestId }; output(result)
        }
        lock.unlock()
        if explicitQuit { break }
    }
    if !explicitQuit && !finish("eof") { exit(1) }
    withExtendedLifetime(sources) { }
} else {
    output(["ok": false, "status": "MODE_REQUIRED", "usage": "clipboard-guard.swift --self-test | --stdio"])
    exit(2)
}
