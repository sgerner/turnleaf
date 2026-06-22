package app.turnleaf.reader;

import com.getcapacitor.BridgeActivity;
import android.view.KeyEvent;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        applyReaderChrome(ReaderChromePlugin.enabled);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyReaderChrome(ReaderChromePlugin.enabled);
        }
    }

    void applyReaderChrome(boolean enabled) {
        runOnUiThread(
            () -> {
                Window window = getWindow();
                WindowCompat.setDecorFitsSystemWindows(window, !enabled);
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, window.getDecorView());
                if (controller == null) {
                    return;
                }

                if (enabled) {
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                    controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    );
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            }
        );
    }

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
