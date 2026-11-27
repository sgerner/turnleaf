package app.turnleaf.reader;

import android.app.Activity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "VolumeButtons")
public class VolumeButtonsPlugin extends Plugin {
    private final ReaderWindowController testController;

    public VolumeButtonsPlugin() {
        this.testController = null;
    }

    VolumeButtonsPlugin(ReaderWindowController testController) {
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
        if (controller == null) {
            return;
        }
        controller.getReaderWindowState().setVolumeButtonsEnabled(enabled);
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
