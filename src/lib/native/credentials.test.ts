import { expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  setKeyPrefix: vi.fn(async () => undefined),
  setSynchronize: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: secureStorage }));

it('reports secure-storage deletion failures without hiding them', async () => {
  secureStorage.remove.mockRejectedValueOnce(new Error('keystore locked'));
  const { removeApiKey } = await import('./credentials');

  await expect(removeApiKey('server_primary_api_key')).rejects.toThrow(
    'Could not remove the saved Kavita auth key.',
  );
  expect(secureStorage.remove).toHaveBeenCalledWith('server_primary_api_key');
});
