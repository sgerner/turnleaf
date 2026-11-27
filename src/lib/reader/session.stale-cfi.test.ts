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

  it('refuses to overwrite persisted CFIs when duplicate excerpts are ambiguous in a chapter or across chapters', async () => {
    books.set(
      'ambiguous-excerpts.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">First occurrence of a recurring refrain in chapter one.</p>',
            '<p data-page="1">Second occurrence of a recurring refrain in chapter one.</p>',
            '<p data-page="1">Shared phrase across chapters without unique context.</p>',
          ].join('\n'),
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter Two',
          body: '<p data-page="0">Shared phrase across chapters without unique context.</p>',
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/ambiguous-excerpts.epub`);
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
    await flushEpubLocationReport();

    // 1. Same-chapter duplicate excerpt without prefix/suffix must NOT guess the first match or repair CFI
    // 2. Removed chapter (chapter-9.xhtml) highlight must NOT passively render or repair onto Chapter 1
    session.updateHighlights([
      {
        id: 'ambiguous-same-chapter',
        cfi: 'epubcfi(/6/2!/4/99,/1:0,/1:17)',
        excerpt: 'recurring refrain',
        href: 'chapter-1.xhtml',
      },
      {
        id: 'removed-chapter-hl',
        cfi: 'epubcfi(/6/18!/4/2,/1:0,/1:52)',
        excerpt: 'Shared phrase across chapters without unique context.',
        href: 'chapter-9.xhtml',
      },
    ]);

    expect(resolutions.flatMap((entry) => entry.repaired)).toHaveLength(0);
    expect(resolutions.flatMap((entry) => entry.missingIds)).toContain('ambiguous-same-chapter');
    expect(resolutions.flatMap((entry) => entry.missingIds)).not.toContain('removed-chapter-hl');
    expect(viewport.querySelectorAll('svg g.turnleaf-highlight rect')).toHaveLength(0);

    // Explicit navigation to an ambiguous cross-chapter excerpt without disambiguating context must refuse to overwrite CFI
    const ambiguousCrossChapter = await session.displayAnnotation({
      id: 'removed-chapter-hl',
      cfi: 'epubcfi(/6/18!/4/2,/1:0,/1:52)',
      excerpt: 'Shared phrase across chapters without unique context.',
      href: 'chapter-9.xhtml',
    });
    expect(ambiguousCrossChapter).toEqual({ status: 'missing' });
  });

  it('renders and navigates 500-character-truncated excerpts without shrinking the stored CFI', async () => {
    const longSelection = Array.from(
      { length: 12 },
      (_, index) =>
        `Sentence ${index + 1} of the long highlighted passage with distinctive phrasing.`,
    ).join(' ');
    expect(longSelection.length).toBeGreaterThan(600);
    const truncatedExcerpt = longSelection.slice(0, 500);

    books.set(
      'truncated-excerpt.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Added preface paragraph shifting original paths.</p>',
            `<p data-page="1">${longSelection}</p>`,
          ].join('\n'),
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/truncated-excerpt.epub`);
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
    await flushEpubLocationReport();

    const originalFullSelectionCfi = 'epubcfi(/6/2!/4/2,/1:0,/1:680)';
    session.updateHighlights([
      {
        id: 'truncated-hl',
        cfi: originalFullSelectionCfi,
        excerpt: truncatedExcerpt,
        href: 'chapter-1.xhtml',
      },
    ]);

    // Renders highlight rectangles for the surviving prefix without overwriting the stored full-selection CFI
    expect(viewport.querySelectorAll('svg g.turnleaf-highlight rect').length).toBeGreaterThan(0);
    expect(resolutions.flatMap((entry) => entry.repaired)).toHaveLength(0);
    expect(resolutions.flatMap((entry) => entry.missingIds)).not.toContain('truncated-hl');

    const jumpResult = await session.displayAnnotation({
      id: 'truncated-hl',
      cfi: originalFullSelectionCfi,
      excerpt: truncatedExcerpt,
      href: 'chapter-1.xhtml',
    });
    expect(jumpResult.status).toBe('displayed');
  });

  it('repairs moved ID-bearing elements instead of letting epubjs XPath position mismatch reset to page 1', async () => {
    books.set(
      'moved-id-v2.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Inserted intro paragraph on page one.</p>',
            '<p data-page="0">Second inserted paragraph on page one.</p>',
            '<p id="target-para" data-page="1">Moved ID paragraph with a saved highlight on page two.</p>',
          ].join('\n'),
        },
      ]),
    );

    // Originally #target-para was the 1st <p> (/4/2[target-para]), now it is the 3rd <p> (/4/6[target-para]).
    // epubjs's stepsToXpath builds `*[position()=2 and @id='target-para']`, which fails without CFI regeneration!
    const staleMovedIdReadingCfi = 'epubcfi(/6/2!/4/2[target-para]/1:0)';
    const staleMovedIdHighlightCfi = 'epubcfi(/6/2!/4/2[target-para],/1:0,/1:54)';

    const readingLocations: ReaderLocation[] = [];
    const readingSession = trackSession(`${baseUrl}/moved-id-v2.epub`);
    await readingSession.open(
      createViewport(),
      staleMovedIdReadingCfi,
      null,
      null,
      defaultAppearance,
      (loc) => readingLocations.push(loc),
      () => {},
    );
    await flushEpubLocationReport();
    expect(readingLocations.at(-1)?.pageIndex).toBe(1);

    const resolutions: ReaderHighlightResolution[] = [];
    const navLocations: ReaderLocation[] = [];
    const highlightViewport = createViewport();
    const highlightSession = trackSession(`${baseUrl}/moved-id-v2.epub`);
    await highlightSession.open(
      highlightViewport,
      null,
      null,
      null,
      defaultAppearance,
      (loc) => navLocations.push(loc),
      () => {},
      undefined,
      undefined,
      (res) => resolutions.push(res),
    );
    await flushEpubLocationReport();

    const movedHighlight: ReaderHighlightInput = {
      id: 'moved-id-hl',
      cfi: staleMovedIdHighlightCfi,
      excerpt: 'Moved ID paragraph with a saved highlight on page two.',
      href: 'chapter-1.xhtml',
    };
    highlightSession.updateHighlights([movedHighlight]);

    const repaired = resolutions.flatMap((entry) => entry.repaired);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.id).toBe('moved-id-hl');
    expect(repaired[0]?.cfi).toContain('/4/6[target-para]');

    const jump = await highlightSession.displayAnnotation(movedHighlight);
    await flushEpubLocationReport();
    expect(jump.status).toBe('repaired');
    expect(navLocations.at(-1)?.pageIndex).toBe(1);
  });

  it('never steals an intact highlight anchor when an earlier duplicate-excerpt highlight was deleted, and rejects contradicted short-phrase context', async () => {
    books.set(
      'duplicate-steal-guard.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Rewritten opening paragraph where the refrain was removed.</p>',
            '<p data-page="1">Harbor watchtower scene: Remember the signal before dawn.</p>',
            '<p data-page="1">Bob shouted Yes loudly across the courtyard.</p>',
          ].join('\n'),
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/duplicate-steal-guard.epub`);
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
      (res) => resolutions.push(res),
    );
    await flushEpubLocationReport();

    // `deleted-dup-1` comes BEFORE `intact-dup-2` in the array!
    // Its paragraph (/4/2) was rewritten, while `intact-dup-2` at /4/4 still resolves directly.
    const deletedFirstDup: ReaderHighlightInput = {
      id: 'deleted-dup-1',
      cfi: 'epubcfi(/6/2!/4/2,/1:14,/1:33)',
      excerpt: 'Remember the signal',
      href: 'chapter-1.xhtml',
      prefix: 'Courtyard whisper: ',
      suffix: ' at midnight.',
    };
    const intactSecondDup: ReaderHighlightInput = {
      id: 'intact-dup-2',
      cfi: 'epubcfi(/6/2!/4/4,/1:25,/1:44)',
      excerpt: 'Remember the signal',
      href: 'chapter-1.xhtml',
      prefix: 'Harbor watchtower scene: ',
      suffix: ' before dawn.',
    };
    const contradictedShortPhrase: ReaderHighlightInput = {
      id: 'contradicted-short',
      cfi: 'epubcfi(/6/2!/4/99,/1:0,/1:3)',
      excerpt: 'Yes',
      href: 'chapter-1.xhtml',
      prefix: 'Alice whispered ',
      suffix: ' softly to him.',
    };

    session.updateHighlights([deletedFirstDup, intactSecondDup, contradictedShortPhrase]);

    expect(resolutions.flatMap((entry) => entry.repaired)).toEqual([]);
    expect(resolutions.flatMap((entry) => entry.missingIds)).toEqual([
      'deleted-dup-1',
      'contradicted-short',
    ]);

    // Explicit jump on the deleted duplicate or contradicted short phrase must also return 'missing' rather than stealing
    expect(await session.displayAnnotation(deletedFirstDup)).toEqual({ status: 'missing' });
    expect(await session.displayAnnotation(contradictedShortPhrase)).toEqual({ status: 'missing' });

    // Meanwhile the intact second duplicate still jumps cleanly to page 2 (pageIndex 1)
    const intactJump = await session.displayAnnotation(intactSecondDup);
    expect(intactJump.status).toBe('displayed');
  });

  it('repairs spine-shifted >500-character highlights directly via DOM CFI without truncating to 500 characters', async () => {
    const longHighlight = Array.from(
      { length: 10 },
      (_, index) =>
        `Clause ${index + 1} of an unchanged chapter passage after a cover page was prepended.`,
    ).join(' ');
    expect(longHighlight.length).toBeGreaterThan(600);

    books.set(
      'frontmatter-shifted.epub',
      buildTestEpub([
        {
          id: 'cover',
          href: 'cover.xhtml',
          title: 'Cover',
          body: '<p data-page="0">New frontmatter cover page.</p>',
        },
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: `<p data-page="0">${longHighlight}</p>`,
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/frontmatter-shifted.epub`);
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
      (res) => resolutions.push(res),
    );
    await session.display('chapter-1.xhtml');
    await flushEpubLocationReport();

    // Originally chapter-1 was spine index 0 (/6/2[ch1]), now it is spine index 1 (/6/4[ch1])
    const preCoverFullCfi = `epubcfi(/6/2[ch1]!/4/2,/1:0,/1:${longHighlight.length})`;
    session.updateHighlights([
      {
        id: 'frontmatter-long-hl',
        cfi: preCoverFullCfi,
        excerpt: longHighlight.slice(0, 500),
        href: 'chapter-1.xhtml',
      },
    ]);

    const repaired = resolutions.flatMap((entry) => entry.repaired);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.cfi).toContain('/6/4');
    // Full end offset is preserved rather than shrinking to :500!
    expect(repaired[0]?.cfi).toContain(`:${longHighlight.length})`);
  });

  it('refuses to shrink clamped >500-char highlights, match short words inside longer words, or let two broken refrains guess a lone survivor', async () => {
    const originalLongQuote = Array.from(
      { length: 12 },
      (_, index) => `Segment ${index + 1} of an extended highlighted passage in chapter one.`,
    ).join(' ');
    expect(originalLongQuote.length).toBeGreaterThan(620);
    // Shorten the tail past 500 chars so the node clamps from ~660 to 540 chars
    const shortenedTailQuote = originalLongQuote.slice(0, 540);

    books.set(
      'clamped-and-refrain-guards.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter One',
          body: [
            '<p data-page="0">Inserted preface paragraph shifting refrains.</p>',
            `<p data-page="0">${shortenedTailQuote}</p>`,
            '<p data-page="1">Yesterday the harbor bell rang once.</p>',
            '<p data-page="1">Echoing refrain without context</p>',
          ].join('\n'),
        },
      ]),
    );

    const resolutions: ReaderHighlightResolution[] = [];
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/clamped-and-refrain-guards.epub`);
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
      (res) => resolutions.push(res),
    );
    await flushEpubLocationReport();

    const clampedLongHighlight: ReaderHighlightInput = {
      id: 'clamped-long-hl',
      cfi: `epubcfi(/6/2!/4/4,/1:0,/1:${originalLongQuote.length})`,
      excerpt: originalLongQuote.slice(0, 500),
      href: 'chapter-1.xhtml',
    };
    const midWordShortHighlight: ReaderHighlightInput = {
      id: 'mid-word-yes',
      cfi: 'epubcfi(/6/2!/4/90,/1:0,/1:3)',
      excerpt: 'Yes',
      href: 'chapter-1.xhtml',
    };
    const brokenRefrainOne: ReaderHighlightInput = {
      id: 'broken-refrain-1',
      cfi: 'epubcfi(/6/2!/4/92,/1:0,/1:31)',
      excerpt: 'Echoing refrain without context',
      href: 'chapter-1.xhtml',
    };
    const brokenRefrainTwo: ReaderHighlightInput = {
      id: 'broken-refrain-2',
      cfi: 'epubcfi(/6/2!/4/94,/1:0,/1:31)',
      excerpt: 'Echoing refrain without context',
      href: 'chapter-1.xhtml',
    };

    session.updateHighlights([
      clampedLongHighlight,
      midWordShortHighlight,
      brokenRefrainOne,
      brokenRefrainTwo,
    ]);

    // Clamped >500-char highlight renders without shrinking its persisted CFI; the other three refuse false matches
    expect(viewport.querySelectorAll('svg g.turnleaf-highlight rect').length).toBeGreaterThan(0);
    expect(resolutions.flatMap((entry) => entry.repaired)).toEqual([]);
    expect(resolutions.flatMap((entry) => entry.missingIds)).toEqual([
      'mid-word-yes',
      'broken-refrain-1',
      'broken-refrain-2',
    ]);

    expect((await session.displayAnnotation(clampedLongHighlight)).status).toBe('displayed');
    expect(await session.displayAnnotation(midWordShortHighlight)).toEqual({ status: 'missing' });
    expect(await session.displayAnnotation(brokenRefrainOne)).toEqual({ status: 'missing' });
    expect(await session.displayAnnotation(brokenRefrainTwo)).toEqual({ status: 'missing' });
  });
});
