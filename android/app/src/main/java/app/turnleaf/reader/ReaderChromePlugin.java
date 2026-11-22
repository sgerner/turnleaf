package app.turnleaf.reader;

import android.app.Activity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReaderChrome")
public class ReaderChromePlugin extends Plugin {
    static volatile boolean enabled = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean value = call.getBoolean("enabled", false);
        enabled = value != null && value;
        applyTo(getActivity(), enabled, call::resolve);
    }

    static void applyTo(Activity activity, boolean enabled) {
        applyTo(activity, enabled, null);
    }

    static void applyTo(Activity activity, boolean enabled, Runnable onComplete) {
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).applyReaderChrome(enabled, onComplete);
            return;
        }
        if (onComplete != null) {
            onComplete.run();
        }
    }
}
