import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCspMonitor, startFixture, styledChapter } from './android-reading-journey.mjs';

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
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const heading = { textContent: `Chapter ${chapter}` };
  const lead = {};
  const load = vi.fn().mockResolvedValue([]);
  const fonts = Object.assign([{ family: "'TurnleafSample'", status: fontStatus }], {
    ready: Promise.resolve(),
    load,
  });
  const contentDocument = {
    fonts,
    querySelector: (selector) => {
      if (selector === 'h1') return heading;
      if (selector === 'p.lead') return lead;
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
});

describe('Android reading journey styledChapter probe', () => {
  it('accepts integer-DPR and Pixel 6 fractional-DPR snapped border widths', async () => {
    const pixel6Window = createJourneyWindow({
      chapter: 1,
      dpr: 2.625,
      headingBorderWidth: '1.90476px',
      leadBorderWidth: '2.66667px',
    });
    expect(await pixel6Window.eval(styledChapter(1))).toBe(true);

    const desktopWindow = createJourneyWindow({
      chapter: 2,
      dpr: 1,
      headingBorderWidth: '2px',
      leadBorderWidth: '3px',
    });
    expect(await desktopWindow.eval(styledChapter(2))).toBe(true);
  });

  it('rejects unstyled or mismatched border widths and colors', async () => {
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
  });

  it('surfaces recorded CSP violations immediately', async () => {
    const window = createJourneyWindow();
    window.eval(installCspMonitor);
    const violation = new window.Event('securitypolicyviolation');
    Object.assign(violation, {
      effectiveDirective: 'style-src-elem',
      blockedURI: 'blob',
    });
    window.document.dispatchEvent(violation);

    await expect(window.eval(styledChapter(1))).rejects.toThrow(
      'CSP violations: style-src-elem:blob',
    );
  });
});
