// @vitest-environment jsdom

import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  native: false,
  files: new Map<string, string>(),
  failDocumentsWrite: false,
  failGetServer: false,
  failGetApiKey: false,
  failResetDatabase: false,
  failSaveServer: false,
  savedServer: null as {
    id: string;
    displayName: string;
    baseUrl: string;
    credentialRef: string;
    kavitaVersion: string | null;
    lastConnectedAt: string;
  } | null,
  savedApiKey: null as string | null,
}));

vi.mock('@capacitor/core', () => ({
  SystemBars: { setStyle: vi.fn().mockResolvedValue(undefined) },
  SystemBarsStyle: {
    Default: 'DEFAULT',
    Dark: 'DARK',
    Light: 'LIGHT',
  },
  Capacitor: {
    isNativePlatform: () => env.native,
    getPlatform: () => (env.native ? 'android' : 'web'),
    convertFileSrc: (value: string) => value,
  },
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Data: 'DATA',
    Documents: 'DOCUMENTS',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    readFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const data = env.files.get(`${directory}:${path}`);
      if (data === undefined) throw new Error('File not found');
      return { data };
    }),
    writeFile: vi.fn(
      async ({ path, data, directory }: { path: string; data: string; directory: string }) => {
        if (directory === 'DOCUMENTS' && env.failDocumentsWrite) {
          throw new Error('Documents directory unavailable');
        }
        env.files.set(`${directory}:${path}`, data);
        return { uri: `file://${directory}/${path}` };
      },
    ),
    deleteFile: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      env.files.delete(`${directory}:${path}`);
    }),
  },
}));

vi.mock('../database/database', () => ({
  getServer: vi.fn(async () => {
    if (env.failGetServer) throw new Error('SQLite open error');
    return env.savedServer;
  }),
  getPreferences: vi.fn(async () => new Map<string, string>()),
  saveServer: vi.fn(async (server) => {
    if (env.failSaveServer) throw new Error('SQLite write error');
    env.savedServer = server;
  }),
  resetLocalDatabase: vi.fn(async () => {
    if (env.failResetDatabase) throw new Error('SQLite delete error');
    env.savedServer = null;
  }),
}));

vi.mock('../native/credentials', () => ({
  getApiKey: vi.fn(async () => {
    if (env.failGetApiKey) throw new Error('Keystore locked');
    return env.savedApiKey;
  }),
  saveApiKey: vi.fn(async (_ref: string, key: string) => {
    env.savedApiKey = key;
  }),
  removeApiKey: vi.fn(async () => {
    env.savedApiKey = null;
  }),
}));

vi.mock('../github/releases', () => ({
  fetchLatestGithubRelease: vi.fn(async () => null),
}));

vi.mock('../themes/themes', () => ({
  loadTheme: vi.fn(async () => true),
  skeletonThemes: ['fennec', 'vintage'],
}));

import { Filesystem } from '@capacitor/filesystem';
import App from '../../App.svelte';
import Onboarding from '../components/Onboarding.svelte';
import { clearDiagnostics, exportDiagnostics, getDiagnosticCount } from './log';

const mountedComponents: Array<Record<string, unknown>> = [];

function renderComponent<Props extends Record<string, unknown>>(
  component: Component<Props>,
  ...args: Record<string, never> extends Props ? [props?: Props] : [props: Props]
): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const [props] = args;
  const instance = mount(
    component,
    (props ? { target: container, props } : { target: container }) as never,
  );
  flushSync();
  mountedComponents.push(instance);
  return { container };
}

async function waitForUi<T>(assertion: () => T): Promise<T> {
  return vi.waitFor(() => {
    flushSync();
    return assertion();
  });
}

function buttonByText(root: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`Button "${label}" not found`);
  }
  return match;
}

