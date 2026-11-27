import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { recordDiagnostic } from '../diagnostics/log';
import {
  advanceRedirect,
  assertSafeTransferTarget,
  createRedirectState,
  KavitaError,
  nativeHeader,
} from '../kavita/redirects';
import { EpubValidationError, validateEpubArchive } from './epub-validation';

const BOOK_DIRECTORY = 'books';
const PARTIAL_SUFFIX = '.partial';
export const EPUB_DOWNLOAD_ENDPOINT = '/api/Download/chapter';
export const EPUB_CONNECT_TIMEOUT_MS = 10_000;
export const EPUB_READ_TIMEOUT_MS = 10_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);
let interruptedDownloadCleanup: Promise<void> | undefined;
let transferAttemptCounter = 0;
let pathOwnerCounter = 0;
const latestIntentByPath = new Map<string, number>();
const committedOwnerByPath = new Map<string, number>();
const bookFileLocks = new Map<string, Promise<void>>();

interface AttemptState {
  readonly id: number;
  readonly path: string;
  pendingOp: Promise<unknown> | null;
  disposed: boolean;
  committed: boolean;
}

function withBookFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = bookFileLocks.get(path) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  bookFileLocks.set(path, settled);
  void settled.finally(() => {
    if (bookFileLocks.get(path) === settled) {
      bookFileLocks.delete(path);
    }
  });
  return result;
}

function runAttemptOp<T>(attempt: AttemptState, op: Promise<T>, signal?: AbortSignal): Promise<T> {
  const tracked = op.finally(() => {
    if (attempt.pendingOp === tracked) {
      attempt.pendingOp = null;
    }
  });
  tracked.catch(() => {});
  attempt.pendingOp = tracked;
  return raceWithAbort(tracked, signal);
}

async function disposeAttempt(attempt: AttemptState | null): Promise<void> {
  if (!attempt || attempt.disposed || attempt.committed) return;
  attempt.disposed = true;
  const deletePartial = () => {
    if (attempt.committed) return Promise.resolve();
    return Filesystem.deleteFile({ path: attempt.path, directory: Directory.Data }).catch(() => {});
  };
  if (attempt.pendingOp) {
    void attempt.pendingOp.then(deletePartial, deletePartial);
    return;
  }
  await deletePartial();
}

export class EpubTransferError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly connectionFailed: boolean,
    readonly timedOut = false,
  ) {
    super('The EPUB transfer failed.');
  }
}

function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTimeoutFailure(error: unknown): boolean {
  const failure = error as {
    code?: unknown;
    message?: unknown;
    data?: { exception?: unknown };
  } | null;
  const text = `${typeof failure?.message === 'string' ? failure.message : ''} ${
    typeof failure?.data?.exception === 'string' ? failure.data.exception : ''
  }`;
  return /timed?\s*out|timeout/i.test(text);
}

function decodeNativeBytes(data: string | Blob): Uint8Array {
  if (typeof data !== 'string') throw new Error('The native EPUB could not be inspected.');
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readNativeRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const result = await Filesystem.readFile({
    path,
    directory: Directory.Data,
    offset,
    length,
  });
  const bytes = decodeNativeBytes(result.data);
  if (bytes.length !== length) throw new Error('The native EPUB read was incomplete.');
  return bytes;
}

function assertSafeBookId(bookId: string): void {
  if (!bookId || bookId === '.' || bookId === '..' || /[\\/\0]/.test(bookId)) {
    throw new Error('Invalid EPUB file name.');
  }
}

function assertSafeBookPath(path: string): void {
  const segments = path.split('/');
  if (
    !path.startsWith(`${BOOK_DIRECTORY}/`) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    path.includes('\\') ||
    segments.at(-1)?.toLowerCase().endsWith('.epub') !== true
  ) {
    throw new Error('Invalid downloaded EPUB path.');
  }
}

function safeCoverNamespace(value: string): string {
  const normalized = value.replace(/[^a-z0-9_-]+/gi, '_').replace(/^\.+|\.+$/g, '');
  return normalized.slice(0, 80) || 'default';
}

export interface DownloadedBookFile {
  relativePath: string;
  nativeUri: string;
  webViewUrl: string;
  size: number;
  ownerToken?: number | undefined;
}

export interface DownloadEpubOptions {
  signal?: AbortSignal | undefined;
  preserveExistingOnAbort?: boolean | undefined;
}

async function ensureDataDirectory(path: string): Promise<void> {
  const existing = await Filesystem.stat({ path, directory: Directory.Data }).catch(() => null);
  if (existing?.type === 'directory') return;
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'OS-PLUG-FILE-0010') throw error;
  }
}

