// @vitest-environment jsdom

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultAppearance } from './appearance';
import {
  buildTestEpub,
  installEpubJsdomEnvironment,
  TEST_PAGE_HEIGHT,
  TEST_PAGE_WIDTH,
} from './fixtures/test-epub-harness';
import {
  ReaderSession,
  type ReaderHighlightInput,
  type ReaderHighlightResolution,
  type ReaderLocation,
} from './session';

async function flushEpubLocationReport(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe('ReaderSession stale CFI and highlight recovery (real epubjs + marks-pane)', () => {
  const books = new Map<string, Uint8Array>();
  let server: Server;
  let baseUrl = '';
  let restoreDom: (() => void) | null = null;
  let activeSessions: ReaderSession[] = [];

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
    restoreDom = installEpubJsdomEnvironment();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const session of activeSessions) {
      session.destroy();
    }
    activeSessions = [];
    restoreDom?.();
    restoreDom = null;
  });

  function createViewport(): HTMLDivElement {
    const viewport = document.createElement('div');
    viewport.className = 'reader-viewport';
    viewport.dataset.readerTestViewport = 'true';
    viewport.style.width = `${TEST_PAGE_WIDTH}px`;
    viewport.style.height = `${TEST_PAGE_HEIGHT}px`;
    document.body.appendChild(viewport);
    return viewport;
  }

  function trackSession(url: string): ReaderSession {
    const session = new ReaderSession(url);
    activeSessions.push(session);
    return session;
  }

  it('clamps a shortened text node CFI and settles ReaderSession.open without hanging', async () => {
    books.set(
      'shortened-v1.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Opening chapter text.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: [
            '<p data-page="0">Chapter two first page.</p>',
            '<p id="editable" data-page="1">This paragraph originally had a very long concluding clause that placed the saved reading offset well past fifty characters.</p>',
          ].join('\n'),
        },
      ]),
    );

    books.set(
      'shortened-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Opening chapter text.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: [
            '<p data-page="0">Chapter two first page.</p>',
            '<p id="editable" data-page="1">Shortened text.</p>',
          ].join('\n'),
        },
      ]),
    );

    // Saved CFI pointing at character offset 95 inside #editable in chapter 2 (spine item index 1 -> /6/4)
    const staleOffsetCfi = 'epubcfi(/6/4!/4/4[editable]/1:95)';
    const locations: ReaderLocation[] = [];
    const session = trackSession(`${baseUrl}/shortened-v2.epub`);
    const viewport = createViewport();

    await session.open(
      viewport,
      staleOffsetCfi,
      '//body/DocFragment[2]/body/p[2]',
      0.75,
      defaultAppearance,
      (location) => locations.push(location),
      () => {},
    );
    await flushEpubLocationReport();

    const finalLocation = locations[locations.length - 1];
    expect(finalLocation).toBeDefined();
    expect(finalLocation?.href).toContain('chapter-2.xhtml');
    expect(finalLocation?.pageIndex).toBe(1);
    const iframe = viewport.querySelector('iframe') as
      (HTMLIFrameElement & { sandbox?: string }) | null;
    expect(iframe).not.toBeNull();
    expect(String(iframe?.sandbox ?? iframe?.getAttribute('sandbox') ?? '')).toBe(
      'allow-same-origin',
    );
  });

  it('skips a deleted CFI target instead of resetting to page 1 and restores XPath or percentage', async () => {
    books.set(
      'deleted-node-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Chapter one intro.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: [
            '<p data-page="0">Chapter two page one.</p>',
            '<p data-page="1">Chapter two page two.</p>',
            '<p data-page="2">Anchor paragraph still present on page three.</p>',
          ].join('\n'),
        },
      ]),
    );

    // Deleted 4th paragraph (/4/8) in chapter 2 (/6/4)
    const deletedElementCfi = 'epubcfi(/6/4!/4/8/1:10)';

    const xpathLocations: ReaderLocation[] = [];
    const xpathSession = trackSession(`${baseUrl}/deleted-node-v2.epub`);
    await xpathSession.open(
      createViewport(),
      deletedElementCfi,
      '//body/DocFragment[2]/body/p[3]',
      0.75,
      defaultAppearance,
      (location) => xpathLocations.push(location),
      () => {},
    );
    await flushEpubLocationReport();

    const restoredByXPath = xpathLocations[xpathLocations.length - 1];
    expect(restoredByXPath?.href).toContain('chapter-2.xhtml');
    // Must land on page 3 (pageIndex 2), NOT reset to page 1 (pageIndex 0)!
    expect(restoredByXPath?.pageIndex).toBe(2);

    // Now test when both CFI and XPath targets are gone -> falls back to percentage (chapter 2)
    const percentageLocations: ReaderLocation[] = [];
    const percentageSession = trackSession(`${baseUrl}/deleted-node-v2.epub`);
    await percentageSession.open(
      createViewport(),
      deletedElementCfi,
      '//body/DocFragment[2]/body/p[99]',
      0.75,
      defaultAppearance,
      (location) => percentageLocations.push(location),
      () => {},
    );
    await flushEpubLocationReport();

    const restoredByPercentage = percentageLocations[percentageLocations.length - 1];
    expect(restoredByPercentage?.href).toContain('chapter-2.xhtml');
  });

  it('renders valid SVG highlight rectangles via marks-pane when another highlight in the chapter was deleted', async () => {
    books.set(
      'highlights-deleted-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Chapter one warm-up.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: [
            '<p data-page="0">First surviving paragraph in chapter two.</p>',
            '<p data-page="0">Keep this vivid sentence highlighted across editions.</p>',
          ].join('\n'),
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/highlights-deleted-v2.epub`);
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      () => {},
      () => {},
      undefined,
      undefined,
      (resolution) => resolutions.push(resolution),
    );

    const highlights: ReaderHighlightInput[] = [
      {
        id: 'deleted-hl',
        cfi: 'epubcfi(/6/4!/4/8,/1:0,/1:28)',
        excerpt: 'Removed paragraph that no longer exists anywhere',
        href: 'chapter-2.xhtml',
      },
      {
        id: 'valid-hl',
        cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:52)',
        excerpt: 'Keep this vivid sentence highlighted across editions',
        href: 'chapter-2.xhtml',
      },
    ];

    session.updateHighlights(highlights);
    // Startup is on chapter 1, so chapter 2 highlights are validated lazily only when chapter 2 renders.
    expect(resolutions).toHaveLength(0);

    await expect(session.display('chapter-2.xhtml')).resolves.toBeUndefined();
    await flushEpubLocationReport();

    const rects = viewport.querySelectorAll('svg g.turnleaf-highlight rect');
    expect(rects.length).toBeGreaterThan(0);
    expect(Number.parseFloat(rects[0]?.getAttribute('width') ?? '0')).toBeGreaterThan(0);
    expect(resolutions.flatMap((entry) => entry.missingIds)).toContain('deleted-hl');
    expect(resolutions.flatMap((entry) => entry.missingIds)).not.toContain('valid-hl');
  });

  it('re-anchors shifted and duplicate-excerpt highlights via saved excerpt and context', async () => {
    // Version 1 where highlight was created on the second occurrence of a repeated phrase
    books.set(
      'shifted-v1.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Early mention of the silver lantern in the courtyard.</p>',
            '<p data-page="0">Later beside the harbor gate stood the silver lantern shining through fog.</p>',
          ].join('\n'),
        },
      ]),
    );

    // Version 2 inserts two new paragraphs at the top of Chapter One, shifting everything down!
    books.set(
      'shifted-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Author note added at the top of the revised edition.</p>',
            '<p data-page="0">Second new prefatory paragraph shifting all original paths.</p>',
            '<p data-page="0">Early mention of the silver lantern in the courtyard.</p>',
            '<p data-page="1">Later beside the harbor gate stood the silver lantern shining through fog.</p>',
          ].join('\n'),
        },
      ]),
    );

    // Original CFI pointed to /4/4 ("Later beside the harbor gate..."), which in v2 is now "Second new prefatory paragraph..."
    const staleShiftedCfi = 'epubcfi(/6/2!/4/4,/1:35,/1:53)';
    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/shifted-v2.epub`);

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      () => {},
      () => {},
      undefined,
      undefined,
      (resolution) => resolutions.push(resolution),
    );

    session.updateHighlights([
      {
        id: 'shifted-hl',
        cfi: staleShiftedCfi,
        excerpt: 'the silver lantern',
        href: 'chapter-1.xhtml',
        prefix: 'beside the harbor gate stood ',
        suffix: ' shining through fog.',
      },
    ]);

    const repairedEntries = resolutions.flatMap((entry) => entry.repaired);
    expect(repairedEntries).toHaveLength(1);
    expect(repairedEntries[0]?.id).toBe('shifted-hl');
    expect(repairedEntries[0]?.href).toBe('chapter-1.xhtml');
    // In v2, the harbor gate paragraph is the 4th <p> -> /4/8!
    expect(repairedEntries[0]?.cfi).toContain('/4/8');
    expect(repairedEntries[0]?.cfi).not.toBe(staleShiftedCfi);

    const rects = viewport.querySelectorAll('svg g.turnleaf-highlight rect');
    expect(rects.length).toBeGreaterThan(0);

    // Navigating to the repaired CFI lands on page 2 (pageIndex 1) where the harbor gate paragraph now lives
    const locations: ReaderLocation[] = [];
    const verifySession = trackSession(`${baseUrl}/shifted-v2.epub`);
    await verifySession.open(
      createViewport(),
      repairedEntries[0]!.cfi,
      null,
      null,
      defaultAppearance,
      (loc) => locations.push(loc),
      () => {},
    );
    await flushEpubLocationReport();
    expect(locations[locations.length - 1]?.pageIndex).toBe(1);
  });

  it('loads cold spine sections before evaluating displayCfi and displayAnnotation', async () => {
    books.set(
      'cold-nav.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: '<p data-page="0">Chapter one start.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: '<p data-page="0">Chapter two bridge.</p>',
        },
        {
          id: 'ch3',
          href: 'chapter-3.xhtml',
          title: 'Chapter Three',
          body: [
            '<p data-page="0">New preface in chapter three.</p>',
            '<p data-page="1">Deep passage relocated into chapter three.</p>',
          ].join('\n'),
        },
      ]),
    );

    const locations: ReaderLocation[] = [];
    const session = trackSession(`${baseUrl}/cold-nav.epub`);
    await session.open(
      createViewport(),
      null,
      null,
      null,
      defaultAppearance,
      (loc) => locations.push(loc),
      () => {},
    );
    await flushEpubLocationReport();

    // Stale CFI on cold chapter-3 returns false cleanly instead of navigating to page 1 or hanging
    const staleResult = await session.displayCfi('epubcfi(/6/6!/4/99/1:20)', 'chapter-3.xhtml');
    expect(staleResult).toBe(false);
    expect(locations[locations.length - 1]?.href).toContain('chapter-1.xhtml');

    // Fallback chapter href navigates cleanly
    expect(await session.displayHref('chapter-2.xhtml#missing-anchor')).toBe(true);
    await flushEpubLocationReport();
    expect(locations[locations.length - 1]?.href).toContain('chapter-2.xhtml');

    // Clicking an annotation whose CFI broke re-anchors across cold sections via excerpt
    const repairedJump = await session.displayAnnotation({
      id: 'moved-hl',
      cfi: 'epubcfi(/6/4!/4/99,/1:0,/1:42)',
      excerpt: 'Deep passage relocated into chapter three.',
      href: 'chapter-2.xhtml',
    });
    await flushEpubLocationReport();
    expect(repairedJump.status).toBe('repaired');
    if (repairedJump.status === 'repaired') {
      expect(repairedJump.href).toBe('chapter-3.xhtml');
    }
    expect(locations[locations.length - 1]?.href).toContain('chapter-3.xhtml');
    expect(locations[locations.length - 1]?.pageIndex).toBe(1);

    // Clicking an annotation whose excerpt was deleted returns { status: 'missing' } without hanging
    const missingJump = await session.displayAnnotation({
      id: 'gone-hl',
      cfi: 'epubcfi(/6/4!/4/88,/1:0,/1:25)',
      excerpt: 'Completely deleted sentence from old edition.',
      href: 'chapter-2.xhtml',
    });
    expect(missingJump).toEqual({ status: 'missing' });
  });
});
