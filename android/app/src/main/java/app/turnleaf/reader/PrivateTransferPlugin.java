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
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "PrivateTransfer")
public class PrivateTransferPlugin extends Plugin {
    static final String ERROR_CONNECTION_FAILED = "PRIVATE_TRANSFER_CONNECTION_FAILED";
    static final String ERROR_INVALID_ARGUMENT = "PRIVATE_TRANSFER_INVALID_ARGUMENT";
    private static final int DEFAULT_TIMEOUT_MS = 60_000;
    private static final int STREAM_BUFFER_BYTES = 16 * 1024;
    private static final long PROGRESS_INTERVAL_NS = 100_000_000L;

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

    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        executor.shutdownNow();
    }

    @PluginMethod
    public void downloadFile(PluginCall call) {
        String rawUrl = call.getString("url");
        String relativePath = call.getString("relativePath");
        if (rawUrl == null || rawUrl.isEmpty() || relativePath == null || relativePath.isEmpty()) {
            call.reject("Invalid private transfer options.", ERROR_INVALID_ARGUMENT);
            return;
        }

        final URL targetUrl;
        final File targetFile;
        try {
            targetUrl = validateHttpUrl(rawUrl);
            targetFile = resolvePrivateDataFile(getContext().getFilesDir(), relativePath);
        } catch (IllegalArgumentException | IOException error) {
            call.reject("Invalid private transfer target.", ERROR_INVALID_ARGUMENT);
            return;
        }

        final Map<String, String> headers = extractHeaders(call.getObject("headers"));
        Integer connectOpt = call.getInt("connectTimeout", DEFAULT_TIMEOUT_MS);
        Integer readOpt = call.getInt("readTimeout", DEFAULT_TIMEOUT_MS);
        final int connectTimeout = connectOpt != null && connectOpt > 0 ? connectOpt : DEFAULT_TIMEOUT_MS;
        final int readTimeout = readOpt != null && readOpt > 0 ? readOpt : DEFAULT_TIMEOUT_MS;
        Boolean progressOpt = call.getBoolean("progress", false);
        final boolean trackProgress = progressOpt != null && progressOpt;
        final String transferId = call.getString("transferId");

        executor.execute(
            () -> {
                try {
                    ProgressListener listener = trackProgress
                        ? (bytes, contentLength, lengthComputable) -> {
                            JSObject event = new JSObject();
                            if (transferId != null) {
                                event.put("transferId", transferId);
                            }
                            event.put("url", rawUrl);
                            event.put("bytes", bytes);
                            event.put("contentLength", contentLength);
                            event.put("lengthComputable", lengthComputable);
                            notifyListeners("progress", event);
                        }
                        : null;

                    TransferOutcome outcome = executeDownload(
                        targetUrl,
                        targetFile,
                        headers,
                        connectTimeout,
                        readTimeout,
                        listener
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
                }
            }
        );
    }

    static URL validateHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            throw new IllegalArgumentException("Download URL is required.");
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
            if (uri.getHost() == null || uri.getHost().isEmpty() || uri.getUserInfo() != null) {
                throw new IllegalArgumentException("Invalid download URL authority.");
            }
            return uri.toURL();
        } catch (URISyntaxException | IOException error) {
            throw new IllegalArgumentException("Malformed download URL.", error);
        }
    }

    static File resolvePrivateDataFile(File filesDir, String relativePath) throws IOException {
        if (filesDir == null || relativePath == null || relativePath.isEmpty()) {
            throw new IllegalArgumentException("Relative path is required.");
        }
        if (
            relativePath.startsWith("/") ||
            relativePath.contains("\\") ||
            relativePath.indexOf('\0') >= 0
        ) {
            throw new IllegalArgumentException("Unsafe private path characters.");
        }
        String[] segments = relativePath.split("/", -1);
        if (segments.length < 2) {
            throw new IllegalArgumentException("Private path must reside in a managed directory.");
        }
        if (!"books".equals(segments[0]) && !"covers".equals(segments[0])) {
            throw new IllegalArgumentException("Private path directory is not permitted.");
        }
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw new IllegalArgumentException("Unsafe private path segment.");
            }
        }

        File baseDir = filesDir.getCanonicalFile();
        File targetFile = new File(baseDir, relativePath).getCanonicalFile();
        String basePath = baseDir.getCanonicalPath();
        String requiredPrefix = basePath.endsWith(File.separator)
            ? basePath
            : basePath + File.separator;
        if (!targetFile.getCanonicalPath().startsWith(requiredPrefix)) {
            throw new IllegalArgumentException("Target path escapes app-private storage.");
        }
        return targetFile;
    }

    static TransferOutcome executeDownload(
        URL url,
        File targetFile,
        Map<String, String> headers,
        int connectTimeout,
        int readTimeout,
        ProgressListener progressListener
    ) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
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
                return new TransferOutcome(status, location, 0L);
            }
            if (status < 200 || status >= 400) {
                closeQuietly(connection.getErrorStream());
                deleteIfExists(targetFile);
                return new TransferOutcome(status, null, 0L);
            }

            File parent = targetFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
                throw new IOException("Could not create private parent directory.");
            }

            long contentLength = connection.getContentLengthLong();
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
                    out.write(buffer, 0, read);
                    bytesWritten += read;
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

            if (progressListener != null) {
                long finalTotal = lengthComputable ? Math.max(contentLength, bytesWritten) : bytesWritten;
                progressListener.onProgress(bytesWritten, finalTotal, true);
            }

            return new TransferOutcome(status, null, bytesWritten);
        } finally {
            connection.disconnect();
        }
    }

    private static Map<String, String> extractHeaders(JSObject rawHeaders) {
        if (rawHeaders == null) {
            return Collections.emptyMap();
        }
        Map<String, String> headers = new HashMap<>();
        Iterator<String> keys = rawHeaders.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = rawHeaders.getString(key);
            if (key != null && !key.isEmpty() && value != null) {
                headers.put(key, value);
            }
        }
        return headers;
    }

    private static void closeQuietly(InputStream stream) {
        if (stream == null) return;
        try {
            stream.close();
        } catch (IOException ignored) {
            // Best-effort cleanup of error stream.
        }
    }

    private static void deleteIfExists(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
