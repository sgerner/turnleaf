// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../reader/session';
import type { ReaderLocation, ReaderSelection } from '../reader/session';

const {
  mockOpen,
  mockUpdateHighlights,
  mockDisplayServerLocation,
  mockGetVisiblePassages,
  mockClearTextSelection,
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockUpdateHighlights: vi.fn(),
  mockDisplayServerLocation: vi.fn(async () => true),
  mockGetVisiblePassages: vi.fn<() => ReaderSelection[]>(() => []),
  mockClearTextSelection: vi.fn(),
}));

vi.mock('../reader/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    ReaderSession: class MockReaderSession {
      open = mockOpen;
      tableOfContents = () => [{ label: 'Chapter 1', href: 'chapter-1.xhtml', children: [] }];
      getVisiblePassages = mockGetVisiblePassages;
      clearTextSelection = mockClearTextSelection;
      updateHighlights = mockUpdateHighlights;
      applyAppearance = vi.fn();
      display = vi.fn(async () => {});
      displayCfi = vi.fn(async () => true);
      displayServerLocation = mockDisplayServerLocation;
      displayServerPercentage = vi.fn(async () => {});
      next = vi.fn(async () => {});
      previous = vi.fn(async () => {});
      search = vi.fn(async () => []);
      destroy = vi.fn();
    },
  };
});

import { getPreferences, resetLocalDatabase, setPreferences } from '../database/database';
import { MAX_ANNOTATIONS, addAnnotation } from '../reader/annotations';
import { MAX_BOOKMARKS, renameBookmark, toggleBookmark } from '../reader/bookmarks';
import Reader from './Reader.svelte';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function flushUi(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
  await Promise.resolve();
  await tick();
}

