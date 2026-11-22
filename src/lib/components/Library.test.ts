// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, ServerConfig } from '../database/database';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  let books: BookRecord[] = [];
  const preferences = new Map<string, string>();
  const deleteDownloadedEpub = vi.fn(async (path: string) => {
    events.push(`deleteDownloadedEpub:${path}`);
  });
  const removeApiKey = vi.fn(async (ref: string) => {
    events.push(`removeApiKey:${ref}`);
  });
  const removeServer = vi.fn(async (id: string) => {
    events.push(`removeServer:${id}`);
  });
  const writeFile = vi.fn(async () => ({ uri: 'file:///Documents/backup.json' }));

  return {
    deleteDownloadedEpub,
    events,
    getBooks: () => books,
    preferences,
    removeApiKey,
    removeServer,
    reset() {
      events.length = 0;
      books = [];
      preferences.clear();
      deleteDownloadedEpub.mockReset();
      deleteDownloadedEpub.mockImplementation(async (path: string) => {
        events.push(`deleteDownloadedEpub:${path}`);
      });
      removeApiKey.mockReset();
      removeApiKey.mockImplementation(async (ref: string) => {
        events.push(`removeApiKey:${ref}`);
      });
      removeServer.mockReset();
      removeServer.mockImplementation(async (id: string) => {
        events.push(`removeServer:${id}`);
      });
      writeFile.mockReset();
      writeFile.mockResolvedValue({ uri: 'file:///Documents/backup.json' });
    },
    setBooks(next: BookRecord[]) {
      books = structuredClone(next);
    },
    writeFile,
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    exitApp: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Documents: 'DOCUMENTS',
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    writeFile: mocks.writeFile,
  },
}));

vi.mock('../downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class extends Error {},
  cacheCover: vi.fn(async () => 'blob:cover'),
  cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  clearCoverCache: vi.fn(async () => undefined),
  deleteDownloadedEpub: mocks.deleteDownloadedEpub,
  downloadEpub: vi.fn(async () => ({ path: 'books/test.epub', size: 1024 })),
  verifyDownloadedEpub: vi.fn(async () => null),
}));

vi.mock('../native/credentials', () => ({
  removeApiKey: mocks.removeApiKey,
  saveApiKey: vi.fn(async () => undefined),
}));

vi.mock('../themes/themes', () => ({
  loadTheme: vi.fn(async () => true),
  skeletonThemes: ['fennec', 'vintage'],
}));

vi.mock('../database/database', () => ({
  acceptRemoteProgress: vi.fn(async () => true),
  getAllBookNoteMetadata: vi.fn(async () =>
    mocks.getBooks().map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      series: b.series,
    })),
  ),
  getBooks: vi.fn(async () => structuredClone(mocks.getBooks())),
  getPreferences: vi.fn(async (keys: readonly string[]) => {
    const out = new Map<string, string>();
    for (const key of keys) {
      const value = mocks.preferences.get(key);
      if (value !== undefined) out.set(key, value);
    }
    return out;
  }),
  getPreferencesByPrefix: vi.fn(async (prefixes: readonly string[]) => {
    const out = new Map<string, string>();
    for (const [key, value] of mocks.preferences.entries()) {
      if (prefixes.some((p) => key.startsWith(p))) out.set(key, value);
    }
    return out;
  }),
  getReadingState: vi.fn(async () => null),
  getSyncStatus: vi.fn(async () => ({ pendingCount: 0, lastError: null })),
  markBookCompleted: vi.fn(async () => undefined),
  markDownloaded: vi.fn(async () => undefined),
  reconcileBooks: vi.fn(async () => undefined),
  removeDownload: vi.fn(async (bookId: string) => {
    mocks.setBooks(
      mocks
        .getBooks()
        .map((b) =>
          b.id === bookId
            ? { ...b, downloadPath: null, downloadStatus: 'none', fileSize: null }
            : b,
        ),
    );
  }),
  removeServer: mocks.removeServer,
  saveLocalProgress: vi.fn(async () => undefined),
  saveRemoteProgress: vi.fn(async () => true),
  saveServer: vi.fn(async () => undefined),
  setPreference: vi.fn(async (k: string, v: string) => {
    mocks.preferences.set(k, v);
  }),
  setPreferences: vi.fn(async (entries: ReadonlyMap<string, string>) => {
    for (const [k, v] of entries) mocks.preferences.set(k, v);
  }),
}));

import Library from './Library.svelte';

