package app.turnleaf.reader;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NoteExport")
public class NoteExportPlugin extends Plugin {
    static final String SHARED_CACHE_DIR = "shared";
    static final String EXTRA_SHARE_TOKEN = "app.turnleaf.reader.SHARE_TOKEN";
    static final int MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
    private static final String KEY_ACTIVE_SHARE_TOKEN = "_shareToken";
    private static final ConcurrentHashMap<String, AtomicBoolean> SHARE_TOKENS = new ConcurrentHashMap<>();

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean exportInFlight = new AtomicBoolean(false);
    private volatile String activeShareToken;

    public static final class ShareChoiceReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            recordShareTargetChoice(intent.getStringExtra(EXTRA_SHARE_TOKEN));
        }
    }

    static String registerShareToken() {
        if (SHARE_TOKENS.size() > 32) {
            SHARE_TOKENS.clear();
        }
        String token = UUID.randomUUID().toString();
        SHARE_TOKENS.put(token, new AtomicBoolean(false));
        return token;
    }

    static void recordShareTargetChoice(String token) {
        if (token == null || token.isEmpty()) return;
        AtomicBoolean chosen = SHARE_TOKENS.get(token);
        if (chosen != null) {
            chosen.set(true);
        }
    }

    static boolean consumeShareToken(String token) {
        if (token == null || token.isEmpty()) return false;
        AtomicBoolean chosen = SHARE_TOKENS.remove(token);
        return chosen != null && chosen.get();
    }

    @Override
    public void load() {
        super.load();
        Context context = getContext();
        if (context != null) {
            File cacheDir = context.getCacheDir();
            executor.execute(() -> cleanupSharedCache(cacheDir));
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        String token = activeShareToken;
        activeShareToken = null;
        boolean chosen = consumeShareToken(token);
        Context context = getContext();
        if (!chosen && context != null) {
            cleanupSharedCache(context.getCacheDir());
        }
        exportInFlight.set(false);
        executor.shutdownNow();
    }

    @PluginMethod
    public void exportMarkdown(PluginCall call) {
        byte[] utf8 = validateMarkdownBytes(call);
        if (utf8 == null) return;
        if (!exportInFlight.compareAndSet(false, true)) {
            call.reject("Another note export is already in progress.");
            return;
        }
        String safeFilename = sanitizeMarkdownFilename(call.getString("filename"));
        String title = call.getString("title", safeFilename);

        Intent createIntent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        createIntent.addCategory(Intent.CATEGORY_OPENABLE);
        createIntent.setType("text/markdown");
        createIntent.putExtra(Intent.EXTRA_TITLE, safeFilename);

        try {
            startActivityForResult(call, createIntent, "handleCreateDocumentResult");
        } catch (ActivityNotFoundException unavailable) {
            launchShareChooser(call, safeFilename, title != null ? title : safeFilename, utf8);
        }
    }

    @PluginMethod
    public void shareMarkdown(PluginCall call) {
        byte[] utf8 = validateMarkdownBytes(call);
        if (utf8 == null) return;
        if (!exportInFlight.compareAndSet(false, true)) {
            call.reject("Another note export is already in progress.");
            return;
        }
        String safeFilename = sanitizeMarkdownFilename(call.getString("filename"));
        String title = call.getString("title", safeFilename);
        launchShareChooser(call, safeFilename, title != null ? title : safeFilename, utf8);
    }

    private static byte[] validateMarkdownBytes(PluginCall call) {
        String markdown = call.getString("markdown");
        if (markdown == null) {
            call.reject("Markdown content is required.");
            return null;
        }
        byte[] utf8 = markdown.getBytes(StandardCharsets.UTF_8);
        if (utf8.length > MAX_MARKDOWN_BYTES) {
            call.reject("Markdown content exceeds maximum export size.");
            return null;
        }
        return utf8;
    }

    private void launchShareChooser(
        PluginCall call,
        String safeFilename,
        String title,
        byte[] markdownBytes
    ) {
        Context context = getContext();
        if (context == null) {
            exportInFlight.set(false);
            call.reject("Application context is unavailable.");
            return;
        }
        executor.execute(() -> {
            String shareToken = registerShareToken();
            activeShareToken = shareToken;
            call.getData().put(KEY_ACTIVE_SHARE_TOKEN, shareToken);
            try {
                File stagedFile = stageSharedMarkdownBytes(
                    context.getCacheDir(),
                    safeFilename,
                    markdownBytes
                );
                Uri contentUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    stagedFile
                );

                Intent sendIntent = new Intent(Intent.ACTION_SEND);
                sendIntent.setType("text/markdown");
                sendIntent.putExtra(Intent.EXTRA_SUBJECT, title);
                sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                sendIntent.setClipData(ClipData.newRawUri(safeFilename, contentUri));
                sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent choiceIntent = new Intent(context, ShareChoiceReceiver.class);
                choiceIntent.setPackage(context.getPackageName());
                choiceIntent.putExtra(EXTRA_SHARE_TOKEN, shareToken);
                PendingIntent pendingChoice = PendingIntent.getBroadcast(
                    context,
                    shareToken.hashCode(),
                    choiceIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE
                );
                Intent chooser = Intent.createChooser(
                    sendIntent,
                    title,
                    pendingChoice.getIntentSender()
                );

                Activity activity = getActivity();
                if (activity == null) {
                    releaseFailedShare(context, shareToken);
                    call.reject("Activity is unavailable.");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        startActivityForResult(call, chooser, "handleShareResult");
                    } catch (ActivityNotFoundException error) {
                        executor.execute(() -> releaseFailedShare(context, shareToken));
                        call.reject("No application can share Markdown notes.");
                    }
                });
            } catch (IOException | IllegalArgumentException error) {
                releaseFailedShare(context, shareToken);
                call.reject("Could not prepare Markdown notes for sharing.");
            }
        });
    }

    private void releaseFailedShare(Context context, String shareToken) {
        if (shareToken.equals(activeShareToken)) {
            activeShareToken = null;
        }
        consumeShareToken(shareToken);
        cleanupSharedCache(context.getCacheDir());
        exportInFlight.set(false);
    }

    @ActivityCallback
    private void handleCreateDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            exportInFlight.set(false);
            return;
        }
        Intent data = result.getData();
        Uri destination = data != null ? data.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || destination == null) {
            exportInFlight.set(false);
            JSObject canceled = new JSObject();
            canceled.put("status", "canceled");
            call.resolve(canceled);
            return;
        }

        byte[] markdownBytes = call.getString("markdown", "").getBytes(StandardCharsets.UTF_8);
        String safeFilename = sanitizeMarkdownFilename(call.getString("filename"));
        Context context = getContext();
        if (context == null || markdownBytes.length > MAX_MARKDOWN_BYTES) {
            exportInFlight.set(false);
            call.reject("Could not write Markdown notes to the selected file.");
            return;
        }

        executor.execute(() -> {
            try (OutputStream out = openDocumentOutputStream(context, destination)) {
                if (out == null) {
                    throw new IOException("Document output stream was null.");
                }
                out.write(markdownBytes);
                out.flush();
                JSObject saved = new JSObject();
                saved.put("status", "saved");
                saved.put("filename", safeFilename);
                call.resolve(saved);
            } catch (IOException | SecurityException error) {
                call.reject("Could not write Markdown notes to the selected file.");
            } finally {
                exportInFlight.set(false);
            }
        });
    }

    @ActivityCallback
    private void handleShareResult(PluginCall call, ActivityResult result) {
        try {
            if (call == null) return;
            String token = call.getData().getString(KEY_ACTIVE_SHARE_TOKEN, activeShareToken);
            if (token != null && token.equals(activeShareToken)) {
                activeShareToken = null;
            }
            boolean chosen = consumeShareToken(token);
            if (chosen || result.getResultCode() == Activity.RESULT_OK) {
                JSObject shared = new JSObject();
                shared.put("status", "shared");
                shared.put("filename", sanitizeMarkdownFilename(call.getString("filename")));
                call.resolve(shared);
                return;
            }
            Context context = getContext();
            if (context != null) {
                File cacheDir = context.getCacheDir();
                executor.execute(() -> cleanupSharedCache(cacheDir));
            }
            JSObject canceled = new JSObject();
            canceled.put("status", "canceled");
            call.resolve(canceled);
        } finally {
            exportInFlight.set(false);
        }
    }

    private static OutputStream openDocumentOutputStream(Context context, Uri uri) throws IOException {
        try {
            OutputStream truncated = context.getContentResolver().openOutputStream(uri, "wt");
            if (truncated != null) return truncated;
        } catch (IllegalArgumentException ignored) {
            // Fall back to default write mode when a provider does not support explicit "wt".
        }
        return context.getContentResolver().openOutputStream(uri);
    }

    static String sanitizeMarkdownFilename(String rawFilename) {
        String candidate = rawFilename == null ? "" : rawFilename.trim();
        if (candidate.toLowerCase(Locale.US).endsWith(".md")) {
            candidate = candidate.substring(0, candidate.length() - 3);
        }
        StringBuilder builder = new StringBuilder();
        boolean lastWasDash = false;
        for (int index = 0; index < candidate.length(); index += 1) {
            char ch = candidate.charAt(index);
            boolean safe =
                (ch >= 'a' && ch <= 'z') ||
                (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') ||
                ch == '_' ||
                ch == '-';
            if (safe) {
                builder.append(ch);
                lastWasDash = false;
            } else if (builder.length() > 0 && !lastWasDash) {
                builder.append('-');
                lastWasDash = true;
            }
        }
        while (builder.length() > 0 && (builder.charAt(0) == '-' || builder.charAt(0) == '_')) {
            builder.deleteCharAt(0);
        }
        while (
            builder.length() > 0 &&
            (builder.charAt(builder.length() - 1) == '-' || builder.charAt(builder.length() - 1) == '_')
        ) {
            builder.deleteCharAt(builder.length() - 1);
        }
        String stem = builder.length() > 80 ? builder.substring(0, 80) : builder.toString();
        return (stem.isEmpty() ? "book-notes" : stem) + ".md";
    }

    static File stageSharedMarkdownFile(File cacheDir, String rawFilename, String markdown)
        throws IOException {
        if (markdown == null) {
            throw new IllegalArgumentException("Markdown content is required.");
        }
        byte[] bytes = markdown.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_MARKDOWN_BYTES) {
            throw new IllegalArgumentException("Markdown content exceeds maximum export size.");
        }
        return stageSharedMarkdownBytes(cacheDir, rawFilename, bytes);
    }

    private static File stageSharedMarkdownBytes(File cacheDir, String rawFilename, byte[] markdownBytes)
        throws IOException {
        if (cacheDir == null || markdownBytes == null) {
            throw new IllegalArgumentException("Cache directory and Markdown content are required.");
        }
        File canonicalCache = cacheDir.getCanonicalFile();
        File sharedDir = new File(canonicalCache, SHARED_CACHE_DIR);
        if (!sharedDir.getCanonicalPath().equals(sharedDir.getPath())) {
            throw new IllegalArgumentException("Shared cache directory must not be a symlink.");
        }
        if (!sharedDir.exists() && !sharedDir.mkdirs() && !sharedDir.isDirectory()) {
            throw new IOException("Could not create shared cache directory.");
        }
        if (!sharedDir.isDirectory() || !sharedDir.getCanonicalPath().equals(sharedDir.getPath())) {
            throw new IOException("Invalid shared cache directory.");
        }
        deleteChildren(sharedDir);

        String safeName = sanitizeMarkdownFilename(rawFilename);
        File stagedFile = new File(sharedDir, safeName);
        if (!stagedFile.getCanonicalPath().equals(stagedFile.getPath())) {
            throw new IllegalArgumentException("Staged file must not be a symlink.");
        }

        try (FileOutputStream out = new FileOutputStream(stagedFile, false)) {
            out.write(markdownBytes);
            out.flush();
            out.getFD().sync();
        }
        return stagedFile;
    }

    static void cleanupSharedCache(File cacheDir) {
        if (cacheDir == null) return;
        try {
            File canonicalCache = cacheDir.getCanonicalFile();
            File sharedDir = new File(canonicalCache, SHARED_CACHE_DIR);
            if (sharedDir.isDirectory() && sharedDir.getCanonicalPath().equals(sharedDir.getPath())) {
                deleteChildren(sharedDir);
            }
        } catch (IOException ignored) {
            // Best-effort cache cleanup.
        }
    }

    private static void deleteChildren(File directory) {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            //noinspection ResultOfMethodCallIgnored
            child.delete();
        }
    }
}
