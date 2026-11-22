import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { createCdpClient } from './android-cdp.mjs';
import { runCleanup } from './android-cleanup.mjs';
import { resolveDeviceSerial } from './android-device.mjs';
import { main as smoke } from './android-smoke.mjs';

const packageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';
const title = 'Turnleaf CI EPUB';
const key = 'turnleaf-ci-only';
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
let deviceSerial;
const adb = async (...args) =>
  (
    await promisify(execFile)('adb', [...(deviceSerial ? ['-s', deviceSerial] : []), ...args], {
      timeout: 20_000,
    })
  ).stdout.trim();

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const checksum = crc32(dataBytes);
    const flags = name === 'mimetype' ? 0 : 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, dataBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(dataBytes.length, 20);
    central.writeUInt32LE(dataBytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

export function createJourneyEpub(hostileBaseUrl) {
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:8f14e45f-ceea-4c9a-b1a5-turnleaf-sample</dc:identifier>
    <dc:title>Sample Lorem Ipsum</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Turnleaf</dc:creator>
    <meta property="dcterms:modified">2026-09-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="book-css" href="styles/book.css" media-type="text/css"/>
    <item id="local-png" href="images/local.png" media-type="image/png"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
`;
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head>
    <title>Table of Contents</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Table of Contents</h1>
      <ol>
        <li><a href="text/chapter1.xhtml">Chapter 1</a></li>
        <li><a href="text/chapter2.xhtml">Chapter 2</a></li>
      </ol>
    </nav>
  </body>
</html>
`;
  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:8f14e45f-ceea-4c9a-b1a5-turnleaf-sample"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>Sample Lorem Ipsum</text>
  </docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="text/chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navpoint-2" playOrder="2">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="text/chapter2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`;
  const bookCss = `@import url('${hostileBaseUrl}/packaged-import.css');
.packaged-local {
  background-image: url('../images/local.png');
}
.packaged-hostile-bg {
  background-image: url('${hostileBaseUrl}/packaged-bg.png');
}
`;
  const chapter1Xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>Chapter 1</title>
    <base href="${hostileBaseUrl}/base/" />
    <link rel="stylesheet" href="${hostileBaseUrl}/remote.css" />
    <link rel="stylesheet" href="../styles/book.css" />
    <meta http-equiv="refresh" content="0;url=${hostileBaseUrl}/redirect" />
    <style>
      @import url('${hostileBaseUrl}/inline-import.css');
      .inline-hostile-bg {
        background-image: url('${hostileBaseUrl}/inline-bg.png');
      }
    </style>
  </head>
  <body onload="fetch('${hostileBaseUrl}/onload')">
    <script>fetch('${hostileBaseUrl}/script');</script>
    <iframe src="${hostileBaseUrl}/frame"></iframe>
    <form action="${hostileBaseUrl}/form"></form>
    <h1>Chapter 1</h1>
    <p class="inline-hostile-bg packaged-hostile-bg packaged-local">
      Lorem ipsum dolor sit amet, consectetur adipiscing elit.
      <a id="internal-link" href="chapter2.xhtml">Next chapter</a>
      <a id="remote-link" href="${hostileBaseUrl}/leave">Leave</a>
      <img id="local-img" src="../images/local.png" alt="" width="1" height="1" />
      <img id="embedded-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" alt="" width="1" height="1" />
      <img id="hostile-img" src="${hostileBaseUrl}/img-src.png" alt="" width="1" height="1" />
      <img id="hostile-srcset" srcset="${hostileBaseUrl}/img-srcset.png 1x, ../images/local.png 2x" alt="" width="1" height="1" />
      <svg width="1" height="1"><image id="hostile-svg" href="${hostileBaseUrl}/svg-image.png" width="1" height="1" /></svg>
      <video id="hostile-video" poster="${hostileBaseUrl}/video-poster.png" width="1" height="1"></video>
    </p>
    <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
  </body>
</html>
`;
  const chapter2Xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>Chapter 2</title>
    <link rel="stylesheet" href="../styles/book.css" />
  </head>
  <body>
    <h1>Chapter 2</h1>
    <p>At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.</p>
    <p>Ut aut reiciendis voluptatibus maiores alias consequatur aut perferendis doloribus asperiores repellat. The end.</p>
  </body>
</html>
`;

  return makeStoredZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', containerXml],
    ['OEBPS/content.opf', contentOpf],
    ['OEBPS/nav.xhtml', navXhtml],
    ['OEBPS/toc.ncx', tocNcx],
    ['OEBPS/styles/book.css', bookCss],
    ['OEBPS/images/local.png', ONE_PIXEL_PNG],
    ['OEBPS/text/chapter1.xhtml', chapter1Xhtml],
    ['OEBPS/text/chapter2.xhtml', chapter2Xhtml],
  ]);
}

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

