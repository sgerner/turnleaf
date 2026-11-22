import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCdpClient } from './android-cdp.mjs';
import { runCleanup } from './android-cleanup.mjs';
import { resolveDeviceSerial } from './android-device.mjs';
import { main as smoke } from './android-smoke.mjs';

const packageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';
const title = 'Turnleaf CI EPUB';
const key = 'turnleaf-ci-only';
const uiDumpRemotePath = '/data/local/tmp/turnleaf-ui.xml';
const coverPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
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

async function isAppResumed() {
  const activities = await adb('shell', 'dumpsys', 'activity', 'activities');
  return activities
    .split('\n')
    .some(
      (line) =>
        /(?:topResumedActivity|mResumedActivity)/.test(line) && line.includes(`${packageName}/`),
    );
}

export function parseUiNodes(xml) {
  const nodes = [];
  const nodePattern = /<node\b([^>]*?)\/?>/g;
  for (const match of xml.matchAll(nodePattern)) {
    const attrs = match[1] ?? '';
    const readAttr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '';
    const boundsMatch = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(readAttr('bounds'));
    if (!boundsMatch) continue;
    const x1 = Number(boundsMatch[1]);
    const y1 = Number(boundsMatch[2]);
    const x2 = Number(boundsMatch[3]);
    const y2 = Number(boundsMatch[4]);
    if (x2 <= x1 || y2 <= y1) continue;
    nodes.push({
      resourceId: readAttr('resource-id'),
      text: readAttr('text'),
      contentDesc: readAttr('content-desc'),
      enabled: readAttr('enabled') !== 'false',
      centerX: Math.round((x1 + x2) / 2),
      centerY: Math.round((y1 + y2) / 2),
    });
  }
  return nodes;
}

async function tapNode(node) {
  await adb('shell', 'input', 'tap', String(node.centerX), String(node.centerY));
}

export async function waitBrieflyForAppResume(
  checkResumed = isAppResumed,
  { attempts = 8, intervalMs = 250 } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(intervalMs);
    if (await checkResumed()) return true;
  }
  return false;
}

export async function cancelSystemExportSheet({
  checkResumed = isAppResumed,
  sendBack = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'),
  settleAttempts = 8,
  settleIntervalMs = 250,
} = {}) {
  await waitFor('system export sheet to open', async () => !(await checkResumed()));
  await waitFor('system export sheet cancellation', async () => {
    if (await checkResumed()) return true;
    await sendBack();
    return waitBrieflyForAppResume(checkResumed, {
      attempts: settleAttempts,
      intervalMs: settleIntervalMs,
    });
  });
}

