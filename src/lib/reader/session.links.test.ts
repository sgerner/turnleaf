// @vitest-environment jsdom

import type { Location } from 'epubjs';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';

const { book, rendition } = vi.hoisted(() => {
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string; index: number }) => void) => {
        visit({ href: 'chapter.xhtml', index: 0 });
      }),
    },
  };
  return { book, rendition };
});

vi.mock('epubjs', () => ({ default: () => book }));

import {
  parseExternalLink,
  ReaderSession,
  sanitizeEpubDocument,
  validateExternalBrowserUrl,
  validateExternalLaunchUrl,
} from './session';

function location(cfi: string): Location {
  return {
    start: {
      cfi,
      href: 'chapter.xhtml',
      index: 0,
      percentage: 0.2,
      displayed: { page: 2, total: 10 },
    },
  } as Location;
}

describe('ReaderSession internal links', () => {
  it('reports link jumps with a one-tap return location and does not retain stale origins', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      vi.fn(),
    );
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];
    const click = rendition.on.mock.calls.find(([name]) => name === 'click')?.[1];
    const contents = {
      window: { getSelection: () => ({ isCollapsed: true }) },
    };
    const source = location('source-cfi');
    const destination = location('destination-cfi');
    relocated(source);

    const internalLink = document.createElement('a');
    internalLink.setAttribute('href', '#footnote');
    click({ target: internalLink, clientX: 100 }, contents);
    relocated(destination);

    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'source-cfi',
      href: 'chapter.xhtml',
    });

    const externalLink = document.createElement('a');
    externalLink.setAttribute('href', 'https://example.org');
    click({ target: externalLink, clientX: 100 }, contents);
    relocated(location('later-cfi'));

    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('restore');
    expect(onLocation.mock.calls.at(-1)).toHaveLength(2);
    session.destroy();
  });

  it('validates http, https, and mailto URLs while rejecting unsafe or credentialed links', () => {
    expect(parseExternalLink('https://example.org/docs?q=1')).toEqual({
      href: 'https://example.org/docs?q=1',
      scheme: 'https:',
    });
    expect(parseExternalLink('http://example.org/page')).toEqual({
      href: 'http://example.org/page',
      scheme: 'http:',
    });
    expect(parseExternalLink('mailto:reader@example.org?subject=Note')).toEqual({
      href: 'mailto:reader@example.org?subject=Note',
      scheme: 'mailto:',
    });

    expect(parseExternalLink('https://user:pass@example.org/')).toBeNull();
    expect(parseExternalLink('javascript:alert(1)')).toBeNull();
    expect(parseExternalLink('file:///etc/passwd')).toBeNull();
    expect(parseExternalLink('//evil.example/path')).toBeNull();
    expect(parseExternalLink('mailto:not-an-email')).toBeNull();
    expect(parseExternalLink('https://example.org/%E0%A4%A')).toBeNull();

    expect(validateExternalBrowserUrl('https://example.org/ref')).toBe('https://example.org/ref');
    expect(validateExternalBrowserUrl('mailto:reader@example.org')).toBeNull();
    expect(validateExternalLaunchUrl('mailto:reader@example.org')).toBe(
      'mailto:reader@example.org',
    );
  });

  it('routes sanitized external links, hidden EPUB 3 footnotes, and chapter figures to inspectors while preserving visible section jumps', async () => {
    vi.clearAllMocks();
    const onLocation = vi.fn();
    const onTap = vi.fn();
    const onExternalLink = vi.fn();
    const onFootnote = vi.fn();
    const onFigure = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 640));

    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      onLocation,
      onTap,
      undefined,
      undefined,
      { onExternalLink, onFootnote, onFigure },
    );

    const registeredTheme = rendition.themes.register.mock.calls.at(-1)?.[1] as Record<
      string,
      Record<string, string>
    >;
    expect(registeredTheme['a[href], a[data-turnleaf-external-href]']).toMatchObject({
      'text-decoration': 'underline !important',
    });
    expect(registeredTheme['a:not([href]):not([data-turnleaf-external-href])']).toMatchObject({
      color: 'inherit !important',
      'text-decoration': 'none !important',
    });

    const hardenHook = rendition.hooks.content.register.mock.calls[0]?.[0] as (
      contents: unknown,
    ) => Promise<void>;
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];

    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <p>
          <a id="ext" href="https://example.org/reference">Reference site</a>
          <a id="mail" href="mailto:author@example.org">Email author</a>
          <a id="unsafe" href="javascript:alert(1)">Unsafe prose</a>
          <a id="noteref" epub:type="noteref" href="#fn-1">[1]</a>
          <a id="jump" href="#part-2">Jump to section</a>
        </p>
        <h2 id="part-2">Part Two</h2>
        <aside id="fn-1" epub:type="footnote" hidden>
          <p><a epub:type="backlink" href="#noteref">↩</a> Clarifying footnote text without leaving the page.</p>
        </aside>
        <figure>
          <img id="chart" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt=" Orbit diagram " />
          <figcaption>Figure 1: Orbital eccentricity across epochs.</figcaption>
        </figure>
        <figure>
          <svg id="vector" width="240" height="120" xmlns="http://www.w3.org/2000/svg">
            <title>Phase plot</title>
            <path d="M 0 0 L 120 60" stroke="currentColor" />
          </svg>
          <figcaption>Figure 2: Phase trajectory.</figcaption>
        </figure>
        <figure>
          <svg id="wrapped-bitmap" viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
            <image href="blob:http://localhost/diagram-bitmap" width="800" height="600" />
          </svg>
          <figcaption>Figure 3: Wrapped bitmap diagram.</figcaption>
        </figure>
      </body></html>`,
      'text/html',
    );

    const contents = {
      document: doc,
      window: {
        getSelection: () => ({ isCollapsed: true }),
      },
      sectionIndex: 0,
    };
    await hardenHook(contents);
    relocated(location('source-cfi'));

    const ext = doc.getElementById('ext')!;
    expect(ext.hasAttribute('href')).toBe(false);
    expect(ext.getAttribute('role')).toBe('link');
    expect(ext.getAttribute('tabindex')).toBe('0');
    expect(ext.getAttribute('data-turnleaf-external-href')).toBe('https://example.org/reference');

    const unsafe = doc.getElementById('unsafe')!;
    expect(unsafe.hasAttribute('href')).toBe(false);
    expect(unsafe.hasAttribute('role')).toBe(false);
    expect(unsafe.hasAttribute('tabindex')).toBe(false);
    expect(unsafe.hasAttribute('data-turnleaf-external-href')).toBe(false);

    ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onExternalLink).toHaveBeenCalledExactlyOnceWith(
      {
        href: 'https://example.org/reference',
        scheme: 'https:',
        label: 'Reference site',
      },
      ext,
    );

    const mail = doc.getElementById('mail')!;
    mail.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(onExternalLink).toHaveBeenLastCalledWith(
      {
        href: 'mailto:author@example.org',
        scheme: 'mailto:',
        label: 'Email author',
      },
      mail,
    );

    const noteref = doc.getElementById('noteref')!;
    let epubDefaultClickRan = false;
    noteref.addEventListener('click', () => {
      epubDefaultClickRan = true;
    });
    noteref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(epubDefaultClickRan).toBe(false);
    expect(onFootnote).toHaveBeenCalledExactlyOnceWith(
      {
        title: 'Footnote 1',
        paragraphs: ['Clarifying footnote text without leaving the page.'],
      },
      noteref,
    );

    const chart = doc.getElementById('chart')!;
    expect(chart.getAttribute('role')).toBe('button');
    expect(chart.getAttribute('tabindex')).toBe('0');
    chart.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onFigure).toHaveBeenCalledExactlyOnceWith(
      {
        src: expect.stringContaining('data:image/png;base64,'),
        alt: 'Orbit diagram',
        caption: 'Figure 1: Orbital eccentricity across epochs.',
      },
      chart,
    );

    const vector = doc.getElementById('vector')!;
    expect(vector.getAttribute('role')).toBe('button');
    vector.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(onFigure).toHaveBeenLastCalledWith(
      {
        src: expect.stringContaining('data:image/svg+xml;charset=utf-8,'),
        alt: 'Phase plot',
        caption: 'Figure 2: Phase trajectory.',
      },
      vector,
    );

    const wrappedBitmap = doc.getElementById('wrapped-bitmap')!;
    expect(wrappedBitmap.getAttribute('role')).toBe('button');
    wrappedBitmap.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onFigure).toHaveBeenLastCalledWith(
      {
        src: 'blob:http://localhost/diagram-bitmap',
        alt: 'Figure 3: Wrapped bitmap diagram.',
        caption: 'Figure 3: Wrapped bitmap diagram.',
      },
      wrappedBitmap,
    );

    // Visible non-footnote internal link still navigates normally with Return to link tracking
    const click = rendition.on.mock.calls.find(([name]) => name === 'click')?.[1];
    const jump = doc.getElementById('jump')!;
    click({ target: jump, clientX: 120 }, contents);
    relocated(location('part-2-cfi'));
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('link');
    expect(onLocation.mock.calls.at(-1)?.[2]).toEqual({
      cfi: 'source-cfi',
      href: 'chapter.xhtml',
    });
    expect(onTap).not.toHaveBeenCalled();

    await sanitizeEpubDocument(doc);
    session.destroy();
  });
});
