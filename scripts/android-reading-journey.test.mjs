import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEpubArchive } from '../src/lib/downloads/epub-validation';
import {
  chapterIsolated,
  createJourneyEpub,
  installCspMonitor,
  startFixture,
  styledChapter,
} from './android-reading-journey.mjs';

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.close();
  }
});

function createJourneyWindow({
  chapter = 1,
  dpr = 1,
  headingBorderWidth = '2px',
  headingBorderColor = 'rgb(180, 83, 9)',
  headingFontFamily = "'TurnleafSample', Georgia, serif",
  leadBorderWidth = '3px',
  leadBorderColor = 'rgb(180, 83, 9)',
  fontStatus = 'loaded',
  csp = "default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; img-src 'self' data: blob:",
  bodyHtml = '',
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const heading = { textContent: `Chapter ${chapter}` };
  const lead = {};
  const metaCsp = { getAttribute: (name) => (name === 'content' ? csp : null) };
  const load = vi.fn().mockResolvedValue([]);
  const fonts = Object.assign([{ family: "'TurnleafSample'", status: fontStatus }], {
    ready: Promise.resolve(),
    load,
  });
  const contentDocument = {
    fonts,
    documentElement: {
      outerHTML: `<html><head></head><body><h1>Chapter ${chapter}</h1>${bodyHtml}</body></html>`,
    },
    querySelector: (selector) => {
      if (selector === 'h1') return heading;
      if (selector === 'p.lead') return lead;
      if (selector === 'meta[http-equiv="Content-Security-Policy"]') return metaCsp;
      return null;
    },
  };
  const contentWindow = {
    devicePixelRatio: dpr,
    getComputedStyle: (element) => {
      if (element === heading) {
        return {
          borderBottomWidth: headingBorderWidth,
          borderBottomColor: headingBorderColor,
          fontFamily: headingFontFamily,
        };
      }
      return {
        borderLeftWidth: leadBorderWidth,
        borderLeftColor: leadBorderColor,
      };
    },
  };
  const frame = window.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  Object.defineProperty(frame, 'contentDocument', { value: contentDocument });
  Object.defineProperty(frame, 'contentWindow', { value: contentWindow });
  window.document.body.appendChild(frame);
  return window;
}

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

  it('builds a valid styled EPUB containing hostile subresource and escaped CSS vectors and records leaks', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const epub = createJourneyEpub(`http://127.0.0.1:${fixture.port}/hostile`);
    await expect(
      validateEpubArchive(epub.length, async (offset, length) =>
        epub.subarray(offset, offset + length),
      ),
    ).resolves.toBeUndefined();

    const archiveText = epub.toString('utf8');
    expect(archiveText).toContain('TurnleafSample');
    expect(archiveText).toContain('/hostile/img-src.png');
    expect(archiveText).toContain('/hostile/img-srcset.png');
    expect(archiveText).toContain('/hostile/svg-image.png');
    expect(archiveText).toContain('/hostile/video-poster.png');
    expect(archiveText).toContain('/hostile/inline-bg.png');
    expect(archiveText).toContain('/hostile/packaged-bg.png');
    expect(archiveText).toContain('/hostile/packaged-import.css');
    expect(archiveText).toContain('/hostile/escaped-packaged-import.css');
    expect(archiveText).toContain('/hostile/escaped-bg.png');
    expect(fixture.hostileRequests).toEqual([]);

    const simulatedLeak = await fetch(`http://127.0.0.1:${fixture.port}/hostile/img-src.png`);
    expect(simulatedLeak.status).toBe(204);
    expect(fixture.hostileRequests).toEqual(['/hostile/img-src.png']);
  });
});

describe('Android reading journey styledChapter and chapterIsolated probes', () => {
  it('accepts integer-DPR and Pixel 6 fractional-DPR snapped border widths and isolated chapters', async () => {
    const pixel6Window = createJourneyWindow({
      chapter: 1,
      dpr: 2.625,
      headingBorderWidth: '1.90476px',
      leadBorderWidth: '2.66667px',
    });
    expect(await pixel6Window.eval(styledChapter(1))).toBe(true);
    expect(pixel6Window.eval(chapterIsolated(1))).toBe(true);

    const desktopWindow = createJourneyWindow({
      chapter: 2,
      dpr: 1,
      headingBorderWidth: '2px',
      leadBorderWidth: '3px',
    });
    expect(await desktopWindow.eval(styledChapter(2))).toBe(true);
    expect(desktopWindow.eval(chapterIsolated(2))).toBe(true);
  });

  it('rejects unstyled borders, mismatched colors, or surviving /hostile/ references', async () => {
    const unstyledWindow = createJourneyWindow({
      chapter: 1,
      dpr: 2.625,
      headingBorderWidth: '0px',
      leadBorderWidth: '0px',
    });
    expect(await unstyledWindow.eval(styledChapter(1))).toBe(false);

    const wrongColorWindow = createJourneyWindow({
      chapter: 1,
      dpr: 2.625,
      headingBorderWidth: '1.90476px',
      leadBorderWidth: '2.66667px',
      headingBorderColor: 'rgb(0, 0, 0)',
    });
    expect(await wrongColorWindow.eval(styledChapter(1))).toBe(false);

    const leakedMarkupWindow = createJourneyWindow({
      chapter: 1,
      bodyHtml: '<img src="http://127.0.0.1:9999/hostile/img-src.png" />',
    });
    expect(leakedMarkupWindow.eval(chapterIsolated(1))).toBe(false);
  });

  it('surfaces unexpected CSP violations while recording blocked hostile base-uri probes separately', async () => {
    const window = createJourneyWindow();
    window.eval(installCspMonitor);

    const hostileBlock = new window.Event('securitypolicyviolation');
    Object.assign(hostileBlock, {
      effectiveDirective: 'base-uri',
      blockedURI: 'http://127.0.0.1:12345/hostile/base/',
    });
    window.document.dispatchEvent(hostileBlock);
    const hostileInlineHandlerBlock = new window.Event('securitypolicyviolation');
    Object.assign(hostileInlineHandlerBlock, {
      effectiveDirective: 'script-src-attr',
      blockedURI: 'inline',
    });
    window.document.dispatchEvent(hostileInlineHandlerBlock);
    expect(await window.eval(styledChapter(1))).toBe(true);

    const localViolation = new window.Event('securitypolicyviolation');
    Object.assign(localViolation, {
      effectiveDirective: 'style-src-elem',
      blockedURI: 'blob',
    });
    window.document.dispatchEvent(localViolation);

    await expect(window.eval(styledChapter(1))).rejects.toThrow(
      'CSP violations: style-src-elem:blob',
    );
  });
});