const server: ServerConfig = {
  id: 'primary',
  displayName: 'Home Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'kavita-primary',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-03-01T00:00:00.000Z',
};

const sampleBook: BookRecord = {
  id: 'primary:1:10',
  serverId: 'primary',
  libraryId: 1,
  seriesId: 1,
  volumeId: 10,
  chapterId: 10,
  title: 'Removed Remote Book',
  author: 'Ursula K. Le Guin',
  series: 'Hainish Cycle',
  descriptionHtml: null,
  format: 'epub',
  pages: 250,
  pagesRead: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: '2026-02-01T00:00:00.000Z',
  downloadPath: 'books/primary-1-10.epub',
  downloadStatus: 'available',
  fileSize: 2_097_152,
  remoteAvailable: false,
};

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

function mountLibrary(onServerDeleted = vi.fn()) {
  return mount(Library, {
    target: document.body,
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
}

describe('Library.svelte notes retention, backup/restore, and safe server removal', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.reset();
    document.body.innerHTML = '';
    Element.prototype.animate ??= (() => {
      const anim = {
        cancel() {},
        finish() {},
        onfinish: null as (() => void) | null,
      };
      queueMicrotask(() => anim.onfinish?.());
      return anim as unknown as Animation;
    }) as typeof Element.prototype.animate;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    if (mounted) unmount(mounted);
    mounted = null;
  });

  it('keeps unavailable remote books with saved notes visible after removing their local download', async () => {
    mocks.setBooks([sampleBook]);
    mocks.preferences.set(
      `readerBookmarks:${sampleBook.id}`,
      JSON.stringify([
        {
          id: 'epubcfi(/6/2)|ch1.xhtml',
          cfi: 'epubcfi(/6/2)',
          href: 'ch1.xhtml',
          percentage: 0.2,
          label: 'Saved bookmark',
          savedAt: '2026-03-01T00:00:00.000Z',
        },
      ]),
    );

    mounted = mountLibrary();
    await settle();

    expect(document.body.textContent).toContain('Removed Remote Book');

    const actionsBtn = document.querySelector<HTMLButtonElement>(
      `[aria-label="Book actions for ${sampleBook.title}"]`,
    );
    expect(actionsBtn).toBeTruthy();
    actionsBtn!.click();
    await settle();

    const removeBtn = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Remove download'),
    );
    expect(removeBtn).toBeTruthy();
    removeBtn!.click();
    await settle();

    expect(mocks.deleteDownloadedEpub).toHaveBeenCalledWith('books/primary-1-10.epub');
    expect(document.body.textContent).toContain('Removed Remote Book');

    const actionsAfterRemove = document.querySelector<HTMLButtonElement>(
      `[aria-label="Book actions for ${sampleBook.title}"]`,
    );
    expect(actionsAfterRemove).toBeTruthy();
    actionsAfterRemove!.click();
    await settle();

    const exportMarkdownBtn = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Export notes (Markdown)'),
    );
    expect(exportMarkdownBtn).toBeTruthy();
  });

  it('exports JSON/Markdown backups with readonly fallback when Documents fails and restores JSON backups', async () => {
    const restorableUnavailableBook: BookRecord = {
      ...sampleBook,
      id: 'primary:2:99',
      title: 'Restored Notes Book',
      downloadPath: null,
      downloadStatus: 'none',
      fileSize: null,
      remoteAvailable: false,
    };
    mocks.setBooks([sampleBook, restorableUnavailableBook]);
    mocks.preferences.set(
      `readerAnnotations:${sampleBook.id}`,
      JSON.stringify([
        {
          id: 'ann-1',
          cfi: 'epubcfi(/6/4)',
          excerpt: 'Light is the left hand of darkness.',
          note: 'Favorite line',
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ]),
    );
    mocks.writeFile.mockRejectedValueOnce(new Error('EACCES: Documents denied'));

    mounted = mountLibrary();
    await settle();

    expect(document.body.textContent).not.toContain('Restored Notes Book');

    const settingsBtn = document.querySelector<HTMLButtonElement>('[aria-label="Open settings"]');
    expect(settingsBtn).toBeTruthy();
    settingsBtn!.click();
    await settle();

    const exportJsonBtn = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Export JSON backup'),
    );
    expect(exportJsonBtn).toBeTruthy();
    exportJsonBtn!.click();
    await settle();

    const fallbackTextarea = document.querySelector<HTMLTextAreaElement>(
      '#turnleaf-notes-backup-output',
    );
    expect(fallbackTextarea).toBeTruthy();
    expect(fallbackTextarea?.readOnly).toBe(true);
    expect(fallbackTextarea?.value).toContain('Light is the left hand of darkness.');

    const pasteToggleBtn = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Paste JSON backup'),
    );
    pasteToggleBtn!.click();
    await settle();

    const backupToRestore = JSON.stringify({
      format: 'turnleaf-reading-notes',
      version: 1,
      exportedAt: '2026-03-05T00:00:00.000Z',
      books: [
        {
          bookId: restorableUnavailableBook.id,
          title: restorableUnavailableBook.title,
          author: restorableUnavailableBook.author,
          series: restorableUnavailableBook.series,
          bookmarks: [
            {
              id: 'epubcfi(/6/8)|ch4.xhtml',
              cfi: 'epubcfi(/6/8)',
              href: 'ch4.xhtml',
              percentage: 0.5,
              label: 'Halfway mark',
              savedAt: '2026-03-05T00:00:00.000Z',
            },
          ],
          annotations: [],
        },
      ],
    });

    const pasteArea = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder*="turnleaf-reading-notes"]',
    );
    expect(pasteArea).toBeTruthy();
    pasteArea!.value = backupToRestore;
    pasteArea!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    const restoreBtn = [...document.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('Restore pasted JSON'),
    );
    restoreBtn!.click();
    await settle();

    expect(mocks.preferences.get(`readerBookmarks:${restorableUnavailableBook.id}`)).toContain(
      'Halfway mark',
    );
    expect(document.body.textContent).toContain('Restored bookmarks and notes for 1 book.');

    const closeSettingsBtn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Close settings"]',
    );
    closeSettingsBtn?.click();
    await settle();

    expect(document.body.textContent).toContain('Restored Notes Book');
  });

  it('aborts deleteServer before deleting any downloaded EPUB when credential or DB removal fails, and surfaces file cleanup errors afterward', async () => {
    mocks.setBooks([sampleBook]);
    const onServerDeleted = vi.fn();
    mounted = mountLibrary(onServerDeleted);
    await settle();

    const settingsBtn = document.querySelector<HTMLButtonElement>('[aria-label="Open settings"]');
    settingsBtn!.click();
    await settle();

    // 1. Credential removal failure -> zero EPUBs deleted
    mocks.removeApiKey.mockRejectedValueOnce(new Error('Keystore locked'));
    const deleteServerBtn = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete server',
    )!;
    deleteServerBtn.click();
    await settle();

    expect(document.body.textContent).toContain('Export your bookmarks and reading notes first');
    let deleteNowBtn = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    )!;
    deleteNowBtn.click();
    await settle();

    expect(mocks.deleteDownloadedEpub).not.toHaveBeenCalled();
    expect(mocks.removeServer).not.toHaveBeenCalled();
    expect(onServerDeleted).not.toHaveBeenCalled();

    // 2. Credential removal succeeds, DB removeServer fails -> zero EPUBs deleted
    mocks.removeServer.mockRejectedValueOnce(new Error('SQLite busy'));
    deleteServerBtn.click();
    await settle();
    deleteNowBtn = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    )!;
    deleteNowBtn.click();
    await settle();

    expect(mocks.deleteDownloadedEpub).not.toHaveBeenCalled();
    expect(onServerDeleted).not.toHaveBeenCalled();
    expect(document.querySelector('#settings-key-error')?.textContent).toContain(
      'local server configuration could not be cleared',
    );

    // 3. DB removeServer succeeds, EPUB deletion fails -> surfaces file cleanup error
    mocks.events.length = 0;
    mocks.deleteDownloadedEpub.mockImplementationOnce(async (path: string) => {
      mocks.events.push(`deleteDownloadedEpub:${path}`);
      throw new Error('EBUSY');
    });
    deleteServerBtn.click();
    await settle();
    deleteNowBtn = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    )!;
    deleteNowBtn.click();
    await settle();

    expect(mocks.events).toEqual([
      'removeServer:primary',
      'deleteDownloadedEpub:books/primary-1-10.epub',
    ]);
    expect(onServerDeleted).not.toHaveBeenCalled();
    expect(document.querySelector('#settings-key-error')?.textContent).toContain(
      'downloaded EPUB file could not be deleted',
    );

    // 4. Retry succeeds and completes server removal
    deleteServerBtn.click();
    await settle();
    deleteNowBtn = [...document.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete now',
    )!;
    deleteNowBtn.click();
    await settle();

    expect(onServerDeleted).toHaveBeenCalledOnce();
  });
});