export function cleanupInterruptedEpubDownloads(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  // Each native transfer waits for the same startup pass before writing a partial file.
  interruptedDownloadCleanup ??= (async () => {
    try {
      const { files } = await Filesystem.readdir({
        path: BOOK_DIRECTORY,
        directory: Directory.Data,
      });
      for (const file of files) {
        if (file.type !== 'file' || !file.name.endsWith(`.epub${PARTIAL_SUFFIX}`)) continue;
        const path = `${BOOK_DIRECTORY}/${file.name}`;
        await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {});
      }
    } catch {
      // The books directory may not exist yet. Cleanup must never block a new transfer.
    }
  })();
  return interruptedDownloadCleanup;
}

interface NativeTransferFailure {
  code?: unknown;
  data?: {
    code?: unknown;
    httpStatus?: unknown;
    headers?: unknown;
  };
}

function readTransferFailure(error: unknown): {
  code: string | undefined;
  status: number | undefined;
  headers: Record<string, unknown> | null;
} {
  const failure = error as NativeTransferFailure | null;
  const code =
    typeof failure?.code === 'string'
      ? failure.code
      : typeof failure?.data?.code === 'string'
        ? failure.data.code
        : undefined;
  const httpStatus = failure?.data?.httpStatus;
  const status =
    typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? httpStatus
      : undefined;
  const headers =
    failure?.data?.headers && typeof failure.data.headers === 'object'
      ? (failure.data.headers as Record<string, unknown>)
      : null;
  return { code, status, headers };
}

async function downloadFileWithRedirects(options: {
  initialUrl: string;
  normalizedInitialUrl: string;
  serverOrigin: string;
  path: string;
  apiKey: string;
  progress?: boolean;
  connectTimeout?: number;
  readTimeout?: number;
  signal?: AbortSignal | undefined;
  isCancelled?: (() => boolean) | undefined;
  onHop?: ((url: string) => void) | undefined;
}): Promise<void> {
  const cancelled = () => options.signal?.aborted === true || options.isCancelled?.() === true;
  const redirects = createRedirectState(
    options.initialUrl,
    options.serverOrigin,
    'GET',
    options.normalizedInitialUrl,
  );
  while (true) {
    if (cancelled()) throw new DOMException('Aborted', 'AbortError');
    options.onHop?.(redirects.currentUrl);
    try {
      await FileTransfer.downloadFile({
        url: redirects.currentUrl,
        path: options.path,
        headers: { 'x-api-key': options.apiKey },
        disableRedirects: true,
        ...(options.progress ? { progress: true } : {}),
        ...(options.connectTimeout !== undefined ? { connectTimeout: options.connectTimeout } : {}),
        ...(options.readTimeout !== undefined ? { readTimeout: options.readTimeout } : {}),
      });
      if (cancelled()) throw new DOMException('Aborted', 'AbortError');
      return;
    } catch (error) {
      if (cancelled()) throw new DOMException('Aborted', 'AbortError');
      const { code, status, headers } = readTransferFailure(error);
      if (code === 'OS-PLUG-FLTR-0010' && status !== undefined && status >= 300 && status < 400) {
        const nextUrl = advanceRedirect(redirects, status, nativeHeader(headers, 'location'));
        if (nextUrl) continue;
      }
      throw error;
    }
  }
}

