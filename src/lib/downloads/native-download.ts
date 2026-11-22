import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { recordDiagnostic } from '../diagnostics/log';
import { EpubValidationError, validateEpubArchive } from './epub-validation';

const BOOK_DIRECTORY = 'books';
const PARTIAL_SUFFIX = '.partial';
export const EPUB_DOWNLOAD_ENDPOINT = '/api/Download/chapter';
export const EPUB_CONNECT_TIMEOUT_MS = 10_000;
export const EPUB_READ_TIMEOUT_MS = 10_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);
let interruptedDownloadCleanup: Promise<void> | undefined;
let transferAttemptCounter = 0;
const latestAttemptByBook = new Map<string, number>();

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

function isTimeoutFailure(
  failure: {
    code?: unknown;
    message?: unknown;
    data?: { exception?: unknown };
  } | null,
): boolean {
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

export async function downloadEpub(
  downloadUrl: string,
  apiKey: string,
  bookId: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<DownloadedBookFile> {
  if (!Capacitor.isNativePlatform()) throw new Error('Downloads require the native application.');
  if (!/^https?:\/\//i.test(downloadUrl)) throw new Error('Invalid Kavita download address.');
  assertSafeBookId(bookId);

  const finalPath = `${BOOK_DIRECTORY}/${bookId}.epub`;
  let temporaryPath: string | null = null;
  let activeAttemptId = 0;
  let listener: { remove: () => Promise<void> } | null = null;

  try {
    throwIfAborted(signal);
    await raceWithAbort(cleanupInterruptedEpubDownloads(), signal);
    await raceWithAbort(ensureDataDirectory(BOOK_DIRECTORY), signal);
    throwIfAborted(signal);

    listener =
      onProgress && typeof FileTransfer.addListener === 'function'
        ? await raceWithAbort(
            FileTransfer.addListener('progress', (event) => {
              if (
                !signal?.aborted &&
                latestAttemptByBook.get(bookId) === activeAttemptId &&
                event.type === 'download' &&
                event.url === downloadUrl &&
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
      throwIfAborted(signal);
      transferAttemptCounter += 1;
      const attemptId = transferAttemptCounter;
      activeAttemptId = attemptId;
      latestAttemptByBook.set(bookId, attemptId);
      const attemptPath = `${BOOK_DIRECTORY}/${bookId}.${Date.now().toString(36)}-${attemptId}.epub${PARTIAL_SUFFIX}`;
      temporaryPath = attemptPath;

      try {
        const destination = await raceWithAbort(
          Filesystem.getUri({ path: attemptPath, directory: Directory.Data }),
          signal,
        );
        let attemptAbandoned = false;
        let transferSettled = false;
        const transfer = FileTransfer.downloadFile({
          url: downloadUrl,
          path: destination.uri,
          headers: { 'x-api-key': apiKey },
          connectTimeout: EPUB_CONNECT_TIMEOUT_MS,
          readTimeout: EPUB_READ_TIMEOUT_MS,
          ...(listener ? { progress: true } : {}),
        });
        void transfer
          .finally(() => {
            transferSettled = true;
            if (attemptAbandoned) {
              return Filesystem.deleteFile({ path: attemptPath, directory: Directory.Data }).catch(
                () => {},
              );
            }
          })
          .catch(() => {});

        try {
          await raceWithAbort(transfer, signal);
        } catch (transferError) {
          if (isAbortError(transferError) || signal?.aborted) {
            if (!transferSettled) attemptAbandoned = true;
            throw createAbortError();
          }
          throw transferError;
        }
        break;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          throw createAbortError();
        }
        const failure = error as {
          code?: unknown;
          message?: unknown;
          data?: { httpStatus?: unknown; exception?: unknown };
        } | null;
        const httpStatus = failure?.data?.httpStatus;
        const status =
          typeof httpStatus === 'number' &&
          Number.isInteger(httpStatus) &&
          httpStatus >= 100 &&
          httpStatus <= 599
            ? httpStatus
            : undefined;
        const timedOut = status === undefined && isTimeoutFailure(failure);
        const connectionFailed = failure?.code === 'OS-PLUG-FLTR-0008';
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

        await Filesystem.deleteFile({ path: attemptPath, directory: Directory.Data }).catch(
          () => {},
        );
        temporaryPath = null;
        recordDiagnostic({
          category: 'download',
          endpoint: EPUB_DOWNLOAD_ENDPOINT,
          status,
          detail: 'download-retry',
        });
        await delayWithAbort(750, signal);
      }
    }

    if (!temporaryPath) throw createAbortError();
    const verifiedPath = temporaryPath;
    throwIfAborted(signal);
    const stat = await raceWithAbort(
      Filesystem.stat({ path: verifiedPath, directory: Directory.Data }),
      signal,
    );
    if (stat.type !== 'file') throw new EpubValidationError('Kavita did not return an EPUB file.');
    const readRange = (offset: number, length: number) =>
      readNativeRange(verifiedPath, offset, length);
    const repaired = await raceWithAbort(validateEpubArchive(stat.size, readRange, true), signal);
    if (repaired) {
      throwIfAborted(signal);
      let binary = '';
      for (let offset = 0; offset < repaired.length; offset += 8192) {
        binary += String.fromCharCode(...repaired.subarray(offset, offset + 8192));
      }
      await raceWithAbort(
        Filesystem.writeFile({
          path: verifiedPath,
          directory: Directory.Data,
          data: btoa(binary),
        }),
        signal,
      );
      const written = await raceWithAbort(
        Filesystem.stat({ path: verifiedPath, directory: Directory.Data }),
        signal,
      );
      if (written.type !== 'file' || written.size !== repaired.length) {
        throw new Error('The repaired EPUB could not be saved.');
      }
      await raceWithAbort(validateEpubArchive(written.size, readRange), signal);
    }
    if (signal?.aborted || latestAttemptByBook.get(bookId) !== activeAttemptId) {
      throw createAbortError();
    }
    const final = await raceWithAbort(
      Filesystem.getUri({ path: finalPath, directory: Directory.Data }),
      signal,
    );
    if (signal?.aborted || latestAttemptByBook.get(bookId) !== activeAttemptId) {
      throw createAbortError();
    }
    const webViewUrl = Capacitor.convertFileSrc(final.uri);
    await Filesystem.rename({
      from: verifiedPath,
      to: finalPath,
      directory: Directory.Data,
    });
    temporaryPath = null;
    if (signal?.aborted) {
      if (latestAttemptByBook.get(bookId) === activeAttemptId) {
        await Filesystem.deleteFile({ path: finalPath, directory: Directory.Data }).catch(() => {});
      }
      throw createAbortError();
    }
    return {
      relativePath: finalPath,
      nativeUri: final.uri,
      webViewUrl,
      size: repaired?.length ?? stat.size,
    };
  } catch (error) {
    if (temporaryPath) {
      await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(
        () => {},
      );
    }
    if (isAbortError(error)) {
      recordDiagnostic({
        category: 'download',
        endpoint: EPUB_DOWNLOAD_ENDPOINT,
        detail: 'download-cancelled',
      });
    }
    throw error;
  } finally {
    if (latestAttemptByBook.get(bookId) === activeAttemptId) {
      latestAttemptByBook.delete(bookId);
    }
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
    await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data }).catch(() => {});
    return null;
  }
}

export async function deleteDownloadedEpub(relativePath: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  assertSafeBookPath(relativePath);
  await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data });
}

export async function cacheCover(
  downloadUrl: string,
  apiKey: string,
  seriesId: number,
  signal?: AbortSignal,
  cacheNamespace = 'default',
  allowDownload = true,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
      await FileTransfer.downloadFile({
        url: downloadUrl,
        path: temporary.uri,
        headers: { 'x-api-key': apiKey },
        connectTimeout: 5_000,
        readTimeout: 5_000,
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
