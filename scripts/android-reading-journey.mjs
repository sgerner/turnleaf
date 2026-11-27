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

async function waitFor(label, check, describeTimeout) {
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
  let detail = '';
  if (describeTimeout) {
    try {
      const info = await describeTimeout();
      if (info !== undefined) detail = ` (${JSON.stringify(info)})`;
    } catch (diagnosticError) {
      detail = ` (diagnostic failed: ${String(diagnosticError)})`;
    }
  }
  throw new Error(`Timed out waiting for ${label}${detail}.`, { cause: lastError });
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
  let redirectCrossOrigin = crossOriginRedirects;
  const offlineRequests = [];
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
    if (request.headers['x-api-key'] !== key) {
      response.writeHead(401).end();
      return;
    }
    const requestUrl = new URL(request.url, 'http://localhost');
    const path = requestUrl.pathname;
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
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
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
    notFoundPaths,
    foreignRequests,
    setOffline(value) {
      offline = value;
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

const renderedBookCover = (bookId) => `(() => {
  const card = document.querySelector(${JSON.stringify(`article[data-book-id="${bookId}"]`)});
  const image = card?.querySelector('img');
  return Boolean(image && image.complete && image.naturalWidth > 0);
})()`;

const libraryBookCardSnapshot = (bookId, fallbackTitle = title) => `(() => {
  const byId = ${bookId ? `document.querySelector(${JSON.stringify(`article[data-book-id="${bookId}"]`)})` : 'null'};
  const card =
    byId ??
    Array.from(document.querySelectorAll('article[data-book-id]')).find(
      (el) => el.querySelector('h2')?.textContent?.trim() === ${JSON.stringify(fallbackTitle)},
    );
  if (!card) return null;
  const openButton = card.querySelector('[data-book-open]');
  const progressBar = card.querySelector('[role="progressbar"]');
  return {
    bookId: card.getAttribute('data-book-id'),
    heading: card.querySelector('h2')?.textContent?.trim() ?? null,
    openDisabled: Boolean(openButton?.disabled),
    openLabel: openButton?.getAttribute('aria-label') ?? null,
    progressNow: progressBar?.getAttribute('aria-valuenow') ?? null,
    progressText: progressBar?.getAttribute('aria-valuetext') ?? null,
  };
})()`;

export function expectedBookCardPercent({ pages, pagesRead }) {
  const totalPages = Number(pages);
  const readPages = Number(pagesRead);
  if (!Number.isFinite(totalPages) || totalPages <= 0 || !Number.isFinite(readPages)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((readPages / totalPages) * 100)));
}

export function inspectLibraryBookCard(
  snapshot,
  { bookId, title: expectedTitle, expectedPercent },
) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (bookId && snapshot.bookId !== bookId) return false;
  if (snapshot.heading !== expectedTitle || snapshot.openDisabled) return false;
  if (typeof snapshot.openLabel !== 'string') return false;
  if (
    !snapshot.openLabel.startsWith(`Open ${expectedTitle},`) ||
    !snapshot.openLabel.includes('downloaded for offline reading')
  ) {
    return false;
  }
  if (expectedPercent > 0) {
    if (Number(snapshot.progressNow) !== expectedPercent) return false;
    if (snapshot.progressText !== `${expectedPercent}% complete`) return false;
    if (
      snapshot.openLabel.includes('% complete') &&
      !snapshot.openLabel.includes(`${expectedPercent}% complete`)
    ) {
      return false;
    }
    return true;
  }
  return snapshot.progressNow === null && !snapshot.openLabel.includes('% complete');
}

export function hasQueuedSyncBanner(warningTexts) {
  return (
    Array.isArray(warningTexts) &&
    warningTexts.some(
      (text) =>
        typeof text === 'string' && text.includes('1 reading progress update waiting to sync.'),
    )
  );
}