describe('Reader destructive action confirmations', () => {
  const bookId = 'server:1:10';
  const currentLoc: ReaderLocation = {
    cfi: 'epubcfi(/6/2!/4/2)',
    href: 'chapter-1.xhtml',
    xpath: '/body/div/p[1]',
    percentage: 0.25,
    spineIndex: 0,
    pageIndex: 1,
    pageCount: 10,
  };
  let host: HTMLDivElement;
  let mounted: ReturnType<typeof mount> | null = null;
  let backHandler: (() => boolean) | null = null;

  beforeEach(async () => {
    Element.prototype.animate ??= (() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel: () => {},
        finish: () => {},
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as typeof Element.prototype.animate;

    vi.stubGlobal('localStorage', new MemoryStorage());
    await resetLocalDatabase();
    vi.clearAllMocks();
    mockGetVisiblePassages.mockReturnValue([]);
    backHandler = null;

    mockOpen.mockImplementation(
      async (
        _viewport: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onRelocated: (loc: ReaderLocation, origin: 'initial') => void,
      ) => {
        onRelocated(currentLoc, 'initial');
      },
    );

    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('gates highlight deletion, previews excerpt and note, restores focus on cancel/Escape/Back, and announces status on confirm', async () => {
    let seedAnnotations = addAnnotation(
      [],
      'epubcfi(/6/2!/4/2)',
      'First highlighted passage',
      'Important reader note',
      '2026-01-01T00:00:00.000Z',
    );
    seedAnnotations = addAnnotation(
      seedAnnotations,
      'epubcfi(/6/2!/4/6)',
      'Second highlighted passage',
      '',
      '2026-01-02T00:00:00.000Z',
    );
    await setPreferences(
      new Map([[`readerAnnotations:${bookId}`, JSON.stringify(seedAnnotations)]]),
    );

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        registerBackHandler: (handler) => {
          backHandler = handler;
          return () => {
            backHandler = null;
          };
        },
      },
    });
    await flushUi();

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await flushUi();
    host
      .querySelector<HTMLButtonElement>('[aria-label="Notes: highlights and annotations"]')!
      .click();
    await flushUi();

    const firstDeleteButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Delete highlight First highlighted passage"]',
    )!;
    firstDeleteButton.focus();
    firstDeleteButton.click();
    await flushUi();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Delete highlight and note?');
    expect(dialog?.textContent).toContain('First highlighted passage');
    expect(dialog?.textContent).toContain('Important reader note');

    // Cancel button is focused first and storage has not been modified yet
    const dialogButtons = Array.from(dialog!.querySelectorAll('button'));
    expect(document.activeElement).toBe(dialogButtons[0]);
    expect(dialogButtons[0]?.textContent?.trim()).toBe('Cancel');
    const storedBeforeConfirm = (await getPreferences([`readerAnnotations:${bookId}`])).get(
      `readerAnnotations:${bookId}`,
    );
    expect(JSON.parse(storedBeforeConfirm!)).toHaveLength(2);

    // Cancel via Escape preserves the panel and restores trigger focus
    dialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('#reader-annotations')).not.toBeNull();
    expect(document.activeElement).toBe(firstDeleteButton);

    // Cancel via Android Back preserves the panel and restores trigger focus
    firstDeleteButton.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(backHandler?.()).toBe(true);
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('#reader-annotations')).not.toBeNull();
    expect(document.activeElement).toBe(firstDeleteButton);

    // Confirming deletes the first highlight, announces status, and focuses the next item's Edit note button
    firstDeleteButton.click();
    await flushUi();
    const confirmFirst = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Delete highlight')!;
    confirmFirst.click();
    await flushUi();

    const storedAfterFirst = (await getPreferences([`readerAnnotations:${bookId}`])).get(
      `readerAnnotations:${bookId}`,
    );
    expect(JSON.parse(storedAfterFirst!)).toHaveLength(1);
    const statusMessages = Array.from(host.querySelectorAll('[role="status"]')).map((node) =>
      node.textContent?.trim(),
    );
    expect(statusMessages).toContain('Highlight and note deleted.');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Edit note for Second highlighted passage',
    );

    // Confirming deletion of the last highlight moves focus to the Saved highlights heading fallback
    const secondDeleteButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Delete highlight Second highlighted passage"]',
    )!;
    secondDeleteButton.focus();
    secondDeleteButton.click();
    await flushUi();
    const confirmSecond = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Delete highlight')!;
    confirmSecond.click();
    await flushUi();

    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-reader-focus')).toBe(
      'annotations-heading',
    );
  });

  it('gates bookmark deletion and custom-label toggleCurrentBookmark while keeping default page toggle immediate', async () => {
    let seedBookmarks = toggleBookmark(
      [],
      { cfi: currentLoc.cfi, href: currentLoc.href, percentage: currentLoc.percentage },
      '2026-01-01T00:00:00.000Z',
    );
    seedBookmarks = renameBookmark(seedBookmarks, seedBookmarks[0]!.id, 'Favorite scene');
    await setPreferences(new Map([[`readerBookmarks:${bookId}`, JSON.stringify(seedBookmarks)]]));

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushUi();

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await flushUi();
    host.querySelector<HTMLButtonElement>('[aria-label="Marks, bookmarks and history"]')!.click();
    await flushUi();

    // Toggling off a custom-labeled bookmark at the current page opens ConfirmDialog
    const currentToggle = host.querySelector<HTMLButtonElement>(
      '[data-reader-focus="bookmark-current"]',
    )!;
    expect(currentToggle.textContent?.trim()).toBe('Remove bookmark at this page');
    currentToggle.focus();
    currentToggle.click();
    await flushUi();

    const toggleDialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(toggleDialog).not.toBeNull();
    expect(toggleDialog?.textContent).toContain('Favorite scene');

    // Cancel keeps the custom bookmark and restores trigger focus
    toggleDialog!.querySelector<HTMLButtonElement>('button')!.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(currentToggle);

    // Delete button in the bookmark list also opens ConfirmDialog, and confirming announces status + focuses fallback
    const listDelete = host.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Favorite scene"]',
    )!;
    listDelete.focus();
    listDelete.click();
    await flushUi();

    const confirmDelete = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Delete bookmark')!;
    confirmDelete.click();
    await flushUi();

    const storedAfterDelete = (await getPreferences([`readerBookmarks:${bookId}`])).get(
      `readerBookmarks:${bookId}`,
    );
    expect(JSON.parse(storedAfterDelete!)).toEqual([]);
    const statuses = Array.from(host.querySelectorAll('[role="status"]')).map((node) =>
      node.textContent?.trim(),
    );
    expect(statuses).toContain('Bookmark “Favorite scene” deleted.');
    expect(document.activeElement).toBe(currentToggle);

    // Default (unrenamed) bookmark toggles on and off without confirmation
    currentToggle.click();
    await flushUi();
    expect(currentToggle.textContent?.trim()).toBe('Remove bookmark at this page');
    currentToggle.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(currentToggle.textContent?.trim()).toBe('Bookmark this page');
  });

  it('uses ConfirmDialog when manual sync finds a divergent Kavita reading position, awaiting async acceptance and surfacing rejection errors', async () => {
    let resolveAccept: (() => void) | null = null;
    let shouldRejectAccept = false;
    const accept = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveAccept = () => {
            if (shouldRejectAccept) {
              reject(new Error('Kavita sync write failed.'));
            } else {
              resolve();
            }
          };
        }),
    );
    const onSyncLatest = vi.fn(async () => {
      // Real browsers blur a focused <button> as soon as disabled={syncingLatest} flips true
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      return {
        xpath: '/body/div/p[9]',
        percentage: 0.8,
        accept,
      };
    });

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
        onSyncLatest,
      },
    });
    await flushUi();

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await flushUi();
    const syncButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Sync latest reading position"]',
    )!;
    syncButton.focus();
    syncButton.click();
    await flushUi();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.parentElement?.classList.contains('z-40')).toBe(true);
    expect(dialog?.textContent).toContain('Move to Kavita’s latest position?');
    const buttons = Array.from(dialog!.querySelectorAll('button'));
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0]?.textContent?.trim()).toBe('Stay here');

    // Escape cancels sync confirmation, keeps controls visible, and restores focus to syncButton
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(accept).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(syncButton);

    // Re-trigger sync and confirm: closes dialog immediately, awaits async accept(), then navigates and restores focus
    syncButton.click();
    await flushUi();
    const confirmButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    );
    confirmButtons[1]!.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(accept).toHaveBeenCalledOnce();
    expect(mockDisplayServerLocation).not.toHaveBeenCalled();

    resolveAccept!();
    await flushUi();
    expect(mockDisplayServerLocation).toHaveBeenCalledWith('/body/div/p[9]');
    expect(document.activeElement).toBe(syncButton);

    // Async rejection during accept() opens decoupled z-40 reader error alertdialog and restores focus on dismiss
    mockDisplayServerLocation.mockClear();
    shouldRejectAccept = true;
    syncButton.click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))[1]!.click();
    await flushUi();
    resolveAccept!();
    await flushUi();

    expect(mockDisplayServerLocation).not.toHaveBeenCalled();
    const errorDialog = host.querySelector<HTMLElement>('[aria-labelledby="reader-error-title"]');
    expect(errorDialog).not.toBeNull();
    expect(errorDialog?.parentElement?.classList.contains('z-40')).toBe(true);
    expect(errorDialog?.textContent).toContain('Kavita sync write failed.');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUi();
    expect(host.querySelector('[aria-labelledby="reader-error-title"]')).toBeNull();
    expect(document.activeElement).toBe(syncButton);
  });

  it('preserves shared panel headers, Escape selection clearing, and passage-highlight confirmation flows together', async () => {
    let onSelectionCallback: ((selection: ReaderSelection | null) => void) | undefined;
    mockGetVisiblePassages.mockReturnValue([
      { cfi: 'epubcfi(/6/2!/4/8)', text: 'Visible keyboard passage on current page' },
    ]);
    mockOpen.mockImplementation(
      async (
        _viewport: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onRelocated: (loc: ReaderLocation, origin: 'restore') => void,
        _onTap: unknown,
        onSelection?: (selection: ReaderSelection | null) => void,
      ) => {
        onSelectionCallback = onSelection;
        onRelocated(currentLoc, 'restore');
      },
    );

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushUi();

    // Active EPUB text selection clears on Escape when no panel or confirmation dialog is open
    onSelectionCallback?.({ cfi: 'epubcfi(/6/2!/4/4)', text: 'Selected inline sentence' });
    await flushUi();
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUi();
    expect(mockClearTextSelection).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="group"][aria-label="Selected text"]')).toBeNull();

    // Open Highlights and notes: verify shared readerPanelHeader + Passage on this page form
    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await flushUi();
    host
      .querySelector<HTMLButtonElement>('[aria-label="Notes: highlights and annotations"]')!
      .click();
    await flushUi();

    const panel = host.querySelector<HTMLElement>('#reader-annotations')!;
    expect(panel).not.toBeNull();
    const closeHeaderButton = panel.firstElementChild as HTMLButtonElement | null;
    expect(closeHeaderButton?.tagName).toBe('BUTTON');
    expect(closeHeaderButton?.getAttribute('title')).toBe('Close');
    expect(closeHeaderButton?.getAttribute('aria-label')).toBe('Close highlights and notes');
    expect(closeHeaderButton?.nextElementSibling?.id).toBe('reader-annotations-title');

    const passageSelect = panel.querySelector<HTMLSelectElement>(
      'select[aria-label="Passage on this page"]',
    );
    expect(passageSelect).not.toBeNull();

    const noteField = panel.querySelector<HTMLTextAreaElement>('textarea')!;
    noteField.value = 'Keyboard passage note';
    noteField.dispatchEvent(new Event('input', { bubbles: true }));
    await flushUi();

    panel
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushUi();

    expect(panel.textContent).toContain('Highlight and note saved.');

    // Deleting the newly created passage highlight opens ConfirmDialog while keeping the panel inert
    const deleteBtn = panel.querySelector<HTMLButtonElement>(
      '[aria-label="Delete highlight Visible keyboard passage on current page"]',
    )!;
    deleteBtn.focus();
    deleteBtn.click();
    await flushUi();

    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(panel.inert).toBe(true);

    // Window-level Escape cancels ConfirmDialog first without closing Highlights and notes
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('#reader-annotations')).not.toBeNull();
    expect(panel.inert).toBe(false);
    expect(document.activeElement).toBe(deleteBtn);

    // Confirming deletes the highlight, clears stale saved banner, announces deletion, and focuses fallback heading
    deleteBtn.click();
    await flushUi();
    const confirmDelete = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Delete highlight')!;
    confirmDelete.click();
    await flushUi();

    expect(panel.textContent).not.toContain('Highlight and note saved.');
    const statuses = Array.from(host.querySelectorAll('[role="status"]')).map((node) =>
      node.textContent?.trim(),
    );
    expect(statuses).toContain('Highlight and note deleted.');
    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-reader-focus')).toBe(
      'annotations-heading',
    );
  });

  it('clears bookmark and highlight cap alerts only after confirming deletion and preserves unsaved selection drafts', async () => {
    let onSelectionCallback: ((selection: ReaderSelection | null) => void) | undefined;
    mockOpen.mockImplementation(
      async (
        _viewport: HTMLElement,
        _cfi: string | null,
        _xpath: string | null,
        _percentage: number | null,
        _appearance: unknown,
        onRelocated: (loc: ReaderLocation, origin: 'restore') => void,
        _onTap: unknown,
        onSelection?: (selection: ReaderSelection | null) => void,
      ) => {
        onSelectionCallback = onSelection;
        onRelocated(currentLoc, 'restore');
      },
    );

    let fullBookmarks = toggleBookmark(
      [],
      { cfi: 'epubcfi(/6/2!/4/100)', href: 'chapter-1.xhtml', percentage: 0.1 },
      '2026-01-01T00:00:00.000Z',
    );
    fullBookmarks = renameBookmark(fullBookmarks, fullBookmarks[0]!.id, 'Saved chapter marker');
    for (let index = 2; index <= MAX_BOOKMARKS; index += 1) {
      fullBookmarks = toggleBookmark(
        fullBookmarks,
        {
          cfi: `epubcfi(/6/2!/4/${100 + index})`,
          href: `chapter-${index}.xhtml`,
          percentage: index / 300,
        },
        `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      );
    }

    let fullAnnotations: ReturnType<typeof addAnnotation> = [];
    for (let index = 1; index <= MAX_ANNOTATIONS; index += 1) {
      fullAnnotations = addAnnotation(
        fullAnnotations,
        `epubcfi(/6/2!/4/${300 + index})`,
        `Saved highlight ${index}`,
        index === 1 ? 'Saved note 1' : '',
        `2026-01-01T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
      );
    }

    await setPreferences(
      new Map([
        [`readerBookmarks:${bookId}`, JSON.stringify(fullBookmarks)],
        [`readerAnnotations:${bookId}`, JSON.stringify(fullAnnotations)],
      ]),
    );

    mounted = mount(Reader, {
      target: host,
      props: {
        bookUrl: 'blob:book',
        bookId,
        title: 'Test Book',
        onBack: vi.fn(),
        onRelocated: vi.fn(),
      },
    });
    await flushUi();

    host.querySelector<HTMLButtonElement>('[aria-label="Show reading controls"]')!.click();
    await flushUi();
    host.querySelector<HTMLButtonElement>('[aria-label="Marks, bookmarks and history"]')!.click();
    await flushUi();

    // Attempting to add a bookmark beyond MAX_BOOKMARKS displays the cap alert
    const currentToggle = host.querySelector<HTMLButtonElement>(
      '[data-reader-focus="bookmark-current"]',
    )!;
    currentToggle.click();
    await flushUi();
    expect(host.textContent).toContain(`You can save up to ${MAX_BOOKMARKS} bookmarks per book.`);

    // Cancelling bookmark deletion keeps the cap alert; confirming clears it
    const deleteCustomBookmark = host.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Saved chapter marker"]',
    )!;
    deleteCustomBookmark.click();
    await flushUi();
    host.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click();
    await flushUi();
    expect(host.textContent).toContain(`You can save up to ${MAX_BOOKMARKS} bookmarks per book.`);

    deleteCustomBookmark.click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find((button) => button.textContent?.trim() === 'Delete bookmark')!
      .click();
    await flushUi();
    expect(host.textContent).not.toContain(
      `You can save up to ${MAX_BOOKMARKS} bookmarks per book.`,
    );

    // Switch to Highlights and notes with an unsaved selection draft at MAX_ANNOTATIONS
    onSelectionCallback?.({ cfi: 'epubcfi(/6/2!/4/999)', text: 'Overflow passage' });
    await flushUi();
    host
      .querySelector<HTMLButtonElement>('[aria-label="Notes: highlights and annotations"]')!
      .click();
    await flushUi();

    const annotationsPanel = host.querySelector<HTMLElement>('#reader-annotations')!;
    const selectionNoteTextarea = annotationsPanel.querySelector<HTMLTextAreaElement>('textarea')!;
    selectionNoteTextarea.value = 'Draft note to preserve';
    selectionNoteTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushUi();

    // Changing or clearing EPUB text selection preserves the active selection draft
    onSelectionCallback?.({ cfi: 'epubcfi(/6/2!/4/1000)', text: 'Replacement selection' });
    onSelectionCallback?.(null);
    await flushUi();
    expect(annotationsPanel.textContent).toContain('Overflow passage');
    expect(selectionNoteTextarea.value).toBe('Draft note to preserve');

    // Start an in-place edit draft on Saved highlight 2 to ensure unrelated edit drafts also survive deletion dialogs
    annotationsPanel
      .querySelector<HTMLButtonElement>('[aria-label="Edit note for Saved highlight 2"]')!
      .click();
    await flushUi();
    const editSecondTextarea = annotationsPanel.querySelector<HTMLTextAreaElement>(
      'textarea[data-reader-focus="annotation-editor"]',
    )!;
    editSecondTextarea.value = 'In-progress edit on highlight 2';
    editSecondTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushUi();

    annotationsPanel
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushUi();
    expect(annotationsPanel.textContent).toContain(
      `You can save up to ${MAX_ANNOTATIONS} highlights per book.`,
    );

    // Deleting an existing highlight keeps cap alert on cancel, clears cap alert on confirm, and preserves both drafts
    const deleteFirstHighlight = annotationsPanel.querySelector<HTMLButtonElement>(
      '[aria-label="Delete highlight Saved highlight 1"]',
    )!;
    deleteFirstHighlight.click();
    await flushUi();
    host.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click();
    await flushUi();
    expect(annotationsPanel.textContent).toContain(
      `You can save up to ${MAX_ANNOTATIONS} highlights per book.`,
    );
    expect(selectionNoteTextarea.value).toBe('Draft note to preserve');
    expect(editSecondTextarea.value).toBe('In-progress edit on highlight 2');

    deleteFirstHighlight.click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find((button) => button.textContent?.trim() === 'Delete highlight')!
      .click();
    await flushUi();
    expect(annotationsPanel.textContent).not.toContain(
      `You can save up to ${MAX_ANNOTATIONS} highlights per book.`,
    );
    expect(selectionNoteTextarea.value).toBe('Draft note to preserve');
    expect(editSecondTextarea.value).toBe('In-progress edit on highlight 2');
  });
});
