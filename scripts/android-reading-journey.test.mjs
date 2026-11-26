import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelSystemExportSheet,
  completeSystemExportSheet,
  journeyExpressions,
  parseUiNodes,
  startFixture,
} from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

const FORBIDDEN_CHROME_74_SYNTAX = [
  { label: 'optional chaining (?.)', pattern: /\?\./ },
  { label: 'nullish coalescing (??)', pattern: /\?\?/ },
  { label: 'logical assignment (||=, &&=, ??=)', pattern: /(?:\|\||&&|\?\?)=/ },
  { label: 'String.prototype.replaceAll', pattern: /\.replaceAll\s*\(/ },
  { label: 'Array/String.prototype.at', pattern: /\.at\s*\(/ },
  { label: 'Object.hasOwn', pattern: /\bObject\.hasOwn\s*\(/ },
];

describe('Android reading journey WebView expressions', () => {
  it('keeps every Runtime.evaluate expression compatible with Android 10 Chrome 74 WebView', () => {
    const samples = [
      ['hasOnboardingUrlInput', journeyExpressions.hasOnboardingUrlInput()],
      [
        'fillOnboardingCredentials',
        journeyExpressions.fillOnboardingCredentials('http://127.0.0.1:41234', 'turnleaf-ci-only'),
      ],
      ['click', journeyExpressions.click('[data-book-open]')],
      ['clickByText', journeyExpressions.clickByText('#reader-annotations', 'Export Markdown')],
      ['hasCachedCoverImage', journeyExpressions.hasCachedCoverImage()],
      ['hasCatalogBookCard', journeyExpressions.hasCatalogBookCard()],
      ['renderedCover', journeyExpressions.renderedCover()],
      ['retryDownloadReady', journeyExpressions.retryDownloadReady()],
      ['chapter', journeyExpressions.chapter(1)],
      ['selectChapterHeading', journeyExpressions.selectChapterHeading(1)],
      ['hasMarkdownCopyFallback', journeyExpressions.hasMarkdownCopyFallback('Turnleaf CI EPUB')],
      ['hasSavedNoteExportConfirmation', journeyExpressions.hasSavedNoteExportConfirmation()],
      ['isNetworkConnected', journeyExpressions.isNetworkConnected()],
      ['hasReaderProgressAtLeast', journeyExpressions.hasReaderProgressAtLeast(50)],
      [
        'hasDownloadedBookProgress',
        journeyExpressions.hasDownloadedBookProgress('Turnleaf CI EPUB', 50),
      ],
    ];

    expect(samples.map(([name]) => name).sort()).toEqual(Object.keys(journeyExpressions).sort());

    for (const [name, expression] of samples) {
      for (const { label, pattern } of FORBIDDEN_CHROME_74_SYNTAX) {
        expect(expression, `${name} must not use ${label}`).not.toMatch(pattern);
      }
      expect(
        () => new Function(`return (${expression});`),
        `${name} must parse as a valid JavaScript expression`,
      ).not.toThrow();
    }
  });

  it('evaluates chapter, selection, note export, cover, and progress checks safely against DOM state', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div class="book-card">
        <button type="button" data-book-open>Open</button>
      </div>
      <div id="reader-annotations">
        <p role="status">Export canceled. Copy the Markdown from the field below.</p>
        <textarea readonly># Notes for Turnleaf CI EPUB</textarea>
      </div>
      <div class="reader-progress" aria-valuenow="50"></div>
    </body></html>`);
    const { document, Event: DomEvent } = dom.window;
    const runExpr = (expr) =>
      new Function('document', 'Event', `return (${expr});`)(document, DomEvent);

    expect(runExpr(journeyExpressions.hasCatalogBookCard())).toBe(true);
    expect(runExpr(journeyExpressions.renderedCover())).toBe(false);
    expect(runExpr(journeyExpressions.retryDownloadReady())).toBe(false);
    expect(runExpr(journeyExpressions.chapter(1))).toBe(false);
    expect(runExpr(journeyExpressions.selectChapterHeading(1))).toBe(false);
    expect(runExpr(journeyExpressions.hasMarkdownCopyFallback('Turnleaf CI EPUB'))).toBe(true);
    expect(runExpr(journeyExpressions.hasSavedNoteExportConfirmation())).toBe(false);
    expect(runExpr(journeyExpressions.hasReaderProgressAtLeast(50))).toBe(true);

    const retryButton = document.createElement('button');
    retryButton.textContent = 'Retry download';
    document.body.appendChild(retryButton);
    expect(runExpr(journeyExpressions.retryDownloadReady())).toBe(true);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.body.innerHTML = '<h1>Chapter 1</h1><p>First page text.</p>';

    expect(runExpr(journeyExpressions.chapter(1))).toBe(true);
    expect(runExpr(journeyExpressions.chapter(2))).toBe(false);
    expect(runExpr(journeyExpressions.selectChapterHeading(1))).toBe(true);
    expect(frame.contentWindow.getSelection().toString()).toBe('Chapter 1');

    document.querySelector('#reader-annotations').innerHTML =
      '<p role="status">Highlight saved.</p><p role="status">Saved notes as Turnleaf-CI-EPUB-notes.md.</p>';
    expect(runExpr(journeyExpressions.hasSavedNoteExportConfirmation())).toBe(true);

    const nav = document.createElement('nav');
    nav.setAttribute('inert', '');
    nav.innerHTML = '<button type="button" aria-label="Next page">Turn forward</button>';
    document.body.appendChild(nav);
    let nextClicks = 0;
    nav.querySelector('button').addEventListener('click', () => {
      nextClicks += 1;
    });
    expect(runExpr(journeyExpressions.click('[aria-label="Next page"]'))).toBe(false);
    expect(runExpr(journeyExpressions.clickByText('nav', 'Turn forward'))).toBe(false);
    expect(nextClicks).toBe(0);

    nav.removeAttribute('inert');
    expect(runExpr(journeyExpressions.click('[aria-label="Next page"]'))).toBe(true);
    expect(runExpr(journeyExpressions.clickByText('nav', 'Turn forward'))).toBe(true);
    expect(nextClicks).toBe(2);
  });
});

describe('Android system export sheet helpers', () => {
  it('waits for slow activity resume after KEYCODE_BACK without sending a duplicate back press', async () => {
    let checks = 0;
    let backPresses = 0;
    await cancelSystemExportSheet({
      checkResumed: async () => {
        checks += 1;
        // 1st check: sheet has opened (not resumed).
        // 2nd check: before first KEYCODE_BACK (not resumed).
        // 3rd-5th checks: ActivityManager still transitioning on API 29.
        // 6th check: MainActivity resumed.
        return checks >= 6;
      },
      sendBack: async () => {
        backPresses += 1;
      },
      settleAttempts: 6,
      settleIntervalMs: 1,
    });

    expect(backPresses).toBe(1);
  });

  it('taps the DocumentsUI Save button once and waits for MainActivity to resume', async () => {
    let checks = 0;
    const tapped = [];
    const xml = `
      <hierarchy rotation="0">
        <node text="Cancel" resource-id="android:id/button2" enabled="true" bounds="[40,1600][240,1720]" />
        <node text="SAVE" resource-id="android:id/button1" enabled="true" bounds="[760,1600][1000,1720]" />
      </hierarchy>
    `;

    expect(parseUiNodes(xml)).toHaveLength(2);

    await completeSystemExportSheet({
      checkResumed: async () => {
        checks += 1;
        return checks >= 5;
      },
      readUiXml: async () => xml,
      tap: async (node) => {
        tapped.push(node);
      },
      settleAttempts: 5,
      settleIntervalMs: 1,
    });

    expect(tapped).toHaveLength(1);
    expect(tapped[0]).toMatchObject({
      resourceId: 'android:id/button1',
      centerX: 880,
      centerY: 1660,
    });
  });
});

describe('Android reading journey fixture', () => {
  it('serves series covers as PNG with zero 404 responses and enforces the API key', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const unauthorized = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
    );
    expect(unauthorized.status).toBe(401);

    const response = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(fixture.covers).toBe(1);
    expect(fixture.notFoundPaths).toEqual([]);
  });

  it('tracks cross-origin redirect isolation for cover and EPUB endpoints', async () => {
    const fixture = await startFixture({ crossOriginRedirects: true });
    fixtures.push(fixture);

    const coverRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(coverRedirect.status).toBe(302);
    expect(coverRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Image/series-cover?seriesId=1`,
    );

    const downloadRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Download/chapter?chapterId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(downloadRedirect.status).toBe(302);
    expect(downloadRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Download/chapter?chapterId=1`,
    );
    expect(fixture.coverRedirects).toBe(1);
    expect(fixture.downloadRedirects).toBe(1);
    expect(fixture.foreignRequests).toEqual([]);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe`);
    expect(fixture.foreignRequests).toEqual(['/probe']);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe-auth`, {
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(fixture.foreignRequests).toEqual(['/probe', '/probe-auth']);
    expect(fixture.foreignAuthHeaders).toBe(1);
  });
});
