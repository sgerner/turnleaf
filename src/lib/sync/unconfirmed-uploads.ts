import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

export const UNCONFIRMED_SYNC_STORAGE_KEY = 'turnleaf_unconfirmed_sync_v1';
export const UNCONFIRMED_SYNC_DIRECTORY = 'sync';
export const UNCONFIRMED_SYNC_FILE_PATH = `${UNCONFIRMED_SYNC_DIRECTORY}/unconfirmed-uploads.json`;

export interface UnconfirmedUpload {
  revision: number;
  updatedAt: string;
  payload: string;
  serverUpdatedAt: string;
}

const webFallbackUploads = new WeakMap<Storage, Map<string, UnconfirmedUpload>>();
const anonymousFallbackUploads = new Map<string, UnconfirmedUpload>();
let nativeJournal: Map<string, UnconfirmedUpload> | null = null;
let nativeJournalQueue: Promise<void> = Promise.resolve();

function unconfirmedKeyFor(serverId: string, bookId: string): string {
  return `${serverId}\0${bookId}`;
}

function isUnconfirmedUpload(value: unknown): value is UnconfirmedUpload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UnconfirmedUpload>;
  return (
    typeof candidate.revision === 'number' &&
    Number.isFinite(candidate.revision) &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.payload === 'string' &&
    typeof candidate.serverUpdatedAt === 'string'
  );
}

function parseUnconfirmedRecord(raw: string | null): Map<string, UnconfirmedUpload> {
  const entries = new Map<string, UnconfirmedUpload>();
  if (!raw) return entries;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return entries;
    for (const [key, value] of Object.entries(parsed)) {
      if (isUnconfirmedUpload(value)) entries.set(key, value);
    }
  } catch {
    // Ignore malformed journal files and fall back to queue state.
  }
  return entries;
}

function getWebFallbackMap(): Map<string, UnconfirmedUpload> {
  if (typeof window === 'undefined') return anonymousFallbackUploads;
  let map = webFallbackUploads.get(window.localStorage);
  if (!map) {
    map = new Map<string, UnconfirmedUpload>();
    webFallbackUploads.set(window.localStorage, map);
  }
  return map;
}

