import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';

const PREFIX = 'turnleaf_';
const BROWSER_PREFIX = 'turnleaf_browser_';

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

function browserStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new SecureStorageUnavailableError('Browser storage is unavailable in this context.');
  }
  return window.localStorage;
}

export async function saveApiKey(reference: string, apiKey: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    browserStorage().setItem(`${BROWSER_PREFIX}${reference}`, apiKey);
    return;
  }
  await prepare();
  await SecureStorage.set(reference, apiKey);
}

export async function getApiKey(reference: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    return browserStorage().getItem(`${BROWSER_PREFIX}${reference}`);
  }
  await prepare();
  const value = await SecureStorage.get(reference, false);
  return typeof value === 'string' ? value : null;
}

export async function removeApiKey(reference: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    browserStorage().removeItem(`${BROWSER_PREFIX}${reference}`);
    return;
  }
  await prepare();
  await SecureStorage.remove(reference);
}
