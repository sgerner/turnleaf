import AVFoundation
import Capacitor
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

    override var prefersHomeIndicatorAutoHidden: Bool {
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
    private var enabled = false

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
    ]

    private static let connectionFailedCode = "PRIVATE_TRANSFER_CONNECTION_FAILED"
    private static let invalidArgumentCode = "PRIVATE_TRANSFER_INVALID_ARGUMENT"

    @objc func downloadFile(_ call: CAPPluginCall) {
        guard
            let rawUrl = call.getString("url"),
            let relativePath = call.getString("relativePath"),
            let targetUrl = Self.validateHttpUrl(rawUrl),
            let destinationUrl = Self.resolvePrivateDataFile(relativePath: relativePath)
        else {
            call.reject("Invalid private transfer options.", Self.invalidArgumentCode)
            return
        }

        let headers = call.getObject("headers") ?? JSObject()
        let connectTimeoutMs = call.getInt("connectTimeout", 60_000)
        let readTimeoutMs = call.getInt("readTimeout", connectTimeoutMs)
        let trackProgress = call.getBool("progress", false)
        let transferId = call.getString("transferId")

        var request = URLRequest(url: targetUrl)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = TimeInterval(max(connectTimeoutMs, readTimeoutMs)) / 1_000.0
        for (key, value) in headers {
            if let headerValue = value as? String {
                request.setValue(headerValue, forHTTPHeaderField: key)
            }
        }

        let delegate = PrivateTransferSessionDelegate(
            call: call,
            rawUrl: rawUrl,
            transferId: transferId,
            destinationUrl: destinationUrl,
            trackProgress: trackProgress
        ) { [weak self] event in
            self?.notifyListeners("progress", data: event)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = TimeInterval(connectTimeoutMs) / 1_000.0
        configuration.timeoutIntervalForResource = TimeInterval(max(connectTimeoutMs, readTimeoutMs)) / 1_000.0
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        delegate.session = session
        session.dataTask(with: request).resume()
    }

    private static func validateHttpUrl(_ rawUrl: String) -> URL? {
        guard
            let components = URLComponents(string: rawUrl),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            let url = components.url
        else {
            return nil
        }
        return url
    }

    private static func resolvePrivateDataFile(relativePath: String) -> URL? {
        if relativePath.isEmpty || relativePath.hasPrefix("/") || relativePath.contains("\\") || relativePath.contains("\0") {
            return nil
        }
        let segments = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard segments.count >= 2, segments[0] == "books" || segments[0] == "covers" else {
            return nil
        }
        if segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            return nil
        }
        guard let documentsUrl = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let baseStandardized = documentsUrl.standardizedFileURL
        let targetStandardized = baseStandardized.appendingPathComponent(relativePath).standardizedFileURL
        let basePrefix = baseStandardized.path.hasSuffix("/") ? baseStandardized.path : baseStandardized.path + "/"
        guard targetStandardized.path.hasPrefix(basePrefix) else {
            return nil
        }
        return targetStandardized
    }
}

private final class PrivateTransferSessionDelegate: NSObject, URLSessionDataDelegate {
    private let call: CAPPluginCall
    private let rawUrl: String
    private let transferId: String?
    private let destinationUrl: URL
    private let trackProgress: Bool
    private let emitProgress: ([String: Any]) -> Void
    weak var session: URLSession?

    private var statusCode = 0
    private var redirectLocation: String?
    private var expectedLength: Int64 = -1
    private var bytesWritten: Int64 = 0
    private var lastProgressTime: TimeInterval = 0
    private var fileHandle: FileHandle?
    private var writeError: Error?

