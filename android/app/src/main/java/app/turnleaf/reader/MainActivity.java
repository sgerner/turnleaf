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
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (handleVolumeKey(keyCode, event, true)) {
            return true;
        }

        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (handleVolumeKey(keyCode, event, false)) {
            return true;
        }

        return super.onKeyUp(keyCode, event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (handleVolumeKey(event.getKeyCode(), event, event.getAction() == KeyEvent.ACTION_DOWN)) {
            return true;
        }

        return super.dispatchKeyEvent(event);
    }

    private boolean handleVolumeKey(int keyCode, KeyEvent event, boolean down) {
        if (!VolumeButtonsPlugin.enabled || getBridge() == null) {
            return false;
        }

        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return false;
        }

        if (!down) {
            return true;
        }

        if (event.getRepeatCount() != 0) {
            return true;
        }

        String direction = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "previous" : "next";
        getBridge().triggerWindowJSEvent(
            "turnleafVolumeButton",
            "{\"direction\":\"" + direction + "\"}"
        );
        return true;
    }
}
