import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../database/database';
import { clearDiagnostics, exportDiagnostics } from '../diagnostics/log';
import { KavitaError } from './client';
import {
  classifyConnectionError,
  cleanupStaleCredentials,
  INITIAL_SETUP_MESSAGES,
  parseStaleCredentialRefs,
  rotateServerConnection,
  saveConnection,
  STALE_CREDENTIAL_CLEANUP_WARNING,
  STALE_CREDENTIAL_PERSIST_FAILED_WARNING,
  STALE_CREDENTIAL_REFS_PREFERENCE_KEY,
  STALE_CREDENTIAL_STATUS_PERSIST_FAILED_WARNING,
  verifyKavitaConnection,
} from './connection';
import { ServerUrlError } from './url';

const mocks = vi.hoisted(() => ({
  saveServer: vi.fn(),
  setPreference: vi.fn(),
  saveApiKey: vi.fn(),
  removeApiKey: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../database/database', () => ({
  saveServer: mocks.saveServer,
  setPreference: mocks.setPreference,
}));

vi.mock('../native/credentials', () => ({
  saveApiKey: mocks.saveApiKey,
  removeApiKey: mocks.removeApiKey,
}));

vi.mock('./client', () => {
  class MockKavitaError extends Error {
    constructor(
      message: string,
      readonly kind: 'network' | 'authentication' | 'server' | 'invalid-response',
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    KavitaError: MockKavitaError,
    KavitaClient: class {
      constructor(
        readonly baseUrl: string,
        readonly apiKey: string,
      ) {}
      testConnection(signal?: AbortSignal) {
        return mocks.testConnection(this.baseUrl, this.apiKey, signal);
      }
    },
  };
});

const existingServer: ServerConfig = {
  id: 'primary',
  displayName: 'Books',
  baseUrl: 'https://old.example.com',
  credentialRef: 'server_primary_api_key',
  kavitaVersion: '0.8.4',
  lastConnectedAt: '2026-01-01T00:00:00.000Z',
};

describe('connection helpers', () => {
  beforeEach(async () => {
    await clearDiagnostics();
    mocks.saveServer.mockReset().mockResolvedValue(undefined);
    mocks.setPreference.mockReset().mockResolvedValue(undefined);
    mocks.saveApiKey.mockReset().mockResolvedValue(undefined);
    mocks.removeApiKey.mockReset().mockResolvedValue(undefined);
    mocks.testConnection.mockReset().mockResolvedValue({
      version: '0.8.5',
      bookLibraries: [{ id: 1, name: 'Books', type: 2 }],
    });
  });

  it('marks 404 route errors as address errors with route guidance', async () => {
    mocks.testConnection.mockRejectedValueOnce(
      new KavitaError('Kavita returned an error (404).', 'server', 404),
    );

    let caught: unknown;
    try {
      await verifyKavitaConnection('https://books.example.com/wrong', 'key');
    } catch (error) {
      caught = error;
    }

    const classified = classifyConnectionError(caught, 'Fallback');
    expect(classified.invalidField).toBe('address');
    expect(classified.message).toContain('404');
    expect(classified.message).toContain('OPDS URL');
  });

  it('classifies URL and authentication errors to their respective fields', () => {
    expect(classifyConnectionError(new ServerUrlError('Bad URL'), 'Fallback')).toEqual({
      message: 'Bad URL',
      invalidField: 'address',
    });
    expect(
      classifyConnectionError(
        new KavitaError('Kavita rejected this auth key.', 'authentication', 401),
        'Fallback',
      ),
    ).toEqual({
      message: 'Kavita rejected this auth key.',
      invalidField: 'key',
    });
  });

  it('rejects accounts with no book or light novel libraries', async () => {
    mocks.testConnection.mockResolvedValueOnce({ version: '0.8.5', bookLibraries: [] });

    await expect(verifyKavitaConnection('https://books.example.com', 'key')).rejects.toThrow(
      'no book or light novel libraries',
    );
  });

  it('rotates credentials and cleans up the old credentialRef after saving', async () => {
    const rotation = await rotateServerConnection(
      existingServer,
      'https://books.example.com/kavita',
      'active-key',
      '0.8.5',
    );

    expect(rotation.server.baseUrl).toBe('https://books.example.com/kavita');
    expect(rotation.server.credentialRef).not.toBe(existingServer.credentialRef);
    expect(rotation.staleCredentialRefs).toEqual([]);
    expect(rotation.cleanupWarning).toBeNull();
    expect(mocks.saveApiKey).toHaveBeenCalledWith(rotation.server.credentialRef, 'active-key');
    expect(mocks.saveServer).toHaveBeenCalledWith(rotation.server);
    expect(mocks.removeApiKey).toHaveBeenCalledWith(existingServer.credentialRef);
  });

  it('keeps the new connection active while recording and returning retryable cleanup status when old-key deletion fails', async () => {
    mocks.removeApiKey.mockRejectedValueOnce(new Error('Keystore locked'));

    const rotation = await rotateServerConnection(
      existingServer,
      'https://books.example.com/kavita',
      'active-key',
      '0.8.5',
    );

    expect(rotation.server.baseUrl).toBe('https://books.example.com/kavita');
    expect(rotation.server.credentialRef).not.toBe(existingServer.credentialRef);
    expect(rotation.staleCredentialRefs).toEqual([existingServer.credentialRef]);
    expect(rotation.cleanupWarning).toBe(STALE_CREDENTIAL_CLEANUP_WARNING);
    expect(rotation.cleanupPersisted).toBe(true);
    expect(mocks.setPreference).toHaveBeenCalledWith(
      STALE_CREDENTIAL_REFS_PREFERENCE_KEY,
      JSON.stringify([existingServer.credentialRef]),
    );

    const diagnostics = exportDiagnostics({ appVersion: '0.3.5', platform: 'android' });
    expect(diagnostics).toContain(
      'startup endpoint=local/credentials detail=credential-cleanup-failed',
    );

    const remaining = await cleanupStaleCredentials(
      [...rotation.staleCredentialRefs, rotation.server.credentialRef],
      rotation.server.credentialRef,
    );
    expect(remaining).toEqual([]);
    expect(mocks.removeApiKey).toHaveBeenCalledTimes(2);
    expect(mocks.removeApiKey).toHaveBeenLastCalledWith(existingServer.credentialRef);
  });

  it('records diagnostics and surfaces an explicit warning when persisting failed cleanup references rejects', async () => {
    mocks.removeApiKey.mockRejectedValueOnce(new Error('Keystore locked'));
    mocks.setPreference.mockRejectedValueOnce(new Error('SQLite disk full'));

    const rotation = await rotateServerConnection(
      existingServer,
      'https://books.example.com/kavita',
      'active-key',
      '0.8.5',
    );

    expect(rotation.staleCredentialRefs).toEqual([existingServer.credentialRef]);
    expect(rotation.cleanupPersisted).toBe(false);
    expect(rotation.cleanupWarning).toBe(STALE_CREDENTIAL_PERSIST_FAILED_WARNING);

    const diagnostics = exportDiagnostics({ appVersion: '0.3.5', platform: 'android' });
    expect(diagnostics).toContain(
      'startup endpoint=local/credentials detail=credential-cleanup-failed',
    );
    expect(diagnostics).toContain(
      'startup endpoint=local/database detail=stale-credential-persist-failed',
    );
  });

  it('retains retryable references and surfaces status persistence failure when clearing previous stale refs fails', async () => {
    mocks.setPreference.mockRejectedValueOnce(new Error('SQLite busy'));

    const rotation = await rotateServerConnection(
      existingServer,
      'https://books.example.com/kavita',
      'active-key',
      '0.8.5',
      undefined,
      ['server_older_api_key'],
    );

    expect(rotation.cleanupPersisted).toBe(false);
    expect(rotation.staleCredentialRefs).toEqual(['server_older_api_key']);
    expect(rotation.cleanupWarning).toBe(STALE_CREDENTIAL_STATUS_PERSIST_FAILED_WARNING);
    expect(
      parseStaleCredentialRefs(
        JSON.stringify(['server_older_api_key', rotation.server.credentialRef]),
        rotation.server.credentialRef,
      ),
    ).toEqual(['server_older_api_key']);
  });

  it('rolls back the newly stored key and keeps old credentials untouched when saveServer fails', async () => {
    mocks.saveServer.mockRejectedValueOnce(new Error('DB write failed'));

    await expect(
      rotateServerConnection(existingServer, 'https://books.example.com', 'active-key', '0.8.5'),
    ).rejects.toThrow('saved connection and auth key were left in place');

    const rotatedRef = mocks.saveApiKey.mock.calls[0]?.[0];
    expect(rotatedRef).toBeTruthy();
    expect(rotatedRef).not.toBe(existingServer.credentialRef);
    expect(mocks.removeApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.removeApiKey).toHaveBeenCalledWith(rotatedRef);
  });

  it('reports cleanup failure when both saveServer and key rollback fail', async () => {
    mocks.saveServer.mockRejectedValueOnce(new Error('DB write failed'));
    mocks.removeApiKey.mockRejectedValueOnce(new Error('Keystore error'));

    await expect(saveConnection(existingServer, 'key', INITIAL_SETUP_MESSAGES)).rejects.toThrow(
      INITIAL_SETUP_MESSAGES.cleanupFailed,
    );
  });
});
