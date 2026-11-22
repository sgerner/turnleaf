package app.turnleaf.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReaderChromePlugin.class);
        registerPlugin(VolumeButtonsPlugin.class);
        registerPlugin(KeepAwakePlugin.class);
        super.onCreate(savedInstanceState);
    }

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
        applyReaderChrome(enabled, null);
    }

    void applyReaderChrome(boolean enabled, Runnable onComplete) {
        runOnUiThread(
            () -> {
                Window window = getWindow();
                if (window == null) {
                    if (onComplete != null) {
                        onComplete.run();
                    }
                    return;
                }
                WindowCompat.setDecorFitsSystemWindows(window, !enabled);
                View decorView = window.getDecorView();
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, decorView);
                if (controller != null) {
                    if (enabled) {
                        controller.hide(WindowInsetsCompat.Type.systemBars());
                        controller.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        );
                    } else {
                        controller.show(WindowInsetsCompat.Type.systemBars());
                    }
                }
                if (onComplete != null) {
                    if (decorView != null && decorView.isAttachedToWindow()) {
                        decorView.post(onComplete);
                    } else {
                        onComplete.run();
                    }
                }
            }
        );
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