export async function completeSystemExportSheet({
  checkResumed = isAppResumed,
  readUiXml = async () => {
    await adb('shell', 'uiautomator', 'dump', uiDumpRemotePath);
    return adb('shell', 'cat', uiDumpRemotePath);
  },
  tap = tapNode,
  settleAttempts = 8,
  settleIntervalMs = 250,
} = {}) {
  await waitFor('system export sheet to open', async () => !(await checkResumed()));
  await waitFor('system export completion', async () => {
    if (await checkResumed()) return true;
    const xml = await readUiXml();
    const nodes = parseUiNodes(xml).filter((node) => node.enabled);
    const saveButton = nodes.find(
      (node) => node.resourceId === 'android:id/button1' || /^save$/i.test(node.text.trim()),
    );
    if (saveButton) {
      await tap(saveButton);
      return waitBrieflyForAppResume(checkResumed, {
        attempts: settleAttempts,
        intervalMs: settleIntervalMs,
      });
    }
    const downloadsRoot = nodes.find((node) => /^downloads?$/i.test(node.text.trim()));
    if (downloadsRoot) {
      await tap(downloadsRoot);
      return false;
    }
    const showRoots = nodes.find((node) => /show roots/i.test(node.contentDesc));
    if (showRoots) {
      await tap(showRoots);
    }
    return false;
  });
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

async function startFixture() {
  const epub = await readFile(
    new URL('../dev/kavita/data/Books/lorem-ipsum.epub', import.meta.url),
  );
  const uploads = [];
  let downloads = 0;
  let covers = 0;
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
      case '/api/Image/series-cover':
        covers += 1;
        response
          .writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': coverPng.length,
          })
          .end(coverPng);
        return;
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
  return {
    port: server.address().port,
    uploads,
    get downloads() {
      return downloads;
    },
    get covers() {
      return covers;
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

// Expressions passed to WebView Runtime.evaluate run untranspiled inside Android's
// system WebView (Chrome 74 / V8 7.4 on API 29), so they must stay ES2019-compatible
// (no optional chaining `?.`, nullish coalescing `??`, or logical assignment).
export const journeyExpressions = {
  hasOnboardingUrlInput: () => "!!document.querySelector('input[type=url]')",
  fillOnboardingCredentials: (origin, authKey) => `(() => {
    const fill = (selector, value) => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('input[type=url]', ${JSON.stringify(origin)});
    fill('#kavita-auth-key', ${JSON.stringify(authKey)});
  })()`,
  click: (selector) => `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`,
  clickByText: (containerSelector, label) => `(() => {
    const root = document.querySelector(${JSON.stringify(containerSelector)});
    if (!root) return false;
    const button = Array.from(root.querySelectorAll('button')).find(
      item => !item.disabled && item.textContent.trim() === ${JSON.stringify(label)}
    );
    if (!button) return false;
    button.click();
    return true;
  })()`,
  hasCachedCoverImage: () =>
    "Array.from(document.querySelectorAll('img')).some(img => img.src.includes('_capacitor_file_') && img.complete && img.naturalWidth > 0)",
  chapter: (number) => `Array.from(document.querySelectorAll('iframe')).some(frame => {
    const doc = frame.contentDocument;
    const heading = doc && doc.querySelector('h1');
    return Boolean(heading && heading.textContent === 'Chapter ${number}');
  })`,
  selectChapterHeading: (number) => `(() => {
    const frame = Array.from(document.querySelectorAll('iframe')).find(item => {
      const doc = item.contentDocument;
      const heading = doc && doc.querySelector('h1');
      return Boolean(heading && heading.textContent === 'Chapter ${number}');
    });
    const doc = frame && frame.contentDocument;
    const heading = doc && doc.querySelector('h1');
    if (!frame || !doc || !heading || !frame.contentWindow) return false;
    const range = doc.createRange();
    range.selectNodeContents(heading);
    const selection = frame.contentWindow.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
    return true;
  })()`,
  hasMarkdownCopyFallback: (bookTitle) => `(() => {
    const field = document.querySelector('#reader-annotations textarea[readonly]');
    return Boolean(
      field && field.value && field.value.includes(${JSON.stringify(`# Notes for ${bookTitle}`)})
    );
  })()`,
  hasSavedNoteExportConfirmation: () => `(() => {
    const status = document.querySelector('#reader-annotations [role="status"]');
    return Boolean(
      status &&
        status.textContent &&
        status.textContent.includes('Saved notes as') &&
        !document.querySelector('#reader-annotations textarea[readonly]')
    );
  })()`,
  isNetworkConnected: () =>
    'Capacitor.Plugins.Network.getStatus().then(status => status.connected)',
  hasReaderProgressAtLeast: (minimumPercent) => `(() => {
    const bar = document.querySelector('.reader-progress');
    return Boolean(bar && Number(bar.getAttribute('aria-valuenow')) >= ${Number(minimumPercent)});
  })()`,
  hasDownloadedBookProgress: (bookTitle, percent) =>
    `Boolean(document.querySelector(${JSON.stringify(`[aria-label="Open ${bookTitle}, downloaded for offline reading, ${percent}% complete"]`)}))`,
};

const { click, clickByText, chapter } = journeyExpressions;

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

    const packageInfo = await adb('shell', 'dumpsys', 'package', packageName);
    if (/android\.permission\.(?:READ|WRITE|MANAGE)_EXTERNAL_STORAGE/.test(packageInfo)) {
      throw new Error(`${packageName} declared forbidden external storage permissions.`);
    }

    web = await connectWebView();
    await waitFor('onboarding', () => web.evaluate(journeyExpressions.hasOnboardingUrlInput()));
    await web.evaluate(
      journeyExpressions.fillOnboardingCredentials(`http://127.0.0.1:${fixture.port}`, key),
    );
    await waitFor('HTTP consent control', () => web.evaluate(click('input[type=checkbox]')));
    await web.evaluate(click('button[type=submit]'));
    await waitFor(
      'cached library cover',
      async () =>
        fixture.covers >= 1 && (await web.evaluate(journeyExpressions.hasCachedCoverImage())),
    );
    await waitFor('catalog book', () => web.evaluate(click('[data-book-open]')));
    await waitFor('downloaded first chapter', () => web.evaluate(chapter(1)));
    if (fixture.downloads !== 1) throw new Error('Expected one EPUB transfer.');

    await waitFor('selected passage in first chapter', () =>
      web.evaluate(journeyExpressions.selectChapterHeading(1)),
    );
    await waitFor('add-note action', () =>
      web.evaluate(clickByText('[aria-label="Selected text"]', 'Add note')),
    );
    await waitFor('save highlight button', () =>
      web.evaluate(click('#reader-annotations button[type="submit"]')),
    );
    await waitFor('export markdown trigger (cancel check)', () =>
      web.evaluate(clickByText('#reader-annotations', 'Export Markdown')),
    );
    await cancelSystemExportSheet();
    await waitFor('markdown copy fallback after cancel', () =>
      web.evaluate(journeyExpressions.hasMarkdownCopyFallback(title)),
    );

    await waitFor('export markdown trigger (save check)', () =>
      web.evaluate(clickByText('#reader-annotations', 'Export Markdown')),
    );
    await completeSystemExportSheet();
    await waitFor('saved note export confirmation', () =>
      web.evaluate(journeyExpressions.hasSavedNoteExportConfirmation()),
    );
    await waitFor('close highlights and notes panel', () =>
      web.evaluate(click('[aria-label="Close highlights and notes"]')),
    );

    disabledNetwork = true;
    await adb('shell', 'svc', 'wifi', 'disable');
    await adb('shell', 'svc', 'data', 'disable');
    await waitFor('offline state', async () => {
      const connected = await web.evaluate(journeyExpressions.isNetworkConnected());
      return connected === false;
    });
    fixture.setOffline(true);
    const uploadCount = fixture.uploads.length;
    await waitFor('next-page control', async () => {
      if (await web.evaluate(click('[aria-label="Next page"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor('second chapter', () => web.evaluate(chapter(2)));
    await waitFor('reader position in the second chapter', () =>
      web.evaluate(journeyExpressions.hasReaderProgressAtLeast(50)),
    );
    await waitFor('return to library control', async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor('saved offline progress', () =>
      web.evaluate(journeyExpressions.hasDownloadedBookProgress(title, 50)),
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
    await waitFor('offline cached cover after restart', () =>
      web.evaluate(journeyExpressions.hasCachedCoverImage()),
    );
    await waitFor('offline catalog book', () => web.evaluate(click('[data-book-open]')));
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
      web.evaluate(journeyExpressions.hasDownloadedBookProgress(title, 50)),
    );
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
    if (deviceSerial) {
      cleanup.push(['remove temporary UI dump', () => adb('shell', 'rm', '-f', uiDumpRemotePath)]);
    }
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
  console.log(
    'Android reading journey passed: connect, cache cover, download, export notes, read, restart offline, sync.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
