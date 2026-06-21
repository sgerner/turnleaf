package app.turnleaf.reader;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "VolumeButtons")
public class VolumeButtonsPlugin extends Plugin {
    static volatile boolean enabled = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean value = call.getBoolean("enabled", false);
        enabled = value != null && value;
        call.resolve();
    }
}
