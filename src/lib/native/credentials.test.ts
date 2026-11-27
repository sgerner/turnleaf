import { beforeEach, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  setKeyPrefix: vi.fn(async () => undefined),
  setSynchronize: vi.fn(async () => undefined),
  get: vi.fn<() => Promise<unknown>>(async () => null),
  set: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: secureStorage }));

beforeEach(async () => {
  secureStorage.setKeyPrefix.mockClear();
  secureStorage.setSynchronize.mockClear();
  secureStorage.get.mockReset().mockResolvedValue(null);
  secureStorage.set.mockReset().mockResolvedValue(undefined);
  secureStorage.remove.mockReset().mockResolvedValue(undefined);
  const { resetCredentialState } = await import('./credentials');
  resetCredentialState();
});

it('reports secure-storage deletion failures without hiding them', async () => {
  secureStorage.remove.mockRejectedValueOnce(new Error('keystore locked'));
  const { removeApiKey } = await import('./credentials');

  await expect(removeApiKey('server_primary_api_key')).rejects.toThrow(
    'Could not remove the saved Kavita auth key.',
  );
  expect(secureStorage.remove).toHaveBeenCalledWith('server_primary_api_key');
});

it('tracks missing, unreadable, and ready states across secure-storage reads and writes', async () => {
  const { canSendCredential, getApiKey, getCredentialState, saveApiKey, subscribeCredentialState } =
    await import('./credentials');

  const baseEpoch = getCredentialState().epoch;
  const states: string[] = [];
  const unsubscribe = subscribeCredentialState((state) => {
    states.push(`${state.status}@${state.epoch}`);
  });

  secureStorage.get.mockResolvedValueOnce(null);
  await expect(getApiKey('server_primary_api_key')).resolves.toBeNull();
  expect(getCredentialState()).toMatchObject({ status: 'missing' });
  expect(canSendCredential('', getCredentialState().epoch)).toBe(false);

  secureStorage.get.mockResolvedValueOnce('   ');
  await expect(getApiKey('server_primary_api_key')).resolves.toBeNull();
  expect(getCredentialState()).toMatchObject({ status: 'missing' });

  secureStorage.get.mockRejectedValueOnce(new Error('Invalid data'));
  await expect(getApiKey('server_primary_api_key')).rejects.toThrow('Invalid data');
  expect(getCredentialState()).toMatchObject({ status: 'unreadable' });

  await expect(saveApiKey('server_primary_api_key', '   ')).rejects.toThrow(
    'Enter a Kavita auth key.',
  );

  await saveApiKey('server_primary_api_key', 'fresh-key');
  const savedEpoch = getCredentialState().epoch;
  expect(getCredentialState()).toEqual({ status: 'ready', epoch: savedEpoch });
  expect(canSendCredential('fresh-key', savedEpoch)).toBe(true);

  unsubscribe();
  expect(states).toEqual([
    `missing@${baseEpoch + 1}`,
    `missing@${baseEpoch + 2}`,
    `unreadable@${baseEpoch + 3}`,
    `ready@${savedEpoch}`,
  ]);
});

it('prevents a late 401 from an older epoch from tripping a newly saved key', async () => {
  const { canSendCredential, getCredentialState, markCredentialRejected, saveApiKey } =
    await import('./credentials');

  await saveApiKey('server_primary_api_key', 'stale-key');
  const staleEpoch = getCredentialState().epoch;

  await saveApiKey('server_primary_api_key', 'rotated-key');
  const rotatedEpoch = getCredentialState().epoch;
  expect(rotatedEpoch).toBeGreaterThan(staleEpoch);

  expect(markCredentialRejected(staleEpoch, 401)).toBe(false);
  expect(getCredentialState()).toEqual({ status: 'ready', epoch: rotatedEpoch });
  expect(canSendCredential('rotated-key', rotatedEpoch)).toBe(true);
  expect(canSendCredential('stale-key', staleEpoch)).toBe(false);

  expect(markCredentialRejected(rotatedEpoch, 401)).toBe(true);
  expect(getCredentialState()).toEqual({
    status: 'rejected',
    epoch: rotatedEpoch,
    statusCode: 401,
  });
  expect(canSendCredential('rotated-key', rotatedEpoch)).toBe(false);
});

it('keeps the newly saved key ready when removing an older credential reference', async () => {
  const { getCredentialState, removeApiKey, saveApiKey } = await import('./credentials');

  await saveApiKey('server_primary_api_key', 'old-key');
  await saveApiKey('server_primary_api_key_new', 'new-key');
  const activeEpoch = getCredentialState().epoch;

  await removeApiKey('server_primary_api_key');

  expect(getCredentialState()).toEqual({ status: 'ready', epoch: activeEpoch });
});

it('fails closed for any non-probe credential when coordinator status is missing, unreadable, rejected, or mismatched', async () => {
  const {
    canSendCredential,
    getCredentialState,
    markCredentialMissing,
    markCredentialRejected,
    markCredentialUnreadable,
    saveApiKey,
  } = await import('./credentials');

  markCredentialMissing(null);
  expect(canSendCredential('stale-in-memory-key')).toBe(false);
  expect(canSendCredential('stale-in-memory-key', getCredentialState().epoch)).toBe(false);

  markCredentialUnreadable('server_primary_api_key');
  expect(canSendCredential('stale-in-memory-key')).toBe(false);
  expect(canSendCredential('stale-in-memory-key', getCredentialState().epoch)).toBe(false);

  await saveApiKey('server_primary_api_key', 'active-key');
  const readyEpoch = getCredentialState().epoch;
  expect(canSendCredential('active-key', readyEpoch)).toBe(true);
  expect(canSendCredential('active-key')).toBe(true);
  expect(canSendCredential('mismatched-key')).toBe(false);
  expect(canSendCredential('mismatched-key', readyEpoch)).toBe(false);

  markCredentialRejected(readyEpoch, 401);
  expect(canSendCredential('active-key', readyEpoch)).toBe(false);
  expect(canSendCredential('active-key')).toBe(false);
  expect(canSendCredential('other-key')).toBe(false);
});
