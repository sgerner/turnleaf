// @vitest-environment jsdom

import type { Location } from 'epubjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ReaderSession } from './session';

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('scopes Tab order to visible columns without aria-hidden or inert and restores tabindex on destroy', async () => {
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400));
    const frameRect = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 900, 400));

    await session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn());
    const prepareContents = rendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];

    const doc = document.implementation.createHTMLDocument('chapter');
    const firstPageLink = doc.createElement('a');
    firstPageLink.setAttribute('href', '#note-1');
    firstPageLink.textContent = 'First page note';
    vi.spyOn(firstPageLink, 'getClientRects').mockReturnValue([
      new DOMRect(40, 30, 80, 18),
    ] as unknown as DOMRectList);

    const wrappingLink = doc.createElement('a');
    wrappingLink.setAttribute('href', '#note-wrap');
    wrappingLink.setAttribute('tabindex', '0');
    wrappingLink.textContent = 'Wrapping link';
    vi.spyOn(wrappingLink, 'getClientRects').mockReturnValue([
      new DOMRect(240, 360, 56, 18),
      new DOMRect(312, 20, 64, 18),
    ] as unknown as DOMRectList);

    const thirdPageLink = doc.createElement('a');
    thirdPageLink.setAttribute('href', '#note-3');
    thirdPageLink.textContent = 'Third page note';
    vi.spyOn(thirdPageLink, 'getClientRects').mockReturnValue([
      new DOMRect(640, 50, 90, 18),
    ] as unknown as DOMRectList);

    doc.body.append(firstPageLink, wrappingLink, thirdPageLink);
    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: () => 'cfi',
    });

    // Page 1 (0..300): firstPageLink and wrappingLink are visible; thirdPageLink is off-screen.
    expect(firstPageLink.getAttribute('tabindex')).toBeNull();
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(thirdPageLink.getAttribute('tabindex')).toBe('-1');
    expect(thirdPageLink.getAttribute('data-turnleaf-tabindex')).toBe('');
    expect(thirdPageLink.hasAttribute('aria-hidden')).toBe(false);
    expect(thirdPageLink.hasAttribute('inert')).toBe(false);

    // Page 2 (300..600): wrappingLink stays tabbable across the column break; firstPageLink becomes -1.
    frameRect.mockReturnValue(new DOMRect(-300, 0, 900, 400));
    container.scrollLeft = 300;
    relocated(location('page-2-cfi'));

    expect(firstPageLink.getAttribute('tabindex')).toBe('-1');
    expect(firstPageLink.getAttribute('data-turnleaf-tabindex')).toBe('');
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(wrappingLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
    expect(thirdPageLink.getAttribute('tabindex')).toBe('-1');

    // Page 3 (600..900): wrappingLink becomes -1 (preserving original tabindex="0"); thirdPageLink restores.
    frameRect.mockReturnValue(new DOMRect(-600, 0, 900, 400));
    container.scrollLeft = 600;
    relocated(location('page-3-cfi'));

    expect(wrappingLink.getAttribute('tabindex')).toBe('-1');
    expect(wrappingLink.getAttribute('data-turnleaf-tabindex')).toBe('0');
    expect(thirdPageLink.getAttribute('tabindex')).toBeNull();
    expect(thirdPageLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);

    session.destroy();
    expect(firstPageLink.getAttribute('tabindex')).toBeNull();
    expect(firstPageLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
    expect(wrappingLink.getAttribute('tabindex')).toBe('0');
    expect(wrappingLink.hasAttribute('data-turnleaf-tabindex')).toBe(false);
  });

  it('locks scrollLeft to the active stride and navigates on off-screen link focus', async () => {
    const onLocation = vi.fn();
    const session = new ReaderSession('book.epub');
    const viewport = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'epub-container';
    const frame = document.createElement('iframe');
    container.append(frame);
    viewport.append(container);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 366, 600));
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 366, 600));
    const frameRect = vi
      .spyOn(frame, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 1464, 600));

    await session.open(viewport, null, null, null, defaultAppearance, onLocation, vi.fn());
    const prepareContents = rendition.hooks.content.register.mock.calls[0]?.[0];
    const relocated = rendition.on.mock.calls.find(([name]) => name === 'relocated')?.[1];

    const doc = document.implementation.createHTMLDocument('chapter');
    const wrappingLink = doc.createElement('a');
    wrappingLink.setAttribute('href', '#wrap');
    wrappingLink.textContent = 'Wrapping column link';
    vi.spyOn(wrappingLink, 'getClientRects').mockReturnValue([
      new DOMRect(280, 560, 80, 18),
      new DOMRect(390, 20, 70, 18),
    ] as unknown as DOMRectList);

    const offscreenLink = doc.createElement('a');
    offscreenLink.setAttribute('href', '#later');
    offscreenLink.textContent = 'Later chapter link';
    vi.spyOn(offscreenLink, 'getClientRects').mockReturnValue([
      new DOMRect(1050, 80, 110, 18),
    ] as unknown as DOMRectList);

    doc.body.append(wrappingLink, offscreenLink);
    await prepareContents({
      window: { frameElement: frame },
      document: doc,
      sectionIndex: 0,
      cfiFromRange: (range: Range) =>
        range.toString().includes('Later')
          ? 'epubcfi(/6/2!/4/4/1:0,/1:0,/1:18)'
          : 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:20)',
    });

    container.scrollLeft = 0;
    relocated(location('page-1-cfi'));
    rendition.display.mockClear();

    // Browser focus nudging scrollLeft on a wrapping link snaps back to active stride (0) without navigating.
    container.scrollLeft = 134;
    wrappingLink.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    container.dispatchEvent(new Event('scroll'));
    expect(container.scrollLeft).toBe(0);
    expect(rendition.display).not.toHaveBeenCalled();

    // Focusing an off-screen link (e.g. TalkBack/VoiceOver link list) snaps scrollLeft and calls display(cfi) via navigate.
    rendition.display.mockImplementationOnce(async () => {
      container.scrollLeft = 732;
      frameRect.mockReturnValue(new DOMRect(-732, 0, 1464, 600));
      relocated({
        start: {
          cfi: 'epubcfi(/6/2!/4/4/1:0)',
          href: 'chapter.xhtml',
          index: 0,
          percentage: 0.5,
          displayed: { page: 3, total: 4 },
        },
      } as Location);
    });

    container.scrollLeft = 1023;
    offscreenLink.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await vi.waitFor(() => {
      expect(rendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/4/1:0,/1:0,/1:18)');
    });

    expect(container.scrollLeft).toBe(732);
    expect(offscreenLink.getAttribute('tabindex')).toBeNull();
    expect(onLocation.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        cfi: 'epubcfi(/6/2!/4/4/1:0)',
        pageIndex: 2,
        pageCount: 4,
      }),
    );
    expect(onLocation.mock.calls.at(-1)?.[1]).toBe('navigation');

    session.destroy();
  });
});
