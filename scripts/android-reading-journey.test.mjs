import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  cancelSystemExportSheet,
  completeSystemExportSheet,
  journeyExpressions,
  parseUiNodes,
} from './android-reading-journey.mjs';

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

  it('evaluates chapter, selection, note export, and progress checks safely against DOM state', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="reader-annotations">
        <p role="status">Export canceled. Copy the Markdown from the field below.</p>
        <textarea readonly># Notes for Turnleaf CI EPUB</textarea>
      </div>
      <div class="reader-progress" aria-valuenow="50"></div>
    </body></html>`);
    const { document, Event: DomEvent } = dom.window;
    const runExpr = (expr) =>
      new Function('document', 'Event', `return (${expr});`)(document, DomEvent);

    expect(runExpr(journeyExpressions.chapter(1))).toBe(false);
    expect(runExpr(journeyExpressions.selectChapterHeading(1))).toBe(false);
    expect(runExpr(journeyExpressions.hasMarkdownCopyFallback('Turnleaf CI EPUB'))).toBe(true);
    expect(runExpr(journeyExpressions.hasSavedNoteExportConfirmation())).toBe(false);
    expect(runExpr(journeyExpressions.hasReaderProgressAtLeast(50))).toBe(true);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument.body.innerHTML = '<h1>Chapter 1</h1><p>First page text.</p>';

    expect(runExpr(journeyExpressions.chapter(1))).toBe(true);
    expect(runExpr(journeyExpressions.chapter(2))).toBe(false);
    expect(runExpr(journeyExpressions.selectChapterHeading(1))).toBe(true);
    expect(frame.contentWindow.getSelection().toString()).toBe('Chapter 1');

    document.querySelector('#reader-annotations').innerHTML =
      '<p role="status">Saved notes as Turnleaf-CI-EPUB-notes.md.</p>';
    expect(runExpr(journeyExpressions.hasSavedNoteExportConfirmation())).toBe(true);
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
