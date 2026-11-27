import { saveServer, type ServerConfig } from '../database/database';
import { recordDiagnostic } from '../diagnostics/log';
import { removeApiKey, saveApiKey } from '../native/credentials';
import { KavitaClient, KavitaError } from './client';
import type { ConnectedServer } from './types';
import { ServerUrlError } from './url';

export type InvalidConnectionField = 'address' | 'key' | null;

export interface SaveConnectionMessages {
  saveFailed: string;
  cleanupFailed: string;
}

export const ADDRESS_ROTATION_MESSAGES: SaveConnectionMessages = {
  saveFailed:
    'The new address tested successfully, but local setup could not be saved. The saved connection and auth key were left in place; retry reconnect.',
  cleanupFailed:
    'The new address tested successfully, but local setup could not be saved and the new auth key could not be cleaned up. The saved connection was left in place; retry reconnect.',
};

export const INITIAL_SETUP_MESSAGES: SaveConnectionMessages = {
  saveFailed:
    'The connection worked, but local setup could not be saved. No auth key was retained; try again.',
  cleanupFailed:
    'The connection worked, but local setup could not be saved and the auth key could not be cleaned up. Retry setup or remove the server from settings.',
};

export const STALE_CREDENTIAL_CLEANUP_WARNING =
  'Server address updated, but the previous auth key could not be removed from this device. Retry cleanup to remove it.';

export const STALE_CREDENTIAL_RETRY_FAILED_WARNING =
  'Turnleaf still could not remove the previous auth key from this device. Retry cleanup again later.';

export interface RotateServerConnectionResult {
  server: ServerConfig;
  staleCredentialRefs: string[];
  cleanupWarning: string | null;
}

export async function saveConnection(
  server: ServerConfig,
  key: string,
  messages: SaveConnectionMessages,
): Promise<void> {
  try {
    await saveApiKey(server.credentialRef, key);
  } catch (credentialError) {
    recordDiagnostic({
      category: 'startup',
      endpoint: 'local/credentials',
      detail: 'credential-save-failed',
    });
    throw credentialError;
  }
  try {
    await saveServer(server);
  } catch (storageError) {
    try {
      await removeApiKey(server.credentialRef);
    } catch (cleanupError) {
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/credentials',
        detail: 'credential-cleanup-failed',
      });
      throw new Error(messages.cleanupFailed, { cause: cleanupError });
    }
    recordDiagnostic({
      category: 'startup',
      endpoint: 'local/database',
      detail: 'server-save-failed',
    });
    throw new Error(messages.saveFailed, { cause: storageError });
  }
}

export async function verifyKavitaConnection(
  baseUrl: string,
  key: string,
  signal?: AbortSignal,
): Promise<ConnectedServer> {
  let result: ConnectedServer;
  try {
    result = await new KavitaClient(baseUrl, key).testConnection(signal);
  } catch (cause) {
    if (cause instanceof KavitaError && cause.status === 404) {
      throw new KavitaError(
        'Kavita API was not found at this address (404). Check the server address or reverse-proxy subpath, or paste your Kavita OPDS URL.',
        'server',
        404,
      );
    }
    throw cause;
  }

  if (result.bookLibraries.length === 0) {
    recordDiagnostic({
      category: 'validation',
      endpoint: '/api/Library/libraries',
      detail: 'no-book-libraries',
    });
    throw new Error(
      'This account has no book or light novel libraries. Other media types are not supported.',
    );
  }
  return result;
}

export async function cleanupStaleCredentials(
  references: readonly string[],
  activeCredentialRef?: string,
): Promise<string[]> {
  const uniqueRefs = [...new Set(references)].filter(
    (ref) => Boolean(ref) && ref !== activeCredentialRef,
  );
  const remaining: string[] = [];
  let failed = false;
  for (const ref of uniqueRefs) {
    try {
      await removeApiKey(ref);
    } catch {
      failed = true;
      remaining.push(ref);
    }
  }
  if (failed) {
    recordDiagnostic({
      category: 'startup',
      endpoint: 'local/credentials',
      detail: 'credential-cleanup-failed',
    });
  }
  return remaining;
}

export async function rotateServerConnection(
  savedServer: ServerConfig,
  baseUrl: string,
  key: string,
  version: string | null,
  messages: SaveConnectionMessages = ADDRESS_ROTATION_MESSAGES,
  previousStaleCredentialRefs: readonly string[] = [],
): Promise<RotateServerConnectionResult> {
  let credentialRef = `server_${savedServer.id}_api_key_${Date.now().toString(36)}`;
  if (
    credentialRef === savedServer.credentialRef ||
    previousStaleCredentialRefs.includes(credentialRef)
  ) {
    credentialRef = `${credentialRef}_next`;
  }
  const connectedServer: ServerConfig = {
    ...savedServer,
    baseUrl,
    credentialRef,
    kavitaVersion: version,
    lastConnectedAt: new Date().toISOString(),
  };
  await saveConnection(connectedServer, key, messages);
  const candidates =
    savedServer.credentialRef !== credentialRef
      ? [...previousStaleCredentialRefs, savedServer.credentialRef]
      : [...previousStaleCredentialRefs];
  const staleCredentialRefs = await cleanupStaleCredentials(candidates, credentialRef);
  return {
    server: connectedServer,
    staleCredentialRefs,
    cleanupWarning: staleCredentialRefs.length > 0 ? STALE_CREDENTIAL_CLEANUP_WARNING : null,
  };
}

export function classifyConnectionError(
  cause: unknown,
  fallbackMessage: string,
): { message: string; invalidField: InvalidConnectionField } {
  let invalidField: InvalidConnectionField = null;
  if (cause instanceof ServerUrlError) {
    invalidField = 'address';
  } else if (cause instanceof KavitaError && cause.status === 404) {
    invalidField = 'address';
  } else if (cause instanceof KavitaError && cause.kind === 'authentication') {
    invalidField = 'key';
  }

  if (cause instanceof KavitaError || cause instanceof ServerUrlError || cause instanceof Error) {
    return { message: cause.message, invalidField };
  }
  return { message: fallbackMessage, invalidField };
}
