package app.turnleaf.reader;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
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
        configureEdgeToEdgeWindow(getWindow());
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

    private void configureEdgeToEdgeWindow(Window window) {
        if (window == null) {
            return;
        }
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Light navigation bar icons require API 26+, so retain a dark scrim on API 24-25.
            window.setNavigationBarColor(Color.argb(0x80, 0x1b, 0x1b, 0x1b));
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            int cutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            if (attributes.layoutInDisplayCutoutMode != cutoutMode) {
                attributes.layoutInDisplayCutoutMode = cutoutMode;
                window.setAttributes(attributes);
            }
        }
    }

    void applyReaderChrome(boolean enabled) {
        applyReaderChrome(enabled, null);
    }

    void applyReaderChrome(boolean enabled, Runnable onComplete) {
        runOnUiThread(
            () -> {
                Window window = getWindow();
                configureEdgeToEdgeWindow(window);
                View decorView = window != null ? window.getDecorView() : null;
                WindowInsetsControllerCompat controller =
                    window != null && decorView != null
                        ? WindowCompat.getInsetsController(window, decorView)
                        : null;
                if (controller != null) {
                    controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    );
                    if (enabled) {
                        controller.hide(WindowInsetsCompat.Type.systemBars());
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
