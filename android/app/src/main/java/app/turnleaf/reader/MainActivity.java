package app.turnleaf.reader;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.view.KeyEvent;
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

    interface WindowJsEventSink {
        void trigger(String eventName, String data);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (
            getBridge() != null &&
            dispatchReaderKey(
                event.getKeyCode(),
                event.getAction(),
                event.getRepeatCount(),
                event.hasNoModifiers(),
                VolumeButtonsPlugin.enabled,
                ReaderChromePlugin.enabled,
                (eventName, data) -> getBridge().triggerWindowJSEvent(eventName, data)
            )
        ) {
            return true;
        }

        return super.dispatchKeyEvent(event);
    }

    static boolean dispatchReaderKey(
        int keyCode,
        int action,
        int repeatCount,
        boolean hasNoModifiers,
        boolean volumeButtonsEnabled,
        boolean readerChromeEnabled,
        WindowJsEventSink sink
    ) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (!volumeButtonsEnabled) {
                return false;
            }
            if (action == KeyEvent.ACTION_DOWN && repeatCount == 0) {
                String direction = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "previous" : "next";
                sink.trigger(
                    "turnleafVolumeButton",
                    "{\"direction\":\"" + direction + "\"}"
                );
            }
            return true;
        }

        if (keyCode == KeyEvent.KEYCODE_PAGE_UP || keyCode == KeyEvent.KEYCODE_PAGE_DOWN) {
            if (!readerChromeEnabled || !hasNoModifiers) {
                return false;
            }
            if (action == KeyEvent.ACTION_DOWN && repeatCount == 0) {
                String direction = keyCode == KeyEvent.KEYCODE_PAGE_UP ? "previous" : "next";
                sink.trigger(
                    "turnleafPageButton",
                    "{\"direction\":\"" + direction + "\"}"
                );
            }
            return true;
        }

        return false;
    }
}
