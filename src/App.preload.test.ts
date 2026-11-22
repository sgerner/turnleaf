// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from './lib/database/database';

const hooks = vi.hoisted(() => ({
  onboardingLoads: 0,
  failOnboardingOnce: false,
  savedServer: null as ServerConfig | null,
  apiKey: null as string | null,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

const server: ServerConfig = {
  id: 'server-1',
  displayName: 'Local Kavita',
  baseUrl: 'https://kavita.example.com',
  credentialRef: 'cred-1',
  kavitaVersion: '0.8.0',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

describe('App cold-launch lazy Onboarding loading', () => {
  let target: HTMLDivElement;
  let cleanupMount: (() => Promise<void>) | null = null;

  beforeEach(() => {
    vi.resetModules();
    hooks.onboardingLoads = 0;
    hooks.failOnboardingOnce = false;
    hooks.savedServer = null;
    hooks.apiKey = null;

    vi.doMock('./lib/database/database', () => ({
      getServer: vi.fn(async () => hooks.savedServer),
      getPreferences: vi.fn(async () => new Map<string, string>()),
      resetLocalDatabase: vi.fn(async () => undefined),
    }));

    vi.doMock('./lib/native/credentials', () => ({
      getApiKey: vi.fn(async () => hooks.apiKey),
    }));

    vi.doMock('./lib/themes/themes', () => ({
      loadTheme: vi.fn(async () => true),
    }));

    vi.doMock('./lib/github/releases', () => ({
      fetchLatestGithubRelease: vi.fn(async () => null),
    }));

    vi.doMock('./lib/components/Library.svelte', () => ({
      default: function MockLibrary(anchor: Comment) {
        const marker = document.createElement('div');
        marker.setAttribute('data-testid', 'mock-library');
        marker.textContent = 'Mock Library Ready';
        anchor.before(marker);
        return {};
      },
    }));

    vi.doMock('./lib/components/Onboarding.svelte', () => {
      hooks.onboardingLoads += 1;
      if (hooks.failOnboardingOnce) {
        hooks.failOnboardingOnce = false;
        throw new Error('simulated onboarding chunk failure');
      }
      return {
        default: function MockOnboarding(anchor: Comment) {
          const marker = document.createElement('div');
          marker.setAttribute('data-testid', 'mock-onboarding');
          marker.textContent = 'Mock Onboarding Ready';
          anchor.before(marker);
          return {};
        },
      };
    });

    target = document.createElement('div');
    document.body.append(target);
  });

  afterEach(async () => {
    if (cleanupMount) {
      await cleanupMount();
      cleanupMount = null;
    }
    target.remove();
  });

  async function mountApp() {
    const svelte = await import('svelte');
    const { default: App } = await import('./App.svelte');
    const instance = svelte.mount(App, { target });
    cleanupMount = () => svelte.unmount(instance);
    return async function flushAsync(turns = 10): Promise<void> {
      for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
      }
      svelte.flushSync();
    };
  }

  it('does not import Onboarding.svelte on cold launch when server credentials exist', async () => {
    hooks.savedServer = server;
    hooks.apiKey = 'valid-key';

    const flushAsync = await mountApp();
    expect(hooks.onboardingLoads).toBe(0);

    await flushAsync(10);

    expect(hooks.onboardingLoads).toBe(0);
    expect(target.querySelector('[data-testid="mock-library"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="mock-onboarding"]')).toBeNull();
  });

  it('dynamically imports Onboarding.svelte when unconfigured and retries cleanly after a chunk failure', async () => {
    hooks.failOnboardingOnce = true;

    const flushAsync = await mountApp();
    await flushAsync(10);

    expect(hooks.onboardingLoads).toBe(1);
    expect(target.textContent).toContain('Turnleaf could not load the server setup screen.');

    const retryButton = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry'),
    );
    expect(retryButton).toBeDefined();
    retryButton!.click();
    await flushAsync(10);

    expect(hooks.onboardingLoads).toBe(2);
    expect(target.querySelector('[data-testid="mock-onboarding"]')).not.toBeNull();
  });
});
