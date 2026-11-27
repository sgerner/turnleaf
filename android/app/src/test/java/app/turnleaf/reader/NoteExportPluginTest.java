package app.turnleaf.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NoteExportPluginTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void declaresZeroManifestPermissionsOnPluginAnnotation() {
        CapacitorPlugin annotation = NoteExportPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertEquals("NoteExport", annotation.name());
        assertEquals(0, annotation.permissions().length);
    }

    @Test
    public void sanitizesExportFilenamesAgainstTraversalAndSpecialCharacters() {
        assertEquals(
            "Turnleaf-Notes-123.md",
            NoteExportPlugin.sanitizeMarkdownFilename("Turnleaf Notes 123.md")
        );
        assertEquals(
            "secret-notes.md",
            NoteExportPlugin.sanitizeMarkdownFilename("../../secret/notes.md")
        );
        assertEquals("book-notes.md", NoteExportPlugin.sanitizeMarkdownFilename("..."));
    }

    @Test
    public void stagesTemporaryFilesStrictlyInsideSharedCacheAndRejectsSymlinks()
        throws IOException {
        File cacheDir = tempFolder.newFolder("cache");
        File unrelatedCacheFile = new File(cacheDir, "keep.tmp");
        try (FileOutputStream out = new FileOutputStream(unrelatedCacheFile)) {
            out.write("keep".getBytes(StandardCharsets.UTF_8));
        }

        File firstStaged = NoteExportPlugin.stageSharedMarkdownFile(
            cacheDir,
            "../first-notes.md",
            "# First"
        );
        assertEquals("shared", firstStaged.getParentFile().getName());
        assertEquals(cacheDir.getCanonicalFile(), firstStaged.getParentFile().getParentFile());
        assertEquals("# First", readUtf8(firstStaged));

        File secondStaged = NoteExportPlugin.stageSharedMarkdownFile(
            cacheDir,
            "second-notes.md",
            "# Second"
        );
        assertFalse(firstStaged.exists());
        assertTrue(secondStaged.exists());
        assertEquals("# Second", readUtf8(secondStaged));

        NoteExportPlugin.cleanupSharedCache(cacheDir);
        assertFalse(secondStaged.exists());
        assertTrue(unrelatedCacheFile.exists());

        File symlinkCache = tempFolder.newFolder("symlink-cache");
        File outside = tempFolder.newFolder("outside");
        Files.createSymbolicLink(new File(symlinkCache, "shared").toPath(), outside.toPath());
        try {
            NoteExportPlugin.stageSharedMarkdownFile(symlinkCache, "notes.md", "# Escape");
            fail("Expected symlink shared directory rejection.");
        } catch (IllegalArgumentException expected) {
            // Expected symlink rejection.
        }
    }

    @Test
    public void correlatesShareChoicesPerTokenWithoutCrossTalk() {
        String firstToken = NoteExportPlugin.registerShareToken();
        String secondToken = NoteExportPlugin.registerShareToken();

        NoteExportPlugin.recordShareTargetChoice("forged-token");
        NoteExportPlugin.recordShareTargetChoice(firstToken);

        assertTrue(NoteExportPlugin.consumeShareToken(firstToken));
        assertFalse(NoteExportPlugin.consumeShareToken(firstToken));
        assertFalse(NoteExportPlugin.consumeShareToken(secondToken));
    }

    private static String readUtf8(File file) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
