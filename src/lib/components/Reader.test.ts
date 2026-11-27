// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { MAX_ANNOTATIONS, type StoredAnnotation } from '../reader/annotations';

const {
  getPreferencesMock,
  setPreferencesMock,
  openSessionMock,
  updateHighlightsMock,
  destroySessionMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  setPreferencesMock: vi.fn(),
  openSessionMock: vi.fn(),
  updateHighlightsMock: vi.fn(),
  destroySessionMock: vi.fn(),
}));

vi.mock('../database/database', () => ({
  getPreferences: getPreferencesMock,
  setPreferences: setPreferencesMock,
}));

vi.mock('../reader/session', () => ({
  ReaderSession: class MockReaderSession {
    open = openSessionMock;
    tableOfContents = () => [];
    getVisiblePassages = () => [];
    clearTextSelection = vi.fn();
    updateHighlights = updateHighlightsMock;
    destroy = destroySessionMock;
  },
}));

import Reader from './Reader.svelte';

describe('Reader mount lifecycle', () => {
  let target: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.animate ??= () => {
      let canceled = false;
      const animation = {
        currentTime: 0,
        playState: 'finished',
        effect: null,
        onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
        cancel: () => {
          canceled = true;
        },
      };
      queueMicrotask(() => {
        if (!canceled) animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
      });
      return animation as unknown as Animation;
    };
    getPreferencesMock.mockResolvedValue(new Map());
    setPreferencesMock.mockResolvedValue(undefined);
    openSessionMock.mockResolvedValue(undefined);
    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    target.remove();
  });

  it('reports true on mount and false on destroy through onMountChange', async () => {
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:test-book',
        bookId: 'book-1',
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(target.querySelector('.reader-shell')).not.toBeNull();
    expect(onMountChange).toHaveBeenCalledTimes(1);
    expect(onMountChange).toHaveBeenNthCalledWith(1, true);

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenNthCalledWith(2, false);
  });

  it('still reports mount and destroy transitions when opening the EPUB fails', async () => {
    openSessionMock.mockRejectedValueOnce(new Error('corrupt epub'));
    const onMountChange = vi.fn<(isMounted: boolean) => void>();

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:broken-book',
        bookId: 'book-2',
        title: 'Broken Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onMountChange,
      },
    });
    flushSync();

    expect(onMountChange).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        'This EPUB could not be opened.',
      );
    });
    expect(onMountChange).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    expect(onMountChange).toHaveBeenCalledTimes(2);
    expect(onMountChange).toHaveBeenLastCalledWith(false);
  });

  it('mounts and unmounts cleanly when onMountChange is omitted', async () => {
    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:optional-book',
        bookId: 'book-3',
        title: 'Optional Callback Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(openSessionMock).toHaveBeenCalledOnce();
    });

    await unmount(mounted);
    mounted = null;
    expect(destroySessionMock).toHaveBeenCalledOnce();
  });

  it('focuses reader-shell on mount, focuses the saved note editor via Add note, preserves selection drafts at highlight limit, and restores heading focus on Cancel', async () => {
    let emitSelection: ((selection: { cfi: string; text: string } | null) => void) | undefined;
    openSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
      emitSelection = args[7] as (selection: { cfi: string; text: string } | null) => void;
    });

    const cappedButOne: StoredAnnotation[] = Array.from(
      { length: MAX_ANNOTATIONS - 1 },
      (_, index) => ({
        id: `ann-${index}`,
        cfi: `epubcfi(/6/2!/4/2/${index})`,
        excerpt: `Passage ${index}`,
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    getPreferencesMock.mockResolvedValueOnce(
      new Map([['readerAnnotations:book-notes', JSON.stringify(cappedButOne)]]),
    );

    mounted = mount(Reader, {
      target,
      props: {
        bookUrl: 'blob:notes-book',
        bookId: 'book-notes',
        title: 'Notes Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    flushSync();

    const shell = target.querySelector<HTMLElement>('.reader-shell')!;
    expect(document.activeElement).toBe(shell);

    await vi.waitFor(() => {
      expect(emitSelection).toBeTypeOf('function');
    });

    flushSync(() => {
      emitSelection?.({ cfi: 'epubcfi(/6/2!/4/2/999)', text: 'Selected passage for note' });
    });

    const addNoteButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Add note',
    )!;
    addNoteButton.focus();
    flushSync(() => {
      addNoteButton.click();
    });
    await tick();

    const annotationsDialog = target.querySelector<HTMLElement>('#reader-annotations')!;
    expect(annotationsDialog).not.toBeNull();
    const noteEditor = annotationsDialog.querySelector<HTMLTextAreaElement>(
      '[data-reader-focus="annotation-editor"]',
    )!;
    expect(noteEditor).not.toBeNull();
    expect(document.activeElement).toBe(noteEditor);

    flushSync(() => {
      target
        .querySelector<HTMLButtonElement>('button[aria-label="Close highlights and notes"]')
        ?.click();
    });
    await tick();

    // Now at MAX_ANNOTATIONS: selecting a new passage and clicking Highlight opens annotations with limit alert.
    flushSync(() => {
      emitSelection?.({ cfi: 'epubcfi(/6/2!/4/2/1000)', text: 'Overflow passage' });
    });
    const highlightButton = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === 'Highlight',
    )!;
    highlightButton.focus();
    flushSync(() => {
      highlightButton.click();
    });
    await tick();

    const cappedDialog = target.querySelector<HTMLElement>('#reader-annotations')!;
    expect(cappedDialog.querySelector('[role="alert"]')?.textContent).toContain(
      `up to ${MAX_ANNOTATIONS} highlights`,
    );

    const draftTextarea = cappedDialog.querySelector<HTMLTextAreaElement>('form textarea')!;
    draftTextarea.value = 'Unsaved selection draft';
    draftTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    // Closing with an active selection draft preserves selectedText across panel close/reopen.
    flushSync(() => {
      target
        .querySelector<HTMLButtonElement>('button[aria-label="Close highlights and notes"]')
        ?.click();
    });
    await tick();
    flushSync(() => {
      target
        .querySelector<HTMLButtonElement>('button[aria-controls="reader-annotations"]')
        ?.click();
    });
    await tick();

    const reopenedDialog = target.querySelector<HTMLElement>('#reader-annotations')!;
    expect(reopenedDialog.querySelector<HTMLTextAreaElement>('form textarea')?.value).toBe(
      'Unsaved selection draft',
    );

    const cancelDraftButton = [
      ...reopenedDialog.querySelectorAll<HTMLButtonElement>('form button'),
    ].find((btn) => btn.textContent?.trim() === 'Cancel')!;
    cancelDraftButton.focus();
    flushSync(() => {
      cancelDraftButton.click();
    });
    await tick();

    const savedHeading = reopenedDialog.querySelector<HTMLElement>(
      '[data-reader-focus="annotations-heading"]',
    )!;
    expect(document.activeElement).toBe(savedHeading);
  });
});
