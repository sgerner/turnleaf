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

final class TurnleafVolumeButtonsController {
    static let shared = TurnleafVolumeButtonsController()

    private weak var bridge: CAPBridgeProtocol?
    private weak var volumeView: MPVolumeView?
    private var volumeObservation: NSKeyValueObservation?
    private var lastVolume: Float = AVAudioSession.sharedInstance().outputVolume
    private var enabled = false
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