export async function startFixture() {
  const uploads = [];
  let downloads = 0;
  let offline = false;
  let epub = Buffer.alloc(0);
  const offlineRequests = [];
  const hostileRequests = [];
  const emptyProgress = { libraryId: 1, seriesId: 1, volumeId: 1, chapterId: 1, pageNum: 0 };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/hostile/')) {
      hostileRequests.push(path);
      response.writeHead(204).end();
      return;
    }
    if (request.headers['x-api-key'] !== key) {
      response.writeHead(401).end();
      return;
    }
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
        body = [{ id: 1, libraryId: 1, name: title, format: 3, pages: 2, pagesRead }];
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
                  pages: 2,
                  pagesRead,
                  format: 3,
                  files: [{ id: 1, format: 3, extension: '.epub', bytes: epub.length }],
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
            'Content-Type': 'application/epub+zip',
            'Content-Length': epub.length,
          })
          .end(epub);
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
  const port = server.address().port;
  epub = createJourneyEpub(`http://127.0.0.1:${port}/hostile`);
  return {
    port,
    uploads,
    get downloads() {
      return downloads;
    },
    offlineRequests,
    hostileRequests,
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

const chapterIsolated = (number) => `(() => {
  const frame = Array.from(document.querySelectorAll('iframe')).find(
    candidate => candidate.contentDocument?.querySelector('h1')?.textContent === 'Chapter ${number}'
  );
  if (!frame || frame.getAttribute('sandbox') !== 'allow-same-origin') return false;
  const doc = frame.contentDocument;
  const csp = doc?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  if (!csp.includes("connect-src 'none'") || !csp.includes("img-src 'self' data: blob:")) return false;
  return !doc.documentElement.outerHTML.includes('/hostile/');
})()`;

function assertNoHostileRequests(fixture, stage) {
  if (fixture.hostileRequests.length > 0) {
    throw new Error(
      `Turnleaf leaked hostile EPUB subresource requests while ${stage}: ${fixture.hostileRequests.join(', ')}.`,
    );
  }
}

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
    await waitFor('catalog book', () => web.evaluate(click('[data-book-open]')));
    await waitFor('downloaded first chapter', () => web.evaluate(chapter(1)));
    await waitFor('isolated first chapter markup', () => web.evaluate(chapterIsolated(1)));
    if (fixture.downloads !== 1) throw new Error('Expected one EPUB transfer.');
    assertNoHostileRequests(fixture, 'opening Chapter 1');

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
    await waitFor('isolated second chapter markup', () => web.evaluate(chapterIsolated(2)));
    assertNoHostileRequests(fixture, 'turning to Chapter 2');
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
        `Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]'))`,
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
    await waitFor('offline catalog book', () => web.evaluate(click('[data-book-open]')));
    await waitFor('offline passage restored after restart', () => web.evaluate(chapter(2)));
    await waitFor('isolated offline chapter after restart', () => web.evaluate(chapterIsolated(2)));
    assertNoHostileRequests(fixture, 'reopening offline after restart');
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
        `Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );
    assertNoHostileRequests(fixture, 'completing reconnect sync');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
