// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type * as ThemesModule from './lib/themes/themes';

const mocks = vi.hoisted(() => {
  const backListeners = new Set<() => void>();
  const networkListeners = new Set<
    (status: { connected: boolean; connectionType?: string }) => void
  >();
  return {
    backListeners,
    networkListeners,
    exitApp: vi.fn(async () => {}),
    getServer: vi.fn(),
    saveServer: vi.fn(),
    removeServer: vi.fn(),
    getPreferences: vi.fn(),
    setPreference: vi.fn(),
    getBooks: vi.fn(),
    getSyncStatus: vi.fn(),
    reconcileBooks: vi.fn(),
    getApiKey: vi.fn(),
    saveApiKey: vi.fn(),
    removeApiKey: vi.fn(),
    fetchLatestGithubRelease: vi.fn(),
    loadTheme: vi.fn(),
    networkConnected: true,
  };
});

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: () => void) => {
      if (event === 'backButton') {
        mocks.backListeners.add(listener);
        return {
          remove: async () => {
            mocks.backListeners.delete(listener);
          },
        };
      }
      return { remove: async () => {} };
    }),
    exitApp: mocks.exitApp,
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: mocks.networkConnected })),
    addListener: vi.fn(
      async (
        event: string,
        listener: (status: { connected: boolean; connectionType?: string }) => void,
      ) => {
        if (event === 'networkStatusChange') {
          mocks.networkListeners.add(listener);
          return {
            remove: async () => {
              mocks.networkListeners.delete(listener);
            },
          };
        }
        return { remove: async () => {} };
      },
    ),
  },
}));

vi.mock('./lib/database/database', () => ({
  getServer: mocks.getServer,
  saveServer: mocks.saveServer,
  removeServer: mocks.removeServer,
  getPreferences: mocks.getPreferences,
  setPreference: mocks.setPreference,
  getBooks: mocks.getBooks,
  getReadingState: vi.fn(async () => null),
  getSyncStatus: mocks.getSyncStatus,
  acceptRemoteProgress: vi.fn(async () => {}),
  markDownloaded: vi.fn(async () => {}),
  markBookCompleted: vi.fn(async () => {}),
  removeDownload: vi.fn(async () => {}),
  reconcileBooks: mocks.reconcileBooks,
  saveLocalProgress: vi.fn(async () => {}),
  saveRemoteProgress: vi.fn(async () => {}),
  resetLocalDatabase: vi.fn(async () => {}),
}));

vi.mock('./lib/native/credentials', () => ({
  getApiKey: mocks.getApiKey,
  saveApiKey: mocks.saveApiKey,
  removeApiKey: mocks.removeApiKey,
}));

vi.mock('./lib/github/releases', () => ({
  fetchLatestGithubRelease: mocks.fetchLatestGithubRelease,
}));

vi.mock('./lib/themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    skeletonThemes: ['fennec', 'vintage'],
    loadTheme: mocks.loadTheme,
  };
});

vi.mock('./lib/downloads/native-download', () => ({
  EPUB_DOWNLOAD_ENDPOINT: '/api/Download/chapter',
  EpubTransferError: class extends Error {},
  cacheCover: vi.fn(async () => ''),
  clearCoverCache: vi.fn(async () => {}),
  cleanupInterruptedEpubDownloads: vi.fn(async () => {}),
  deleteDownloadedEpub: vi.fn(async () => {}),
  downloadEpub: vi.fn(async () => ''),
  verifyDownloadedEpub: vi.fn(async () => {}),
}));

import App from './App.svelte';
import { clearDiagnostics, exportDiagnostics } from './lib/diagnostics/log';

let target: HTMLDivElement;
let instance: Record<string, unknown> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
  flushSync();
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function pasteText(input: HTMLInputElement, text: string): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
    },
  });
  const notCancelled = input.dispatchEvent(event);
  flushSync();
  return notCancelled;
}

function pressAndroidBack(): void {
  for (const listener of [...mocks.backListeners]) {
    listener();
  }
  flushSync();
}

