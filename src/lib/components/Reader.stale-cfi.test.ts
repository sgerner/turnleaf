// @vitest-environment jsdom

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPreferences, setPreferences } from '../database/database';
import { parseAnnotations, type StoredAnnotation } from '../reader/annotations';
import type { StoredReaderLocation } from '../reader/bookmarks';
import type { ReaderLocation } from '../reader/session';
import { buildTestEpub, installEpubJsdomEnvironment } from '../reader/fixtures/test-epub-harness';
import Reader from './Reader.svelte';

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Reader.svelte condition.');
}

describe('Reader.svelte stale bookmark and highlight recovery (real epubjs + marks-pane)', () => {
  const books = new Map<string, Uint8Array>();
  let server: Server;
  let baseUrl = '';
  let restoreDom: (() => void) | null = null;
  let mountedComponents: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const key = (req.url ?? '/').replace(/^\//, '');
      const payload = books.get(key);
      if (!payload) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/epub+zip',
        'Content-Length': String(payload.byteLength),
      });
      res.end(Buffer.from(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    restoreDom = installEpubJsdomEnvironment();
  });

  afterEach(async () => {
    for (const instance of mountedComponents) {
      await unmount(instance);
    }
    mountedComponents = [];
    restoreDom?.();
    restoreDom = null;
  });

  it('persists repaired highlight CFIs to local storage and reports disappeared highlights without deleting notes', async () => {
    books.set(
      'reader-edition-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Added foreword paragraph in revised edition.</p>',
            '<p data-page="0">Anchor quote preserved in chapter one.</p>',
          ].join('\n'),
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: '<p data-page="0">Remaining text in chapter two.</p>',
        },
      ]),
    );

    const bookId = 'book-highlights-1';
    const initialAnnotations: StoredAnnotation[] = [
      {
        id: 'shifted-1',
        // Originally at /4/2 before the foreword paragraph was inserted
        cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:38)',
        excerpt: 'Anchor quote preserved in chapter one.',
        note: 'Important theme note',
        createdAt: '2026-01-01T00:00:00.000Z',
        href: 'chapter-1.xhtml',
      },
      {
        id: 'deleted-2',
        cfi: 'epubcfi(/6/4!/4/6,/1:0,/1:28)',
        excerpt: 'Passage removed from chapter two.',
        note: 'User note that must never be deleted',
        createdAt: '2026-01-02T00:00:00.000Z',
        href: 'chapter-2.xhtml',
      },
    ];

    await setPreferences(
      new Map([[`readerAnnotations:${bookId}`, JSON.stringify(initialAnnotations)]]),
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const relocated: ReaderLocation[] = [];
    const instance = mount(Reader, {
      target: host,
      props: {
        bookUrl: `${baseUrl}/reader-edition-v2.epub`,
        bookId,
        title: 'Revised Edition',
        onBack: () => {},
        onRelocated: (loc: ReaderLocation) => relocated.push(loc),
      },
    });
    mountedComponents.push(instance);

    // Wait for chapter 1 highlight to re-anchor and persist its repaired CFI
    await waitForCondition(() => {
      const rects = host.querySelectorAll('svg g.turnleaf-highlight rect');
      return rects.length > 0;
    });

    await waitForCondition(() => {
      const raw = localStorage.getItem('turnleaf_browser_database_v1') ?? '';
      return raw.includes('/4/4');
    });

    const savedPrefs = await getPreferences([`readerAnnotations:${bookId}`]);
    const persisted = parseAnnotations(savedPrefs.get(`readerAnnotations:${bookId}`) ?? null);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.id).toBe('shifted-1');
    expect(persisted[0]?.cfi).toContain('/4/4');
    expect(persisted[0]?.note).toBe('Important theme note');
    expect(persisted[1]?.id).toBe('deleted-2');
    expect(persisted[1]?.note).toBe('User note that must never be deleted');

    // Open controls and open the Highlights & Notes dialog
    const showControlsBtn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Show reading controls"]',
    );
    showControlsBtn?.click();
    await waitForCondition(() =>
      Boolean(host.querySelector('button[aria-controls="reader-annotations"]')),
    );

    host.querySelector<HTMLButtonElement>('button[aria-controls="reader-annotations"]')?.click();
    await waitForCondition(() => Boolean(host.querySelector('#reader-annotations')));

    // Click the unanchored highlight ("Passage removed from chapter two.")
    const highlightButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-annotations article > button'),
    ];
    const deletedButton = highlightButtons.find((btn) =>
      btn.textContent?.includes('Passage removed from chapter two.'),
    );
    expect(deletedButton).toBeDefined();
    deletedButton!.click();

    await waitForCondition(() => {
      const panelText = host.querySelector('#reader-annotations')?.textContent ?? '';
      return panelText.includes('no longer available in the current EPUB');
    });

    // Verify user's note was NOT deleted and fallback chapter-2 navigated cleanly without hanging
    const prefsAfterClick = await getPreferences([`readerAnnotations:${bookId}`]);
    const stillSaved = parseAnnotations(prefsAfterClick.get(`readerAnnotations:${bookId}`) ?? null);
    expect(stillSaved).toHaveLength(2);
    expect(stillSaved.find((a) => a.id === 'deleted-2')?.note).toBe(
      'User note that must never be deleted',
    );
    await waitForCondition(() =>
      Boolean(relocated[relocated.length - 1]?.href.includes('chapter-2.xhtml')),
    );
  });

  it('falls back to saved href and percentage when selecting stale bookmarks in Reader.svelte', async () => {
    books.set(
      'bookmarks-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Chapter one text.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: '<p data-page="0">Chapter two text.</p>',
        },
        {
          id: 'ch3',
          href: 'chapter-3-renamed.xhtml',
          title: 'Chapter Three',
          body: '<p data-page="0">Chapter three after file rename.</p>',
        },
      ]),
    );

    const bookId = 'book-bookmarks-1';
    const bookmarks: StoredReaderLocation[] = [
      {
        id: 'stale-href-bm',
        cfi: 'epubcfi(/6/4!/4/99/1:15)',
        href: 'chapter-2.xhtml',
        percentage: 0.4,
        label: 'Chapter Two Stale CFI',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'stale-pct-bm',
        cfi: 'epubcfi(/6/99!/4/99/1:15)',
        href: 'old-chapter-3.xhtml',
        percentage: 0.85,
        label: 'Chapter Three Renamed File',
        savedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'unresolvable-bm',
        cfi: 'epubcfi(/6/99!/4/99/1:15)',
        href: 'deleted-appendix.xhtml',
        percentage: -1,
        label: 'Removed Appendix Bookmark',
        savedAt: '2026-01-03T00:00:00.000Z',
      },
    ];

    await setPreferences(new Map([[`readerBookmarks:${bookId}`, JSON.stringify(bookmarks)]]));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const relocated: ReaderLocation[] = [];
    const instance = mount(Reader, {
      target: host,
      props: {
        bookUrl: `${baseUrl}/bookmarks-v2.epub`,
        bookId,
        title: 'Bookmarks Edition',
        onBack: () => {},
        onRelocated: (loc: ReaderLocation) => relocated.push(loc),
      },
    });
    mountedComponents.push(instance);

    await waitForCondition(() => Boolean(host.querySelector('iframe')));

    // Open Bookmarks panel and click the first stale bookmark -> falls back to chapter-2.xhtml via href
    host.querySelector<HTMLButtonElement>('button[aria-label="Show reading controls"]')?.click();
    await waitForCondition(() =>
      Boolean(host.querySelector('button[aria-controls="reader-bookmarks"]')),
    );
    host.querySelector<HTMLButtonElement>('button[aria-controls="reader-bookmarks"]')?.click();
    await waitForCondition(() => Boolean(host.querySelector('#reader-bookmarks')));

    const firstBmButton = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-bookmarks button'),
    ].find((btn) => btn.textContent?.includes('Chapter Two Stale CFI'));
    expect(firstBmButton).toBeDefined();
    firstBmButton!.click();

    await waitForCondition(() =>
      Boolean(relocated[relocated.length - 1]?.href.includes('chapter-2.xhtml')),
    );

    // Reopen Bookmarks panel and click the second stale bookmark (both CFI and href invalid -> falls back to percentage -> chapter-3-renamed.xhtml)
    await waitForCondition(() =>
      Boolean(host.querySelector('button[aria-controls="reader-bookmarks"]')),
    );
    host.querySelector<HTMLButtonElement>('button[aria-controls="reader-bookmarks"]')?.click();
    await waitForCondition(() => Boolean(host.querySelector('#reader-bookmarks')));

    const secondBmButton = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-bookmarks button'),
    ].find((btn) => btn.textContent?.includes('Chapter Three Renamed File'));
    expect(secondBmButton).toBeDefined();
    secondBmButton!.click();

    await waitForCondition(() =>
      Boolean(relocated[relocated.length - 1]?.href.includes('chapter-3-renamed.xhtml')),
    );

    // Reopen Bookmarks panel and click the unresolvable bookmark -> shows dismissible runtime alertdialog without fatal startup screen
    await waitForCondition(() =>
      Boolean(host.querySelector('button[aria-controls="reader-bookmarks"]')),
    );
    host.querySelector<HTMLButtonElement>('button[aria-controls="reader-bookmarks"]')?.click();
    await waitForCondition(() => Boolean(host.querySelector('#reader-bookmarks')));

    const thirdBmButton = [
      ...host.querySelectorAll<HTMLButtonElement>('#reader-bookmarks button'),
    ].find((btn) => btn.textContent?.includes('Removed Appendix Bookmark'));
    expect(thirdBmButton).toBeDefined();
    thirdBmButton!.click();

    await waitForCondition(() => {
      const dialogText = host.querySelector('[role="alertdialog"]')?.textContent ?? '';
      return dialogText.includes('no longer available in the current EPUB');
    });
    const errorDialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(errorDialog).not.toBeNull();
    expect(errorDialog!.textContent).not.toContain('Unable to open book');
    const dismissButton = [...errorDialog!.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Dismiss',
    );
    expect(dismissButton).toBeDefined();
    dismissButton!.click();
    await waitForCondition(() => host.querySelector('[role="alertdialog"]') === null);
    expect(host.querySelector('#reader-bookmarks')).not.toBeNull();
  });
});
