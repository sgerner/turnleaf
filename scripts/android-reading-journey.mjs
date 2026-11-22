import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_FONT_SCALE,
  KEYCODE_BACK,
  KEYCODE_VOLUME_DOWN,
  createAdbRunner,
  dumpWindowState,
  getFontScale,
  sendKeyEvent,
  setFontScale,
} from './android-adb.mjs';
import { createCdpClient } from './android-cdp.mjs';
import { runCleanup } from './android-cleanup.mjs';
import { resolveDeviceSerial } from './android-device.mjs';
import { main as smoke } from './android-smoke.mjs';

const packageName = process.env.ANDROID_PACKAGE_NAME || 'app.turnleaf.reader.debug';
const title = 'Turnleaf CI EPUB';
const key = 'turnleaf-ci-only';
let deviceSerial;
const adb = createAdbRunner({ getSerial: () => deviceSerial });

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

async function startFixture() {
  const epub = await readFile(
    new URL('../dev/kavita/data/Books/lorem-ipsum.epub', import.meta.url),
  );
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
  return {
    port: server.address().port,
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

const clickButtonWithText = (label) => `(() => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => !candidate.disabled && candidate.textContent?.trim() === ${JSON.stringify(label)},
  );
  if (!button) return false;
  button.click();
  return true;
})()`;

const enableReaderCheckbox = (label) => `(() => {
  const match = Array.from(document.querySelectorAll('#reader-appearance label')).find((item) =>
    item.textContent?.includes(${JSON.stringify(label)}),
  );
  const input = match?.querySelector('input[type="checkbox"]');
  if (!input) return false;
  if (!input.checked) input.click();
  return input.checked === true;
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
    await waitFor('catalog book', () => web.evaluate(click('[data-book-open]')));
    await waitFor('downloaded first chapter', () => web.evaluate(chapter(1)));
    if (fixture.downloads !== 1) throw new Error('Expected one EPUB transfer.');

    await waitFor('immersive reader window state', async () => {
      const state = await dumpWindowState(adb, packageName);
      return state.windowFound && !state.keepScreenOn && state.systemBarsVisible === false;
    });
    await waitFor('show reading controls', async () => {
      if (!(await web.evaluate('Boolean(document.querySelector("[data-controls]"))'))) {
        await web.evaluate(click('.reader-top-reveal'));
      }
      return web.evaluate('Boolean(document.querySelector("[data-controls]"))');
    });
    await waitFor('reading appearance panel', async () => {
      if (!(await web.evaluate('Boolean(document.querySelector("#reader-appearance"))'))) {
        await web.evaluate(click('[aria-label="Text, reading appearance"]'));
      }
      return web.evaluate('Boolean(document.querySelector("#reader-appearance"))');
    });
    await waitFor('keep screen on toggle', () =>
      web.evaluate(enableReaderCheckbox('Keep screen on while reading')),
    );
    await waitFor('volume buttons toggle', () =>
      web.evaluate(enableReaderCheckbox('Turn pages with volume buttons')),
    );
    await waitFor('keep-awake flag enabled in dumpsys window', async () => {
      const state = await dumpWindowState(adb, packageName);
      return state.windowFound && state.keepScreenOn && state.systemBarsVisible === false;
    });

    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('appearance panel dismissed by Android Back', () =>
      web.evaluate(
        '!document.querySelector("#reader-appearance") && Boolean(document.querySelector("[data-controls]"))',
      ),
    );
    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('reader controls hidden by Android Back with top reveal focused', () =>
      web.evaluate(
        '!document.querySelector("[data-controls]") && document.activeElement?.classList.contains("reader-top-reveal")',
      ),
    );

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
    await sendKeyEvent(adb, KEYCODE_VOLUME_DOWN);
    await waitFor('second chapter via KEYCODE_VOLUME_DOWN', () => web.evaluate(chapter(2)));
    await waitFor('reader position in the second chapter', () =>
      web.evaluate(
        'Number(document.querySelector(".reader-progress")?.getAttribute("aria-valuenow")) >= 50',
      ),
    );

    const readerWindowBeforeScale = await dumpWindowState(adb, packageName);
    await setFontScale(adb, '2.0');
    await waitFor('200% Android font scale', async () => (await getFontScale(adb)) === 2);
    await waitFor('open reader chapter preserved at 200% font scale', async () => {
      if (!(await web.evaluate(chapter(2)))) return false;
      const state = await dumpWindowState(adb, packageName);
      return (
        state.windowFound &&
        state.windowToken === readerWindowBeforeScale.windowToken &&
        state.keepScreenOn &&
        state.systemBarsVisible === false
      );
    });

    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('saved offline progress after single Android Back exit', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]')) && document.activeElement?.hasAttribute('data-book-open')`,
      ),
    );
    await waitFor('library window flags and system bars restored at 200% font scale', async () => {
      const state = await dumpWindowState(adb, packageName);
      return state.windowFound && !state.keepScreenOn && state.systemBarsVisible === true;
    });

    await web.evaluate(`(() => {
      window.__turnleafJourneyVolumeEvents = 0;
      window.__turnleafJourneyVolumeListener = () => {
        window.__turnleafJourneyVolumeEvents += 1;
      };
      window.addEventListener('turnleafVolumeButton', window.__turnleafJourneyVolumeListener);
    })()`);
    await sendKeyEvent(adb, KEYCODE_VOLUME_DOWN);
    await delay(300);
    const leakedVolumeEvents = await web.evaluate(`(() => {
      window.removeEventListener('turnleafVolumeButton', window.__turnleafJourneyVolumeListener);
      return window.__turnleafJourneyVolumeEvents;
    })()`);
    if (leakedVolumeEvents !== 0) {
      throw new Error(
        `Expected volume keys to be released in library, got ${leakedVolumeEvents} reader event(s).`,
      );
    }

    await setFontScale(adb, DEFAULT_FONT_SCALE);
    await waitFor(
      'default Android font scale restored',
      async () => (await getFontScale(adb)) === 1,
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
    await waitFor('show reading controls before two-press Back exit', async () => {
      if (!(await web.evaluate('Boolean(document.querySelector("[data-controls]"))'))) {
        await web.evaluate(click('.reader-top-reveal'));
      }
      return web.evaluate('Boolean(document.querySelector("[data-controls]"))');
    });
    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('first Android Back hides reader controls without exiting', async () => {
      if (!(await web.evaluate(chapter(2)))) return false;
      return web.evaluate(
        '!document.querySelector("[data-controls]") && document.activeElement?.classList.contains("reader-top-reveal")',
      );
    });
    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('second Android Back returns to library after reconnect', () =>
      web.evaluate(
        `Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]')) && document.activeElement?.hasAttribute('data-book-open')`,
      ),
    );
    await waitFor('library window flags restored after reconnect', async () => {
      const state = await dumpWindowState(adb, packageName);
      return state.windowFound && !state.keepScreenOn && state.systemBarsVisible === true;
    });

    await waitFor('open library settings', () =>
      web.evaluate(click('[aria-label="Open settings"]')),
    );
    await waitFor('open server address editor', () =>
      web.evaluate(clickButtonWithText('Change server address')),
    );
    await waitFor('server address edit form', () =>
      web.evaluate("Boolean(document.querySelector('input[type=url]'))"),
    );
    await sendKeyEvent(adb, KEYCODE_BACK);
    await waitFor('saved library restored after canceling server edit with Android Back', () =>
      web.evaluate(
        `!document.querySelector('input[type=url]') && Boolean(document.querySelector('[aria-label="Open ${title}, downloaded for offline reading, 50% complete"]'))`,
      ),
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
      cleanup.push([
        'restore Android system font_scale',
        () => adb('shell', 'settings', 'put', 'system', 'font_scale', DEFAULT_FONT_SCALE),
      ]);
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
  console.log('Android reading journey passed: connect, download, read, restart offline, sync.');
}

await run().catch((error) => {
  console.error(error);
  process.exitCode ??= 1;
});
