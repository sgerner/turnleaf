// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../database/database';
import type * as NativeDownloadModule from '../downloads/native-download';
import type * as ThemesModule from '../themes/themes';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = () => {
    const animation = {
      onfinish: null as (() => void) | null,
      cancel() {},
      finish() {
        animation.onfinish?.();
      },
      finished: Promise.resolve(),
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

const { appListeners, exitAppMock, testConnectionMock, saveApiKeyMock, saveServerMock } =
  vi.hoisted(() => {
    const listeners = new Map<string, Array<() => void>>();
    return {
      appListeners: listeners,
      exitAppMock: vi.fn(async () => undefined),
      testConnectionMock: vi.fn(),
      saveApiKeyMock: vi.fn(async () => undefined),
      saveServerMock: vi.fn(async () => undefined),
    };
  });

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (eventName: string, callback: () => void) => {
      const bucket = appListeners.get(eventName) ?? [];
      bucket.push(callback);
      appListeners.set(eventName, bucket);
      return {
        remove: vi.fn(async () => {
          const list = appListeners.get(eventName);
          if (!list) return;
          const index = list.indexOf(callback);
          if (index >= 0) list.splice(index, 1);
        }),
      };
    }),
    exitApp: exitAppMock,
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: false, connectionType: 'none' })),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));

vi.mock('../downloads/native-download', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeDownloadModule>();
  return {
    ...actual,
    cleanupInterruptedEpubDownloads: vi.fn(async () => undefined),
  };
});

vi.mock('../database/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    getBooks: vi.fn(async () => []),
    getPreferences: vi.fn(async () => new Map()),
    getServer: vi.fn(async () => null),
    getSyncStatus: vi.fn(async () => ({ pendingCount: 0, conflictCount: 0, lastError: null })),
    resetLocalDatabase: vi.fn(async () => undefined),
    saveServer: saveServerMock,
  };
});

vi.mock('../native/credentials', () => ({
  getApiKey: vi.fn(async () => null),
  removeApiKey: vi.fn(async () => undefined),
  saveApiKey: saveApiKeyMock,
}));

vi.mock('../github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => null),
}));

vi.mock('../themes/themes', async (importOriginal) => {
  const actual = await importOriginal<typeof ThemesModule>();
  return {
    ...actual,
    loadTheme: vi.fn(async () => true),
    skeletonThemes: ['fennec'],
  };
});

vi.mock('../kavita/client', () => ({
  KavitaError: class KavitaError extends Error {
    kind = 'network';
  },
  KavitaClient: class {
    testConnection = testConnectionMock;
  },
}));

import { createBackButtonStack, handleLibraryBack, handleOnboardingBack } from './back-button';
import { getPreferences, getServer } from '../database/database';
import { getApiKey } from '../native/credentials';
import Onboarding from '../components/Onboarding.svelte';
import RootApp from '../../App.svelte';

function emitNativeBack(): void {
  for (const listener of [...(appListeners.get('backButton') ?? [])]) {
    listener();
  }
}