describe('shared diagnostics across onboarding and startup', () => {
  beforeEach(async () => {
    env.native = false;
    env.files.clear();
    env.failDocumentsWrite = false;
    env.failGetServer = false;
    env.failGetApiKey = false;
    env.failResetDatabase = false;
    env.failSaveServer = false;
    env.savedServer = null;
    env.savedApiKey = null;
    window.localStorage.clear();
    vi.clearAllMocks();
    await clearDiagnostics();
  });

  if (!Element.prototype.animate) {
    Element.prototype.animate = () =>
      ({
        cancel: () => {},
        finish: () => {},
        onfinish: null,
      }) as unknown as Animation;
  }

  afterEach(async () => {
    for (const instance of mountedComponents.splice(0)) {
      await unmount(instance);
    }
    document.body.innerHTML = '';
  });

  it('exposes redacted diagnostics in Onboarding after testConnection failure and expands textarea on clipboard failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (
          url.includes(encodeURIComponent('/api/Library/libraries')) ||
          url.includes('/api/Library/libraries')
        ) {
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            json: async () => ({ message: 'Invalid key for secret-book-library' }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ version: '0.8.4' }),
        };
      }) as unknown as typeof fetch,
    );

    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderComponent(Onboarding, {
      onConnected: vi.fn(),
    });

    // Diagnostics panel is hidden initially when no error or saved log exists.
    expect(container.querySelector('[aria-label="Turnleaf diagnostics log"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some((b) =>
        b.textContent?.includes('Copy diagnostics'),
      ),
    ).toBe(false);

    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = container.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    urlInput.value = 'https://private-kavita.example.com:5000';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    keyInput.value = 'super-secret-api-key-999';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const form = container.querySelector('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await waitForUi(() => {
      expect(container.querySelector('#connection-error')?.textContent).toContain(
        'Kavita rejected this auth key.',
      );
    });

    const copyButton = buttonByText(container, 'Copy diagnostics');
    copyButton.click();

    await waitForUi(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copiedLog = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copiedLog).toContain('endpoint=/api/Library/libraries status=401');
    expect(copiedLog).not.toContain('private-kavita.example.com');
    expect(copiedLog).not.toContain('super-secret-api-key-999');
    expect(copiedLog).not.toContain('secret-book-library');

    // When clipboard fails on Android/WebView, DiagnosticsPanel expands the readonly textarea.
    copyButton.click();

    const textarea = await waitForUi(() => {
      const field = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Turnleaf diagnostics log"]',
      );
      expect(field).not.toBeNull();
      return field!;
    });
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toContain('endpoint=/api/Library/libraries status=401');
    expect(textarea.value).not.toContain('super-secret-api-key-999');
  });

  it('records allowlisted onboarding setup validation and storage failures without leaking inputs', async () => {
    const { container } = renderComponent(Onboarding, {
      onConnected: vi.fn(),
    });

    const urlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    urlInput.value = 'http://plain-http.example.local:5000';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const form = container.querySelector('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await waitForUi(() => {
      expect(buttonByText(container, 'View diagnostics')).toBeTruthy();
    });
    const logText = exportDiagnostics({ appVersion: '0.3.5', platform: 'web' });
    expect(logText).toContain('validation endpoint=local/setup detail=insecure-http-blocked');
    expect(logText).not.toContain('plain-http.example.local');

    // Also verify server-save-failed is logged when Kavita succeeds but SQLite saveServer fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ id: 1, name: 'Private Shelf', type: 2 }],
      })) as unknown as typeof fetch,
    );
    env.failSaveServer = true;

    urlInput.value = 'https://books.example.com';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    const keyInput = container.querySelector<HTMLInputElement>('#kavita-auth-key')!;
    keyInput.value = 'valid-secret-key';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await waitForUi(() => {
      const afterStorageFailure = exportDiagnostics({ appVersion: '0.3.5', platform: 'web' });
      expect(afterStorageFailure).toContain(
        'startup endpoint=local/database detail=server-save-failed',
      );
      expect(afterStorageFailure).not.toContain('books.example.com');
      expect(afterStorageFailure).not.toContain('valid-secret-key');
      expect(afterStorageFailure).not.toContain('Private Shelf');
    });
  });

  it('shows compact DiagnosticsPanel on Onboarding when persisted logs exist and selects bound textarea text', async () => {
    window.localStorage.setItem(
      'turnleaf_diagnostics_v1',
      JSON.stringify([
        {
          at: '2026-11-21T09:00:00.000Z',
          category: 'request',
          endpoint: '/api/Health',
          detail: 'network-error',
        },
      ]),
    );

    const { container } = renderComponent(App);

    // Onboarding renders with compact DiagnosticsPanel visible immediately because logs exist.
    const viewButton = await waitForUi(() => buttonByText(container, 'View diagnostics'));
    viewButton.click();
    flushSync();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Turnleaf diagnostics log"]',
    )!;
    expect(textarea.value).toContain('endpoint=/api/Health detail=network-error');

    const selectSpy = vi.spyOn(textarea, 'select');
    buttonByText(container, 'Select all text').click();
    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it('hydrates prior logs on startup failure, exports to Directory.Documents on native, expands on export failure, and clears on reset', async () => {
    env.native = true;
    env.failGetServer = true;
    env.files.set(
      'DATA:diagnostics.json',
      JSON.stringify([
        {
          at: '2026-11-21T08:00:00.000Z',
          category: 'response',
          endpoint: 'https://secret.example/api/Library/libraries?apiKey=secret',
          status: 500,
        },
      ]),
    );

    const { container } = renderComponent(App);

    const alert = await waitForUi(() => {
      const el = container.querySelector('[role="alert"]');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('Turnleaf could not open its local data.');
      return el!;
    });

    // Native export succeeds and writes sanitized log to Directory.Documents.
    const downloadButton = buttonByText(container, 'Download log');
    downloadButton.click();

    await waitForUi(() => {
      expect(Filesystem.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: 'DOCUMENTS',
          encoding: 'utf8',
        }),
      );
    });
    const exportedDocEntry = Array.from(env.files.entries()).find(([key]) =>
      key.startsWith('DOCUMENTS:turnleaf-diagnostics-'),
    );
    expect(exportedDocEntry).toBeDefined();
    expect(exportedDocEntry?.[1]).toContain(
      '2026-11-21T08:00:00.000Z response endpoint=/api/Library/libraries status=500',
    );
    expect(exportedDocEntry?.[1]).toContain(
      'startup endpoint=local/database detail=database-open-failed',
    );
    expect(exportedDocEntry?.[1]).not.toContain('secret.example');

    // When Directory.Documents write fails, expands readonly textarea for manual selection.
    env.failDocumentsWrite = true;
    downloadButton.click();

    const textarea = await waitForUi(() => {
      const field = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Turnleaf diagnostics log"]',
      );
      expect(field).not.toBeNull();
      return field!;
    });
    expect(textarea.value).toContain('detail=database-open-failed');

    // Resetting local data clears both in-memory and persisted Directory.Data diagnostics.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    env.failGetServer = false;
    buttonByText(alert, 'Reset local data').click();

    await waitForUi(() => {
      expect(getDiagnosticCount()).toBe(0);
      expect(env.files.has('DATA:diagnostics.json')).toBe(false);
    });
  });
});