function enqueueNativeJournal<T>(task: () => Promise<T>): Promise<T> {
  const next = nativeJournalQueue.then(task);
  nativeJournalQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function ensureNativeJournal(): Promise<Map<string, UnconfirmedUpload>> {
  if (nativeJournal) return nativeJournal;
  return enqueueNativeJournal(async () => {
    if (nativeJournal) return nativeJournal;
    try {
      const file = await Filesystem.readFile({
        path: UNCONFIRMED_SYNC_FILE_PATH,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      nativeJournal = parseUnconfirmedRecord(typeof file.data === 'string' ? file.data : null);
    } catch {
      nativeJournal = new Map();
    }
    return nativeJournal;
  });
}

async function persistNativeJournal(
  journal: ReadonlyMap<string, UnconfirmedUpload>,
): Promise<void> {
  const snapshot = Object.fromEntries(journal);
  const empty = journal.size === 0;
  await enqueueNativeJournal(async () => {
    if (empty) {
      await Filesystem.deleteFile({
        path: UNCONFIRMED_SYNC_FILE_PATH,
        directory: Directory.Data,
      }).catch(() => {});
      return;
    }
    await Filesystem.mkdir({
      path: UNCONFIRMED_SYNC_DIRECTORY,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => {});
    await Filesystem.writeFile({
      path: UNCONFIRMED_SYNC_FILE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot),
    }).catch(() => {});
  });
}

export async function getUnconfirmedUpload(
  serverId: string,
  bookId: string,
): Promise<UnconfirmedUpload | undefined> {
  const key = unconfirmedKeyFor(serverId, bookId);
  if (!Capacitor.isNativePlatform()) {
    const fallback = getWebFallbackMap().get(key);
    if (typeof window === 'undefined') return fallback;
    try {
      const persisted = parseUnconfirmedRecord(
        window.localStorage.getItem(UNCONFIRMED_SYNC_STORAGE_KEY),
      ).get(key);
      return persisted ?? fallback;
    } catch {
      return fallback;
    }
  }
  const journal = await ensureNativeJournal();
  return journal.get(key);
}

export async function recordUnconfirmedUpload(
  serverId: string,
  bookId: string,
  upload: UnconfirmedUpload,
): Promise<void> {
  const key = unconfirmedKeyFor(serverId, bookId);
  if (!Capacitor.isNativePlatform()) {
    const fallback = getWebFallbackMap();
    fallback.set(key, upload);
    if (typeof window === 'undefined') return;
    try {
      const entries = parseUnconfirmedRecord(
        window.localStorage.getItem(UNCONFIRMED_SYNC_STORAGE_KEY),
      );
      entries.set(key, upload);
      window.localStorage.setItem(
        UNCONFIRMED_SYNC_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries)),
      );
      fallback.delete(key);
    } catch {
      // Keep the in-memory fallback if storage is temporarily full.
    }
    return;
  }
  const journal = await ensureNativeJournal();
  journal.set(key, upload);
  await persistNativeJournal(journal);
}

export async function deleteUnconfirmedUpload(serverId: string, bookId: string): Promise<void> {
  const key = unconfirmedKeyFor(serverId, bookId);
  if (!Capacitor.isNativePlatform()) {
    getWebFallbackMap().delete(key);
    if (typeof window === 'undefined') return;
    try {
      const entries = parseUnconfirmedRecord(
        window.localStorage.getItem(UNCONFIRMED_SYNC_STORAGE_KEY),
      );
      if (!entries.delete(key)) return;
      if (entries.size === 0) {
        window.localStorage.removeItem(UNCONFIRMED_SYNC_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          UNCONFIRMED_SYNC_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(entries)),
        );
      }
    } catch {
      // Ignore storage removal errors; revision matching still prevents stale reuse.
    }
    return;
  }
  const journal = await ensureNativeJournal();
  if (!journal.delete(key)) return;
  await persistNativeJournal(journal);
}

/**
 * Remove persisted and in-memory unconfirmed-upload journal entries for a
 * deleted server or a full local storage reset.
 */
export async function clearUnconfirmedUploads(serverId?: string): Promise<void> {
  const prefix = serverId === undefined ? null : `${serverId}\0`;
  if (!Capacitor.isNativePlatform()) {
    const fallback = getWebFallbackMap();
    if (prefix === null) {
      fallback.clear();
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem(UNCONFIRMED_SYNC_STORAGE_KEY);
        } catch {
          // Best effort only.
        }
      }
      return;
    }
    for (const key of fallback.keys()) {
      if (key.startsWith(prefix)) fallback.delete(key);
    }
    if (typeof window === 'undefined') return;
    try {
      const entries = parseUnconfirmedRecord(
        window.localStorage.getItem(UNCONFIRMED_SYNC_STORAGE_KEY),
      );
      let changed = false;
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          changed = true;
        }
      }
      if (!changed) return;
      if (entries.size === 0) {
        window.localStorage.removeItem(UNCONFIRMED_SYNC_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          UNCONFIRMED_SYNC_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(entries)),
        );
      }
    } catch {
      // Best effort only.
    }
    return;
  }

  if (prefix === null) {
    if (nativeJournal) {
      nativeJournal.clear();
    } else {
      nativeJournal = new Map();
    }
    await persistNativeJournal(nativeJournal);
    return;
  }
  const journal = await ensureNativeJournal();
  let changed = false;
  for (const key of journal.keys()) {
    if (key.startsWith(prefix)) {
      journal.delete(key);
      changed = true;
    }
  }
  if (changed) await persistNativeJournal(journal);
}