export async function downloadEpub(
  downloadUrl: string,
  apiKey: string,
  bookId: string,
  onProgress?: (percent: number) => void,
  serverOrigin?: string,
  options?: DownloadEpubOptions,
): Promise<DownloadedBookFile> {
  const signal = options?.signal;
  if (!Capacitor.isNativePlatform()) throw new Error('Downloads require the native application.');
  const target = assertSafeTransferTarget(
    downloadUrl,
    serverOrigin,
    'Invalid Kavita download address.',
  );
  assertSafeBookId(bookId);
  throwIfAborted(signal);

  const finalPath = `${BOOK_DIRECTORY}/${bookId}.epub`;
  pathOwnerCounter += 1;
  const ownerToken = pathOwnerCounter;
  latestIntentByPath.set(finalPath, ownerToken);
  const isCurrentIntent = () => latestIntentByPath.get(finalPath) === ownerToken;
  const throwIfCancelled = () => {
    if (signal?.aborted || !isCurrentIntent()) throw createAbortError();
  };

  let currentAttempt: AttemptState | null = null;
  let activeHopUrl = target.url;
  let listener: { remove: () => Promise<void> } | null = null;

  try {
    await raceWithAbort(cleanupInterruptedEpubDownloads(), signal);
    throwIfCancelled();
    await raceWithAbort(ensureDataDirectory(BOOK_DIRECTORY), signal);
    throwIfCancelled();

    listener =
      onProgress && typeof FileTransfer.addListener === 'function'
        ? await raceWithAbort(
            FileTransfer.addListener('progress', (event) => {
              if (
                !signal?.aborted &&
                isCurrentIntent() &&
                currentAttempt !== null &&
                !currentAttempt.disposed &&
                event.type === 'download' &&
                event.url === activeHopUrl &&
                event.lengthComputable &&
                event.contentLength > 0 &&
                Number.isFinite(event.bytes)
              ) {
                onProgress(
                  Math.max(0, Math.min(100, Math.floor((event.bytes / event.contentLength) * 100))),
                );
              }
            }).catch(() => null),
            signal,
          )
        : null;

    for (let attempt = 0; ; attempt += 1) {
      throwIfCancelled();
      transferAttemptCounter += 1;
      const attemptId = transferAttemptCounter;
      const attemptPath = `${BOOK_DIRECTORY}/${bookId}.${Date.now().toString(36)}-${attemptId}.epub${PARTIAL_SUFFIX}`;
      const attemptState: AttemptState = {
        id: attemptId,
        path: attemptPath,
        pendingOp: null,
        disposed: false,
        committed: false,
      };
      currentAttempt = attemptState;

      try {
        const destination = await raceWithAbort(
          Filesystem.getUri({ path: attemptPath, directory: Directory.Data }),
          signal,
        );
        throwIfCancelled();
        await runAttemptOp(
          attemptState,
          downloadFileWithRedirects({
            initialUrl: target.url,
            normalizedInitialUrl: target.normalizedUrl,
            serverOrigin: target.serverOrigin,
            path: destination.uri,
            apiKey,
            progress: Boolean(listener),
            connectTimeout: EPUB_CONNECT_TIMEOUT_MS,
            readTimeout: EPUB_READ_TIMEOUT_MS,
            signal,
            isCancelled: () => signal?.aborted === true || !isCurrentIntent(),
            onHop: (url) => {
              activeHopUrl = url;
            },
          }),
          signal,
        );
        throwIfCancelled();
        break;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted || !isCurrentIntent()) {
          throw createAbortError();
        }
        if (error instanceof KavitaError) throw error;
        const { code, status } = readTransferFailure(error);
        const timedOut = status === undefined && isTimeoutFailure(error);
        const connectionFailed = code === 'OS-PLUG-FLTR-0008';
        const retryable =
          status === undefined ? connectionFailed || timedOut : RETRYABLE_HTTP_STATUSES.has(status);
        if (attempt > 0 || !retryable) {
          if (timedOut) {
            recordDiagnostic({
              category: 'download',
              endpoint: EPUB_DOWNLOAD_ENDPOINT,
              detail: 'download-timeout',
            });
          }
          throw new EpubTransferError(status, connectionFailed, timedOut);
        }

        await disposeAttempt(attemptState);
        currentAttempt = null;
        recordDiagnostic({
          category: 'download',
          endpoint: EPUB_DOWNLOAD_ENDPOINT,
          status,
          detail: 'download-retry',
        });
        await delayWithAbort(750, signal);
      }
    }

    if (!currentAttempt) throw createAbortError();
    const verifiedAttempt = currentAttempt;
    const verifiedPath = verifiedAttempt.path;
    throwIfCancelled();
    const stat = await runAttemptOp(
      verifiedAttempt,
      Filesystem.stat({ path: verifiedPath, directory: Directory.Data }),
      signal,
    );
    if (stat.type !== 'file') throw new EpubValidationError('Kavita did not return an EPUB file.');
    const readRange = (offset: number, length: number) =>
      readNativeRange(verifiedPath, offset, length);
    const repaired = await runAttemptOp(
      verifiedAttempt,
      validateEpubArchive(stat.size, readRange, true),
      signal,
    );
    if (repaired) {
      throwIfCancelled();
      let binary = '';
      for (let offset = 0; offset < repaired.length; offset += 8192) {
        binary += String.fromCharCode(...repaired.subarray(offset, offset + 8192));
      }
      await runAttemptOp(
        verifiedAttempt,
        Filesystem.writeFile({
          path: verifiedPath,
          directory: Directory.Data,
          data: btoa(binary),
        }),
        signal,
      );
      const written = await runAttemptOp(
        verifiedAttempt,
        Filesystem.stat({ path: verifiedPath, directory: Directory.Data }),
        signal,
      );
      if (written.type !== 'file' || written.size !== repaired.length) {
        throw new Error('The repaired EPUB could not be saved.');
      }
      await runAttemptOp(verifiedAttempt, validateEpubArchive(written.size, readRange), signal);
    }
    throwIfCancelled();
    const commitOp = withBookFileLock(finalPath, async () => {
      throwIfCancelled();
      const final = await Filesystem.getUri({ path: finalPath, directory: Directory.Data });
      throwIfCancelled();
      const webViewUrl = Capacitor.convertFileSrc(final.uri);
      await Filesystem.rename({
        from: verifiedPath,
        to: finalPath,
        directory: Directory.Data,
      });
      verifiedAttempt.committed = true;
      committedOwnerByPath.set(finalPath, ownerToken);
      if (signal?.aborted || !isCurrentIntent()) {
        if (!options?.preserveExistingOnAbort) {
          await Filesystem.deleteFile({ path: finalPath, directory: Directory.Data }).catch(
            () => {},
          );
          if (committedOwnerByPath.get(finalPath) === ownerToken) {
            committedOwnerByPath.delete(finalPath);
          }
        }
        throw createAbortError();
      }
      return {
        relativePath: finalPath,
        nativeUri: final.uri,
        webViewUrl,
        size: repaired?.length ?? stat.size,
        ownerToken,
      };
    });
    return await runAttemptOp(verifiedAttempt, commitOp, signal);
  } catch (error) {
    await disposeAttempt(currentAttempt);
    if (isAbortError(error)) {
      recordDiagnostic({
        category: 'download',
        endpoint: EPUB_DOWNLOAD_ENDPOINT,
        detail: 'download-cancelled',
      });
    }
    throw error;
  } finally {
    await listener?.remove().catch(() => {});
  }
}

