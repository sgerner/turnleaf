package app.turnleaf.reader;

import android.app.Activity;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {
    private final ReaderWindowController testController;

    public KeepAwakePlugin() {
        this.testController = null;
    }

    KeepAwakePlugin(ReaderWindowController testController) {
        this.testController = testController;
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean value = call.getBoolean("enabled", false);
        setEnabled(value != null && value);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        setEnabled(false);
    }

    void setEnabled(boolean enabled) {
        ReaderWindowController controller = resolveController();
        if (controller != null) {
            controller.getReaderWindowState().setKeepAwakeEnabled(enabled);
            controller.applyKeepAwake(enabled);
            return;
        }
        if (getBridge() == null) {
            return;
        }
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(
                () -> {
                    Window window = activity.getWindow();
                    if (window == null) {
                        return;
                    }
                    if (enabled) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                }
            );
        }
    }

    private ReaderWindowController resolveController() {
        if (testController != null) {
            return testController;
        }
        if (getBridge() == null) {
            return null;
        }
        Activity activity = getActivity();
        return activity instanceof ReaderWindowController ? (ReaderWindowController) activity : null;
    }
}
