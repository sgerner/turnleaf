// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReaderSessionModule from '../reader/session';
import type {
  ReaderHighlightAnnotation,
  ReaderInspectorCallbacks,
  ReaderLocation,
  ReaderLocationOrigin,
  ReaderLinkReturnTarget,
  ReaderSelection,
} from '../reader/session';

const { sessionMock, preferencesStore } = vi.hoisted(() => {
  const preferencesStore = new Map<string, string>();
  const sessionMock = {
    inspectors: {} as ReaderInspectorCallbacks,
    onLocation: null as
      | ((
          location: ReaderLocation,
          origin: ReaderLocationOrigin,
          returnTarget?: ReaderLinkReturnTarget,
        ) => void)
      | null,
    onTap: null as ((zone: 'previous' | 'center' | 'next') => void) | null,
    onSelection: null as ((selection: ReaderSelection | null) => void) | null,
    onKeyboard: null as ((event: KeyboardEvent) => void) | null,
    visiblePassages: [] as ReaderSelection[],
    lastHighlights: [] as ReaderHighlightAnnotation[],
    lastAppearanceFontSize: 18,
    open: vi.fn(
      async (
        _target: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        appearance: { fontSize: number },
        onLocation: typeof sessionMock.onLocation,
        onTap: typeof sessionMock.onTap,
        onSelection?: typeof sessionMock.onSelection,
        onKeyboard?: typeof sessionMock.onKeyboard,
        inspectors: ReaderInspectorCallbacks = {},
      ) => {
        sessionMock.lastAppearanceFontSize = appearance.fontSize;
        sessionMock.onLocation = onLocation;
        sessionMock.onTap = onTap;
        sessionMock.onSelection = onSelection ?? null;
        sessionMock.onKeyboard = onKeyboard ?? null;
        sessionMock.inspectors = inspectors;
      },
    ),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    display: vi.fn(async () => {}),
    displayCfi: vi.fn(async () => true),
    applyAppearance: vi.fn((appearance: { fontSize: number }) => {
      sessionMock.lastAppearanceFontSize = appearance.fontSize;
    }),
    tableOfContents: vi.fn(() => [{ label: 'Chapter 1', href: 'ch1.xhtml', children: [] }]),
    updateHighlights: vi.fn((annotations: ReaderHighlightAnnotation[]) => {
      sessionMock.lastHighlights = annotations;
    }),
    getVisiblePassages: vi.fn(() => sessionMock.visiblePassages),
    search: vi.fn(async () => []),
    destroy: vi.fn(),
  };
  return { sessionMock, preferencesStore };
});

