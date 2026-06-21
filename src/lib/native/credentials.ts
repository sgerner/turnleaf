import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';

const PREFIX = 'turnleaf_';

export class SecureStorageUnavailableError extends Error {}

function requireNative(): void {
  if (!Capacitor.isNativePlatform()) {
    throw new SecureStorageUnavailableError(
      'Secure credential storage is available in the Android and iOS applications.',
    );
  }
}

async function prepare(): Promise<void> {
  requireNative();
  await SecureStorage.setKeyPrefix(PREFIX);
  await SecureStorage.setSynchronize(false);
}

export async function saveApiKey(reference: string, apiKey: string): Promise<void> {
  await prepare();
  await SecureStorage.set(reference, apiKey);
}

export async function getApiKey(reference: string): Promise<string | null> {
  await prepare();
  const value = await SecureStorage.get(reference, false);
  return typeof value === 'string' ? value : null;
}

export async function removeApiKey(reference: string): Promise<void> {
  await prepare();
  await SecureStorage.remove(reference);
}