    init(
        call: CAPPluginCall,
        rawUrl: String,
        transferId: String?,
        destinationUrl: URL,
        trackProgress: Bool,
        emitProgress: @escaping ([String: Any]) -> Void
    ) {
        self.call = call
        self.rawUrl = rawUrl
        self.transferId = transferId
        self.destinationUrl = destinationUrl
        self.trackProgress = trackProgress
        self.emitProgress = emitProgress
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
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(statusCode) else {
            try? FileManager.default.removeItem(at: destinationUrl)
            completionHandler(.cancel)
            return
        }
        expectedLength = http.expectedContentLength
        do {
            let parent = destinationUrl.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: destinationUrl.path, contents: nil)
            fileHandle = try FileHandle(forWritingTo: destinationUrl)
            completionHandler(.allow)
        } catch {
            writeError = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let handle = fileHandle else { return }
        do {
            try handle.write(contentsOf: data)
            bytesWritten += Int64(data.count)
            if trackProgress {
                let now = CACurrentMediaTime()
                if now - lastProgressTime >= 0.1 {
                    let computable = expectedLength > 0
                    var payload: [String: Any] = [
                        "url": rawUrl,
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
        defer { session.finishTasksAndInvalidate() }
        try? fileHandle?.synchronize()
        try? fileHandle?.close()
        fileHandle = nil

        if let writeError {
            try? FileManager.default.removeItem(at: destinationUrl)
            call.reject(writeError.localizedDescription, "PRIVATE_TRANSFER_CONNECTION_FAILED")
            return
        }

        if (300..<400).contains(statusCode) {
            var result: JSObject = ["status": statusCode, "bytesWritten": 0]
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
            call.reject(error.localizedDescription, "PRIVATE_TRANSFER_CONNECTION_FAILED")
            return
        }

        if trackProgress {
            let finalTotal = expectedLength > 0 ? max(expectedLength, bytesWritten) : bytesWritten
            var payload: [String: Any] = [
                "url": rawUrl,
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
}

@objc(TurnleafNoteExportPlugin)
public final class TurnleafNoteExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TurnleafNoteExportPlugin"
    public let jsName = "NoteExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "exportMarkdown", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareMarkdown", returnType: CAPPluginReturnPromise),
    ]

    @objc func exportMarkdown(_ call: CAPPluginCall) {
        presentActivitySheet(call, successStatus: "saved")
    }

    @objc func shareMarkdown(_ call: CAPPluginCall) {
        presentActivitySheet(call, successStatus: "shared")
    }

    private func presentActivitySheet(_ call: CAPPluginCall, successStatus: String) {
        guard let markdown = call.getString("markdown") else {
            call.reject("Markdown content is required.")
            return
        }
        let safeFilename = Self.sanitizeFilename(call.getString("filename") ?? "book-notes.md")
        guard
            let cachesUrl = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        else {
            call.reject("Cache directory is unavailable.")
            return
        }

        let sharedDir = cachesUrl.standardizedFileURL.appendingPathComponent("shared", isDirectory: true)
        let stagedFile = sharedDir.appendingPathComponent(safeFilename).standardizedFileURL
        guard stagedFile.path.hasPrefix(sharedDir.path + "/") else {
            call.reject("Invalid export file path.")
            return
        }

        do {
            try FileManager.default.createDirectory(at: sharedDir, withIntermediateDirectories: true)
            if let existing = try? FileManager.default.contentsOfDirectory(at: sharedDir, includingPropertiesForKeys: nil) {
                for item in existing {
                    try? FileManager.default.removeItem(at: item)
                }
            }
            try Data(markdown.utf8).write(to: stagedFile, options: .atomic)
        } catch {
            call.reject("Could not stage Markdown notes.")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let viewController = self?.bridge?.viewController else {
                try? FileManager.default.removeItem(at: stagedFile)
                call.reject("View controller is unavailable.")
                return
            }
            let activityController = UIActivityViewController(activityItems: [stagedFile], applicationActivities: nil)
            if let popover = activityController.popoverPresentationController {
                popover.sourceView = viewController.view
                popover.sourceRect = CGRect(
                    x: viewController.view.bounds.midX,
                    y: viewController.view.bounds.midY,
                    width: 1,
                    height: 1
                )
            }
            activityController.completionWithItemsHandler = { _, completed, _, activityError in
                try? FileManager.default.removeItem(at: stagedFile)
                if activityError != nil {
                    call.reject("Could not export Markdown notes.")
                    return
                }
                if completed {
                    call.resolve(["status": successStatus, "filename": safeFilename])
                } else {
                    call.resolve(["status": "canceled"])
                }
            }
            viewController.present(activityController, animated: true)
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
