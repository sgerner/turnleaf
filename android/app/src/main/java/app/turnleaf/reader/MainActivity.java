package app.turnleaf.reader;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity implements ReaderWindowController {
    private final ReaderWindowState windowState = new ReaderWindowState();

    @Override
    public ReaderWindowState getReaderWindowState() {
        return windowState;
    }

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
        applyReaderChrome(windowState.isReaderChromeEnabled());
        applyKeepAwake(windowState.isKeepAwakeEnabled());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyReaderChrome(windowState.isReaderChromeEnabled());
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        windowState.reset();
    }

    @Override
    public void applyReaderChrome(boolean enabled) {
        runOnUiThread(
            () -> {
                Window window = getWindow();
                if (window == null) {
                    return;
                }
                View decorView = window.peekDecorView();
                if (decorView == null && enabled) {
                    decorView = window.getDecorView();
                }
                if (decorView == null) {
                    return;
                }
                WindowCompat.setDecorFitsSystemWindows(window, !enabled);
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, decorView);
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
    public void applyKeepAwake(boolean enabled) {
        runOnUiThread(
            () -> {
                Window window = getWindow();
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

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (handleVolumeKey(event.getKeyCode(), event, event.getAction() == KeyEvent.ACTION_DOWN)) {
            return true;
        }

        return super.dispatchKeyEvent(event);
    }

    private boolean handleVolumeKey(int keyCode, KeyEvent event, boolean down) {
        ReaderWindowState.VolumeKeyResult result = windowState.onVolumeKey(
            keyCode,
            down,
            event.getRepeatCount(),
            getBridge() != null
        );
        if (!result.consumed) {
            return false;
        }

        if (result.direction != null) {
            getBridge().triggerWindowJSEvent(
                "turnleafVolumeButton",
                "{\"direction\":\"" + result.direction + "\"}"
            );
        }
        return true;
    }
}
