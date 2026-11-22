package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.view.WindowManager;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class MainActivityTest {
    @Test
    public void displayCutoutModeUsesShortEdgesOnlyWhileReaderChromeIsEnabled() {
        assertEquals(
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
            MainActivity.displayCutoutModeForReaderChrome(true)
        );
        assertEquals(
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT,
            MainActivity.displayCutoutModeForReaderChrome(false)
        );
    }

    @Test
    public void readerChromeApplyToCompletesWhenActivityIsUnavailable() {
        AtomicBoolean completed = new AtomicBoolean(false);
        ReaderChromePlugin.applyTo(null, true, () -> completed.set(true));
        assertTrue(completed.get());
    }
}
