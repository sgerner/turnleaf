package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MainActivityTest {
    @Test
    public void deduplicatesRepeatedSameStateReaderChromeDispatches() {
        MainActivity.ReaderChromeDispatchTracker tracker =
            new MainActivity.ReaderChromeDispatchTracker();

        // Initial onResume(false) schedules one UI runnable.
        assertTrue(tracker.request(false));
        // Back-to-back onWindowFocusChanged(true) before the runnable runs is skipped.
        assertFalse(tracker.request(false));

        assertEquals(Boolean.FALSE, tracker.beginApply());
        assertFalse(tracker.completeApply(false, true));

        // Subsequent onWindowFocusChanged(true) / onResume(false) after apply is also skipped.
        assertFalse(tracker.request(false));
        assertNull(tracker.beginApply());
    }

    @Test
    public void coalescesStateTransitionsAndReassertsImmersiveModeAfterFocusLoss() {
        MainActivity.ReaderChromeDispatchTracker tracker =
            new MainActivity.ReaderChromeDispatchTracker();

        assertTrue(tracker.request(false));
        assertEquals(Boolean.FALSE, tracker.beginApply());
        assertFalse(tracker.completeApply(false, true));

        // Entering the reader schedules a single runnable even if invoked twice.
        assertTrue(tracker.request(true));
        assertFalse(tracker.request(true));
        assertEquals(Boolean.TRUE, tracker.beginApply());
        assertFalse(tracker.completeApply(true, true));
        assertFalse(tracker.request(true));

        // Losing window focus or pausing invalidates immersive mode so resume re-hides bars once.
        tracker.invalidateIfEnabled();
        assertTrue(tracker.request(true));
        assertFalse(tracker.request(true));
        assertEquals(Boolean.TRUE, tracker.beginApply());
        assertFalse(tracker.completeApply(true, true));

        // Desired state changing mid-apply triggers a single follow-up pass.
        assertTrue(tracker.request(false));
        assertEquals(Boolean.FALSE, tracker.beginApply());
        assertFalse(tracker.request(true));
        assertTrue(tracker.completeApply(false, true));
        assertEquals(Boolean.TRUE, tracker.beginApply());
        assertFalse(tracker.completeApply(true, true));
    }

    @Test
    public void retriesWhenInsetsControllerIsTemporarilyUnavailable() {
        MainActivity.ReaderChromeDispatchTracker tracker =
            new MainActivity.ReaderChromeDispatchTracker();

        assertTrue(tracker.request(false));
        assertEquals(Boolean.FALSE, tracker.beginApply());
        assertFalse(tracker.completeApply(false, false));

        // Because controller was null, the next lifecycle callback still dispatches.
        assertTrue(tracker.request(false));
        assertEquals(Boolean.FALSE, tracker.beginApply());
        assertFalse(tracker.completeApply(false, true));
        assertFalse(tracker.request(false));
    }
}