export async function verifyDownloadedEpub(
  relativePath: string,
): Promise<DownloadedBookFile | null> {
  try {
    assertSafeBookPath(relativePath);
  } catch {
    return null;
  }
  return withBookFileLock(relativePath, async () => {
    try {
      const stat = await Filesystem.stat({ path: relativePath, directory: Directory.Data });
      if (stat.type !== 'file') return null;
      await validateEpubArchive(stat.size, (offset, length) =>
        readNativeRange(relativePath, offset, length),
      );
      const uri = await Filesystem.getUri({ path: relativePath, directory: Directory.Data });
      return {
        relativePath,
        nativeUri: uri.uri,
        webViewUrl: Capacitor.convertFileSrc(uri.uri),
        size: stat.size,
      };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'OS-PLUG-FILE-0008') return null;
      if (!(error instanceof EpubValidationError)) throw error;
      await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data }).catch(
        () => {},
      );
      committedOwnerByPath.delete(relativePath);
      return null;
    }
  });
}

export async function deleteDownloadedEpub(
  relativePath: string,
  expectedOwnerToken?: number,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  assertSafeBookPath(relativePath);
  if (expectedOwnerToken === undefined) {
    pathOwnerCounter += 1;
    latestIntentByPath.set(relativePath, pathOwnerCounter);
  }
  await withBookFileLock(relativePath, async () => {
    if (
      expectedOwnerToken !== undefined &&
      committedOwnerByPath.get(relativePath) !== expectedOwnerToken
    ) {
      return;
    }
    try {
      await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data });
      committedOwnerByPath.delete(relativePath);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'OS-PLUG-FILE-0008') {
        committedOwnerByPath.delete(relativePath);
      }
      throw error;
    }
  });
}

export async function cacheCover(
  downloadUrl: string,
  apiKey: string,
  seriesId: number,
  signal?: AbortSignal,
  cacheNamespace = 'default',
  allowDownload = true,
  serverOrigin?: string,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const target = assertSafeTransferTarget(
    downloadUrl,
    serverOrigin,
    'Invalid Kavita cover address.',
  );
  const namespace = safeCoverNamespace(cacheNamespace);
  const directory = `covers/${namespace}`;
  const path = `${directory}/${seriesId}.img`;
  const temporaryPath = `${path}.partial`;
  const valid = await Filesystem.stat({ path, directory: Directory.Data }).catch(() => null);
  if (!valid || valid.type !== 'file' || valid.size === 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!allowDownload) throw new Error('Offline');
    await ensureDataDirectory(directory);
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => {});
    const temporary = await Filesystem.getUri({ path: temporaryPath, directory: Directory.Data });
    try {
      await downloadFileWithRedirects({
        initialUrl: target.url,
        normalizedInitialUrl: target.normalizedUrl,
        serverOrigin: target.serverOrigin,
        path: temporary.uri,
        apiKey,
        connectTimeout: 5_000,
        readTimeout: 5_000,
        signal,
      });
      const downloaded = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data });
      if (downloaded.type !== 'file' || downloaded.size === 0)
        throw new Error('Kavita returned an empty cover.');
      await Filesystem.rename({
        from: temporaryPath,
        to: path,
        directory: Directory.Data,
      });
    } catch (error) {
      await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(
        () => {},
      );
      throw error;
    }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (valid?.type === 'file' && valid.size > 0 && valid.uri) {
    return Capacitor.convertFileSrc(valid.uri);
  }
  const existing = await Filesystem.getUri({ path, directory: Directory.Data });
  return Capacitor.convertFileSrc(existing.uri);
}

export async function clearCoverCache(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.rmdir({ path: 'covers', directory: Directory.Data, recursive: true }).catch(
    () => {},
  );
}
