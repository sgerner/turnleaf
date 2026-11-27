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
        if bridge?.plugin(withName: "SqliteReset") == nil {
            bridge?.registerPluginInstance(TurnleafSqliteResetPlugin())
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

@objc(TurnleafSqliteResetPlugin)
public final class TurnleafSqliteResetPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let databaseFile = "turnleafSQLite.db"
    private static let allowedFiles = [
        databaseFile,
        "\(databaseFile)-wal",
        "\(databaseFile)-shm",
        "\(databaseFile)-journal",
    ]

    public let identifier = "TurnleafSqliteResetPlugin"
    public let jsName = "SqliteReset"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "deleteDatabase", returnType: CAPPluginReturnPromise),
    ]

    @objc func deleteDatabase(_ call: CAPPluginCall) {
        let requested = call.getString("database") ?? "turnleaf"
        guard requested == "turnleaf" || requested == Self.databaseFile else {
            call.reject("Unsupported database name.")
            return
        }

        let configuredLocation =
            bridge?.config.getPluginConfig("CapacitorSQLite").getString("iosDatabaseLocation")
            ?? "Documents"

        do {
            let directoryURL = try Self.resolveDatabaseDirectory(location: configuredLocation)
            let fileManager = FileManager.default
            for fileName in Self.allowedFiles {
                let targetURL = directoryURL.appendingPathComponent(fileName)
                guard fileManager.fileExists(atPath: targetURL.path) else {
                    continue
                }
                do {
                    try fileManager.removeItem(at: targetURL)
                } catch let error as NSError where error.domain == NSCocoaErrorDomain
                    && error.code == NSFileNoSuchFileError
                {
                    continue
                }
            }
            call.resolve()
        } catch {
            call.reject("Could not delete local SQLite files: \(error.localizedDescription)")
        }
    }

    private static func resolveDatabaseDirectory(location: String) throws -> URL {
        let parts = location.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard let rootPart = parts.first, !rootPart.isEmpty else {
            throw NSError(
                domain: "TurnleafSqliteResetPlugin",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid database location."]
            )
        }

        let root = String(rootPart)
        let fileManager = FileManager.default
        let baseURL: URL
        if root == "Documents" || root == "default" {
            guard let url = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
                throw NSError(
                    domain: "TurnleafSqliteResetPlugin",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Documents directory is unavailable."]
                )
            }
            baseURL = url
        } else if root == "Library" {
            guard let url = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first else {
                throw NSError(
                    domain: "TurnleafSqliteResetPlugin",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Library directory is unavailable."]
                )
            }
            baseURL = url
        } else if root == "Applications" {
            guard let url = fileManager.urls(for: .applicationDirectory, in: .userDomainMask).first else {
                throw NSError(
                    domain: "TurnleafSqliteResetPlugin",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Application directory is unavailable."]
                )
            }
            baseURL = url
        } else if root == "tmp" {
            baseURL = fileManager.temporaryDirectory
        } else if root.caseInsensitiveCompare("cache") == .orderedSame {
            guard let url = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
                throw NSError(
                    domain: "TurnleafSqliteResetPlugin",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Caches directory is unavailable."]
                )
            }
            baseURL = url
        } else {
            throw NSError(
                domain: "TurnleafSqliteResetPlugin",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Unsupported database location."]
            )
        }

        guard parts.count > 1 else {
            return baseURL
        }

        let subsegments = parts[1].split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if subsegments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw NSError(
                domain: "TurnleafSqliteResetPlugin",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Invalid database subpath."]
            )
        }

        return subsegments.reduce(baseURL) { $0.appendingPathComponent($1) }
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
