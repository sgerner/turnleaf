import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { installCspMonitor, styledChapter } from './android-reading-journey.mjs';

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