describe('Onboarding, inline Settings address editing, OPDS paste, and Android Back', () => {
  beforeEach(async () => {
    mocks.backListeners.clear();
    mocks.networkListeners.clear();
    await clearDiagnostics();
    mocks.exitApp.mockClear();
    mocks.getServer.mockReset().mockResolvedValue(null);
    mocks.saveServer.mockReset().mockResolvedValue(undefined);
    mocks.removeServer.mockReset().mockResolvedValue(undefined);
    mocks.getPreferences.mockReset().mockResolvedValue(new Map());
    mocks.setPreference.mockReset().mockResolvedValue(undefined);
    mocks.getBooks.mockReset().mockResolvedValue([]);
    mocks.getSyncStatus.mockReset().mockResolvedValue({
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastUpdatedAt: null,
    });
    mocks.reconcileBooks.mockReset().mockResolvedValue(undefined);
    mocks.getApiKey.mockReset().mockResolvedValue(null);
    mocks.saveApiKey.mockReset().mockResolvedValue(undefined);
    mocks.removeApiKey.mockReset().mockResolvedValue(undefined);
    mocks.fetchLatestGithubRelease.mockReset().mockResolvedValue(null);
    mocks.loadTheme.mockReset().mockResolvedValue(true);
    mocks.networkConnected = true;

    if (typeof Element.prototype.animate !== 'function') {
      Element.prototype.animate = () =>
        ({
          finished: Promise.resolve(),
          cancel: () => {},
          onfinish: null,
        }) as unknown as Animation;
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/Library/libraries')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => [{ id: 1, name: 'Books', type: 2 }],
          };
        }
        if (url.endsWith('/api/Health')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ version: '0.8.5' }),
          };
        }
        if (url.includes('/api/Series/v2')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => [],
          };
        }
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          json: async () => ({}),
        };
      }) as unknown as typeof fetch,
    );

    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (instance) {
      unmount(instance);
      instance = null;
    }
    target.remove();
  });

  it('disables native validation and mobile text corrections, parses OPDS pastes, and accepts bare hosts in Onboarding', async () => {
    instance = mount(App, { target });
    await settle();

    const form = target.querySelector('form')!;
    expect(form.hasAttribute('novalidate')).toBe(true);

    const urlInput = target.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = target.querySelector<HTMLInputElement>('#kavita-auth-key')!;

    for (const input of [urlInput, keyInput]) {
      expect(input.getAttribute('autocapitalize')).toBe('none');
      expect(input.getAttribute('autocorrect')).toBe('off');
      expect(input.getAttribute('spellcheck')).toBe('false');
    }

    // Paste OPDS URL into empty form -> extracts baseUrl and populates empty key field
    pasteText(urlInput, 'https://books.example.com/kavita/api/opds/opds-token-42');
    expect(urlInput.value).toBe('https://books.example.com/kavita');
    expect(keyInput.value).toBe('opds-token-42');

    // Pasting another OPDS URL when key is non-empty updates baseUrl without overwriting key
    pasteText(urlInput, 'https://mirror.example.com/kavita/api/opds/other-token');
    expect(urlInput.value).toBe('https://mirror.example.com/kavita');
    expect(keyInput.value).toBe('opds-token-42');

    // Bare host with port also submits cleanly without native validation blocking it
    setInputValue(urlInput, '192.168.1.8:5000');
    target.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();

    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.8:5000/api/Library/libraries',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'opds-token-42' }),
      }),
    );
    expect(mocks.saveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://192.168.1.8:5000',
      }),
    );
  });

  it('marks the server address input invalid with route guidance on HTTP 404 during connection tests', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response);

    instance = mount(App, { target });
    await settle();

    const urlInput = target.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = target.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    setInputValue(urlInput, 'books.example.com/wrong-subpath');
    setInputValue(keyInput, 'valid-key');

    target.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();

    expect(urlInput.getAttribute('aria-invalid')).toBe('true');
    expect(keyInput.getAttribute('aria-invalid')).toBeNull();
    expect(target.querySelector('#connection-error')?.textContent).toContain('404');
  });

  it('edits server address inline in Settings, preserves catalog & focus on cancel, and reuses active auth key on save', async () => {
    mocks.getServer.mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://192.168.1.8:5000',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.getApiKey.mockResolvedValue('saved-active-key');

    instance = mount(App, { target });
    await settle();

    const seriesCallsAfterMount = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes('/api/Series/v2')).length;
    expect(seriesCallsAfterMount).toBe(1);

    const openSettingsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Open settings"]',
    )!;
    openSettingsBtn.focus();
    openSettingsBtn.click();
    await settle();

    const replacementKeyInput = target.querySelector<HTMLInputElement>('#replacement-api-key')!;
    expect(replacementKeyInput.getAttribute('autocapitalize')).toBe('none');
    expect(replacementKeyInput.getAttribute('autocorrect')).toBe('off');
    expect(replacementKeyInput.getAttribute('spellcheck')).toBe('false');
    expect(replacementKeyInput.closest('form')?.hasAttribute('novalidate')).toBe(true);

    const changeBtn = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    )!;
    changeBtn.focus();
    changeBtn.click();
    await settle();

    // Library remains mounted and focus moves to inline server URL input
    expect(target.querySelector('[aria-label="Open settings"]')).not.toBeNull();
    const inlineUrlInput = target.querySelector<HTMLInputElement>('#settings-server-url')!;
    expect(inlineUrlInput).not.toBeNull();
    expect(document.activeElement).toBe(inlineUrlInput);
    expect(inlineUrlInput.getAttribute('autocapitalize')).toBe('none');
    expect(inlineUrlInput.getAttribute('autocorrect')).toBe('off');
    expect(inlineUrlInput.getAttribute('spellcheck')).toBe('false');
    expect(inlineUrlInput.closest('form')?.hasAttribute('novalidate')).toBe(true);

    // Cancel inline edit -> keeps Library & Settings mounted, skips catalog reload, restores focus
    setInputValue(inlineUrlInput, 'books.example.com');
    const cancelBtn = Array.from(
      inlineUrlInput.closest('form')!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((btn) => btn.textContent?.trim() === 'Cancel')!;
    cancelBtn.click();
    await settle();

    const seriesCallsAfterCancel = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes('/api/Series/v2')).length;
    expect(seriesCallsAfterCancel).toBe(seriesCallsAfterMount);

    const restoredChangeBtn = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    )!;
    expect(document.activeElement).toBe(restoredChangeBtn);
    expect(document.activeElement).not.toBe(document.body);

    // Reopen inline edit and save with blank replacement key -> reuses saved-active-key
    restoredChangeBtn.click();
    await settle();

    const reopenedUrlInput = target.querySelector<HTMLInputElement>('#settings-server-url')!;
    setInputValue(reopenedUrlInput, 'https://books.example.com/preferences#clients');
    expect(replacementKeyInput.value).toBe('');

    reopenedUrlInput
      .closest('form')!
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click();
    await settle();

    expect(fetch).toHaveBeenCalledWith(
      'https://books.example.com/api/Library/libraries',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'saved-active-key' }),
      }),
    );
    expect(mocks.saveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://books.example.com',
      }),
    );
    expect(target.textContent).toContain('https://books.example.com');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('steps Android Back through inline Settings edit, Settings dialog, and app exit cleanly', async () => {
    mocks.getServer.mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.getApiKey.mockResolvedValue('saved-active-key');

    instance = mount(App, { target });
    await settle();

    const openSettingsBtn = target.querySelector<HTMLButtonElement>(
      '[aria-label="Open settings"]',
    )!;
    openSettingsBtn.focus();
    openSettingsBtn.click();
    await settle();

    const changeBtn = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    )!;
    changeBtn.focus();
    changeBtn.click();
    await settle();

    expect(target.querySelector('#settings-server-url')).not.toBeNull();

    // 1st Back: cancels inline address editing and restores focus inside Settings
    pressAndroidBack();
    await settle();
    expect(target.querySelector('#settings-server-url')).toBeNull();
    expect(target.querySelector('#library-settings-title')).not.toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Change server address');
    expect(mocks.exitApp).not.toHaveBeenCalled();

    // 2nd Back: closes Settings and restores focus to Open settings button
    pressAndroidBack();
    await settle();
    expect(document.activeElement).toBe(openSettingsBtn);
    expect(mocks.exitApp).not.toHaveBeenCalled();

    // 3rd Back: exits Turnleaf cleanly via App.svelte
    pressAndroidBack();
    await settle();
    expect(mocks.exitApp).toHaveBeenCalledTimes(1);
  });

  it('handles Android Back during startup recovery and top-level onboarding without stalling', async () => {
    mocks.getServer.mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.getApiKey.mockRejectedValueOnce(new Error('Keystore locked'));

    instance = mount(App, { target });
    await settle();

    // Dismiss startup error to enter startup recovery
    const enterKeyBtn = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Enter auth key',
    )!;
    enterKeyBtn.click();
    await settle();

    const changeAddressToggle = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    )!;
    changeAddressToggle.click();
    await settle();

    expect(target.querySelector('input[type="url"]')).not.toBeNull();

    // 1st Back during startup recovery returns to saved address prompt and restores focus
    pressAndroidBack();
    await settle();
    expect(target.querySelector('input[type="url"]')).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Change server address');
    expect(mocks.exitApp).not.toHaveBeenCalled();

    // 2nd Back at top-level prompt exits Turnleaf cleanly
    pressAndroidBack();
    await settle();
    expect(mocks.exitApp).toHaveBeenCalledTimes(1);
  });

  it('supports OPDS paste, plain HTTP confirmation, and rollback in inline Settings address editing', async () => {
    mocks.getServer.mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://old.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.4',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.getApiKey.mockResolvedValue('saved-active-key');

    instance = mount(App, { target });
    await settle();

    target.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await settle();

    const changeBtn = Array.from(target.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Change server address',
    )!;
    changeBtn.click();
    await settle();

    const inlineUrlInput = target.querySelector<HTMLInputElement>('#settings-server-url')!;
    const replacementKeyInput = target.querySelector<HTMLInputElement>('#replacement-api-key')!;
    const inlineForm = inlineUrlInput.closest('form')!;
    const submitBtn = inlineForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    // Plain HTTP requires explicit allowHttp confirmation
    setInputValue(inlineUrlInput, 'http://192.168.1.9:5000');
    submitBtn.click();
    await settle();
    expect(inlineUrlInput.getAttribute('aria-invalid')).toBe('true');
    expect(target.querySelector('#settings-address-error')?.textContent).toContain(
      'unencrypted HTTP',
    );
    expect(mocks.saveServer).not.toHaveBeenCalled();

    // Pasting an OPDS URL extracts baseUrl and populates blank replacement key
    pasteText(inlineUrlInput, 'https://books.example.com/kavita/api/opds/pasted-settings-key');
    expect(inlineUrlInput.value).toBe('https://books.example.com/kavita');
    expect(replacementKeyInput.value).toBe('pasted-settings-key');

    // Simulate saveServer failure -> rolls back rotated key and preserves old server
    mocks.saveServer.mockRejectedValueOnce(new Error('SQLite busy'));
    submitBtn.click();
    await settle();

    const rotatedRef = mocks.saveApiKey.mock.calls[0]?.[0];
    expect(rotatedRef).toBeTruthy();
    expect(rotatedRef).not.toBe('server_primary_api_key');
    expect(mocks.removeApiKey).toHaveBeenCalledWith(rotatedRef);
    expect(target.querySelector('#settings-address-error')?.textContent).toContain(
      'saved connection and auth key were left in place',
    );
    expect(target.textContent).toContain('https://old.example.com');

    // Retry succeeds and never stores OPDS token in baseUrl
    submitBtn.click();
    await settle();

    expect(mocks.saveServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseUrl: 'https://books.example.com/kavita',
      }),
    );
    expect(mocks.saveServer.mock.calls.at(-1)?.[0]?.baseUrl).not.toContain('pasted-settings-key');
  });

  it('registers a single native backButton listener, consumes Back while busy, and redacts OPDS tokens from diagnostics', async () => {
    let resolveAuthCheck!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveAuthCheck = resolve;
        }),
    );

    instance = mount(App, { target });
    await settle();
    expect(mocks.backListeners.size).toBe(1);

    const urlInput = target.querySelector<HTMLInputElement>('input[type="url"]')!;
    pasteText(urlInput, 'https://secret-host.example.com/kavita/api/opds/ultra-secret-opds-token');

    target.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    flushSync();

    // Pressing Back while connection verification is busy must neither exit nor reset inputs
    pressAndroidBack();
    await settle();
    expect(mocks.exitApp).not.toHaveBeenCalled();

    resolveAuthCheck({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ message: 'Unauthorized ultra-secret-opds-token' }),
    } as unknown as Response);
    await settle();

    const exported = exportDiagnostics({ appVersion: '0.3.5', platform: 'web' });
    expect(exported).toContain('endpoint=/api/Library/libraries status=401');
    expect(exported).not.toContain('ultra-secret-opds-token');
    expect(exported).not.toContain('secret-host.example.com');
  });

  it('sends zero authenticated requests after offline transition even when preceded by a cellular handoff event', async () => {
    mocks.getServer.mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.5',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.getApiKey.mockResolvedValue('saved-active-key');

    instance = mount(App, { target });
    await settle();
    expect(mocks.backListeners.size).toBe(1);

    vi.mocked(fetch).mockClear();

    // Simulate Wi-Fi disabling first (brief cellular connected event while already online)
    for (const listener of mocks.networkListeners) {
      listener({ connected: true, connectionType: 'cellular' });
    }
    // Immediately followed by mobile data disabling (full offline)
    mocks.networkConnected = false;
    for (const listener of mocks.networkListeners) {
      listener({ connected: false, connectionType: 'none' });
    }
    await settle();

    expect(fetch).not.toHaveBeenCalled();
  });
});
