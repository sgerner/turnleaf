// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThemesModule from '../themes/themes';

const {
  backListeners,
  mockDownloadEpub,
  mockDeleteDownloadedEpub,
  mockClearCoverCache,
  mockRemoveApiKey,
} = vi.hoisted(() => ({
  backListeners: [] as Array<() => void>,
  mockDownloadEpub: vi.fn(),
  mockDeleteDownloadedEpub: vi.fn(async () => {}),
  mockClearCoverCache: vi.fn(async () => {}),
  mockRemoveApiKey: vi.fn(async () => {}),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (eventName: string, callback: () => void) => {
      if (eventName === 'backButton') backListeners.push(callback);
      return {
        remove: vi.fn(async () => {
          const index = backListeners.indexOf(callback);
          if (index >= 0) backListeners.splice(index, 1);
        }),
      };
    }),
    exitApp: vi.fn(async () => {}),
  },
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class EpubTransferError extends Error {
    status?: number;
    connectionFailed?: boolean;
  },
  cacheCover: vi.fn(),
  clearCoverCache: mockClearCoverCache,
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: mockDeleteDownloadedEpub,
  downloadEpub: mockDownloadEpub,
  verifyDownloadedEpub: vi.fn(),
}));

vi.mock('../native/credentials', () => ({
  removeApiKey: mockRemoveApiKey,
  saveApiKey: vi.fn(async () => {}),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: vi.fn(async () => true),
  };
});

import {
  getBooks,
  getPendingSync,
  getReadingState,
  reconcileBooks,
  resetLocalDatabase,
  saveLocalProgress,
  saveServer,
  setPreference,
  type BookRecord,
  type ServerConfig,
} from '../database/database';
import { clearDiagnostics, getDiagnosticCount, recordDiagnostic } from '../diagnostics/log';
import Library from './Library.svelte';

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
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  await tick();
  await Promise.resolve();
  await tick();
}

const server: ServerConfig = {
  id: 'primary',
  displayName: 'Home Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

const activeBook: BookRecord = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 100,
  title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 200,
  pagesRead: 80,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-01-02T00:00:00.000Z',
  downloadPath: 'books/primary-1-10.epub',
  downloadStatus: 'available',
  fileSize: 2_097_152,
  remoteAvailable: true,
};

const serverRemovedBook: BookRecord = {
  ...activeBook,
  id: 'primary:2:20',
  seriesId: 2,
  volumeId: 20,
  chapterId: 200,
  title: 'Out of Print Edition',
  pagesRead: 0,
  lastReadAt: null,
  downloadPath: 'books/primary-2-20.epub',
  remoteAvailable: false,
};

