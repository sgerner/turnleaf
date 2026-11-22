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
import { ReaderSession, type ReaderLocation, type ReaderLocationOrigin } from './session';

async function settleFrames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

describe('ReaderSession viewport resize and relocation race protection (real epubjs)', () => {
  const books = new Map<string, Uint8Array>();
  let server: Server;
  let baseUrl = '';
  let restoreDom: (() => void) | null = null;
  let activeSessions: ReaderSession[] = [];
  let resizeListeners: ResizeObserverCallback[] = [];

  beforeAll(async () => {
    books.set(
      'two-chapters.epub',
      buildTestEpub([
        {
          id: 'ch1',
          href: 'chapter-1.xhtml',
          title: 'Chapter 1',
          body: '<h1>Chapter 1</h1><p data-page="0">Opening passage in chapter one.</p>',
        },
        {
          id: 'ch2',
          href: 'chapter-2.xhtml',
          title: 'Chapter 2',
          body: '<h1>Chapter 2</h1><p data-page="0">Second chapter passage restored offline.</p>',
        },
      ]),
    );

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
    resizeListeners = [];
    class ControllableResizeObserver {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeListeners.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        resizeListeners = resizeListeners.filter((entry) => entry !== this.callback);
      }
    }
    globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;
    window.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;
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

  function triggerResize(width: number, height: number): void {
    for (const callback of [...resizeListeners]) {
      callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
    }
    window.dispatchEvent(new Event('resize'));
  }

  function renderedHeading(viewport: HTMLElement): string | null {
    for (const frame of viewport.querySelectorAll('iframe')) {
      const heading = frame.contentDocument?.querySelector('h1')?.textContent ?? null;
      if (heading) return heading;
    }
    return null;
  }

  function trackSession(url: string): ReaderSession {
    const session = new ReaderSession(url);
    activeSessions.push(session);
    return session;
  }

  it('defers viewport resizes arriving before rendition.started without throwing or losing the chapter', async () => {
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/two-chapters.epub`);
    const events: Array<{ location: ReaderLocation; origin: ReaderLocationOrigin }> = [];

    const openPromise = session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      (location, origin) => events.push({ location, origin }),
      () => {},
    );

    // Resize arrives synchronously while rendition.started and archive loading are still in flight.
    expect(() => triggerResize(TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT + 48)).not.toThrow();

    await openPromise;
    await settleFrames();

    expect(renderedHeading(viewport)).toBe('Chapter 1');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.origin).toBe('restore');
  });

  it('keeps the restored chapter rendered when immersive chrome resizes before reportLocation rAF runs', async () => {
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/two-chapters.epub`);
    const locations: ReaderLocation[] = [];

    // Open with a saved CFI in Chapter 2 (mirroring offline app restart in android-reading-journey).
    await session.open(
      viewport,
      'epubcfi(/6/4!/4/2/1:0)',
      '//body/DocFragment[2]/body/h1[1]',
      0.5,
      defaultAppearance,
      (location) => locations.push(location),
      () => {},
    );

    // Immediately after open() resolves, the iframe is rendered but reportLocation's rAF has not run yet.
    expect(renderedHeading(viewport)).toBe('Chapter 2');
    triggerResize(TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT + 48);

    // Must not wipe the rendered iframe while rendition.location is still pending its animation frame.
    expect(renderedHeading(viewport)).toBe('Chapter 2');

    await settleFrames();

    expect(renderedHeading(viewport)).toBe('Chapter 2');
    expect(locations.at(-1)?.href).toContain('chapter-2.xhtml');
  });

  it('preserves navigation origin and target chapter when next() and resize race initial relocation', async () => {
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/two-chapters.epub`);
    const events: Array<{ location: ReaderLocation; origin: ReaderLocationOrigin }> = [];

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      (location, origin) => events.push({ location, origin }),
      () => {},
    );

    // Advance immediately before Chapter 1's reportLocation rAF has fired until Chapter 2 renders,
    // then fire a viewport resize before Chapter 2's reportLocation rAF runs.
    await session.next();
    if (renderedHeading(viewport) !== 'Chapter 2') {
      await session.next();
    }
    expect(renderedHeading(viewport)).toBe('Chapter 2');
    triggerResize(TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT + 48);

    await settleFrames();

    expect(renderedHeading(viewport)).toBe('Chapter 2');
    expect(events[0]?.origin).toBe('restore');
    const navigationEvents = events.filter((entry) => entry.origin === 'navigation');
    expect(navigationEvents.length).toBeGreaterThan(0);
    expect(navigationEvents.at(-1)?.location.href).toContain('chapter-2.xhtml');
    expect(navigationEvents.at(-1)?.location.percentage).toBeGreaterThanOrEqual(0.5);
  });

  it('does not revert to Chapter 1 when a resize arrives immediately after navigating to Chapter 2', async () => {
    const viewport = createViewport();
    const session = trackSession(`${baseUrl}/two-chapters.epub`);
    const events: Array<{ location: ReaderLocation; origin: ReaderLocationOrigin }> = [];

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      (location, origin) => events.push({ location, origin }),
      () => {},
    );

    // Jump to chapter-2 immediately after open() (before Chapter 1's rAF), then resize before Chapter 2's rAF.
    await session.display('chapter-2.xhtml');
    expect(renderedHeading(viewport)).toBe('Chapter 2');
    triggerResize(TEST_PAGE_WIDTH, TEST_PAGE_HEIGHT + 48);

    await settleFrames();

    expect(renderedHeading(viewport)).toBe('Chapter 2');
    expect(events[0]?.origin).toBe('restore');
    const navigationEvents = events.filter((entry) => entry.origin === 'navigation');
    expect(navigationEvents.at(-1)?.location.href).toContain('chapter-2.xhtml');
  });
});
