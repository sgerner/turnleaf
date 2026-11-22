import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { createCdpClient } from './android-cdp.mjs';
import { runCleanup } from './android-cleanup.mjs';
import { resolveDeviceSerial } from './android-device.mjs';
import { main as smoke } from './android-smoke.mjs';

const packageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';
const title = 'Turnleaf CI EPUB';
const primaryFileName = 'edition-1-primary.epub';
const companionFileName = 'edition-2-companion.epub';
const primaryTitle = `${title} (edition-1-primary)`;
const companionTitle = `${title} (edition-2-companion)`;
const key = 'turnleaf-ci-only';
let deviceSerial;
const adb = async (...args) =>
  (
    await promisify(execFile)('adb', [...(deviceSerial ? ['-s', deviceSerial] : []), ...args], {
      timeout: 20_000,
    })
  ).stdout.trim();

async function waitFor(label, check) {
  const end = Date.now() + 30_000;
  let lastError;
  do {
    if (receivedSignal)
      throw new Error(`Android reading journey interrupted by ${receivedSignal}.`);
    try {
      const value = await check();
      if (receivedSignal)
        throw new Error(`Android reading journey interrupted by ${receivedSignal}.`);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}.`, { cause: lastError });
}

async function connectWebView() {
  const pid = await waitFor('app process', () => adb('shell', 'pidof', packageName));
  const port = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  try {
    const endpoint = await waitFor('debug WebView', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      const pages = await response.json();
      return pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl;
    });
    const socket = new WebSocket(endpoint);
    await once(socket, 'open', { signal: AbortSignal.timeout(5_000) });
    const cdp = createCdpClient(socket);
    return {
      evaluate: (expression) => cdp.evaluate(expression),
      async close() {
        cdp.close();
        await adb('forward', '--remove', `tcp:${port}`);
      },
    };
  } catch (error) {
    await adb('forward', '--remove', `tcp:${port}`);
    throw error;
  }
}

function appendZipComment(epubBytes, commentText) {
  const comment = Buffer.from(commentText, 'utf8');
  const copy = Buffer.alloc(epubBytes.length + comment.length);
  epubBytes.copy(copy, 0);
  copy.writeUInt16LE(comment.length, epubBytes.length - 2);
  comment.copy(copy, epubBytes.length);
  return copy;
}

export function buildChapterZipArchive(entries) {
  const prepared = entries.map((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const compressed = deflateRawSync(raw);
    return {
      name,
      compressed,
      uncompressedSize: raw.length,
      crc: crc32(raw),
    };
  });
  const localSize = prepared.reduce(
    (sum, item) => sum + 30 + item.name.length + item.compressed.length,
    0,
  );
  const centralSize = prepared.reduce((sum, item) => sum + 46 + item.name.length, 0);
  const archive = Buffer.alloc(localSize + centralSize + 22);
  let offset = 0;
  const localOffsets = [];
  for (const item of prepared) {
    localOffsets.push(offset);
    archive.writeUInt32LE(0x04034b50, offset);
    archive.writeUInt16LE(20, offset + 4);
    archive.writeUInt16LE(0x800, offset + 6);
    archive.writeUInt16LE(8, offset + 8);
    archive.writeUInt32LE(item.crc, offset + 14);
    archive.writeUInt32LE(item.compressed.length, offset + 18);
    archive.writeUInt32LE(item.uncompressedSize, offset + 22);
    archive.writeUInt16LE(item.name.length, offset + 26);
    offset += 30;
    item.name.copy(archive, offset);
    offset += item.name.length;
    item.compressed.copy(archive, offset);
    offset += item.compressed.length;
  }
  const centralOffset = offset;
  prepared.forEach((item, index) => {
    archive.writeUInt32LE(0x02014b50, offset);
    archive.writeUInt16LE(20, offset + 4);
    archive.writeUInt16LE(20, offset + 6);
    archive.writeUInt16LE(0x800, offset + 8);
    archive.writeUInt16LE(8, offset + 10);
    archive.writeUInt32LE(item.crc, offset + 16);
    archive.writeUInt32LE(item.compressed.length, offset + 20);
    archive.writeUInt32LE(item.uncompressedSize, offset + 24);
    archive.writeUInt16LE(item.name.length, offset + 28);
    archive.writeUInt32LE(localOffsets[index], offset + 42);
    offset += 46;
    item.name.copy(archive, offset);
    offset += item.name.length;
  });
  archive.writeUInt32LE(0x06054b50, offset);
  archive.writeUInt16LE(prepared.length, offset + 8);
  archive.writeUInt16LE(prepared.length, offset + 10);
  archive.writeUInt32LE(centralSize, offset + 12);
  archive.writeUInt32LE(centralOffset, offset + 16);
  return archive;
}

export async function startFixture() {
  const primaryEpub = await readFile(
    new URL('../dev/kavita/data/Books/lorem-ipsum.epub', import.meta.url),
  );
  const companionEpub = appendZipComment(primaryEpub, 'turnleaf-companion-edition');
  const referencePdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');
  const chapterArchive = buildChapterZipArchive([
    { name: `edition-1-primary/${primaryFileName}`, data: primaryEpub },
    { name: `edition-2-companion/${companionFileName}`, data: companionEpub },
    { name: 'reference/reference.pdf', data: referencePdf },
  ]);
  const uploads = [];
  let downloads = 0;
  let offline = false;
  const offlineRequests = [];
  const emptyProgress = { libraryId: 1, seriesId: 1, volumeId: 1, chapterId: 1, pageNum: 0 };
  const server = createServer(async (request, response) => {
    if (request.headers['x-api-key'] !== key) {
      response.writeHead(401).end();
      return;
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    if (offline) {
      offlineRequests.push(path);
      response.writeHead(503).end();
      return;
    }
    const pagesRead = uploads.at(-1)?.pageNum ?? 0;
    let body;
    switch (path) {
      case '/api/Health':
        body = { version: '0.0.0-ci' };
        break;
      case '/api/Library/libraries':
        body = [{ id: 1, name: 'Books', type: 2 }];
        break;
      case '/api/Series/v2':
        body = [{ id: 1, libraryId: 1, name: title, format: 3, pages: 14, pagesRead }];
        break;
      case '/api/Series/series-detail':
        body = {
          volumes: [
            {
              id: 1,
              chapters: [
                {
                  id: 1,
                  volumeId: 1,
                  title,
                  titleName: title,
                  pages: 14,
                  pagesRead,
                  format: 3,
                  files: [
                    {
                      id: 1,
                      format: 3,
                      extension: '.epub',
                      pages: 2,
                      bytes: primaryEpub.length,
                      filePath: `/manga/Books/Turnleaf CI/${primaryFileName}`,
                    },
                    {
                      id: 2,
                      format: 3,
                      extension: '.epub',
                      pages: 2,
                      bytes: companionEpub.length,
                      filePath: `/manga/Books/Turnleaf CI/${companionFileName}`,
                    },
                    {
                      id: 3,
                      format: 4,
                      extension: '.pdf',
                      pages: 10,
                      bytes: referencePdf.length,
                      filePath: '/manga/Books/Turnleaf CI/reference.pdf',
                    },
                  ],
                },
              ],
            },
          ],
        };
        break;
      case '/api/Download/chapter':
        downloads += 1;
        response
          .writeHead(200, {
            'Content-Type': 'application/vnd.comicbook+zip',
            'Content-Length': chapterArchive.length,
          })
          .end(chapterArchive);
        return;
      case '/api/Reader/get-progress':
        body = uploads.at(-1) ?? emptyProgress;
        break;
      case '/api/Reader/progress': {
        let json = '';
        for await (const chunk of request) json += chunk;
        try {
          uploads.push(JSON.parse(json));
          body = {};
        } catch {
          response.writeHead(400).end();
          return;
        }
        break;
      }
      default:
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    key,
    primaryTitle,
    companionTitle,
    primaryByteSize: primaryEpub.length,
    companionByteSize: companionEpub.length,
    uploads,
    get downloads() {
      return downloads;
    },
    offlineRequests,
    setOffline(value) {
      offline = value;
    },
    close() {
      server.close();
    },
  };
}

const click = (selector) => `(() => {
  const button = document.querySelector(${JSON.stringify(selector)});
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

const chapter = (number) => `Array.from(document.querySelectorAll('iframe')).some(
  frame => frame.contentDocument?.querySelector('h1')?.textContent === 'Chapter ${number}'
)`;

let receivedSignal;

function throwIfInterrupted() {
  if (receivedSignal) throw new Error(`Android reading journey interrupted by ${receivedSignal}.`);
}

async function run() {
  const onSignal = (signal) => {
    receivedSignal = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let fixture;
  let tunnel;
  let web;
  let disabledNetwork = false;
  let journeyError;
  let cleanupError;
  let journeyPassed = false;
  try {
    deviceSerial = await resolveDeviceSerial({ emulatorOnly: true });
    throwIfInterrupted();
    fixture = await startFixture();
    throwIfInterrupted();
    tunnel = `tcp:${fixture.port}`;
    await adb('reverse', tunnel, tunnel);
    throwIfInterrupted();
    await smoke({
      packageName,
      apkPath: process.env.ANDROID_APK_PATH,
      resetData: true,
      serial: deviceSerial,
    });
    throwIfInterrupted();
    web = await connectWebView();
    await waitFor('onboarding', () => web.evaluate("!!document.querySelector('input[type=url]')"));
    await web.evaluate(`(() => {
      const fill = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      fill('input[type=url]', 'http://127.0.0.1:${fixture.port}');
      fill('#kavita-auth-key', ${JSON.stringify(key)});
    })()`);
    await waitFor('HTTP consent control', () => web.evaluate(click('input[type=checkbox]')));
    await web.evaluate(click('button[type=submit]'));
    await waitFor('both disambiguated EPUB books in catalog', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${primaryTitle}"]')) && Boolean(document.querySelector('[aria-label="Open ${companionTitle}"]'))`,
      ),
    );
    await waitFor('open primary catalog book', () =>
      web.evaluate(click(`[aria-label="Open ${primaryTitle}"]`)),
    );
    await waitFor('downloaded and unwrapped first chapter', () => web.evaluate(chapter(1)));
    if (fixture.downloads !== 1) throw new Error('Expected one chapter archive transfer.');

    disabledNetwork = true;
    await adb('shell', 'svc', 'wifi', 'disable');
    await adb('shell', 'svc', 'data', 'disable');
    await waitFor('offline state', async () => {
      const connected = await web.evaluate(
        'Capacitor.Plugins.Network.getStatus().then(status => status.connected)',
      );
      return connected === false;
    });
    fixture.setOffline(true);
    const uploadCount = fixture.uploads.length;
    await waitFor('next-page control', () => web.evaluate(click('[aria-label="Next page"]')));
    await waitFor('second chapter', () => web.evaluate(chapter(2)));
    await waitFor('reader position in the second chapter', () =>
      web.evaluate(
        'Number(document.querySelector(".reader-progress")?.getAttribute("aria-valuenow")) >= 50',
      ),
    );
    await waitFor('return to library control', async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor('saved offline progress', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${primaryTitle}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );

    const offlineRequestsBeforeRestart = fixture.offlineRequests.length;
    await web.close();
    web = undefined;
    await adb('shell', 'am', 'force-stop', packageName);
    await adb(
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      `${packageName}/app.turnleaf.reader.MainActivity`,
    );
    web = await connectWebView();
    await waitFor('offline catalog book', () =>
      web.evaluate(
        click(`[aria-label="Open ${primaryTitle}, downloaded for offline reading, 50% complete"]`),
      ),
    );
    await waitFor('offline passage restored after restart', () => web.evaluate(chapter(2)));
    if (fixture.offlineRequests.length > 0) {
      throw new Error(
        `Turnleaf sent authenticated requests offline (${offlineRequestsBeforeRestart} before restart): ${fixture.offlineRequests.join(', ')}.`,
      );
    }

    fixture.setOffline(false);
    await adb('shell', 'svc', 'wifi', 'enable');
    await adb('shell', 'svc', 'data', 'enable');
    disabledNetwork = false;
    await waitFor('queued passage uploaded after reconnect', () =>
      fixture.uploads
        .slice(uploadCount)
        .some(
          (progress) =>
            progress.chapterId === 1 && progress.bookScrollId?.includes('DocFragment[2]'),
        ),
    );
    await waitFor('return to library after reconnect', async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor('saved passage after reconnect', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${primaryTitle}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );

    const uploadsBeforeCompanion = fixture.uploads.length;
    await waitFor('open secondary companion EPUB', () =>
      web.evaluate(click(`[aria-label="Open ${companionTitle}"]`)),
    );
    await waitFor('downloaded and unwrapped companion first chapter', () =>
      web.evaluate(chapter(1)),
    );
    if (fixture.downloads !== 2) throw new Error('Expected second chapter archive transfer.');
    await waitFor('companion next-page control', () =>
      web.evaluate(click('[aria-label="Next page"]')),
    );
    await waitFor('companion second chapter', () => web.evaluate(chapter(2)));
    await waitFor('return to library from companion EPUB', async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor('saved local companion progress', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${companionTitle}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );
    await delay(3_000);
    if (fixture.uploads.length !== uploadsBeforeCompanion) {
      throw new Error('Secondary EPUB sent remote progress for a shared chapterId.');
    }
    throwIfInterrupted();
    journeyPassed = true;
  } catch (error) {
    journeyError = error;
    if (deviceSerial) {
      const crashes = await adb('logcat', '-d', '-b', 'crash', '-t', '80').catch(() => '');
      if (crashes) console.error(crashes);
    }
  } finally {
    const cleanup = [];
    if (disabledNetwork) {
      cleanup.push(['restore Wi-Fi', () => adb('shell', 'svc', 'wifi', 'enable')]);
      cleanup.push(['restore mobile data', () => adb('shell', 'svc', 'data', 'enable')]);
    }
    if (web) cleanup.push(['close WebView debugger', () => web.close()]);
    if (tunnel)
      cleanup.push(['remove ADB reverse tunnel', () => adb('reverse', '--remove', tunnel)]);

    const failures = await runCleanup(cleanup);
    fixture?.close();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (failures.length) {
      cleanupError = new Error(
        `${journeyPassed ? 'Reading journey passed, but cleanup failed' : 'Android journey cleanup failed'}: ${failures.join('; ')}`,
      );
    }
  }

  if (journeyError) {
    if (cleanupError) console.error(cleanupError.message);
    throw journeyError;
  }
  if (cleanupError) throw cleanupError;
  console.log('Android reading journey passed: connect, download, read, restart offline, sync.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
