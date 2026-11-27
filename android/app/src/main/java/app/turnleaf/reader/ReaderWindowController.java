package app.turnleaf.reader;

interface ReaderWindowController {
    ReaderWindowState getReaderWindowState();

    void applyReaderChrome(boolean enabled);

    void applyKeepAwake(boolean enabled);
}
