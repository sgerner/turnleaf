import AVFoundation
import Capacitor
import MediaPlayer
import UIKit
import WebKit

@objc(TurnleafBridgeViewController)
final class TurnleafBridgeViewController: CAPBridgeViewController {
    private var contentSizeObserver: NSObjectProtocol?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        let script = WKUserScript(
            source: Self.dynamicTypeScript(for: resolvedContentSizeCategory()),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        webView?.configuration.userContentController.addUserScript(script)
    }

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
        contentSizeObserver = NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.applyDynamicTypeScale()
        }
        if #available(iOS 17.0, *) {
            _ = registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in
                self.applyDynamicTypeScale()
            }
        }
        applyDynamicTypeScale()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applyDynamicTypeScale()
    }

    deinit {
        if let contentSizeObserver {
            NotificationCenter.default.removeObserver(contentSizeObserver)
        }
    }

    private func resolvedContentSizeCategory() -> UIContentSizeCategory {
        let traitCategory = traitCollection.preferredContentSizeCategory
        if traitCategory != .unspecified {
            return traitCategory
        }
        return UIApplication.shared.preferredContentSizeCategory
    }

    private static func dynamicTypeScale(for category: UIContentSizeCategory) -> CGFloat {
        let resolved = category == .unspecified ? .large : category
        let basePoints: CGFloat = 17.0
        let scaledPoints = UIFontMetrics(forTextStyle: .body).scaledValue(
            for: basePoints,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: resolved)
        )
        return min(2.0, max(0.85, scaledPoints / basePoints))
    }

    private static func formattedScale(for category: UIContentSizeCategory) -> String {
        let raw = Double(dynamicTypeScale(for: category))
        let rounded = (raw * 1000).rounded() / 1000
        return String(rounded)
    }

    private static func dynamicTypeScript(for category: UIContentSizeCategory) -> String {
        let resolved = category == .unspecified ? .large : category
        let scale = formattedScale(for: resolved)
        return """
        (() => {
          const root = document.documentElement;
          if (!root) return;
          root.style.setProperty('--turnleaf-text-scale', '\(scale)');
          root.dataset.contentSizeCategory = '\(resolved.rawValue)';
        })();
        """
    }

    private func applyDynamicTypeScale() {
        let category = resolvedContentSizeCategory()
        let resolved = category == .unspecified ? .large : category
        let scale = Self.formattedScale(for: resolved)
        webView?.evaluateJavaScript(Self.dynamicTypeScript(for: resolved), completionHandler: nil)
        bridge?.triggerWindowJSEvent(
            eventName: "turnleafDynamicType",
            data: #"{"scale":\#(scale),"category":"\#(resolved.rawValue)"}"#
        )
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
