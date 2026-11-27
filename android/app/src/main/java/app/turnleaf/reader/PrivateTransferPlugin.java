package app.turnleaf.reader;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "PrivateTransfer")
public class PrivateTransferPlugin extends Plugin {
    static final String ERROR_CONNECTION_FAILED = "PRIVATE_TRANSFER_CONNECTION_FAILED";
    static final String ERROR_INVALID_ARGUMENT = "PRIVATE_TRANSFER_INVALID_ARGUMENT";
    static final long MAX_TRANSFER_BYTES = 512L * 1024L * 1024L;
    private static final int DEFAULT_TIMEOUT_MS = 60_000;
    private static final int STREAM_BUFFER_BYTES = 16 * 1024;
    private static final long PROGRESS_INTERVAL_NS = 100_000_000L;
    private static final int MAX_SEGMENT_LENGTH = 160;
    private static final Set<String> ALLOWED_HEADERS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("x-api-key", "accept", "accept-language"))
    );

    interface ProgressListener {
        void onProgress(long bytes, long contentLength, boolean lengthComputable);
    }

    static final class TransferOutcome {
        final int status;
        final String location;
        final long bytesWritten;

        TransferOutcome(int status, String location, long bytesWritten) {
            this.status = status;
            this.location = location;
            this.bytesWritten = bytesWritten;
        }
    }

    static final class TransferControl {
        final AtomicBoolean canceled = new AtomicBoolean(false);
        final File targetFile;
        volatile HttpURLConnection connection;
        volatile Thread worker;

        TransferControl(File targetFile) {
            this.targetFile = targetFile;
        }

        void cancel() {
            if (!canceled.compareAndSet(false, true)) return;
            Thread thread = worker;
            if (thread != null) {
                thread.interrupt();
            }
            HttpURLConnection active = connection;
            if (active != null) {
                active.disconnect();
            }
            deleteIfExists(targetFile);
        }
    }

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, TransferControl> activeTransfers = new ConcurrentHashMap<>();

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        for (TransferControl control : activeTransfers.values()) {
            control.cancel();
        }
        activeTransfers.clear();
        executor.shutdownNow();
    }

    @PluginMethod
    public void abortTransfer(PluginCall call) {
        String transferId = call.getString("transferId");
        if (transferId != null && !transferId.isEmpty()) {
            TransferControl control = activeTransfers.remove(transferId);
            if (control != null) {
                executor.execute(control::cancel);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void downloadFile(PluginCall call) {
        String rawUrl = call.getString("url");
        String relativePath = call.getString("relativePath");
        if (rawUrl == null || rawUrl.isEmpty() || relativePath == null || relativePath.isEmpty()) {
            call.reject("Invalid private transfer options.", ERROR_INVALID_ARGUMENT);
            return;
        }

        final File filesDir = getContext().getFilesDir();
        final URL targetUrl;
        final File targetFile;
        final Map<String, String> headers;
        try {
            targetUrl = validateHttpUrl(rawUrl);
            targetFile = resolvePrivateDataFile(filesDir, relativePath);
            headers = validateHeaders(call.getObject("headers"));
        } catch (IllegalArgumentException | IOException error) {
            call.reject("Invalid private transfer target.", ERROR_INVALID_ARGUMENT);
            return;
        }

        Integer connectOpt = call.getInt("connectTimeout", DEFAULT_TIMEOUT_MS);
        Integer readOpt = call.getInt("readTimeout", DEFAULT_TIMEOUT_MS);
        final int connectTimeout = connectOpt != null && connectOpt > 0 ? connectOpt : DEFAULT_TIMEOUT_MS;
        final int readTimeout = readOpt != null && readOpt > 0 ? readOpt : DEFAULT_TIMEOUT_MS;
        Boolean progressOpt = call.getBoolean("progress", false);
        final boolean trackProgress = progressOpt != null && progressOpt;
        final String transferId = call.getString("transferId");
        final String trackingKey =
            transferId != null && !transferId.isEmpty() ? transferId : UUID.randomUUID().toString();
        final TransferControl control = new TransferControl(targetFile);
        TransferControl previous = activeTransfers.put(trackingKey, control);
        if (previous != null) {
            previous.cancel();
        }

        executor.execute(() -> {
            control.worker = Thread.currentThread();
            try {
                if (control.canceled.get()) {
                    throw new IOException("Private transfer canceled.");
                }
                ProgressListener listener = trackProgress
                    ? (bytes, contentLength, lengthComputable) -> {
                        if (control.canceled.get()) return;
                        JSObject event = new JSObject();
                        if (transferId != null) {
                            event.put("transferId", transferId);
                        }
                        event.put("bytes", bytes);
                        event.put("contentLength", contentLength);
                        event.put("lengthComputable", lengthComputable);
                        notifyListeners("progress", event);
                    }
                    : null;

                TransferOutcome outcome = executeDownload(
                    targetUrl,
                    filesDir,
                    targetFile,
                    headers,
                    connectTimeout,
                    readTimeout,
                    listener,
                    control
                );

                JSObject response = new JSObject();
                response.put("status", outcome.status);
                if (outcome.location != null) {
                    response.put("location", outcome.location);
                }
                response.put("bytesWritten", outcome.bytesWritten);
                call.resolve(response);
            } catch (IOException error) {
                call.reject("The private file transfer failed.", ERROR_CONNECTION_FAILED);
            } finally {
                activeTransfers.remove(trackingKey, control);
            }
        });
    }

    static URL validateHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            throw new IllegalArgumentException("Download URL is required.");
        }
        for (int i = 0; i < rawUrl.length(); i += 1) {
            char ch = rawUrl.charAt(i);
            if (ch <= 0x1f || ch == 0x7f) {
                throw new IllegalArgumentException("Download URL contains control characters.");
            }
        }
        try {
            URI uri = new URI(rawUrl);
            String scheme = uri.getScheme();
            if (scheme == null) {
                throw new IllegalArgumentException("Download URL scheme is required.");
            }
            String normalizedScheme = scheme.toLowerCase(Locale.US);
            if (!"http".equals(normalizedScheme) && !"https".equals(normalizedScheme)) {
                throw new IllegalArgumentException("Only HTTP and HTTPS URLs are allowed.");
            }
            if (
                uri.getHost() == null ||
                uri.getHost().isEmpty() ||
                uri.getUserInfo() != null ||
                uri.getRawFragment() != null
            ) {
                throw new IllegalArgumentException("Invalid download URL authority or fragment.");
            }
            return uri.toURL();
        } catch (URISyntaxException | IOException error) {
            throw new IllegalArgumentException("Malformed download URL.", error);
        }
    }

    static Map<String, String> validateHeaders(JSObject rawHeaders) {
        if (rawHeaders == null) {
            return Collections.emptyMap();
        }
        Map<String, Object> extracted = new HashMap<>();
        Iterator<String> keys = rawHeaders.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            extracted.put(key, key != null ? rawHeaders.opt(key) : null);
        }
        return validateHeaderMap(extracted);
    }

    static Map<String, String> validateHeaderMap(Map<String, ?> rawHeaders) {
        if (rawHeaders == null || rawHeaders.isEmpty()) {
            return Collections.emptyMap();
        }
        Map<String, String> headers = new HashMap<>();
        for (Map.Entry<String, ?> entry : rawHeaders.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.trim().isEmpty()) {
                throw new IllegalArgumentException("Header name must not be empty.");
            }
            String normalized = key.trim().toLowerCase(Locale.US);
            if (!ALLOWED_HEADERS.contains(normalized)) {
                throw new IllegalArgumentException("Disallowed private transfer header: " + key);
            }
            Object rawValue = entry.getValue();
            if (!(rawValue instanceof String)) {
                throw new IllegalArgumentException("Header value must be a string.");
            }
            String value = (String) rawValue;
            if (containsHeaderControlChars(key) || containsHeaderControlChars(value)) {
                throw new IllegalArgumentException("Invalid private transfer header value.");
            }
            headers.put(normalized, value);
        }
        return headers;
    }

    private static boolean containsHeaderControlChars(String value) {
        for (int i = 0; i < value.length(); i += 1) {
            char ch = value.charAt(i);
            if (ch == '\r' || ch == '\n' || ch == '\0') {
                return true;
            }
        }
        return false;
    }

    private static boolean isSafePathSegment(String segment) {
        if (segment == null || segment.isEmpty() || segment.length() > MAX_SEGMENT_LENGTH) {
            return false;
        }
        if (segment.charAt(0) == '.' || segment.charAt(segment.length() - 1) == '.' || segment.contains("..")) {
            return false;
        }
        for (int i = 0; i < segment.length(); i += 1) {
            char ch = segment.charAt(i);
            boolean safe =
                (ch >= 'a' && ch <= 'z') ||
                (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') ||
                ch == '.' ||
                ch == '_' ||
                ch == '-';
            if (!safe) return false;
        }
        return true;
    }

    static File resolvePrivateDataFile(File filesDir, String relativePath) throws IOException {
        if (filesDir == null || relativePath == null || relativePath.isEmpty()) {
            throw new IllegalArgumentException("Relative path is required.");
        }
        if (relativePath.startsWith("/") || relativePath.contains("\\") || relativePath.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Unsafe private path characters.");
        }
        String[] segments = relativePath.split("/", -1);
        for (String segment : segments) {
            if (!isSafePathSegment(segment)) {
                throw new IllegalArgumentException("Unsafe private path segment.");
            }
        }
        boolean validBookPartial =
            segments.length == 2 &&
            "books".equals(segments[0]) &&
            segments[1].endsWith(".epub.partial") &&
            segments[1].length() > ".epub.partial".length();
        boolean validCoverPartial =
            segments.length == 3 &&
            "covers".equals(segments[0]) &&
            segments[2].endsWith(".img.partial") &&
            segments[2].length() > ".img.partial".length();
        if (!validBookPartial && !validCoverPartial) {
            throw new IllegalArgumentException("Private transfer path must target a .partial staging file.");
        }

        File baseDir = filesDir.getCanonicalFile();
        File current = baseDir;
        for (String segment : segments) {
            current = new File(current, segment);
            if (!current.getCanonicalPath().equals(current.getPath())) {
                throw new IllegalArgumentException("Symlinks are not permitted in private storage.");
            }
        }
        String basePrefix = baseDir.getPath().endsWith(File.separator)
            ? baseDir.getPath()
            : baseDir.getPath() + File.separator;
        if (!current.getPath().startsWith(basePrefix)) {
            throw new IllegalArgumentException("Target path escapes app-private storage.");
        }
        return current;
    }

    private static void ensureCanonicalStagingPath(File filesDir, File targetFile) throws IOException {
        File baseDir = filesDir.getCanonicalFile();
        String basePrefix = baseDir.getPath().endsWith(File.separator)
            ? baseDir.getPath()
            : baseDir.getPath() + File.separator;
        if (!targetFile.getPath().startsWith(basePrefix)) {
            throw new IOException("Staging file path escaped app-private storage.");
        }
        File parent = targetFile.getParentFile();
        if (parent == null) {
            throw new IOException("Staging file parent directory is missing.");
        }
        if (!parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Could not create private parent directory.");
        }
        for (File cursor = parent; cursor != null && !cursor.equals(baseDir); cursor = cursor.getParentFile()) {
            if (!cursor.isDirectory() || !cursor.getCanonicalPath().equals(cursor.getPath())) {
                throw new IOException("Unsafe private staging directory.");
            }
        }
        if (!targetFile.getCanonicalPath().equals(targetFile.getPath())) {
            throw new IOException("Unsafe private staging target.");
        }
    }

    static TransferOutcome executeDownload(
        URL url,
        File filesDir,
        File targetFile,
        Map<String, String> headers,
        int connectTimeout,
        int readTimeout,
        ProgressListener progressListener,
        TransferControl control
    ) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        if (control != null) {
            control.connection = connection;
            if (control.canceled.get()) {
                connection.disconnect();
                throw new IOException("Private transfer canceled.");
            }
        }
        try {
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (header.getKey() != null && header.getValue() != null) {
                    connection.setRequestProperty(header.getKey(), header.getValue());
                }
            }

            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                closeQuietly(connection.getErrorStream());
                deleteIfExists(targetFile);
                return new TransferOutcome(status, location, 0L);
            }
            if (status < 200 || status >= 400) {
                closeQuietly(connection.getErrorStream());
                deleteIfExists(targetFile);
                return new TransferOutcome(status, null, 0L);
            }

            long contentLength = connection.getContentLengthLong();
            if (contentLength > MAX_TRANSFER_BYTES) {
                closeQuietly(connection.getInputStream());
                deleteIfExists(targetFile);
                throw new IOException("Transfer exceeds maximum permitted size.");
            }

            ensureCanonicalStagingPath(filesDir, targetFile);
            boolean lengthComputable = contentLength > 0;
            long bytesWritten = 0L;
            long lastProgressNs = 0L;

            try (
                InputStream in = connection.getInputStream();
                FileOutputStream out = new FileOutputStream(targetFile, false)
            ) {
                byte[] buffer = new byte[STREAM_BUFFER_BYTES];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if ((control != null && control.canceled.get()) || Thread.currentThread().isInterrupted()) {
                        throw new IOException("Private transfer interrupted.");
                    }
                    bytesWritten += read;
                    if (bytesWritten > MAX_TRANSFER_BYTES) {
                        throw new IOException("Transfer exceeded maximum permitted size.");
                    }
                    out.write(buffer, 0, read);
                    if (progressListener != null) {
                        long now = System.nanoTime();
                        if (now - lastProgressNs >= PROGRESS_INTERVAL_NS) {
                            progressListener.onProgress(
                                bytesWritten,
                                lengthComputable ? contentLength : -1L,
                                lengthComputable
                            );
                            lastProgressNs = now;
                        }
                    }
                }
                out.flush();
                out.getFD().sync();
            } catch (IOException error) {
                deleteIfExists(targetFile);
                throw error;
            }

            if (control != null && control.canceled.get()) {
                deleteIfExists(targetFile);
                throw new IOException("Private transfer canceled.");
            }

            if (progressListener != null) {
                long finalTotal = lengthComputable ? Math.max(contentLength, bytesWritten) : bytesWritten;
                progressListener.onProgress(bytesWritten, finalTotal, true);
            }

            return new TransferOutcome(status, null, bytesWritten);
        } finally {
            connection.disconnect();
        }
    }

    private static void closeQuietly(InputStream stream) {
        if (stream == null) return;
        try {
            stream.close();
        } catch (IOException ignored) {
            // Best-effort cleanup of HTTP stream.
        }
    }

    private static void deleteIfExists(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
