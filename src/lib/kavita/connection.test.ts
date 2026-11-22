import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../database/database';
import { KavitaError } from './client';
import {
  classifyConnectionError,
  INITIAL_SETUP_MESSAGES,
  rotateServerConnection,
  saveConnection,
  verifyKavitaConnection,
} from './connection';
import { ServerUrlError } from './url';

const mocks = vi.hoisted(() => ({
  saveServer: vi.fn(),
  saveApiKey: vi.fn(),
  removeApiKey: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../database/database', () => ({
  saveServer: mocks.saveServer,
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
  beforeEach(() => {
    mocks.saveServer.mockReset().mockResolvedValue(undefined);
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
    const updated = await rotateServerConnection(
      existingServer,
      'https://books.example.com/kavita',
      'active-key',
      '0.8.5',
    );

    expect(updated.baseUrl).toBe('https://books.example.com/kavita');
    expect(updated.credentialRef).not.toBe(existingServer.credentialRef);
    expect(mocks.saveApiKey).toHaveBeenCalledWith(updated.credentialRef, 'active-key');
    expect(mocks.saveServer).toHaveBeenCalledWith(updated);
    expect(mocks.removeApiKey).toHaveBeenCalledWith(existingServer.credentialRef);
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
