import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { main as smoke } from './android-smoke.mjs';

const packageName = 'app.turnleaf.reader.debug';
const title = 'Turnleaf CI EPUB';
const key = 'turnleaf-ci-only';
const adb = async (...args) =>
  (await promisify(execFile)('adb', args, { timeout: 20_000 })).stdout.trim();

async function waitFor(label, check) {
  const end = Date.now() + 30_000;
  let lastError;
  do {
    try {
      const value = await check();
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
    let id = 0;
    return {
      async evaluate(expression) {
        const requestId = ++id;
        const message = once(socket, 'message', { signal: AbortSignal.timeout(5_000) });
        socket.send(
          JSON.stringify({
            id: requestId,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
        const [event] = await message;
        const reply = JSON.parse(event.data);
        if (reply.id !== requestId || reply.error || reply.result?.exceptionDetails) {
          throw new Error(`WebView evaluation failed: ${expression}`);
        }
        return reply.result.result.value;
      },
      async close() {
        socket.close();
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
  const emptyProgress = { libraryId: 1, seriesId: 1, volumeId: 1, chapterId: 1, pageNum: 0 };
  const server = createServer(async (request, response) => {
    if (offline || request.headers['x-api-key'] !== key) {
      response.writeHead(offline ? 503 : 401).end();
      return;
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    let body;
    switch (path) {
      case '/api/Health':
        body = { version: '0.0.0-ci' };
        break;
      case '/api/Library/libraries':
        body = [{ id: 1, name: 'Books', type: 2 }];
        break;
      case '/api/Series/v2':
        body = [{ id: 1, libraryId: 1, name: title, format: 3, pages: 2, pagesRead: 0 }];
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
                  pagesRead: 0,
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

async function run() {
  if (!(await adb('get-serialno')).startsWith('emulator-')) {
    throw new Error('Use a fresh Android emulator for the reading journey.');
  }
  const fixture = await startFixture();
  const tunnel = `tcp:${fixture.port}`;
  let web;
  let disabledNetwork = false;
  try {
    await adb('reverse', tunnel, tunnel);
    await smoke();
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

    fixture.setOffline(true);
    disabledNetwork = true;
    await adb('shell', 'svc', 'wifi', 'disable');
    await adb('shell', 'svc', 'data', 'disable');
    await waitFor('offline state', async () => {
      const connected = await web.evaluate(
        'Capacitor.Plugins.Network.getStatus().then(status => status.connected)',
      );
      return connected === false;
    });
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
        `Number(document.querySelector('[aria-label="Reading progress for ${title}"]')?.getAttribute('aria-valuenow')) >= 50`,
      ),
    );

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
    if (fixture.downloads !== 1 || fixture.uploads.length !== uploadCount) {
      throw new Error('The offline restart requested another download or uploaded progress.');
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
    console.log('Android reading journey passed: connect, download, read, restart offline, sync.');
  } finally {
    try {
      await web?.close();
      if (disabledNetwork) {
        await adb('shell', 'svc', 'wifi', 'enable');
        await adb('shell', 'svc', 'data', 'enable');
      }
      await adb('reverse', '--remove', tunnel);
    } finally {
      fixture.close();
    }
  }
}

await run();
