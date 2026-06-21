package app.turnleaf.reader;

import com.getcapacitor.BridgeActivity;
import android.view.KeyEvent;

public class MainActivity extends BridgeActivity {
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (
            event.getAction() == KeyEvent.ACTION_DOWN &&
            event.getRepeatCount() == 0 &&
            VolumeButtonsPlugin.enabled &&
            getBridge() != null
        ) {
            String direction = null;
            if (event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_UP) {
                direction = "previous";
            } else if (event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_DOWN) {
                direction = "next";
            }

            if (direction != null) {
                getBridge().triggerWindowJSEvent(
                    "turnleafVolumeButton",
                    "{\"direction\":\"" + direction + "\"}"
                );
                return true;
            }
        }

        return super.dispatchKeyEvent(event);
    }
}
