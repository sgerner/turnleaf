import AVFoundation
import Capacitor
import Darwin
import MediaPlayer
import UIKit

@objc(TurnleafBridgeViewController)
final class TurnleafBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        if bridge?.plugin(withName: "VolumeButtons") == nil {
            bridge?.registerPluginInstance(TurnleafVolumeButtonsPlugin())
        }
        if bridge?.plugin(withName: "ReaderChrome") == nil {
            bridge?.registerPluginInstance(TurnleafReaderChromePlugin())
        }
        if bridge?.plugin(withName: "KeepAwake") == nil {
            bridge?.registerPluginInstance(TurnleafKeepAwakePlugin())
        }
        if bridge?.plugin(withName: "PrivateTransfer") == nil {
            bridge?.registerPluginInstance(TurnleafPrivateTransferPlugin())
        }
        if bridge?.plugin(withName: "NoteExport") == nil {
            bridge?.registerPluginInstance(TurnleafNoteExportPlugin())
        }
    }

    override var prefersStatusBarHidden: Bool {
        TurnleafReaderChromeController.shared.enabled
    }

    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge {
        TurnleafReaderChromeController.shared.enabled ? [.bottom] : []
    }
}

@objc(TurnleafVolumeButtonsPlugin)
public final class TurnleafVolumeButtonsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafVolumeButtonsPlugin"
    public let jsName = "VolumeButtons"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        TurnleafVolumeButtonsController.shared.attach(to: bridge)
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        TurnleafVolumeButtonsController.shared.attach(to: bridge)
        TurnleafVolumeButtonsController.shared.setEnabled(call.getBool("enabled", false))
        call.resolve()
    }
}

@objc(TurnleafReaderChromePlugin)
public final class TurnleafReaderChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafReaderChromePlugin"
    public let jsName = "ReaderChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        TurnleafReaderChromeController.shared.attach(to: bridge)
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        TurnleafReaderChromeController.shared.attach(to: bridge)
        TurnleafReaderChromeController.shared.setEnabled(call.getBool("enabled", false))
        call.resolve()
    }
}

final class TurnleafVolumeButtonsController {
    static let shared = TurnleafVolumeButtonsController()

    private weak var bridge: CAPBridgeProtocol?
    private weak var volumeView: MPVolumeView?
    private var volumeObservation: NSKeyValueObservation?
    private var lastVolume: Float = AVAudioSession.sharedInstance().outputVolume
    fileprivate var enabled = false
    private var suppressing = false

    func attach(to bridge: CAPBridgeProtocol?) {
        self.bridge = bridge
        if enabled {
            startObserving()
        }
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        if enabled {
            startObserving()
        } else {
            stopObserving()
        }
    }

    private func startObserving() {
        guard volumeObservation == nil, let bridge else { return }
        configureAudioSession()
        installHiddenVolumeView(in: bridge)
        lastVolume = AVAudioSession.sharedInstance().outputVolume
        volumeObservation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let self, let newVolume = change.newValue else { return }
            self.handleVolumeChange(to: newVolume)
        }
    }

    private func stopObserving() {
        volumeObservation?.invalidate()
        volumeObservation = nil
        volumeView?.removeFromSuperview()
        volumeView = nil
        suppressing = false
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    private func installHiddenVolumeView(in bridge: CAPBridgeProtocol) {
        guard volumeView == nil else { return }
        guard let view = bridge.viewController?.view else { return }

        let volumeView = MPVolumeView(frame: CGRect(x: -1_000, y: -1_000, width: 1, height: 1))
        volumeView.alpha = 0.01
        volumeView.isUserInteractionEnabled = false
        volumeView.showsRouteButton = false
        volumeView.showsVolumeSlider = true
        view.addSubview(volumeView)
        self.volumeView = volumeView
    }

    private func handleVolumeChange(to newVolume: Float) {
        guard enabled, !suppressing else {
            lastVolume = newVolume
            return
        }

        let previousVolume = lastVolume
        let delta = newVolume - lastVolume
        guard abs(delta) > 0.01 else {
            lastVolume = newVolume
            return
        }

        let direction = delta > 0 ? "previous" : "next"
        emit(direction: direction)
        lastVolume = previousVolume
        restoreVolume(to: max(0, min(1, previousVolume)))
    }

    private func emit(direction: String) {
        guard let bridge else { return }
        bridge.triggerWindowJSEvent(
            eventName: "turnleafVolumeButton",
            data: #"{"direction":"\#(direction)"}"#
        )
    }

    private func restoreVolume(to target: Float) {
        guard let slider = volumeSlider else { return }
        suppressing = true
        DispatchQueue.main.async { [weak self] in
            slider.setValue(target, animated: false)
            slider.sendActions(for: .valueChanged)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self?.suppressing = false
            }
        }
    }

    private var volumeSlider: UISlider? {
        volumeView?.subviews.compactMap { $0 as? UISlider }.first
    }
}

