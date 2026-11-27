// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  native: true,
}));

const secureStorage = vi.hoisted(() => ({
  setKeyPrefix: vi.fn(async () => undefined),
  setSynchronize: vi.fn(async () => undefined),
  get: vi.fn<(_key: string, _convertDate?: boolean) => Promise<string | null>>(
    async () => 'saved-api-key',
  ),
  set: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: secureStorage }));

beforeEach(() => {
  vi.resetModules();
  platform.native = true;
  window.localStorage.clear();
  secureStorage.setKeyPrefix.mockReset().mockResolvedValue(undefined);
  secureStorage.setSynchronize.mockReset().mockResolvedValue(undefined);
  secureStorage.get.mockReset().mockResolvedValue('saved-api-key');
  secureStorage.set.mockReset().mockResolvedValue(undefined);
  secureStorage.remove.mockReset().mockResolvedValue(undefined);
});

describe('credentials native storage preparation', () => {
  it('memoizes SecureStorage setup across prepare, getApiKey, saveApiKey, and removeApiKey', async () => {
    const { getApiKey, prepare, removeApiKey, saveApiKey } = await import('./credentials');

    await Promise.all([prepare(), getApiKey('server_primary_api_key')]);
    await saveApiKey('server_primary_api_key', 'next-key');
    await removeApiKey('server_primary_api_key');

    expect(secureStorage.setKeyPrefix).toHaveBeenCalledExactlyOnceWith('turnleaf_');
    expect(secureStorage.setSynchronize).toHaveBeenCalledExactlyOnceWith(false);
    expect(secureStorage.get).toHaveBeenCalledWith('server_primary_api_key', false);
    expect(secureStorage.set).toHaveBeenCalledWith('server_primary_api_key', 'next-key');
    expect(secureStorage.remove).toHaveBeenCalledWith('server_primary_api_key');
  });

  it('clears the cached preparation promise when initialization fails and succeeds on retry', async () => {
    secureStorage.setKeyPrefix.mockRejectedValueOnce(new Error('keystore unavailable'));
    const { getApiKey, prepare } = await import('./credentials');

    await expect(prepare()).rejects.toThrow('keystore unavailable');
    await expect(getApiKey('server_primary_api_key')).resolves.toBe('saved-api-key');
    await expect(getApiKey('server_primary_api_key')).resolves.toBe('saved-api-key');

    expect(secureStorage.setKeyPrefix).toHaveBeenCalledTimes(2);
    expect(secureStorage.setSynchronize).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('reports secure-storage deletion failures without hiding them', async () => {
    secureStorage.remove.mockRejectedValueOnce(new Error('keystore locked'));
    const { removeApiKey } = await import('./credentials');

    await expect(removeApiKey('server_primary_api_key')).rejects.toThrow(
      'Could not remove the saved Kavita auth key.',
    );
    expect(secureStorage.remove).toHaveBeenCalledWith('server_primary_api_key');
  });

  it('preserves browser localStorage fallback without touching SecureStorage', async () => {
    platform.native = false;
    const { getApiKey, prepare, removeApiKey, saveApiKey } = await import('./credentials');

    await prepare();
    await saveApiKey('server_primary_api_key', 'browser-secret');
    await expect(getApiKey('server_primary_api_key')).resolves.toBe('browser-secret');
    await removeApiKey('server_primary_api_key');
    await expect(getApiKey('server_primary_api_key')).resolves.toBeNull();

    expect(secureStorage.setKeyPrefix).not.toHaveBeenCalled();
    expect(secureStorage.setSynchronize).not.toHaveBeenCalled();
  });
});
