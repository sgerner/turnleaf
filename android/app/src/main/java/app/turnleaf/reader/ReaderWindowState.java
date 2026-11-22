package app.turnleaf.reader;

import android.view.KeyEvent;

final class ReaderWindowState {
    static final class VolumeKeyResult {
        static final VolumeKeyResult NOT_CONSUMED = new VolumeKeyResult(false, null);
        static final VolumeKeyResult CONSUMED_NOOP = new VolumeKeyResult(true, null);
        static final VolumeKeyResult PREVIOUS = new VolumeKeyResult(true, "previous");
        static final VolumeKeyResult NEXT = new VolumeKeyResult(true, "next");

        final boolean consumed;
        final String direction;

        private VolumeKeyResult(boolean consumed, String direction) {
            this.consumed = consumed;
            this.direction = direction;
        }
    }

    private volatile boolean readerChromeEnabled = false;
    private volatile boolean volumeButtonsEnabled = false;
    private volatile boolean keepAwakeEnabled = false;

    boolean isReaderChromeEnabled() {
        return readerChromeEnabled;
    }

    void setReaderChromeEnabled(boolean enabled) {
        this.readerChromeEnabled = enabled;
    }

    boolean isVolumeButtonsEnabled() {
        return volumeButtonsEnabled;
    }

    void setVolumeButtonsEnabled(boolean enabled) {
        this.volumeButtonsEnabled = enabled;
    }

    boolean isKeepAwakeEnabled() {
        return keepAwakeEnabled;
    }

    void setKeepAwakeEnabled(boolean enabled) {
        this.keepAwakeEnabled = enabled;
    }

    void reset() {
        readerChromeEnabled = false;
        volumeButtonsEnabled = false;
        keepAwakeEnabled = false;
    }

    VolumeKeyResult onVolumeKey(int keyCode, boolean down, int repeatCount, boolean bridgeAvailable) {
        if (!volumeButtonsEnabled || !bridgeAvailable) {
            return VolumeKeyResult.NOT_CONSUMED;
        }
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return VolumeKeyResult.NOT_CONSUMED;
        }
        if (!down || repeatCount != 0) {
            return VolumeKeyResult.CONSUMED_NOOP;
        }
        return keyCode == KeyEvent.KEYCODE_VOLUME_UP
            ? VolumeKeyResult.PREVIOUS
            : VolumeKeyResult.NEXT;
    }
}