@objc(TurnleafKeepAwakePlugin)
public final class TurnleafKeepAwakePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafKeepAwakePlugin"
    public let jsName = "KeepAwake"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
    ]

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled", false)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
        }
        call.resolve()
    }
}

final class TurnleafReaderChromeController {
    static let shared = TurnleafReaderChromeController()

    private weak var bridge: CAPBridgeProtocol?
    fileprivate var enabled = false

    func attach(to bridge: CAPBridgeProtocol?) {
        self.bridge = bridge
        refresh()
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        refresh()
    }

    private func refresh() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let bridge = self.bridge, let viewController = bridge.viewController else {
                return
            }
            viewController.setNeedsStatusBarAppearanceUpdate()
            viewController.setNeedsUpdateOfHomeIndicatorAutoHidden()
            viewController.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        }
    }
}

@objc(TurnleafPrivateTransferPlugin)
public final class TurnleafPrivateTransferPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafPrivateTransferPlugin"
    public let jsName = "PrivateTransfer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "downloadFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortTransfer", returnType: CAPPluginReturnPromise),
    ]

    fileprivate static let connectionFailedCode = "PRIVATE_TRANSFER_CONNECTION_FAILED"
    fileprivate static let invalidArgumentCode = "PRIVATE_TRANSFER_INVALID_ARGUMENT"
    fileprivate static let maxDownloadBytes: Int64 = 512 * 1_024 * 1_024
    private static let allowedRequestHeaders: Set<String> = [
        "x-api-key",
        "accept",
        "accept-language",
    ]

    private let sessionsLock = NSLock()
    private var activeSessions: [String: URLSession] = [:]

    deinit {
        cancelAllSessions()
    }

    @objc func abortTransfer(_ call: CAPPluginCall) {
        if let transferId = call.getString("transferId"), !transferId.isEmpty {
            sessionsLock.lock()
            let session = activeSessions.removeValue(forKey: transferId)
            sessionsLock.unlock()
            session?.invalidateAndCancel()
        }
        call.resolve()
    }

    @objc func downloadFile(_ call: CAPPluginCall) {
        let rawHeaders = call.getObject("headers") ?? JSObject()
        guard
            let rawUrl = call.getString("url"),
            let relativePath = call.getString("relativePath"),
            let targetUrl = Self.validateHttpUrl(rawUrl),
            let validatedHeaders = Self.validateHeaders(rawHeaders),
            let stagedTarget = Self.resolvePrivateDataFile(relativePath: relativePath)
        else {
            call.reject("Invalid private transfer options.", Self.invalidArgumentCode)
            return
        }

        let connectTimeoutMs = max(1_000, min(call.getInt("connectTimeout", 60_000), 300_000))
        let readTimeoutMs = max(1_000, min(call.getInt("readTimeout", connectTimeoutMs), 300_000))
        let trackProgress = call.getBool("progress", false)
        let rawTransferId = call.getString("transferId")
        let transferId = (rawTransferId?.isEmpty == false) ? rawTransferId : nil
        let sessionKey = transferId ?? UUID().uuidString

        var request = URLRequest(url: targetUrl)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = TimeInterval(max(connectTimeoutMs, readTimeoutMs)) / 1_000.0
        for (key, value) in validatedHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = TimeInterval(connectTimeoutMs) / 1_000.0
        configuration.timeoutIntervalForResource = TimeInterval(max(connectTimeoutMs, readTimeoutMs)) / 1_000.0

        let delegate = PrivateTransferSessionDelegate(
            call: call,
            transferId: transferId,
            baseDocumentsUrl: stagedTarget.baseDocumentsUrl,
            topDirectoryUrl: stagedTarget.topDirectoryUrl,
            destinationUrl: stagedTarget.destinationUrl,
            trackProgress: trackProgress,
            emitProgress: { [weak self] event in
                self?.notifyListeners("progress", data: event)
            },
            onComplete: { [weak self] in
                self?.unregisterSession(forKey: sessionKey)
            }
        )
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        sessionsLock.lock()
        let previousSession = activeSessions.updateValue(session, forKey: sessionKey)
        sessionsLock.unlock()
        previousSession?.invalidateAndCancel()
        session.dataTask(with: request).resume()
    }

    private func unregisterSession(forKey key: String) {
        sessionsLock.lock()
        activeSessions.removeValue(forKey: key)
        sessionsLock.unlock()
    }

    private func cancelAllSessions() {
        sessionsLock.lock()
        let sessions = Array(activeSessions.values)
        activeSessions.removeAll()
        sessionsLock.unlock()
        for session in sessions {
            session.invalidateAndCancel()
        }
    }

    private static func hasControlCharacters(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            scalar.value <= 0x1F || scalar.value == 0x7F
        }
    }

    private static func validateHttpUrl(_ rawUrl: String) -> URL? {
        if rawUrl.isEmpty || hasControlCharacters(rawUrl) {
            return nil
        }
        guard
            let components = URLComponents(string: rawUrl),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            components.fragment == nil,
            let url = components.url
        else {
            return nil
        }
        return url
    }

    private static func validateHeaders(_ rawHeaders: JSObject) -> [String: String]? {
        var sanitized: [String: String] = [:]
        for (rawName, rawValue) in rawHeaders {
            let trimmedName = rawName.trimmingCharacters(in: .whitespaces)
            let normalizedName = trimmedName.lowercased()
            guard
                !trimmedName.isEmpty,
                allowedRequestHeaders.contains(normalizedName),
                let stringValue = rawValue as? String,
                !stringValue.contains("\r"),
                !stringValue.contains("\n"),
                !stringValue.contains("\0")
            else {
                return nil
            }
            sanitized[trimmedName] = stringValue
        }
        return sanitized
    }

    private static func isSafeSegment(_ segment: String) -> Bool {
        guard
            !segment.isEmpty,
            segment != ".",
            segment != "..",
            !segment.hasPrefix("."),
            !segment.hasSuffix(".")
        else {
            return false
        }
        return segment.unicodeScalars.allSatisfy { scalar in
            let v = scalar.value
            return (v >= 0x30 && v <= 0x39)
                || (v >= 0x41 && v <= 0x5A)
                || (v >= 0x61 && v <= 0x7A)
                || v == 0x2D || v == 0x5F || v == 0x2E
        }
    }

    fileprivate static func isSymbolicLink(_ url: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return false
        }
        let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey])
        return values?.isSymbolicLink == true
    }

    private static func resolvePrivateDataFile(
        relativePath: String
    ) -> (baseDocumentsUrl: URL, topDirectoryUrl: URL, destinationUrl: URL)? {
        if relativePath.isEmpty || relativePath.hasPrefix("/") || relativePath.contains("\\") || relativePath.contains("\0") {
            return nil
        }
        let segments = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard segments.allSatisfy(isSafeSegment) else {
            return nil
        }
        let validLayout: Bool
        if segments.count == 2 && segments[0] == "books" {
            validLayout = segments[1].count > ".epub.partial".count && segments[1].hasSuffix(".epub.partial")
        } else if segments.count == 3 && segments[0] == "covers" {
            validLayout = segments[2].count > ".img.partial".count && segments[2].hasSuffix(".img.partial")
        } else {
            validLayout = false
        }
        guard validLayout else {
            return nil
        }

        guard
            let documentsUrl = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
            !isSymbolicLink(documentsUrl)
        else {
            return nil
        }

        let realBase = documentsUrl.resolvingSymlinksInPath().standardizedFileURL
        var cursor = realBase
        for segment in segments.dropLast() {
            cursor = cursor.appendingPathComponent(segment, isDirectory: true)
            if isSymbolicLink(cursor) {
                return nil
            }
        }
        let destinationUrl = cursor.appendingPathComponent(segments[segments.count - 1], isDirectory: false).standardizedFileURL
        if isSymbolicLink(destinationUrl) {
            return nil
        }
        let basePrefix = realBase.path.hasSuffix("/") ? realBase.path : realBase.path + "/"
        guard destinationUrl.path.hasPrefix(basePrefix) else {
            return nil
        }
        let topDirectoryUrl = realBase.appendingPathComponent(segments[0], isDirectory: true)
        return (realBase, topDirectoryUrl, destinationUrl)
    }
}

