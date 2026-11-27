package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class MainActivityTest {
    private static final class RecordedEvent {
        final String name;
        final String data;

        RecordedEvent(String name, String data) {
            this.name = name;
            this.data = data;
        }
    }

    @Test
    public void preservesVolumeButtonGatingRepeatAndActionUpSemantics() {
        List<RecordedEvent> events = new ArrayList<>();
        MainActivity.WindowJsEventSink sink =
            (name, data) -> events.add(new RecordedEvent(name, data));

        // Disabled VolumeButtonsPlugin leaves volume keys to Android system handling.
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_UP,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_DOWN,
                KeyEvent.ACTION_UP,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertTrue(events.isEmpty());

        // Enabled VolumeButtonsPlugin emits once on initial ACTION_DOWN and consumes repeats/ACTION_UP.
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_UP,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                true,
                false,
                sink
            )
        );
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_UP,
                KeyEvent.ACTION_DOWN,
                1,
                true,
                true,
                false,
                sink
            )
        );
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_UP,
                KeyEvent.ACTION_UP,
                0,
                true,
                true,
                false,
                sink
            )
        );
        assertEquals(1, events.size());
        assertEquals("turnleafVolumeButton", events.get(0).name);
        assertEquals("{\"direction\":\"previous\"}", events.get(0).data);

        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_VOLUME_DOWN,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                true,
                true,
                sink
            )
        );
        assertEquals(2, events.size());
        assertEquals("turnleafVolumeButton", events.get(1).name);
        assertEquals("{\"direction\":\"next\"}", events.get(1).data);
    }

    @Test
    public void gatesPageButtonsOnReaderChromeModifiersRepeatAndActionUpIndependentOfVolumeButtons() {
        List<RecordedEvent> events = new ArrayList<>();
        MainActivity.WindowJsEventSink sink =
            (name, data) -> events.add(new RecordedEvent(name, data));

        // Outside active reading (ReaderChrome disabled), page keys pass through to WebView DOM.
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_DOWN,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                true,
                false,
                sink
            )
        );
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_UP,
                KeyEvent.ACTION_UP,
                0,
                true,
                false,
                false,
                sink
            )
        );

        // Modified page keys (hasNoModifiers == false) pass through untouched.
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_DOWN,
                KeyEvent.ACTION_DOWN,
                0,
                false,
                false,
                true,
                sink
            )
        );
        assertTrue(events.isEmpty());

        // During active reading (ReaderChrome enabled), page keys emit once on initial ACTION_DOWN
        // even when VolumeButtonsPlugin is disabled, and consume repeats and ACTION_UP.
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_UP,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_UP,
                KeyEvent.ACTION_DOWN,
                2,
                true,
                false,
                true,
                sink
            )
        );
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_UP,
                KeyEvent.ACTION_UP,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertEquals(1, events.size());
        assertEquals("turnleafPageButton", events.get(0).name);
        assertEquals("{\"direction\":\"previous\"}", events.get(0).data);

        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_DOWN,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertTrue(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_PAGE_DOWN,
                KeyEvent.ACTION_UP,
                0,
                true,
                false,
                true,
                sink
            )
        );
        assertEquals(2, events.size());
        assertEquals("turnleafPageButton", events.get(1).name);
        assertEquals("{\"direction\":\"next\"}", events.get(1).data);

        // D-pad keys stay on the WebView DOM path for spatial focus navigation.
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                true,
                true,
                sink
            )
        );
        assertFalse(
            MainActivity.dispatchReaderKey(
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.ACTION_DOWN,
                0,
                true,
                true,
                true,
                sink
            )
        );
    }
}
