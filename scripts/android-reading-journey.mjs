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
const rotatedKey = 'turnleaf-ci-rotated';
const secureStorageKey = 'turnleaf_server_primary_api_key';
const coverPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
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

export async function startFixture({ crossOriginRedirects = false } = {}) {
  const epub = await readFile(
    new URL('../dev/kavita/data/Books/lorem-ipsum.epub', import.meta.url),
  );
  const uploads = [];
  let downloads = 0;
  let covers = 0;
  let coverRedirects = 0;
  let downloadRedirects = 0;
  let foreignAuthHeaders = 0;
  let offline = false;
  let activeKey = key;
  let version = '0.0.0-ci';
  let redirectCrossOrigin = crossOriginRedirects;
  const offlineRequests = [];
  const unauthorizedRequests = [];
  const notFoundPaths = [];
  const foreignRequests = [];
  const emptyProgress = { libraryId: 1, seriesId: 1, volumeId: 1, chapterId: 1, pageNum: 0 };

  const foreignServer = createServer((request, response) => {
    foreignRequests.push(new URL(request.url, 'http://localhost').pathname);
    if (request.headers['x-api-key']) {
      foreignAuthHeaders += 1;
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end('foreign');
  });
  foreignServer.listen(0, '127.0.0.1');
  await once(foreignServer, 'listening');
  const foreignPort = foreignServer.address().port;
  const foreignOrigin = `http://127.0.0.1:${foreignPort}`;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const path = requestUrl.pathname;
    if (path === '/connectivity-check') {
      response.writeHead(503).end();
      return;
    }
    if (offline) {
      offlineRequests.push(path);
      response.writeHead(503).end();
      return;
    }
    if (request.headers['x-api-key'] !== activeKey) {
      unauthorizedRequests.push(path);
      response.writeHead(401).end();
      return;
    }
    const pagesRead = uploads.at(-1)?.pageNum ?? 0;
    let body;
    switch (path) {
      case '/api/Health':
        body = { version };
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
                  titleName,
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
        if (redirectCrossOrigin) {
          coverRedirects += 1;
          response
            .writeHead(302, {
              Location: `${foreignOrigin}/api/Image/series-cover${requestUrl.search}`,
            })
            .end();
          return;
        }
        covers += 1;
        response
          .writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': coverPng.length,
          })
          .end(coverPng);
        return;
      case '/api/Download/chapter':
        if (redirectCrossOrigin) {
          downloadRedirects += 1;
          response
            .writeHead(302, {
              Location: `${foreignOrigin}/api/Download/chapter${requestUrl.search}`,
            })
            .end();
          return;
        }
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
        notFoundPaths.push(path);
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  const titleName = title;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    foreignPort,
    uploads,
    get downloads() {
      return downloads;
    },
    get covers() {
      return covers;
    },
    get coverRedirects() {
      return coverRedirects;
    },
    get downloadRedirects() {
      return downloadRedirects;
    },
    get foreignAuthHeaders() {
      return foreignAuthHeaders;
    },
    offlineRequests,
    unauthorizedRequests,
    notFoundPaths,
    foreignRequests,
    setOffline(value) {
      offline = value;
    },
    setApiKey(nextKey, nextVersion = version) {
      activeKey = nextKey;
      version = nextVersion;
    },
    setCrossOriginRedirects(value) {
      redirectCrossOrigin = value;
    },
    close() {
      server.close();
      foreignServer.close();
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

const renderedCover = `(() => {
  const image = document.querySelector('[data-book-open]')?.parentElement?.querySelector('img');
  return Boolean(image && image.complete && image.naturalWidth > 0);
})()`;

const retryDownloadReady = `Array.from(document.querySelectorAll('button')).some(
  button => !button.disabled && button.textContent?.trim() === 'Retry download'
)`;

let receivedSignal;

function throwIfInterrupted() {
  if (receivedSignal) throw new Error(`Android reading journey interrupted by ${receivedSignal}.`);
}

function assertRedirectIsolation(fixture) {
  if (fixture.foreignRequests.length > 0 || fixture.foreignAuthHeaders > 0) {
    throw new Error(
      `Cross-origin redirect received ${fixture.foreignRequests.length} request(s) and ${fixture.foreignAuthHeaders} x-api-key header(s).`,
    );
  }
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
  let foreignTunnel;
  let web;
  let disabledNetwork = false;
  let previousCaptivePortalSettings;
  let journeyError;
  let cleanupError;
  let journeyPassed = false;

  async function restartApp() {
    if (web) {
      await web.close();
      web = undefined;
    }
    await delay(250);
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
  }

  async function returnToLibrary(label) {
    await waitFor(label, async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
  }

  try {
    deviceSerial = await resolveDeviceSerial({ emulatorOnly: true });
    throwIfInterrupted();
    fixture = await startFixture({ crossOriginRedirects: true });
    throwIfInterrupted();
    tunnel = `tcp:${fixture.port}`;
    await adb('reverse', tunnel, tunnel);
    foreignTunnel = `tcp:${fixture.foreignPort}`;
    await adb('reverse', foreignTunnel, foreignTunnel);
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

    await waitFor('catalog book card', () =>
      web.evaluate("Boolean(document.querySelector('[data-book-open]'))"),
    );
    await waitFor('blocked cross-origin cover redirect', () => fixture.coverRedirects >= 1);
    await waitFor('attempt redirected EPUB download', () =>
      web.evaluate(click('[data-book-open]')),
    );
    await waitFor('blocked cross-origin EPUB redirect', () => web.evaluate(retryDownloadReady));
    if (fixture.downloadRedirects !== 1) {
      throw new Error('Expected one cross-origin EPUB redirect check.');
    }
    if (await web.evaluate(renderedCover)) {
      throw new Error('Expected cross-origin cover redirect to not render.');
    }
    assertRedirectIsolation(fixture);

    fixture.setCrossOriginRedirects(false);
    await waitFor('refresh library for online cover', () =>
      web.evaluate(click('[aria-label="Refresh library"]')),
    );
    await waitFor('rendered online cover', () => web.evaluate(renderedCover));
    if (fixture.covers !== 1) throw new Error('Expected one cached cover transfer.');
    await waitFor('catalog book', () => web.evaluate(click('[data-book-open]')));
    await waitFor('downloaded first chapter', () => web.evaluate(chapter(1)));
    if (fixture.downloads !== 1) throw new Error('Expected one EPUB transfer.');

    disabledNetwork = true;
    await adb('shell', 'svc', 'wifi', 'disable');
    await adb('shell', 'svc', 'data', 'disable');
    await waitFor('disconnected state', async () => {
      const status = await web.evaluate('Capacitor.Plugins.Network.getStatus()');
      return status?.connected === false && status?.connectionType === 'none';
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
    await returnToLibrary('return to library control');
    await waitFor('saved offline progress', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );
    await waitFor('rendered offline cover before restart', () => web.evaluate(renderedCover));

    // Phase 2: degraded offline startup when saved key is missing from SecureStorage.
    await web.evaluate(
      `Capacitor.Plugins.SecureStorage.internalRemoveItem({ prefixedKey: ${JSON.stringify(secureStorageKey)}, sync: false }).then(() => true)`,
    );
    const offlineRequestsBeforeRestart = fixture.offlineRequests.length;
    await restartApp();
    await waitFor('missing-key alert in degraded offline library', () =>
      web.evaluate(
        `document.querySelector('[data-credential-alert="missing"]') !== null && document.querySelectorAll('.alert').length === 1`,
      ),
    );
    await waitFor('rendered offline cover after restart', () => web.evaluate(renderedCover));
    await waitFor('offline catalog book without saved key', () =>
      web.evaluate(click('[data-book-open]')),
    );
    await waitFor('offline passage restored without saved key', () => web.evaluate(chapter(2)));
    await returnToLibrary('return to library from missing-key offline reader');
    await waitFor('missing-key alert after closing offline reader', () =>
      web.evaluate(`document.querySelector('[data-credential-alert="missing"]') !== null`),
    );
    if (fixture.offlineRequests.length > 0) {
      throw new Error(
        `Turnleaf sent requests while offline (${offlineRequestsBeforeRestart} before restart): ${fixture.offlineRequests.join(', ')}.`,
      );
    }

    // Phase 3: unvalidated Wi-Fi reconnect with stale key verifies 401 circuit breaker & consolidated alert.
    await web.evaluate(
      `Capacitor.Plugins.SecureStorage.internalSetItem({ prefixedKey: ${JSON.stringify(secureStorageKey)}, data: ${JSON.stringify(JSON.stringify(key))}, sync: false, access: 0 }).then(() => true)`,
    );
    fixture.setApiKey(rotatedKey, '0.0.1-rotated');
    const captivePortalSettingKeys = [
      'captive_portal_mode',
      'captive_portal_use_https',
      'captive_portal_http_url',
      'captive_portal_https_url',
      'test_url_expiration_time',
      'test_captive_portal_http_url',
      'test_captive_portal_https_url',
    ];
    previousCaptivePortalSettings = await Promise.all(
      captivePortalSettingKeys.map(async (settingKey) => [
        settingKey,
        await adb('shell', 'settings', 'get', 'global', settingKey),
      ]),
    );
    const deviceEpochSeconds = Number.parseInt(await adb('shell', 'date', '+%s'), 10);
    const expirationMs = String(
      (Number.isFinite(deviceEpochSeconds) ? deviceEpochSeconds : Math.floor(Date.now() / 1000)) *
        1000 +
        300_000,
    );
    const portalHttpUrl = `http://localhost:${fixture.port}/connectivity-check`;
    const portalHttpsUrl = `https://localhost:${fixture.port}/connectivity-check`;
    for (const [settingKey, value] of [
      ['captive_portal_mode', '1'],
      ['captive_portal_use_https', '0'],
      ['test_url_expiration_time', expirationMs],
      ['test_captive_portal_http_url', portalHttpUrl],
      ['test_captive_portal_https_url', portalHttpsUrl],
      ['captive_portal_http_url', portalHttpUrl],
      ['captive_portal_https_url', portalHttpsUrl],
    ]) {
      await adb('shell', 'settings', 'put', 'global', settingKey, value);
    }

    await restartApp();
    await waitFor('offline library with restored stale key', () =>
      web.evaluate(
        `document.querySelector('[data-credential-alert]') === null && Boolean(document.querySelector('[data-book-open]')) && document.querySelectorAll('.alert').length === 1`,
      ),
    );
    if (fixture.offlineRequests.length > 0) {
      throw new Error(
        `Turnleaf sent requests during offline restart: ${fixture.offlineRequests.join(', ')}.`,
      );
    }

    fixture.unauthorizedRequests.length = 0;
    fixture.setOffline(false);
    await adb('shell', 'svc', 'wifi', 'enable');
    await waitFor('unvalidated Wi-Fi state', async () => {
      const status = await web.evaluate('Capacitor.Plugins.Network.getStatus()');
      return status?.connectionType === 'wifi' && status?.connected === false;
    });
    await waitFor('consolidated rejected-key alert on unvalidated Wi-Fi', () =>
      web.evaluate(
        `document.querySelector('[data-credential-alert="rejected"]') !== null && document.querySelectorAll('.alert').length === 1`,
      ),
    );
    await waitFor('rendered cached cover while key is rejected', () => web.evaluate(renderedCover));
    await waitFor('downloaded book while key is rejected', () =>
      web.evaluate(click('[data-book-open]')),
    );
    await waitFor('offline passage while key is rejected', () => web.evaluate(chapter(2)));
    await returnToLibrary('return to library while key is rejected');
    await waitFor('consolidated rejected-key alert after closing reader', () =>
      web.evaluate(
        `document.querySelector('[data-credential-alert="rejected"]') !== null && document.querySelectorAll('.alert').length === 1`,
      ),
    );
    const allowedInitial401Paths = new Set(['/api/Series/v2', '/api/Reader/progress']);
    const seenInitial401Paths = new Set();
    const unexpected401 =
      fixture.unauthorizedRequests.length === 0 ||
      fixture.unauthorizedRequests.some((reqPath) => {
        if (!allowedInitial401Paths.has(reqPath) || seenInitial401Paths.has(reqPath)) {
          return true;
        }
        seenInitial401Paths.add(reqPath);
        return false;
      });
    if (unexpected401) {
      throw new Error(
        `Expected at most one initial /api/Series/v2 and/or /api/Reader/progress 401 before circuit breaker tripped, saw: ${fixture.unauthorizedRequests.join(', ') || 'none'}.`,
      );
    }
    if (fixture.uploads.length !== uploadCount) {
      throw new Error('Queued progress uploaded before key rotation.');
    }

    // Phase 4: key rotation in Settings on unvalidated Wi-Fi clears circuit breaker and flushes queued progress.
    await waitFor('recover key in Settings control', () =>
      web.evaluate(click('[data-credential-recover]')),
    );
    await waitFor('replacement API key input', () =>
      web.evaluate("Boolean(document.querySelector('#replacement-api-key'))"),
    );
    await waitFor('submit replacement API key', () =>
      web.evaluate(`(() => {
        const input = document.querySelector('#replacement-api-key');
        if (!input) return false;
        input.value = ${JSON.stringify(rotatedKey)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const submit = input.closest('form')?.querySelector('button[type="submit"]');
        if (!submit || submit.disabled) return false;
        submit.click();
        return true;
      })()`),
    );
    await waitFor('queued passage uploaded after key rotation on unvalidated Wi-Fi', () =>
      fixture.uploads
        .slice(uploadCount)
        .some(
          (progress) =>
            progress.chapterId === 1 && progress.bookScrollId?.includes('DocFragment[2]'),
        ),
    );
    const syncNetworkStatus = await web.evaluate('Capacitor.Plugins.Network.getStatus()');
    if (syncNetworkStatus?.connectionType !== 'wifi' || syncNetworkStatus?.connected !== false) {
      throw new Error(
        `Expected unvalidated Wi-Fi during reconnect sync, got ${JSON.stringify(syncNetworkStatus)}.`,
      );
    }
    await waitFor('credential alert cleared and saved passage preserved after key rotation', () =>
      web.evaluate(
        `!document.querySelector('[data-credential-alert]') && Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]'))`,
      ),
    );
    await waitFor('rendered cover after reconnect', () => web.evaluate(renderedCover));
    assertRedirectIsolation(fixture);
    if (fixture.notFoundPaths.length > 0) {
      throw new Error(
        `Fixture returned unexpected 404 responses: ${fixture.notFoundPaths.join(', ')}.`,
      );
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
    if (previousCaptivePortalSettings) {
      cleanup.push([
        'restore captive portal settings',
        async () => {
          for (const [settingKey, previousValue] of previousCaptivePortalSettings) {
            if (!previousValue || previousValue === 'null') {
              await adb('shell', 'settings', 'delete', 'global', settingKey);
            } else {
              await adb('shell', 'settings', 'put', 'global', settingKey, previousValue);
            }
          }
        },
      ]);
    }
    if (disabledNetwork) {
      cleanup.push(['restore Wi-Fi', () => adb('shell', 'svc', 'wifi', 'enable')]);
      cleanup.push(['restore mobile data', () => adb('shell', 'svc', 'data', 'enable')]);
    }
    if (web) cleanup.push(['close WebView debugger', () => web.close()]);
    if (foreignTunnel) {
      cleanup.push([
        'remove foreign ADB reverse tunnel',
        () => adb('reverse', '--remove', foreignTunnel),
      ]);
    }
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
    'Android reading journey passed: connect, download, missing-key offline startup, unvalidated Wi-Fi 401 gating, rotate key, sync.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