describe('centralized LIFO Back stack', () => {
  let host: HTMLDivElement;
  let mounted: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    appListeners.clear();
    host = document.createElement('div');
    document.body.append(host);
    mounted = null;
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    host.remove();
  });

  it('dispatches handlers in LIFO order and falls back to exitApp when unhandled', () => {
    const order: string[] = [];
    const exitApp = vi.fn();
    const stack = createBackButtonStack({ exitApp });

    let libraryOpenLayer = true;
    let readerOpenLayer = true;

    stack.register(() => {
      order.push('library');
      if (!libraryOpenLayer) return false;
      libraryOpenLayer = false;
      return true;
    });
    const removeReader = stack.register(() => {
      order.push('reader');
      if (!readerOpenLayer) return false;
      readerOpenLayer = false;
      return true;
    });

    expect(stack.dispatch()).toBe(true);
    expect(order).toEqual(['reader']);
    expect(exitApp).not.toHaveBeenCalled();

    removeReader();
    removeReader();

    expect(stack.dispatch()).toBe(true);
    expect(order).toEqual(['reader', 'library']);
    expect(exitApp).not.toHaveBeenCalled();

    expect(stack.dispatch()).toBe(false);
    expect(order).toEqual(['reader', 'library', 'library']);
    expect(exitApp).toHaveBeenCalledOnce();
  });

  it('handles library overlays in priority order and yields when idle', () => {
    const actions = {
      closeConflict: vi.fn(),
      closeMenu: vi.fn(),
      closeReader: vi.fn(),
      closeSettings: vi.fn(),
      hideFilters: vi.fn(),
    };
    const baseState = {
      hasConflict: false,
      acceptingRemoteProgress: false,
      hasActionMenu: false,
      hasOpenReader: false,
      settingsVisible: false,
      filtersVisible: false,
    };

    expect(
      handleLibraryBack(
        { ...baseState, hasConflict: true, acceptingRemoteProgress: true },
        actions,
      ),
    ).toBe(true);
    expect(actions.closeConflict).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...baseState, hasConflict: true }, actions)).toBe(true);
    expect(actions.closeConflict).toHaveBeenCalledOnce();

    expect(handleLibraryBack({ ...baseState, hasActionMenu: true }, actions)).toBe(true);
    expect(actions.closeMenu).toHaveBeenCalledOnce();

    expect(handleLibraryBack({ ...baseState, hasOpenReader: true }, actions)).toBe(true);
    expect(actions.closeReader).toHaveBeenCalledOnce();

    expect(handleLibraryBack({ ...baseState, settingsVisible: true }, actions)).toBe(true);
    expect(actions.closeSettings).toHaveBeenCalledOnce();

    expect(handleLibraryBack({ ...baseState, filtersVisible: true }, actions)).toBe(true);
    expect(actions.hideFilters).toHaveBeenCalledOnce();

    expect(handleLibraryBack(baseState, actions)).toBe(false);
  });

  it('cancels server address edits on Back and ignores Back while busy connecting', async () => {
    let releaseConnection!: (value: {
      version: string;
      bookLibraries: Array<{ id: number }>;
    }) => void;
    testConnectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseConnection = resolve;
        }),
    );

    const exitApp = vi.fn();
    const onCancel = vi.fn();
    const onConnected = vi.fn();
    const stack = createBackButtonStack({ exitApp });

    mounted = mount(Onboarding, {
      target: host,
      props: {
        savedServer: {
          id: 'primary',
          displayName: 'Books',
          baseUrl: 'https://books.example.com',
          credentialRef: 'server_primary_api_key',
          kavitaVersion: '0.8.0',
          lastConnectedAt: '2026-01-01T00:00:00.000Z',
        },
        editAddress: true,
        onCancel,
        registerBackHandler: stack.register,
        onConnected,
      },
    });
    await tick();

    expect(stack.dispatch()).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(exitApp).not.toHaveBeenCalled();

    const keyInput = host.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    keyInput.value = 'secret-key';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    host
      .querySelector('form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(stack.dispatch()).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(exitApp).not.toHaveBeenCalled();

    releaseConnection({ version: '0.8.1', bookLibraries: [{ id: 1 }] });
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('invokes App.exitApp() on cold-start Onboarding and startupError in App.svelte', async () => {
    expect(handleOnboardingBack({ busy: false, onCancel: undefined })).toBe(false);
    expect(handleOnboardingBack({ busy: true, onCancel: undefined })).toBe(true);

    vi.mocked(getPreferences).mockResolvedValue(new Map());
    vi.mocked(getServer).mockResolvedValue(null);

    mounted = mount(RootApp, { target: host });
    await vi.waitFor(() => expect(host.querySelector('input[type="url"]')).not.toBeNull());
    await vi.waitFor(() => expect(appListeners.get('backButton')?.length).toBe(1));

    emitNativeBack();
    expect(exitAppMock).toHaveBeenCalledTimes(1);

    await unmount(mounted);
    mounted = null;

    vi.mocked(getServer).mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.0',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getApiKey).mockRejectedValue(new Error('Keystore locked'));

    mounted = mount(RootApp, { target: host });
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'could not read the saved Kavita key',
      ),
    );
    await vi.waitFor(() => expect(appListeners.get('backButton')?.length).toBe(1));

    emitNativeBack();
    expect(exitAppMock).toHaveBeenCalledTimes(2);
  });

  it('cancels changingServerAddress on Android Back in App.svelte and remounts Library.svelte', async () => {
    vi.mocked(getPreferences).mockResolvedValue(new Map());
    vi.mocked(getServer).mockResolvedValue({
      id: 'primary',
      displayName: 'Books',
      baseUrl: 'https://books.example.com',
      credentialRef: 'server_primary_api_key',
      kavitaVersion: '0.8.0',
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getApiKey).mockResolvedValue('valid-key');

    mounted = mount(RootApp, { target: host });
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Open settings"]')).not.toBeNull(),
    );
    await vi.waitFor(() => expect(appListeners.get('backButton')?.length).toBe(1));

    host.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click();
    await tick();

    const changeAddressButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Change server address',
    );
    expect(changeAddressButton).not.toBeUndefined();
    changeAddressButton!.click();
    await tick();

    expect(host.querySelector('input[type="url"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Open settings"]')).toBeNull();

    emitNativeBack();
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Open settings"]')).not.toBeNull(),
    );
    expect(host.querySelector('input[type="url"]')).toBeNull();
    expect(exitAppMock).not.toHaveBeenCalled();
  });
});
