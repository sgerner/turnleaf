import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';

const PREFIX = 'turnleaf_';
const BROWSER_PREFIX = 'turnleaf_browser_';
let prepared: Promise<void> | null = null;

export function prepare(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return Promise.resolve();
  }
  prepared ??= (async () => {
    try {
      await SecureStorage.setKeyPrefix(PREFIX);
      await SecureStorage.setSynchronize(false);
    } catch (error) {
      prepared = null;
      throw error;
    }
  })();
  return prepared;
}

function browserStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Browser storage is unavailable in this context.');
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
  try {
    await SecureStorage.remove(reference);
  } catch (error) {
    throw new Error('Could not remove the saved Kavita auth key.', { cause: error });
  }
}
