import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';

const PREFIX = 'turnleaf_';
const BROWSER_PREFIX = 'turnleaf_browser_';

export type CredentialStatus = 'ready' | 'missing' | 'unreadable' | 'rejected';

export interface CredentialState {
  readonly status: CredentialStatus;
  readonly epoch: number;
  readonly statusCode?: number | undefined;
}

let currentStatus: CredentialStatus = 'ready';
let currentEpoch = 0;
let currentStatusCode: number | undefined;
let activeReference: string | null = null;
let activeApiKey: string | null = null;
let managed = false;
const listeners = new Set<(state: CredentialState) => void>();

function snapshot(): CredentialState {
  return currentStatusCode === undefined
    ? { status: currentStatus, epoch: currentEpoch }
    : { status: currentStatus, epoch: currentEpoch, statusCode: currentStatusCode };
}

function notifyListeners(): void {
  const next = snapshot();
  for (const listener of listeners) listener(next);
}

function transition(
  status: CredentialStatus,
  options: {
    advanceEpoch: boolean;
    reference?: string | null;
    apiKey?: string | null;
    statusCode?: number | undefined;
    isManaged?: boolean;
  },
): CredentialState {
  const nextEpoch = options.advanceEpoch ? currentEpoch + 1 : currentEpoch;
  const nextManaged = options.isManaged ?? true;
  const nextRef = options.reference !== undefined ? options.reference : activeReference;
  const nextKey = options.apiKey !== undefined ? options.apiKey : activeApiKey;
  const changed =
    currentStatus !== status ||
    currentEpoch !== nextEpoch ||
    currentStatusCode !== options.statusCode ||
    activeReference !== nextRef ||
    activeApiKey !== nextKey ||
    managed !== nextManaged;

  currentStatus = status;
  currentEpoch = nextEpoch;
  currentStatusCode = options.statusCode;
  activeReference = nextRef;
  activeApiKey = nextKey;
  managed = nextManaged;

  if (changed) notifyListeners();
  return snapshot();
}

export function getCredentialState(): CredentialState {
  return snapshot();
}

export function subscribeCredentialState(listener: (state: CredentialState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isCredentialReady(): boolean {
  if (!managed) return currentStatus === 'ready';
  return currentStatus === 'ready' && Boolean(activeApiKey?.trim());
}

export function resolveCredentialEpoch(apiKey: string, explicitEpoch?: number): number | undefined {
  if (explicitEpoch !== undefined) return explicitEpoch;
  if (!managed) return undefined;
  if (!apiKey.trim() || activeApiKey === null || apiKey === activeApiKey) {
    return currentEpoch;
  }
  return undefined;
}

export function canSendCredential(apiKey: string, epoch?: number): boolean {
  if (!apiKey.trim()) return false;
  if (currentStatus !== 'ready') return false;
  if (epoch !== undefined && epoch !== currentEpoch) return false;
  if (managed) {
    return Boolean(activeApiKey?.trim()) && apiKey === activeApiKey;
  }
  return true;
}

export function markCredentialRejected(epoch: number | undefined, statusCode?: number): boolean {
  if (epoch === undefined || epoch !== currentEpoch) return false;
  if (currentStatus === 'rejected' && currentStatusCode === statusCode) return true;
  transition('rejected', {
    advanceEpoch: false,
    statusCode,
    isManaged: managed,
  });
  return true;
}

export function markCredentialMissing(reference?: string | null): CredentialState {
  if (managed && currentStatus === 'missing' && activeApiKey === null) {
    return snapshot();
  }
  return transition('missing', {
    advanceEpoch: true,
    reference: reference ?? activeReference,
    apiKey: null,
  });
}

export function markCredentialUnreadable(reference?: string | null): CredentialState {
  if (managed && currentStatus === 'unreadable' && activeApiKey === null) {
    return snapshot();
  }
  return transition('unreadable', {
    advanceEpoch: true,
    reference: reference ?? activeReference,
    apiKey: null,
  });
}

export function syncLoadedCredential(apiKey: string, reference?: string): CredentialState {
  if (!apiKey.trim()) return markCredentialMissing(reference ?? activeReference);
  if (
    managed &&
    currentStatus === 'ready' &&
    activeApiKey === apiKey &&
    (reference === undefined || activeReference === reference)
  ) {
    return snapshot();
  }
  return transition('ready', {
    advanceEpoch: true,
    reference: reference ?? activeReference,
    apiKey,
  });
}

export function resetCredentialState(): void {
  currentStatus = 'ready';
  currentEpoch += 1;
  currentStatusCode = undefined;
  activeReference = null;
  activeApiKey = null;
  managed = false;
  notifyListeners();
}

async function prepare(): Promise<void> {
  await SecureStorage.setKeyPrefix(PREFIX);
  await SecureStorage.setSynchronize(false);
}

function browserStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Browser storage is unavailable in this context.');
  }
  return window.localStorage;
}

export async function saveApiKey(reference: string, apiKey: string): Promise<void> {
  if (!apiKey.trim()) {
    throw new Error('Enter a Kavita auth key.');
  }
  if (!Capacitor.isNativePlatform()) {
    browserStorage().setItem(`${BROWSER_PREFIX}${reference}`, apiKey);
    transition('ready', { advanceEpoch: true, reference, apiKey });
    return;
  }
  await prepare();
  await SecureStorage.set(reference, apiKey);
  transition('ready', { advanceEpoch: true, reference, apiKey });
}

export async function getApiKey(reference: string): Promise<string | null> {
  let raw: unknown;
  try {
    if (!Capacitor.isNativePlatform()) {
      raw = browserStorage().getItem(`${BROWSER_PREFIX}${reference}`);
    } else {
      await prepare();
      raw = await SecureStorage.get(reference, false);
    }
  } catch (error) {
    transition('unreadable', { advanceEpoch: true, reference, apiKey: null });
    throw error;
  }
  const value = typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
  if (value === null) {
    transition('missing', { advanceEpoch: true, reference, apiKey: null });
    return null;
  }
  transition('ready', { advanceEpoch: true, reference, apiKey: value });
  return value;
}

export async function removeApiKey(reference: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    browserStorage().removeItem(`${BROWSER_PREFIX}${reference}`);
    if (activeReference === null || activeReference === reference) {
      transition('missing', { advanceEpoch: true, reference: null, apiKey: null });
    }
    return;
  }
  await prepare();
  try {
    await SecureStorage.remove(reference);
  } catch (error) {
    throw new Error('Could not remove the saved Kavita auth key.', { cause: error });
  }
  if (activeReference === null || activeReference === reference) {
    transition('missing', { advanceEpoch: true, reference: null, apiKey: null });
  }
}