private final class PrivateTransferSessionDelegate: NSObject, URLSessionDataDelegate {
    private let call: CAPPluginCall
    private let transferId: String?
    private let baseDocumentsUrl: URL
    private let topDirectoryUrl: URL
    private let destinationUrl: URL
    private let trackProgress: Bool
    private let emitProgress: ([String: Any]) -> Void
    private let onComplete: () -> Void

    private var statusCode = 0
    private var redirectLocation: String?
    private var expectedLength: Int64 = -1
    private var bytesWritten: Int64 = 0
    private var lastProgressTime: TimeInterval = 0
    private var fileHandle: FileHandle?
    private var writeError: Error?

    init(
        call: CAPPluginCall,
        transferId: String?,
        baseDocumentsUrl: URL,
        topDirectoryUrl: URL,
        destinationUrl: URL,
        trackProgress: Bool,
        emitProgress: @escaping ([String: Any]) -> Void,
        onComplete: @escaping () -> Void
    ) {
        self.call = call
        self.transferId = transferId
        self.baseDocumentsUrl = baseDocumentsUrl
        self.topDirectoryUrl = topDirectoryUrl
        self.destinationUrl = destinationUrl
        self.trackProgress = trackProgress
        self.emitProgress = emitProgress
        self.onComplete = onComplete
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        statusCode = response.statusCode
        redirectLocation = response.value(forHTTPHeaderField: "Location")
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        statusCode = http.statusCode
        if (300..<400).contains(statusCode) {
            redirectLocation = http.value(forHTTPHeaderField: "Location")
            try? FileManager.default.removeItem(at: destinationUrl)
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(statusCode) else {
            try? FileManager.default.removeItem(at: destinationUrl)
            completionHandler(.cancel)
            return
        }
        expectedLength = http.expectedContentLength
        if expectedLength > TurnleafPrivateTransferPlugin.maxDownloadBytes {
            writeError = NSError(
                domain: "TurnleafPrivateTransfer",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Download exceeds maximum permitted size."]
            )
            completionHandler(.cancel)
            return
        }
        do {
            fileHandle = try openValidatedDestinationFile()
            completionHandler(.allow)
        } catch {
            writeError = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let handle = fileHandle else { return }
        let nextTotal = bytesWritten + Int64(data.count)
        if nextTotal > TurnleafPrivateTransferPlugin.maxDownloadBytes {
            writeError = NSError(
                domain: "TurnleafPrivateTransfer",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Download exceeds maximum permitted size."]
            )
            dataTask.cancel()
            return
        }
        do {
            try handle.write(contentsOf: data)
            bytesWritten = nextTotal
            if trackProgress {
                let now = ProcessInfo.processInfo.systemUptime
                if now - lastProgressTime >= 0.1 {
                    let computable = expectedLength > 0
                    var payload: [String: Any] = [
                        "bytes": bytesWritten,
                        "contentLength": computable ? expectedLength : -1,
                        "lengthComputable": computable,
                    ]
                    if let transferId {
                        payload["transferId"] = transferId
                    }
                    emitProgress(payload)
                    lastProgressTime = now
                }
            }
        } catch {
            writeError = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            onComplete()
            session.finishTasksAndInvalidate()
        }
        try? fileHandle?.synchronize()
        try? fileHandle?.close()
        fileHandle = nil

        if let writeError {
            try? FileManager.default.removeItem(at: destinationUrl)
            call.reject(writeError.localizedDescription, TurnleafPrivateTransferPlugin.connectionFailedCode)
            return
        }

        if (300..<400).contains(statusCode) {
            try? FileManager.default.removeItem(at: destinationUrl)
            var result: PluginCallResultData = ["status": statusCode, "bytesWritten": 0]
            if let redirectLocation {
                result["location"] = redirectLocation
            }
            call.resolve(result)
            return
        }

        if statusCode >= 100 && !(200..<300).contains(statusCode) {
            try? FileManager.default.removeItem(at: destinationUrl)
            call.resolve(["status": statusCode, "bytesWritten": 0])
            return
        }

        if let error {
            try? FileManager.default.removeItem(at: destinationUrl)
            call.reject(error.localizedDescription, TurnleafPrivateTransferPlugin.connectionFailedCode)
            return
        }

        if trackProgress {
            let finalTotal = expectedLength > 0 ? max(expectedLength, bytesWritten) : bytesWritten
            var payload: [String: Any] = [
                "bytes": bytesWritten,
                "contentLength": finalTotal,
                "lengthComputable": true,
            ]
            if let transferId {
                payload["transferId"] = transferId
            }
            emitProgress(payload)
        }

        call.resolve(["status": statusCode, "bytesWritten": bytesWritten])
    }

    private func openValidatedDestinationFile() throws -> FileHandle {
        let parent = destinationUrl.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

        var mutableTopDir = topDirectoryUrl
        var backupValues = URLResourceValues()
        backupValues.isExcludedFromBackup = true
        try? mutableTopDir.setResourceValues(backupValues)

        let basePrefix = baseDocumentsUrl.path.hasSuffix("/") ? baseDocumentsUrl.path : baseDocumentsUrl.path + "/"
        let realParent = parent.resolvingSymlinksInPath().standardizedFileURL
        guard
            !TurnleafPrivateTransferPlugin.isSymbolicLink(topDirectoryUrl),
            !TurnleafPrivateTransferPlugin.isSymbolicLink(parent),
            !TurnleafPrivateTransferPlugin.isSymbolicLink(destinationUrl),
            realParent.path.hasPrefix(basePrefix)
        else {
            throw NSError(
                domain: "TurnleafPrivateTransfer",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unsafe private transfer destination."]
            )
        }

        if FileManager.default.fileExists(atPath: destinationUrl.path) {
            try FileManager.default.removeItem(at: destinationUrl)
        }
        let fd = Darwin.open(
            destinationUrl.path,
            O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard fd >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
}

@objc(TurnleafNoteExportPlugin)
public final class TurnleafNoteExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafNoteExportPlugin"
    public let jsName = "NoteExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "exportMarkdown", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareMarkdown", returnType: CAPPluginReturnPromise),
    ]

    private static let maxMarkdownBytes = 10 * 1_024 * 1_024
    private var exportInFlight = false
    private var activeDocumentExport: DocumentExportCoordinator?

    override public func load() {
        Self.cleanupStagedNotesDirectory()
    }

    @objc func exportMarkdown(_ call: CAPPluginCall) {
        presentStagedMarkdown(call) { [weak self] viewController, staged in
            guard let self else { return }
            let picker = UIDocumentPickerViewController(forExporting: [staged.fileUrl], asCopy: true)
            let coordinator = DocumentExportCoordinator(
                stagedFile: staged.fileUrl,
                filename: staged.filename,
                call: call
            ) { [weak self] in
                self?.activeDocumentExport = nil
                self?.exportInFlight = false
            }
            self.activeDocumentExport = coordinator
            picker.delegate = coordinator
            picker.presentationController?.delegate = coordinator
            viewController.present(picker, animated: true)
        }
    }

    @objc func shareMarkdown(_ call: CAPPluginCall) {
        presentStagedMarkdown(call) { [weak self] viewController, staged in
            let activityController = UIActivityViewController(activityItems: [staged.fileUrl], applicationActivities: nil)
            if let popover = activityController.popoverPresentationController {
                popover.sourceView = viewController.view
                popover.sourceRect = CGRect(
                    x: viewController.view.bounds.midX,
                    y: viewController.view.bounds.midY,
                    width: 1,
                    height: 1
                )
            }
            activityController.completionWithItemsHandler = { [weak self] _, completed, _, activityError in
                try? FileManager.default.removeItem(at: staged.fileUrl)
                self?.exportInFlight = false
                if activityError != nil {
                    call.reject("Could not export Markdown notes.")
                    return
                }
                call.resolve(
                    completed
                        ? ["status": "shared", "filename": staged.filename]
                        : ["status": "canceled"]
                )
            }
            viewController.present(activityController, animated: true)
        }
    }

    private func presentStagedMarkdown(
        _ call: CAPPluginCall,
        present: @escaping (UIViewController, (fileUrl: URL, filename: String)) -> Void
    ) {
        guard let staged = stageMarkdownRequest(call) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.exportInFlight, let viewController = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: staged.fileUrl)
                call.reject(
                    self?.exportInFlight == true
                        ? "Another note export is already in progress."
                        : "Note export is unavailable."
                )
                return
            }
            self.exportInFlight = true
            present(viewController, staged)
        }
    }

    private func stageMarkdownRequest(_ call: CAPPluginCall) -> (fileUrl: URL, filename: String)? {
        guard let markdown = call.getString("markdown") else {
            call.reject("Markdown content is required.")
            return nil
        }
        let utf8Data = Data(markdown.utf8)
        guard utf8Data.count <= Self.maxMarkdownBytes else {
            call.reject("Markdown notes exceed maximum export size.")
            return nil
        }
        let safeFilename = Self.sanitizeFilename(call.getString("filename") ?? "book-notes.md")
        guard
            let cachesUrl = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
            !TurnleafPrivateTransferPlugin.isSymbolicLink(cachesUrl)
        else {
            call.reject("Cache directory is unavailable.")
            return nil
        }

        let realCaches = cachesUrl.resolvingSymlinksInPath().standardizedFileURL
        var sharedDir = realCaches.appendingPathComponent("shared", isDirectory: true)
        if TurnleafPrivateTransferPlugin.isSymbolicLink(sharedDir) {
            call.reject("Invalid export file path.")
            return nil
        }
        let stagedFile = sharedDir.appendingPathComponent(safeFilename, isDirectory: false).standardizedFileURL
        let sharedPrefix = sharedDir.path.hasSuffix("/") ? sharedDir.path : sharedDir.path + "/"
        guard stagedFile.path.hasPrefix(sharedPrefix) else {
            call.reject("Invalid export file path.")
            return nil
        }

        do {
            try FileManager.default.createDirectory(at: sharedDir, withIntermediateDirectories: true)
            var backupValues = URLResourceValues()
            backupValues.isExcludedFromBackup = true
            try? sharedDir.setResourceValues(backupValues)

            let realShared = sharedDir.resolvingSymlinksInPath().standardizedFileURL
            let cachesPrefix = realCaches.path.hasSuffix("/") ? realCaches.path : realCaches.path + "/"
            guard
                !TurnleafPrivateTransferPlugin.isSymbolicLink(sharedDir),
                realShared.path.hasPrefix(cachesPrefix),
                !TurnleafPrivateTransferPlugin.isSymbolicLink(stagedFile)
            else {
                call.reject("Invalid export file path.")
                return nil
            }

            if let existing = try? FileManager.default.contentsOfDirectory(at: sharedDir, includingPropertiesForKeys: nil) {
                for item in existing {
                    try? FileManager.default.removeItem(at: item)
                }
            }

            let fd = Darwin.open(
                stagedFile.path,
                O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC,
                mode_t(S_IRUSR | S_IWUSR)
            )
            guard fd >= 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try handle.write(contentsOf: utf8Data)
            try handle.synchronize()
            try handle.close()
            return (stagedFile, safeFilename)
        } catch {
            try? FileManager.default.removeItem(at: stagedFile)
            call.reject("Could not stage Markdown notes.")
            return nil
        }
    }

    private static func cleanupStagedNotesDirectory() {
        guard
            let cachesUrl = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
            !TurnleafPrivateTransferPlugin.isSymbolicLink(cachesUrl)
        else {
            return
        }
        let sharedDir = cachesUrl.resolvingSymlinksInPath().standardizedFileURL.appendingPathComponent("shared", isDirectory: true)
        guard !TurnleafPrivateTransferPlugin.isSymbolicLink(sharedDir) else { return }
        if let items = try? FileManager.default.contentsOfDirectory(at: sharedDir, includingPropertiesForKeys: nil) {
            for item in items {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }

    private static func sanitizeFilename(_ raw: String) -> String {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasSuffix(".md") {
            trimmed.removeLast(3)
        }
        let mapped = trimmed.map { ch -> Character in
            if ch.isLetter || ch.isNumber || ch == "-" || ch == "_" {
                return ch
            }
            return "-"
        }
        let stem = String(mapped)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
            .prefix(80)
        return (stem.isEmpty ? "book-notes" : String(stem)) + ".md"
    }
}

private final class DocumentExportCoordinator: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private let stagedFile: URL
    private let filename: String
    private let call: CAPPluginCall
    private let onFinish: () -> Void
    private var completed = false

    init(
        stagedFile: URL,
        filename: String,
        call: CAPPluginCall,
        onFinish: @escaping () -> Void
    ) {
        self.stagedFile = stagedFile
        self.filename = filename
        self.call = call
        self.onFinish = onFinish
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(saved: !urls.isEmpty)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(saved: false)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(saved: false)
    }

    private func finish(saved: Bool) {
        guard !completed else { return }
        completed = true
        try? FileManager.default.removeItem(at: stagedFile)
        onFinish()
        if saved {
            call.resolve(["status": "saved", "filename": filename])
        } else {
            call.resolve(["status": "canceled"])
        }
    }
}