vi.mock('../database/database', () => ({
  getPreferences: vi.fn(async (keys: string[]) => {
    const result = new Map<string, string>();
    for (const key of keys) {
      const value = preferencesStore.get(key);
      if (value !== undefined) result.set(key, value);
    }
    return result;
  }),
  setPreferences: vi.fn(async (entries: Map<string, string>) => {
    for (const [key, value] of entries) {
      preferencesStore.set(key, value);
    }
  }),
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderSessionModule>();
  class MockReaderSession {
    open = sessionMock.open;
    next = sessionMock.next;
    previous = sessionMock.previous;
    display = sessionMock.display;
    displayCfi = sessionMock.displayCfi;
    applyAppearance = sessionMock.applyAppearance;
    tableOfContents = sessionMock.tableOfContents;
    updateHighlights = sessionMock.updateHighlights;
    getVisiblePassages = sessionMock.getVisiblePassages;
    search = sessionMock.search;
    destroy = sessionMock.destroy;
  }
  return {
    ...actual,
    ReaderSession: MockReaderSession,
  };
});

import Reader from './Reader.svelte';

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

describe('Reader inspectors, keyboard selection, and Dynamic Type', () => {
  let host: HTMLDivElement;
  let instance: Record<string, unknown> | null = null;
  let backHandler: (() => boolean) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    preferencesStore.clear();
    document.documentElement.style.removeProperty('--turnleaf-text-scale');
    if (typeof Element !== 'undefined') {
      Element.prototype.animate = (() => {
        const anim = {
          finished: Promise.resolve(),
          cancel: () => {},
          onfinish: null as (() => void) | null,
        };
        queueMicrotask(() => anim.onfinish?.());
        return anim as unknown as Animation;
      }) as typeof Element.prototype.animate;
    }
    sessionMock.visiblePassages = [
      {
        cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:34)',
        text: 'First visible passage on this page.',
      },
    ];
    host = document.createElement('div');
    document.body.append(host);
    backHandler = null;
  });

  afterEach(() => {
    if (instance) {
      unmount(instance);
      instance = null;
    }
    host.remove();
    vi.unstubAllGlobals();
  });

  async function mountReader(): Promise<void> {
    instance = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:http://localhost/book.epub',
        bookId: 'book-1',
        title: 'Accessible Orbital Mechanics',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        registerBackHandler: (handler: () => boolean) => {
          backHandler = handler;
          return () => {
            backHandler = null;
          };
        },
      },
    });
    await flushAsync();
  }

  it('keeps the page still on Shift+Arrow keys and lets keyboard users save visible passage notes and reopen highlights', async () => {
    await mountReader();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }),
    );
    expect(sessionMock.next).not.toHaveBeenCalled();
    expect(sessionMock.previous).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(sessionMock.next).toHaveBeenCalledOnce();

    // Reveal controls and open Notes
    const revealBtn = host.querySelector<HTMLButtonElement>('.reader-top-reveal')!;
    revealBtn.click();
    await flushAsync();

    const notesToggle = host.querySelector<HTMLButtonElement>(
      '[aria-controls="reader-annotations"]',
    )!;
    notesToggle.click();
    await flushAsync();

    const annotationsDialog = host.querySelector<HTMLElement>('#reader-annotations');
    expect(annotationsDialog).not.toBeNull();
    const passageButton = Array.from(
      annotationsDialog!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((btn) => btn.textContent?.includes('First visible passage on this page.'));
    expect(passageButton).toBeDefined();

    passageButton!.click();
    await flushAsync();

    const textarea = annotationsDialog!.querySelector<HTMLTextAreaElement>(
      '[data-reader-focus="new-annotation-note"]',
    )!;
    textarea.value = 'Important orbital assumption';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const form = textarea.closest('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await flushAsync();

    expect(sessionMock.lastHighlights).toHaveLength(1);
    expect(sessionMock.lastHighlights[0]).toMatchObject({
      cfi: 'epubcfi(/6/2!/4/2/1:0,/1:0,/1:34)',
      excerpt: 'First visible passage on this page.',
      note: 'Important orbital assumption',
    });

    // Close Notes, then activate the saved highlight overlay button
    backHandler?.();
    await flushAsync();
    expect(host.querySelector('#reader-annotations')).toBeNull();

    const highlightOpener = document.createElement('button');
    host.append(highlightOpener);
    sessionMock.next.mockClear();
    sessionMock.inspectors.onHighlight?.('epubcfi(/6/2!/4/2/1:0,/1:0,/1:34)', highlightOpener);
    await flushAsync();

    expect(sessionMock.next).not.toHaveBeenCalled();
    const reopenedDialog = host.querySelector<HTMLElement>('#reader-annotations');
    expect(reopenedDialog).not.toBeNull();
    expect(reopenedDialog?.textContent).toContain('Important orbital assumption');

    backHandler?.();
    await flushAsync();
    expect(document.activeElement).toBe(highlightOpener);
  });

  it('opens external link, footnote, and figure dialogs and restores focus on Cancel, Escape, and Android Back', async () => {
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await mountReader();

    // 1. External link confirmation dialog
    const linkOpener = document.createElement('a');
    linkOpener.setAttribute('role', 'link');
    linkOpener.tabIndex = 0;
    host.append(linkOpener);

    sessionMock.inspectors.onExternalLink?.(
      {
        href: 'https://example.org/spec',
        scheme: 'https:',
        label: 'EPUB specification',
      },
      linkOpener,
    );
    await flushAsync();

    const extDialog = host.querySelector<HTMLElement>('#reader-external-link');
    expect(extDialog).not.toBeNull();
    expect(extDialog?.textContent).toContain('https://example.org/spec');

    const copyBtn = Array.from(extDialog!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Copy link'),
    )!;
    copyBtn.click();
    await flushAsync();
    expect(writeText).toHaveBeenCalledWith('https://example.org/spec');

    const cancelBtn = Array.from(extDialog!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel'),
    )!;
    cancelBtn.click();
    await flushAsync();
    expect(host.querySelector('#reader-external-link')).toBeNull();
    expect(document.activeElement).toBe(linkOpener);
    expect(openSpy).not.toHaveBeenCalled();

    // Reopen and confirm browser launch
    sessionMock.inspectors.onExternalLink?.(
      {
        href: 'https://example.org/spec',
        scheme: 'https:',
        label: 'EPUB specification',
      },
      linkOpener,
    );
    await flushAsync();
    const launchBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>('#reader-external-link button'),
    ).find((b) => b.textContent?.includes('Open in browser'))!;
    launchBtn.click();
    await flushAsync();
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.org/spec',
      '_blank',
      'noopener,noreferrer',
    );

    // 2. Footnote preview modal + Android Back focus return
    const noterefOpener = document.createElement('a');
    noterefOpener.href = '#fn-1';
    host.append(noterefOpener);

    sessionMock.inspectors.onFootnote?.(
      {
        title: 'Footnote 1',
        paragraphs: ['Hidden EPUB 3 footnote preview text.'],
      },
      noterefOpener,
    );
    await flushAsync();

    const footnoteDialog = host.querySelector<HTMLElement>('#reader-footnote');
    expect(footnoteDialog).not.toBeNull();
    expect(footnoteDialog?.textContent).toContain('Hidden EPUB 3 footnote preview text.');

    expect(backHandler?.()).toBe(true);
    await flushAsync();
    expect(host.querySelector('#reader-footnote')).toBeNull();
    expect(document.activeElement).toBe(noterefOpener);

    // 3. Figure viewer modal with zoom, pan, caption, and Escape focus return
    const figureOpener = document.createElement('img');
    figureOpener.setAttribute('role', 'button');
    figureOpener.tabIndex = 0;
    host.append(figureOpener);

    sessionMock.inspectors.onFigure?.(
      {
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        alt: 'Trajectory diagram',
        caption: 'Figure 4: Apogee transfer ellipse.',
      },
      figureOpener,
    );
    await flushAsync();

    const figureDialog = host.querySelector<HTMLElement>('#reader-figure-viewer');
    expect(figureDialog).not.toBeNull();
    expect(figureDialog?.textContent).toContain('Figure 4: Apogee transfer ellipse.');

    const zoomInBtn = figureDialog!.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
    zoomInBtn.click();
    await flushAsync();
    expect(figureDialog?.textContent).toContain('150%');

    figureDialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    await flushAsync();
    const img = figureDialog!.querySelector('img')!;
    expect(img.style.transform).toContain('scale(1.5)');
    expect(img.style.transform).toContain('translate3d(32px');

    figureDialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushAsync();
    expect(host.querySelector('#reader-figure-viewer')).toBeNull();
    expect(document.activeElement).toBe(figureOpener);

    // 4. Disconnected inspector opener falls back to reader reveal/toolbar via modal-focus guards
    const disconnectedOpener = document.createElement('a');
    disconnectedOpener.href = '#fn-2';
    host.append(disconnectedOpener);
    sessionMock.inspectors.onFootnote?.(
      {
        title: 'Footnote 2',
        paragraphs: ['Detached opener fallback test.'],
      },
      disconnectedOpener,
    );
    await flushAsync();
    disconnectedOpener.remove();

    host
      .querySelector<HTMLElement>('#reader-footnote')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await flushAsync();
    expect(host.querySelector('#reader-footnote')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.reader-top-reveal'));
  });

  it('scales default reader font size when turnleafDynamicType fires without adding custom preferences', async () => {
    document.documentElement.style.setProperty('--turnleaf-text-scale', '1.35');
    await mountReader();
    expect(sessionMock.lastAppearanceFontSize).toBe(24);

    document.documentElement.style.setProperty('--turnleaf-text-scale', '1.75');
    window.dispatchEvent(new CustomEvent('turnleafDynamicType', { detail: { scale: 1.75 } }));
    await flushAsync();

    expect(sessionMock.lastAppearanceFontSize).toBe(32);
    expect(preferencesStore.has('appearance')).toBe(false);
  });
});