describe('Library destructive action confirmations', () => {
  let host: HTMLDivElement;
  let mounted: ReturnType<typeof mount> | null = null;

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
    backListeners.length = 0;

    await saveServer(server);
    await reconcileBooks(server.id, [activeBook, serverRemovedBook]);
    // Mark serverRemovedBook as remoteAvailable: false via a reconcile without it while downloaded
    await reconcileBooks(server.id, [activeBook]);
    await saveLocalProgress(activeBook, 'epubcfi(/6/4!/4/2)', '/body/p[4]', 0.4);

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

  it('gates Mark as read before updating progress, restores trigger focus on cancel/Back/Escape, emits onOverlayActiveChange, and focuses #library-results when hidden', async () => {
    const onOverlayActiveChange = vi.fn();
    mounted = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
        onOverlayActiveChange,
      },
    });
    await flushUi();
    expect(onOverlayActiveChange).toHaveBeenLastCalledWith(false);

    const actionsTrigger = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Book actions for The Left Hand of Darkness"]',
    )!;
    actionsTrigger.focus();
    actionsTrigger.click();
    await flushUi();
    expect(onOverlayActiveChange).toHaveBeenLastCalledWith(true);
    onOverlayActiveChange.mockClear();

    const markReadButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Mark as read',
    )!;
    markReadButton.focus();
    markReadButton.click();
    await flushUi();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('[inert]')).toBeNull();
    expect(dialog?.textContent).toContain('Mark “The Left Hand of Darkness” as read?');
    expect(dialog?.textContent).toContain('40% complete');
    expect(dialog?.textContent).toContain('Hide completed is active');
    expect(onOverlayActiveChange).not.toHaveBeenCalledWith(false);

    // Progress has NOT been overwritten yet
    const stateBefore = await getReadingState(activeBook.id);
    expect(stateBefore?.percentage).toBe(0.4);
    expect(stateBefore?.cfi).toBe('epubcfi(/6/4!/4/2)');

    // Escape dismisses ConfirmDialog, keeps Book actions open, and restores focus to Mark as read
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('#book-actions-title')).not.toBeNull();
    expect(document.activeElement).toBe(markReadButton);
    expect(onOverlayActiveChange).not.toHaveBeenCalledWith(false);

    // Reopen and verify Android Back dismisses ConfirmDialog, keeps Book actions open, and restores focus
    markReadButton.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    backListeners.at(-1)?.();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('#book-actions-title')).not.toBeNull();
    expect(document.activeElement).toBe(markReadButton);
    expect(onOverlayActiveChange).not.toHaveBeenCalledWith(false);

    // Confirming marks book completed, hides the card (hideCompleted=true), emits overlay inactive, and moves focus to #library-results
    markReadButton.click();
    await flushUi();
    const confirmButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Mark as read')!;
    confirmButton.click();
    await flushUi();

    const stateAfter = await getReadingState(activeBook.id);
    expect(stateAfter?.percentage).toBe(1);
    expect(stateAfter?.cfi).toBe('');
    const pending = await getPendingSync(server.id);
    expect(JSON.parse(pending[0]!.payload).pageNum).toBe(activeBook.pages);
    expect(
      host.querySelector('[aria-label^="Book actions for The Left Hand of Darkness"]'),
    ).toBeNull();
    expect(onOverlayActiveChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement?.id).toBe('library-results');
  });

  it('gates Remove download only when remoteAvailable is false and removes immediately when remoteAvailable is true', async () => {
    mounted = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await flushUi();

    // 1. remoteAvailable === true removes immediately on one click without ConfirmDialog
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label^="Book actions for The Left Hand of Darkness"]',
      )!
      .click();
    await flushUi();
    const removeActive = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove download',
    )!;
    removeActive.click();
    await flushUi();

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockDeleteDownloadedEpub).toHaveBeenCalledWith('books/primary-1-10.epub');

    // 2. remoteAvailable === false opens ConfirmDialog before deleting the sole local copy
    mockDeleteDownloadedEpub.mockClear();
    const removedActions = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Book actions for Out of Print Edition"]',
    )!;
    removedActions.focus();
    removedActions.click();
    await flushUi();

    const removeUnavailable = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove download',
    )!;
    removeUnavailable.focus();
    removeUnavailable.click();
    await flushUi();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Kavita no longer serves this book');
    expect(dialog?.textContent).toContain('permanently removes this book');
    expect(mockDeleteDownloadedEpub).not.toHaveBeenCalled();

    // Escape cancels sole-copy deletion, keeps Book actions open, and restores focus to Remove download
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockDeleteDownloadedEpub).not.toHaveBeenCalled();
    expect(host.querySelector('#book-actions-title')).not.toBeNull();
    expect(document.activeElement).toBe(removeUnavailable);

    // Reopen and confirm permanent removal: deletes the file, drops the card from displayableBooks, and focuses #library-results
    removeUnavailable.click();
    await flushUi();
    const reopenedDialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirmPermanent = Array.from(reopenedDialog.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Remove permanently',
    )!;
    confirmPermanent.click();
    await flushUi();

    expect(mockDeleteDownloadedEpub).toHaveBeenCalledWith('books/primary-2-20.epub');
    expect(host.querySelector('[aria-label="Book actions for Out of Print Edition"]')).toBeNull();
    expect(document.activeElement?.id).toBe('library-results');
  });

  it('replaces window.confirm in Remove all downloaded books and inline confirmDeleteServer with ConfirmDialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onServerDeleted = vi.fn();

    mounted = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted,
        onChangeServerAddress: vi.fn(),
      },
    });
    await flushUi();

    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();

    const removeAllButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove all downloaded books',
    )!;
    removeAllButton.focus();
    removeAllButton.click();
    await flushUi();

    expect(confirmSpy).not.toHaveBeenCalled();
    const removeAllDialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(removeAllDialog).not.toBeNull();
    expect(removeAllDialog?.textContent).toContain('Remove 2 downloaded books?');
    expect(removeAllDialog?.textContent).toContain('1 book is no longer available on Kavita');

    // Cancel restores focus to Remove all downloaded books inside Settings
    removeAllDialog!.querySelector<HTMLButtonElement>('button')!.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(removeAllButton);

    // Confirm Remove all downloaded books
    removeAllButton.click();
    await flushUi();
    const confirmRemoveAll = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Remove downloads')!;
    confirmRemoveAll.click();
    await flushUi();

    const booksAfterRemoveAll = await getBooks(server.id);
    expect(booksAfterRemoveAll.every((book) => book.downloadPath === null)).toBe(true);

    // Reopen Settings and test Delete server via ConfirmDialog alongside shared DiagnosticsPanel
    await clearDiagnostics();
    recordDiagnostic({
      category: 'download',
      endpoint: '/api/Download/chapter',
      detail: 'network-error',
    });
    expect(getDiagnosticCount()).toBe(1);

    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    const settingsDialog = host.querySelector<HTMLElement>(
      '[aria-labelledby="library-settings-title"]',
    )!;
    const settingsHeader = settingsDialog.querySelector<HTMLElement>('.dialog-header')!;
    const settingsBody = settingsDialog.querySelector<HTMLElement>('.dialog-body')!;
    expect(settingsHeader.classList.contains('shrink-0')).toBe(true);
    expect(settingsHeader.classList.contains('sticky')).toBe(false);
    expect(settingsBody.classList.contains('flex-1')).toBe(true);
    expect(settingsBody.classList.contains('min-h-0')).toBe(true);
    expect(settingsBody.classList.contains('overflow-y-auto')).toBe(true);
    expect(settingsBody.contains(settingsHeader)).toBe(false);
    expect(
      settingsDialog.querySelector('[aria-labelledby="library-settings-diagnostics-title"]'),
    ).not.toBeNull();

    const deleteServerButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Delete server',
    )!;
    deleteServerButton.focus();
    deleteServerButton.click();
    await flushUi();

    const deleteServerDialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(deleteServerDialog).not.toBeNull();
    expect(deleteServerDialog?.textContent).toContain('Delete this server?');
    expect(settingsDialog.parentElement?.inert).toBe(true);
    expect(deleteServerDialog!.closest('[inert]')).toBeNull();
    expect(getDiagnosticCount()).toBe(1);

    // Escape dismisses ConfirmDialog, restores DialogShell interactivity, preserves diagnostics, and restores focus
    deleteServerDialog!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(settingsDialog.parentElement?.inert).toBe(false);
    expect(getDiagnosticCount()).toBe(1);
    expect(document.activeElement).toBe(deleteServerButton);

    // Android Back dismisses ConfirmDialog without closing Settings DialogShell and restores focus
    deleteServerButton.click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(settingsDialog.parentElement?.inert).toBe(true);
    backListeners.at(-1)?.();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector('[aria-labelledby="library-settings-title"]')).not.toBeNull();
    expect(settingsDialog.parentElement?.inert).toBe(false);
    expect(getDiagnosticCount()).toBe(1);
    expect(document.activeElement).toBe(deleteServerButton);

    // Cancelling via Cancel button preserves diagnostics and restores focus to Delete server
    deleteServerButton.click();
    await flushUi();
    host
      .querySelector<HTMLElement>('[role="alertdialog"]')!
      .querySelector<HTMLButtonElement>('button')!
      .click();
    await flushUi();
    expect(getDiagnosticCount()).toBe(1);
    expect(document.activeElement).toBe(deleteServerButton);

    deleteServerButton.click();
    await flushUi();
    const confirmDeleteServer = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.trim() === 'Delete now')!;
    confirmDeleteServer.click();
    await flushUi();

    expect(mockRemoveApiKey).toHaveBeenCalledWith(server.credentialRef);
    expect(getDiagnosticCount()).toBe(0);
    expect(onServerDeleted).toHaveBeenCalledOnce();
  });

  it('coordinates persisted library filter preferences with Mark as read and Remove download focus behavior', async () => {
    await setPreference('libraryHideCompleted', 'false');
    await setPreference('libraryDownloadedOnly', 'true');

    mounted = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await flushUi();

    const menuTrigger = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Book actions for The Left Hand of Darkness"]',
    )!;
    menuTrigger.focus();
    menuTrigger.click();
    await flushUi();

    const markReadButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Mark as read',
    )!;
    markReadButton.click();
    await flushUi();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).not.toContain('Hide completed is active');

    const confirmMarkRead = Array.from(dialog!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Mark as read',
    )!;
    confirmMarkRead.click();
    await flushUi();

    // Card stays visible when persisted libraryHideCompleted is false, updates savedBook completion state in place, and restores focus to its menu trigger
    const remainingTrigger = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Book actions for The Left Hand of Darkness"]',
    );
    expect(remainingTrigger).not.toBeNull();
    expect(document.activeElement).toBe(remainingTrigger);

    // Reopening Mark as read reflects 100% completion (not stale 40% complete) from in-place savedBook state
    remainingTrigger!.click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Mark as read')!
      .click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')?.textContent).not.toContain('40% complete');
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'overwrites any saved reading position with 100% completion',
    );
    host.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click();
    await flushUi();

    // Removing a server-available download while persisted libraryDownloadedOnly is true runs immediately and focuses #library-results
    const removeButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove download',
    )!;
    removeButton.click();
    await flushUi();

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockDeleteDownloadedEpub).toHaveBeenCalledWith(activeBook.downloadPath);
    expect(
      host.querySelector('[aria-label^="Book actions for The Left Hand of Darkness"]'),
    ).toBeNull();
    expect(document.activeElement?.id).toBe('library-results');
  });

  it('guards Remove download and Remove all downloaded books while downloadingBookId or cleanupInProgress is active', async () => {
    const undownloadedBook: BookRecord = {
      ...activeBook,
      id: 'primary:3:30',
      seriesId: 3,
      volumeId: 30,
      chapterId: 300,
      title: 'A Wizard of Earthsea',
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteAvailable: true,
    };
    await reconcileBooks(server.id, [activeBook, undownloadedBook]);

    let finishDownload: ((value: { relativePath: string; size: number }) => void) | null = null;
    mockDownloadEpub.mockImplementationOnce(
      () =>
        new Promise<{ relativePath: string; size: number }>((resolve) => {
          finishDownload = resolve;
        }),
    );

    mounted = mount(Library, {
      target: host,
      props: {
        server,
        apiKey: 'secret-key',
        theme: 'fennec',
        mode: 'dark',
        onThemeChange: vi.fn(),
        onModeChange: vi.fn(),
        onApiKeyChange: vi.fn(),
        onServerDeleted: vi.fn(),
        onChangeServerAddress: vi.fn(),
      },
    });
    await flushUi();

    // Start an in-flight download so downloadingBookId is set
    host
      .querySelector<HTMLButtonElement>('[data-book-open][aria-label*="A Wizard of Earthsea"]')!
      .click();
    await flushUi();

    // Settings disables Remove all downloaded books while downloadingBookId is active
    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Remove all downloaded books',
      )!.disabled,
    ).toBe(true);
    host.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
    await flushUi();

    // Attempting to remove a sole offline copy while downloadingBookId is active skips ConfirmDialog and shows the busy guard
    host
      .querySelector<HTMLButtonElement>('[aria-label^="Book actions for Out of Print Edition"]')!
      .click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove download')!
      .click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockDeleteDownloadedEpub).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Wait for the current download or cleanup to finish before removing a book.',
    );

    // Fail markDownloaded + initial file cleanup so failedDownloadCleanupPath renders Retry cleanup
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    mockDeleteDownloadedEpub.mockRejectedValueOnce(new Error('EBUSY'));
    finishDownload!({ relativePath: 'books/primary-3-30.epub', size: 1024 });
    await flushUi();

    let finishCleanup: (() => void) | null = null;
    mockDeleteDownloadedEpub.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );

    const retryCleanupButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry cleanup',
    )!;
    retryCleanupButton.click();
    await flushUi();

    // While cleanupInProgress is true, Settings disables Remove all downloaded books and Remove download skips ConfirmDialog
    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Remove all downloaded books',
      )!.disabled,
    ).toBe(true);
    host.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
    await flushUi();

    mockDeleteDownloadedEpub.mockClear();
    host
      .querySelector<HTMLButtonElement>('[aria-label^="Book actions for Out of Print Edition"]')!
      .click();
    await flushUi();
    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove download')!
      .click();
    await flushUi();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockDeleteDownloadedEpub).not.toHaveBeenCalled();

    // Once cleanup finishes, Remove all downloaded books becomes enabled again
    finishCleanup!();
    await flushUi();
    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await flushUi();
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Remove all downloaded books',
      )!.disabled,
    ).toBe(false);
  });
});
