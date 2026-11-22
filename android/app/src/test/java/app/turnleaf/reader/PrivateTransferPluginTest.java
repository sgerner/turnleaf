package app.turnleaf.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PrivateTransferPluginTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void declaresZeroManifestPermissionsOnPluginAnnotation() {
        CapacitorPlugin annotation = PrivateTransferPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertEquals("PrivateTransfer", annotation.name());
        assertEquals(0, annotation.permissions().length);
    }

    @Test
    public void resolvesValidPrivatePathsAndRejectsTraversalOrOutsideDirectories() throws IOException {
        File filesDir = tempFolder.newFolder("files");
        File epubTarget = PrivateTransferPlugin.resolvePrivateDataFile(
            filesDir,
            "books/book-1.epub.partial"
        );
        assertTrue(epubTarget.getCanonicalPath().startsWith(filesDir.getCanonicalPath()));

        File coverTarget = PrivateTransferPlugin.resolvePrivateDataFile(
            filesDir,
            "covers/server_1/42.img.partial"
        );
        assertTrue(coverTarget.getCanonicalPath().startsWith(filesDir.getCanonicalPath()));

        String[] rejected = {
            "",
            "/books/book.epub",
            "books/../secret.txt",
            "books/..\\secret.txt",
            "shared/notes.md",
            "databases/turnleafSQLite.db",
            "books/bad\0name.epub"
        };
        for (String candidate : rejected) {
            try {
                PrivateTransferPlugin.resolvePrivateDataFile(filesDir, candidate);
                fail("Expected path rejection for: " + candidate);
            } catch (IllegalArgumentException expected) {
                // Expected rejection.
            }
        }
    }

    @Test
    public void validatesHttpUrlsAndRejectsUnsafeSchemesOrEmbeddedCredentials() {
        URL valid = PrivateTransferPlugin.validateHttpUrl(
            "https://books.example.com/api/Download/chapter?chapterId=1"
        );
        assertEquals("https", valid.getProtocol());

        String[] rejected = {
            "",
            "file:///data/data/app.turnleaf.reader/databases/db",
            "javascript:alert(1)",
            "https://user:pass@books.example.com/download"
        };
        for (String rawUrl : rejected) {
            try {
                PrivateTransferPlugin.validateHttpUrl(rawUrl);
                fail("Expected URL rejection for: " + rawUrl);
            } catch (IllegalArgumentException expected) {
                // Expected rejection.
            }
        }
    }

    @Test
    public void streamsAuthenticatedDownloadsAndReturnsRedirectsWithoutFollowing() throws Exception {
        byte[] payload = "PK\u0003\u0004turnleaf-epub-stream-payload".getBytes(StandardCharsets.UTF_8);
        List<String> seenApiKeys = Collections.synchronizedList(new ArrayList<>());

        try (ServerSocket serverSocket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))) {
            Thread serverThread = new Thread(() -> {
                for (int handled = 0; handled < 3; handled += 1) {
                    try (
                        Socket socket = serverSocket.accept();
                        BufferedReader reader = new BufferedReader(
                            new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII)
                        );
                        OutputStream out = socket.getOutputStream()
                    ) {
                        String requestLine = reader.readLine();
                        String path = requestLine != null ? requestLine.split(" ")[1] : "";
                        String apiKey = null;
                        String headerLine;
                        while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
                            int colon = headerLine.indexOf(':');
                            if (colon > 0) {
                                String name = headerLine.substring(0, colon).trim();
                                if ("x-api-key".equalsIgnoreCase(name)) {
                                    apiKey = headerLine.substring(colon + 1).trim();
                                }
                            }
                        }
                        if ("/download".equals(path)) {
                            seenApiKeys.add(apiKey);
                            String head =
                                "HTTP/1.1 200 OK\r\n" +
                                "Content-Length: " + payload.length + "\r\n" +
                                "Connection: close\r\n\r\n";
                            out.write(head.getBytes(StandardCharsets.US_ASCII));
                            out.write(payload);
                        } else if ("/redirect".equals(path)) {
                            seenApiKeys.add(apiKey);
                            String head =
                                "HTTP/1.1 302 Found\r\n" +
                                "Location: http://evil.example/leak\r\n" +
                                "Content-Length: 0\r\n" +
                                "Connection: close\r\n\r\n";
                            out.write(head.getBytes(StandardCharsets.US_ASCII));
                        } else {
                            byte[] html = "<html>Server Error</html>".getBytes(StandardCharsets.UTF_8);
                            String head =
                                "HTTP/1.1 503 Service Unavailable\r\n" +
                                "Content-Length: " + html.length + "\r\n" +
                                "Connection: close\r\n\r\n";
                            out.write(head.getBytes(StandardCharsets.US_ASCII));
                            out.write(html);
                        }
                        out.flush();
                    } catch (IOException ignored) {
                        break;
                    }
                }
            });
            serverThread.setDaemon(true);
            serverThread.start();

            int port = serverSocket.getLocalPort();
            File filesDir = tempFolder.newFolder("app-files");

            File partialEpub = PrivateTransferPlugin.resolvePrivateDataFile(
                filesDir,
                "books/ch-1.epub.partial"
            );
            List<Long> reportedBytes = new ArrayList<>();
            PrivateTransferPlugin.TransferOutcome success = PrivateTransferPlugin.executeDownload(
                PrivateTransferPlugin.validateHttpUrl("http://127.0.0.1:" + port + "/download"),
                partialEpub,
                Collections.singletonMap("x-api-key", "secret-key"),
                5_000,
                5_000,
                (bytes, total, computable) -> {
                    if (computable && total > 0) {
                        reportedBytes.add(bytes);
                    }
                }
            );
            assertEquals(200, success.status);
            assertNull(success.location);
            assertEquals(payload.length, success.bytesWritten);
            assertArrayEquals(payload, readFileBytes(partialEpub));
            assertFalse(reportedBytes.isEmpty());
            assertEquals(Long.valueOf(payload.length), reportedBytes.get(reportedBytes.size() - 1));

            File redirectFile = PrivateTransferPlugin.resolvePrivateDataFile(
                filesDir,
                "books/redirect.epub.partial"
            );
            PrivateTransferPlugin.TransferOutcome redirect = PrivateTransferPlugin.executeDownload(
                PrivateTransferPlugin.validateHttpUrl("http://127.0.0.1:" + port + "/redirect"),
                redirectFile,
                Collections.singletonMap("x-api-key", "secret-key"),
                5_000,
                5_000,
                null
            );
            assertEquals(302, redirect.status);
            assertEquals("http://evil.example/leak", redirect.location);
            assertFalse(redirectFile.exists());
            assertEquals(2, seenApiKeys.size());
            assertEquals("secret-key", seenApiKeys.get(0));
            assertEquals("secret-key", seenApiKeys.get(1));

            File errorFile = PrivateTransferPlugin.resolvePrivateDataFile(
                filesDir,
                "books/error.epub.partial"
            );
            PrivateTransferPlugin.TransferOutcome failure = PrivateTransferPlugin.executeDownload(
                PrivateTransferPlugin.validateHttpUrl("http://127.0.0.1:" + port + "/error"),
                errorFile,
                Collections.singletonMap("x-api-key", "secret-key"),
                5_000,
                5_000,
                null
            );
            assertEquals(503, failure.status);
            assertFalse(errorFile.exists());

            serverThread.join(5_000);
        }
    }

    private static byte[] readFileBytes(File file) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        return output.toByteArray();
    }
}
