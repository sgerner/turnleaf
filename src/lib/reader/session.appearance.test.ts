// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import { contrastRatio, parseCssColor } from './color-contrast';

const { mockBook, mockRendition, mockContentsList } = vi.hoisted(() => {
  const contentsList: Array<{ document: Document; sectionIndex?: number }> = [];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    getContents: vi.fn(() => contentsList),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: {
      each: vi.fn((visit: (section: { href: string }) => void) => {
        visit({ href: 'chapter-1.xhtml' });
      }),
    },
    navigation: { toc: [] },
  };
  return { mockBook: book, mockRendition: rendition, mockContentsList: contentsList };
});

vi.mock('epubjs', () => ({ default: vi.fn(() => mockBook) }));

import { ReaderSession } from './session';

function setRootThemeTokens(tokens: Record<string, string>, theme = 'cerberus'): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.removeAttribute('style');
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
}

describe('ReaderSession appearance, link contrast, and theme reactivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContentsList.length = 0;
    document.documentElement.removeAttribute('style');
    document.documentElement.dataset.theme = 'cerberus';
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
  });

  it('registers persistent link underlines and clamps low-contrast theme links to >= 4.5:1', async () => {
    setRootThemeTokens(
      {
        '--color-surface-50': '#f8fafc',
        '--color-surface-950': '#0f172a',
        // Deliberately pale primary-700 (~1.3:1 on #f8fafc) to verify clamping.
        '--color-primary-700': '#cbd5e1',
        '--color-primary-600': '#e2e8f0',
        '--color-primary-200': '#dbeafe',
      },
      'reign',
    );

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      { ...defaultAppearance, mode: 'light' },
      vi.fn(),
      vi.fn(),
    );

    const registeredRules = mockRendition.themes.register.mock.calls.at(-1)?.[1] as Record<
      string,
      Record<string, string>
    >;
    expect(registeredRules).toBeDefined();
    expect(registeredRules.a?.['text-decoration']).toBe('underline !important');
    expect(registeredRules.a?.['text-decoration-line']).toBe('underline !important');
    expect(registeredRules['a:link, a:visited, a:hover, a:active']?.['text-decoration-line']).toBe(
      'underline !important',
    );
    expect(registeredRules['a:focus-visible']?.outline).toContain('3px solid');
    expect(registeredRules['a:focus-visible']?.['box-shadow']).toContain('0 0 0 2px');

    const bgHex = registeredRules.body?.background?.replace(' !important', '') ?? '';
    const linkHex = registeredRules.a?.color?.replace(' !important', '') ?? '';
    const bg = parseCssColor(bgHex)!;
    const link = parseCssColor(linkHex)!;
    expect(contrastRatio(link, bg)).toBeGreaterThanOrEqual(4.5);

    session.destroy();
  });

  it('re-applies EPUB theme and highlight SVG styles when appearance.mode or root data-theme changes', async () => {
    const injectedDoc = document.implementation.createHTMLDocument('chapter');
    const injectedStyle = injectedDoc.createElement('style');
    injectedStyle.id = 'epubjs-inserted-css-turnleaf';
    injectedStyle.textContent = 'body { color: red; }';
    injectedDoc.head.append(injectedStyle);
    mockContentsList.push({ document: injectedDoc, sectionIndex: 0 });

    setRootThemeTokens(
      {
        '--color-surface-50': '#ffffff',
        '--color-surface-950': '#111827',
        '--color-primary-700': '#1d4ed8',
        '--color-primary-600': '#2563eb',
        '--color-primary-400': '#60a5fa',
        '--color-primary-300': '#93c5fd',
      },
      'cerberus',
    );

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      { ...defaultAppearance, mode: 'light' },
      vi.fn(),
      vi.fn(),
    );

    const cfi = 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:12)';
    session.updateHighlights([{ cfi }]);
    expect(mockRendition.annotations.highlight).toHaveBeenCalledTimes(1);
    const lightHighlight = mockRendition.annotations.highlight.mock.calls[0]?.[4] as Record<
      string,
      string
    >;

    mockRendition.display.mockClear();

    // Switch reading mode from light -> dark without changing layout metrics.
    session.applyAppearance({ ...defaultAppearance, mode: 'dark' });

    expect(injectedStyle.textContent).toBe('');
    expect(mockRendition.themes.register).toHaveBeenCalledTimes(2);
    expect(mockRendition.annotations.remove).toHaveBeenCalledWith(cfi, 'highlight');
    expect(mockRendition.annotations.highlight).toHaveBeenCalledTimes(2);
    // Color-only updates should not trigger pagination reflow navigation.
    expect(mockRendition.display).not.toHaveBeenCalled();

    const darkHighlight = mockRendition.annotations.highlight.mock.calls[1]?.[4] as Record<
      string,
      string
    >;
    expect(darkHighlight['mix-blend-mode']).toBe('normal');
    expect(darkHighlight).not.toEqual(lightHighlight);

    // Mutate root data-theme (e.g. switching to eink) and verify MutationObserver refreshes both theme & highlights.
    setRootThemeTokens(
      {
        '--color-surface-50': '#ffffff',
        '--color-surface-950': '#000000',
        '--color-primary-700': '#1f1f1f',
        '--color-primary-600': '#363636',
        '--color-primary-400': '#737373',
        '--color-primary-300': '#999999',
      },
      'eink',
    );
    await Promise.resolve();

    expect(mockRendition.themes.register).toHaveBeenCalledTimes(3);
    expect(mockRendition.annotations.highlight).toHaveBeenCalledTimes(3);

    const registerCountBeforeDestroy = mockRendition.themes.register.mock.calls.length;
    session.destroy();

    setRootThemeTokens({ '--color-surface-950': '#1a1a1a' }, 'mint');
    await Promise.resolve();
    expect(mockRendition.themes.register).toHaveBeenCalledTimes(registerCountBeforeDestroy);
  });
});