async function captureLibraryDiagnostics(web) {
  const dom = await web.evaluate(`(() => ({
    booting: Boolean(document.querySelector('[aria-label="Opening Turnleaf"]')),
    alerts: Array.from(document.querySelectorAll('[role="alert"], [role="status"], .alert')).map(
      (el) => el.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    ),
    cards: Array.from(document.querySelectorAll('article[data-book-id]')).map((el) => ({
      bookId: el.getAttribute('data-book-id'),
      heading: el.querySelector('h2')?.textContent?.trim() ?? null,
      openLabel: el.querySelector('[data-book-open]')?.getAttribute('aria-label') ?? null,
      progressNow: el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
    })),
  }))()`);
  const books = await web
    .evaluate(
      querySqliteRows(
        'SELECT id, title, pages, pages_read, download_path, remote_available FROM books',
      ),
    )
    .catch((error) => ({ error: String(error) }));
  const queue = await web
    .evaluate(querySqliteRows('SELECT book_id, revision, last_error, updated_at FROM sync_queue'))
    .catch((error) => ({ error: String(error) }));
  return { dom, books, queue };
}

const retryDownloadReady = `Array.from(document.querySelectorAll('button')).some(
  button => !button.disabled && button.textContent?.trim() === 'Retry download'
)`;

const readerSnapshotExpression = `(() => {
  const shell = document.querySelector('.reader-shell');
  const viewport = document.querySelector('.reader-viewport');
  const frame = viewport?.querySelector('iframe');
  const doc = frame?.contentDocument;
  if (!shell || !viewport || !frame || !doc) return null;
  const liveText =
    shell.querySelector('[aria-live="polite"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
  const pageMatch = liveText.match(/,\\s*page\\s+(\\d+)\\s+of\\s+(\\d+),/i);
  if (!pageMatch) return null;
  const progressAttr = shell.querySelector('.reader-progress')?.getAttribute('aria-valuenow');
  const progressNow = progressAttr === null || progressAttr === undefined ? NaN : Number(progressAttr);
  const headingEl = doc.querySelector('h1');
  const heading = headingEl?.textContent?.trim() ?? null;
  if (!heading) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const inViewport = (el) => {
    const rect = el.getBoundingClientRect();
    const left = frameRect.left + rect.left;
    const right = frameRect.left + rect.right;
    const top = frameRect.top + rect.top;
    const bottom = frameRect.top + rect.bottom;
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      right > viewportRect.left + 8 &&
      left < viewportRect.right - 8 &&
      bottom > viewportRect.top + 8 &&
      top < viewportRect.bottom - 8
    );
  };
  const headingVisible = headingEl ? inViewport(headingEl) : false;
  const visibleParagraphs = Array.from(doc.querySelectorAll('p'))
    .filter((el) => inViewport(el))
    .map((el) => el.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 32) ?? '')
    .filter(Boolean);
  return {
    heading,
    headingVisible,
    liveText,
    page: Number(pageMatch[1]),
    pageCount: Number(pageMatch[2]),
    progressNow,
    visibleParagraphs,
  };
})()`;

const querySqliteRows = (statement) => `(async () => {
  const txBefore = await Capacitor.Plugins.CapacitorSQLite.isTransactionActive({
    database: 'turnleaf',
  });
  if (txBefore?.result !== false) return null;
  const res = await Capacitor.Plugins.CapacitorSQLite.query({
    database: 'turnleaf',
    statement: ${JSON.stringify(statement)},
    values: [],
    readonly: false,
  });
  const txAfter = await Capacitor.Plugins.CapacitorSQLite.isTransactionActive({
    database: 'turnleaf',
  });
  return txAfter?.result === false ? (res?.values ?? []) : null;
})()`;

function isMidChapterTwoSnapshot(snapshot) {
  if (!snapshot || snapshot.heading !== 'Chapter 2') return false;
  if (!Number.isFinite(snapshot.page) || !Number.isFinite(snapshot.pageCount)) return false;
  if (snapshot.pageCount < 3) return false;
  const minMidPage = snapshot.pageCount >= 4 ? 3 : 2;
  return (
    snapshot.page >= minMidPage &&
    snapshot.page < snapshot.pageCount &&
    snapshot.headingVisible === false &&
    Number.isFinite(snapshot.progressNow) &&
    snapshot.progressNow > 50 &&
    snapshot.visibleParagraphs.length > 0 &&
    !snapshot.visibleParagraphs.some((snippet) => snippet.startsWith('Chapter 2, paragraph 1.'))
  );
}

