package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;

import android.view.WindowManager;
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
}
