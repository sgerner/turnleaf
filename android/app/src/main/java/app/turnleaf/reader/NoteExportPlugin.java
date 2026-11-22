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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NoteExport")
public class NoteExportPlugin extends Plugin {
    static final String SHARED_CACHE_DIR = "shared";
    private static final AtomicBoolean shareTargetChosen = new AtomicBoolean(false);
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    public static final class ShareChoiceReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            shareTargetChosen.set(true);
        }
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
        executor.shutdownNow();
    }

    @PluginMethod
    public void exportMarkdown(PluginCall call) {
        String markdown = call.getString("markdown");
        if (markdown == null) {
            call.reject("Markdown content is required.");
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
            launchShareChooser(call, safeFilename, title != null ? title : safeFilename, markdown);
        }
    }

    @PluginMethod
    public void shareMarkdown(PluginCall call) {
        String markdown = call.getString("markdown");
        if (markdown == null) {
            call.reject("Markdown content is required.");
            return;
        }
        String safeFilename = sanitizeMarkdownFilename(call.getString("filename"));
        String title = call.getString("title", safeFilename);
        launchShareChooser(call, safeFilename, title != null ? title : safeFilename, markdown);
    }

    private void launchShareChooser(
        PluginCall call,
        String safeFilename,
        String title,
        String markdown
    ) {
        Context context = getContext();
        if (context == null) {
            call.reject("Application context is unavailable.");
            return;
        }
        executor.execute(
            () -> {
                try {
                    File stagedFile = stageSharedMarkdownFile(
                        context.getCacheDir(),
                        safeFilename,
                        markdown
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

                    shareTargetChosen.set(false);
                    Intent choiceIntent = new Intent(context, ShareChoiceReceiver.class);
                    PendingIntent pendingChoice = PendingIntent.getBroadcast(
                        context,
                        0,
                        choiceIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                    );
                    Intent chooser = Intent.createChooser(
                        sendIntent,
                        title,
                        pendingChoice.getIntentSender()
                    );

                    Activity activity = getActivity();
                    if (activity == null) {
                        cleanupSharedCache(context.getCacheDir());
                        call.reject("Activity is unavailable.");
                        return;
                    }
                    activity.runOnUiThread(
                        () -> {
                            try {
                                startActivityForResult(call, chooser, "handleShareResult");
                            } catch (ActivityNotFoundException error) {
                                executor.execute(() -> cleanupSharedCache(context.getCacheDir()));
                                call.reject("No application can share Markdown notes.");
                            }
                        }
                    );
                } catch (IOException | IllegalArgumentException error) {
                    cleanupSharedCache(context.getCacheDir());
                    call.reject("Could not prepare Markdown notes for sharing.");
                }
            }
        );
    }

    @ActivityCallback
    private void handleCreateDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri destination = data != null ? data.getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || destination == null) {
            JSObject canceled = new JSObject();
            canceled.put("status", "canceled");
            call.resolve(canceled);
            return;
        }

        String markdown = call.getString("markdown", "");
        String safeFilename = sanitizeMarkdownFilename(call.getString("filename"));
        Context context = getContext();
        if (context == null) {
            call.reject("Application context is unavailable.");
            return;
        }

        executor.execute(
            () -> {
                try (OutputStream out = openDocumentOutputStream(context, destination)) {
                    if (out == null) {
                        throw new IOException("Document output stream was null.");
                    }
                    out.write(markdown.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    JSObject saved = new JSObject();
                    saved.put("status", "saved");
                    saved.put("filename", safeFilename);
                    call.resolve(saved);
                } catch (IOException | SecurityException error) {
                    call.reject("Could not write Markdown notes to the selected file.");
                }
            }
        );
    }

    @ActivityCallback
    private void handleShareResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        boolean chosen = shareTargetChosen.getAndSet(false);
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
    }

    private static OutputStream openDocumentOutputStream(Context context, Uri uri)
        throws IOException {
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
            (builder.charAt(builder.length() - 1) == '-' ||
                builder.charAt(builder.length() - 1) == '_')
        ) {
            builder.deleteCharAt(builder.length() - 1);
        }
        String stem = builder.length() > 80 ? builder.substring(0, 80) : builder.toString();
        if (stem.isEmpty()) {
            stem = "book-notes";
        }
        return stem + ".md";
    }

    static File stageSharedMarkdownFile(File cacheDir, String rawFilename, String markdown)
        throws IOException {
        if (cacheDir == null || markdown == null) {
            throw new IllegalArgumentException("Cache directory and Markdown content are required.");
        }
        File canonicalCache = cacheDir.getCanonicalFile();
        String cachePath = canonicalCache.getCanonicalPath();
        String cachePrefix = cachePath.endsWith(File.separator)
            ? cachePath
            : cachePath + File.separator;

        File sharedDir = new File(canonicalCache, SHARED_CACHE_DIR).getCanonicalFile();
        if (!sharedDir.getCanonicalPath().startsWith(cachePrefix)) {
            throw new IllegalArgumentException("Shared cache directory escaped app cache.");
        }
        if (!sharedDir.exists() && !sharedDir.mkdirs() && !sharedDir.isDirectory()) {
            throw new IOException("Could not create shared cache directory.");
        }
        deleteChildren(sharedDir);

        String safeName = sanitizeMarkdownFilename(rawFilename);
        File stagedFile = new File(sharedDir, safeName).getCanonicalFile();
        String sharedPath = sharedDir.getCanonicalPath();
        String sharedPrefix = sharedPath.endsWith(File.separator)
            ? sharedPath
            : sharedPath + File.separator;
        if (!stagedFile.getCanonicalPath().startsWith(sharedPrefix)) {
            throw new IllegalArgumentException("Staged file escaped shared cache directory.");
        }

        try (FileOutputStream out = new FileOutputStream(stagedFile, false)) {
            out.write(markdown.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
        return stagedFile;
    }

    static void cleanupSharedCache(File cacheDir) {
        if (cacheDir == null) return;
        File sharedDir = new File(cacheDir, SHARED_CACHE_DIR);
        if (sharedDir.isDirectory()) {
            deleteChildren(sharedDir);
        }
    }

    private static void deleteChildren(File directory) {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                child.delete();
            }
        }
    }
}