async function advanceToMidChapterTwo(web) {
  let current = await waitFor('settled initial reader page snapshot', async () => {
    const first = await web.evaluate(`(() => {
      const rect = document.querySelector('.reader-viewport')?.getBoundingClientRect();
      const snap = ${readerSnapshotExpression};
      if (!rect || !snap) return null;
      return { w: Math.floor(rect.width), h: Math.floor(rect.height), snap };
    })()`);
    if (!first || first.w <= 0 || first.h <= 0) return null;
    await delay(200);
    const second = await web.evaluate(`(() => {
      const rect = document.querySelector('.reader-viewport')?.getBoundingClientRect();
      const snap = ${readerSnapshotExpression};
      if (!rect || !snap) return null;
      return { w: Math.floor(rect.width), h: Math.floor(rect.height), snap };
    })()`);
    if (!second || second.w !== first.w || second.h !== first.h) return null;
    if (second.snap.liveText !== first.snap.liveText) return null;
    return second.snap;
  });
  for (let step = 0; step < 20; step += 1) {
    if (isMidChapterTwoSnapshot(current)) return current;
    const previousLiveText = current.liveText;
    await waitFor(`next-page control (step ${step + 1})`, () =>
      web.evaluate(click('[aria-label="Next page"]')),
    );
    current = await waitFor(`page relocation (step ${step + 1})`, async () => {
      const next = await web.evaluate(readerSnapshotExpression);
      return next && next.liveText !== previousLiveText ? next : null;
    });
  }
  throw new Error(
    `Did not reach a mid-chapter page in Chapter 2 after 20 page turns (last=${JSON.stringify(current)}).`,
  );
}

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
  let journeyError;
  let cleanupError;
  let journeyPassed = false;
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
    await waitFor('connect submit', () => web.evaluate(click('button[type=submit]')));

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
    await adb('shell', 'svc', 'data', 'disable');
    await adb('shell', 'svc', 'wifi', 'disable');
    await waitFor('offline state', async () => {
      const status = await web.evaluate('Capacitor.Plugins.Network.getStatus()');
      return (
        status?.connected === false &&
        status?.connectionType !== 'wifi' &&
        status?.connectionType !== 'cellular'
      );
    });
    fixture.setOffline(true);
    const uploadCount = fixture.uploads.length;

    const midChapterTarget = await advanceToMidChapterTwo(web);
    const anchorParagraph = midChapterTarget.visibleParagraphs[0];
    const committedProgress = await waitFor(
      'persisted mid-chapter SQLite progress while Reader remains mounted',
      async () => {
        const readerMounted = await web.evaluate(
          "Boolean(document.querySelector('.reader-shell .reader-viewport iframe'))",
        );
        if (!readerMounted) {
          throw new Error('Reader unmounted unexpectedly before am force-stop.');
        }
        const rows = await web.evaluate(
          querySqliteRows(
            `SELECT b.id AS book_id, b.pages, b.pages_read,
                    r.cfi, r.kavita_xpath, r.percentage, r.pending_sync, q.revision
             FROM reading_state r
             JOIN sync_queue q ON q.book_id = r.book_id
             JOIN books b ON b.id = r.book_id`,
          ),
        );
        if (!Array.isArray(rows) || rows.length !== 1) return null;
        const row = rows[0];
        const xpathMatch =
          typeof row.kavita_xpath === 'string'
            ? row.kavita_xpath.match(/^\/\/body\/DocFragment\[2\]\/body\/p\[(\d+)\]$/)
            : null;
        const paragraphNumber = xpathMatch ? Number(xpathMatch[1]) : 0;
        if (
          typeof row.book_id === 'string' &&
          row.book_id.length > 0 &&
          Number(row.pending_sync) === 1 &&
          typeof row.cfi === 'string' &&
          row.cfi.startsWith('epubcfi(') &&
          paragraphNumber > 1 &&
          Math.round(Number(row.percentage) * 100) === midChapterTarget.progressNow
        ) {
          const pages = Number(row.pages);
          const pagesRead = Number(row.pages_read);
          return {
            bookId: row.book_id,
            cfi: row.cfi,
            expectedCardPercent: expectedBookCardPercent({ pages, pagesRead }),
            pages,
            pagesRead,
            percentage: Number(row.percentage),
            revision: Number(row.revision),
            xpath: row.kavita_xpath,
          };
        }
        return null;
      },
    );

    const stillMountedBeforeStop = await web.evaluate(
      "Boolean(document.querySelector('.reader-shell .reader-viewport iframe'))",
    );
    if (!stillMountedBeforeStop) {
      throw new Error('Expected Reader.svelte to remain mounted immediately before force-stop.');
    }

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
    const bookOpenSelector = `article[data-book-id="${committedProgress.bookId}"] [data-book-open]`;
    await waitFor(
      'offline library book card after restart',
      async () => {
        const snapshot = await web.evaluate(libraryBookCardSnapshot(committedProgress.bookId));
        return inspectLibraryBookCard(snapshot, {
          bookId: committedProgress.bookId,
          title,
          expectedPercent: committedProgress.expectedCardPercent,
        });
      },
      () => captureLibraryDiagnostics(web),
    );
    await waitFor(
      'queued reading progress banner after restart',
      async () => {
        const warningTexts = await web.evaluate(`Array.from(
          document.querySelectorAll('.alert.preset-tonal-warning'),
          (el) => el.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
        )`);
        return hasQueuedSyncBanner(warningTexts);
      },
      () => captureLibraryDiagnostics(web),
    );
    await waitFor(
      'rendered offline cover after restart',
      () => web.evaluate(renderedBookCover(committedProgress.bookId)),
      () => captureLibraryDiagnostics(web),
    );
    await waitFor('offline catalog book', () => web.evaluate(click(bookOpenSelector)));
    await waitFor('exact mid-chapter offline passage restored after force-stop', async () => {
      const restored = await web.evaluate(readerSnapshotExpression);
      if (!isMidChapterTwoSnapshot(restored)) return false;
      return (
        restored.page === midChapterTarget.page &&
        restored.pageCount === midChapterTarget.pageCount &&
        restored.progressNow === midChapterTarget.progressNow &&
        restored.visibleParagraphs.includes(anchorParagraph)
      );
    });
    if (fixture.offlineRequests.length > 0) {
      throw new Error(
        `Turnleaf sent authenticated requests offline (${offlineRequestsBeforeRestart} before restart): ${fixture.offlineRequests.join(', ')}.`,
      );
    }

    fixture.setOffline(false);
    await adb('shell', 'svc', 'wifi', 'enable');
    await adb('shell', 'svc', 'data', 'enable');
    disabledNetwork = false;
    await waitFor('queued mid-chapter passage uploaded after reconnect', () =>
      fixture.uploads
        .slice(uploadCount)
        .some(
          (progress) =>
            progress.chapterId === 1 && progress.bookScrollId === committedProgress.xpath,
        ),
    );
    await waitFor('return to library after reconnect', async () => {
      if (await web.evaluate(click('[aria-label="Back to library"]'))) return true;
      await web.evaluate(click('[aria-label="Show reading controls"]'));
      return false;
    });
    await waitFor(
      'synced passage in library with zero pending sync warning banners',
      async () => {
        const domState = await web.evaluate(`(() => ({
          card: ${libraryBookCardSnapshot(committedProgress.bookId)},
          hasWarning: Boolean(document.querySelector('.alert.preset-tonal-warning')),
        }))()`);
        if (
          !domState ||
          domState.hasWarning ||
          !inspectLibraryBookCard(domState.card, {
            bookId: committedProgress.bookId,
            title,
            expectedPercent: committedProgress.expectedCardPercent,
          })
        ) {
          return false;
        }
        const queueRows = await web.evaluate(
          querySqliteRows('SELECT COUNT(*) AS count FROM sync_queue'),
        );
        const readingRows = await web.evaluate(
          querySqliteRows('SELECT pending_sync FROM reading_state'),
        );
        return (
          Number(queueRows?.[0]?.count ?? -1) === 0 &&
          readingRows?.length === 1 &&
          Number(readingRows[0]?.pending_sync) === 0
        );
      },
      () => captureLibraryDiagnostics(web),
    );
    await waitFor(
      'rendered cover after reconnect',
      () => web.evaluate(renderedBookCover(committedProgress.bookId)),
      () => captureLibraryDiagnostics(web),
    );
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
    'Android reading journey passed: connect, download, force-stop mid-chapter offline, restore exact passage, sync.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    console.error(error);
    process.exitCode ??= 1;
  });
}
