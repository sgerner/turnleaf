package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class ReaderWindowStateTest {
    private static final class RecordingWindowController implements ReaderWindowController {
        private final ReaderWindowState state = new ReaderWindowState();
        final List<Boolean> chromeTransitions = new ArrayList<>();
        final List<Boolean> keepAwakeTransitions = new ArrayList<>();

        @Override
        public ReaderWindowState getReaderWindowState() {
            return state;
        }

        @Override
        public void applyReaderChrome(boolean enabled) {
            chromeTransitions.add(enabled);
        }

        @Override
        public void applyKeepAwake(boolean enabled) {
            keepAwakeTransitions.add(enabled);
        }
    }

    @Test
    public void isolatesStateAcrossRecreatedActivities() {
        RecordingWindowController firstActivity = new RecordingWindowController();
        RecordingWindowController recreatedActivity = new RecordingWindowController();

        new ReaderChromePlugin(firstActivity).setEnabled(true);
        new VolumeButtonsPlugin(firstActivity).setEnabled(true);
        new KeepAwakePlugin(firstActivity).setEnabled(true);

        assertTrue(firstActivity.getReaderWindowState().isReaderChromeEnabled());
        assertTrue(firstActivity.getReaderWindowState().isVolumeButtonsEnabled());
        assertTrue(firstActivity.getReaderWindowState().isKeepAwakeEnabled());

        assertFalse(recreatedActivity.getReaderWindowState().isReaderChromeEnabled());
        assertFalse(recreatedActivity.getReaderWindowState().isVolumeButtonsEnabled());
        assertFalse(recreatedActivity.getReaderWindowState().isKeepAwakeEnabled());
    }

    @Test
    public void resetsWindowFlagsAndVolumeKeysWhenPluginsDestroy() {
        RecordingWindowController activity = new RecordingWindowController();
        ReaderChromePlugin chromePlugin = new ReaderChromePlugin(activity);
        VolumeButtonsPlugin volumePlugin = new VolumeButtonsPlugin(activity);
        KeepAwakePlugin keepAwakePlugin = new KeepAwakePlugin(activity);

        chromePlugin.setEnabled(true);
        volumePlugin.setEnabled(true);
        keepAwakePlugin.setEnabled(true);

        chromePlugin.handleOnDestroy();
        volumePlugin.handleOnDestroy();
        keepAwakePlugin.handleOnDestroy();

        assertFalse(activity.getReaderWindowState().isReaderChromeEnabled());
        assertFalse(activity.getReaderWindowState().isVolumeButtonsEnabled());
        assertFalse(activity.getReaderWindowState().isKeepAwakeEnabled());
        assertEquals(List.of(true, false), activity.chromeTransitions);
        assertEquals(List.of(true, false), activity.keepAwakeTransitions);
    }

    @Test
    public void consumesVolumeKeysOnlyWhileEnabledWithActiveBridge() {
        ReaderWindowState state = new ReaderWindowState();

        assertFalse(state.onVolumeKey(KeyEvent.KEYCODE_VOLUME_DOWN, true, 0, true).consumed);

        state.setVolumeButtonsEnabled(true);

        assertFalse(state.onVolumeKey(KeyEvent.KEYCODE_VOLUME_DOWN, true, 0, false).consumed);
        assertFalse(state.onVolumeKey(KeyEvent.KEYCODE_BACK, true, 0, true).consumed);

        ReaderWindowState.VolumeKeyResult next = state.onVolumeKey(
            KeyEvent.KEYCODE_VOLUME_DOWN,
            true,
            0,
            true
        );
        assertTrue(next.consumed);
        assertEquals("next", next.direction);

        ReaderWindowState.VolumeKeyResult previous = state.onVolumeKey(
            KeyEvent.KEYCODE_VOLUME_UP,
            true,
            0,
            true
        );
        assertTrue(previous.consumed);
        assertEquals("previous", previous.direction);

        ReaderWindowState.VolumeKeyResult repeat = state.onVolumeKey(
            KeyEvent.KEYCODE_VOLUME_DOWN,
            true,
            1,
            true
        );
        assertTrue(repeat.consumed);
        assertNull(repeat.direction);

        ReaderWindowState.VolumeKeyResult keyUp = state.onVolumeKey(
            KeyEvent.KEYCODE_VOLUME_DOWN,
            false,
            0,
            true
        );
        assertTrue(keyUp.consumed);
        assertNull(keyUp.direction);

        state.reset();
        assertFalse(state.onVolumeKey(KeyEvent.KEYCODE_VOLUME_DOWN, true, 0, true).consumed);
    }

    @Test
    public void declaresNoMutableStaticFieldsOnReaderPlugins() {
        for (Class<?> pluginClass : List.of(
            ReaderChromePlugin.class,
            VolumeButtonsPlugin.class,
            KeepAwakePlugin.class
        )) {
            for (Field field : pluginClass.getDeclaredFields()) {
                if (field.isSynthetic()) {
                    continue;
                }
                int modifiers = field.getModifiers();
                assertFalse(
                    pluginClass.getSimpleName() + " must not hold mutable static state: " + field.getName(),
                    Modifier.isStatic(modifiers) && !Modifier.isFinal(modifiers)
                );
            }
        }
    }
}
