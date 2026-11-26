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
const RETRYABLE_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);
let interruptedDownloadCleanup: Promise<void> | undefined;

export class EpubTransferError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly connectionFailed: boolean,
  ) {
    super('The EPUB transfer failed.');
  }
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
  transferredSize?: number;
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
  onHop?: ((url: string) => void) | undefined;
}): Promise<void> {
  const redirects = createRedirectState(
    options.initialUrl,
    options.serverOrigin,
    'GET',
    options.normalizedInitialUrl,
  );
  while (true) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
): Promise<DownloadedBookFile> {
  if (!Capacitor.isNativePlatform()) throw new Error('Downloads require the native application.');
  const target = assertSafeTransferTarget(
    downloadUrl,
    serverOrigin,
    'Invalid Kavita download address.',
  );
  assertSafeBookId(bookId);

  await cleanupInterruptedEpubDownloads();
  await ensureDataDirectory(BOOK_DIRECTORY);
  const finalPath = `${BOOK_DIRECTORY}/${bookId}.epub`;
  const temporaryPath = `${finalPath}${PARTIAL_SUFFIX}`;
  const destination = await Filesystem.getUri({ path: temporaryPath, directory: Directory.Data });
  let activeHopUrl = target.url;
  const listener = onProgress
    ? await FileTransfer.addListener('progress', (event) => {
        if (
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
      }).catch(() => null)
    : null;

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await downloadFileWithRedirects({
          initialUrl: target.url,
          normalizedInitialUrl: target.normalizedUrl,
          serverOrigin: target.serverOrigin,
          path: destination.uri,
          apiKey,
          progress: Boolean(listener),
          onHop: (url) => {
            activeHopUrl = url;
          },
        });
        break;
      } catch (error) {
        if (error instanceof KavitaError) throw error;
        const { code, status } = readTransferFailure(error);
        const connectionFailed = code === 'OS-PLUG-FLTR-0008';
        const retryable =
          status === undefined ? connectionFailed : RETRYABLE_HTTP_STATUSES.has(status);
        if (attempt > 0 || !retryable) throw new EpubTransferError(status, connectionFailed);

        await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(
          () => {},
        );
        recordDiagnostic({
          category: 'download',
          endpoint: EPUB_DOWNLOAD_ENDPOINT,
          status,
          detail: 'download-retry',
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    const stat = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data });
    if (stat.type !== 'file') throw new EpubValidationError('Kavita did not return an EPUB file.');
    const readRange = (offset: number, length: number) =>
      readNativeRange(temporaryPath, offset, length);
    const repaired = await validateEpubArchive(stat.size, readRange, true);
    if (repaired) {
      let binary = '';
      for (let offset = 0; offset < repaired.length; offset += 8192) {
        binary += String.fromCharCode(...repaired.subarray(offset, offset + 8192));
      }
      await Filesystem.writeFile({
        path: temporaryPath,
        directory: Directory.Data,
        data: btoa(binary),
      });
      const written = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data });
      if (written.type !== 'file' || written.size !== repaired.length) {
        throw new Error('The repaired EPUB could not be saved.');
      }
      await validateEpubArchive(written.size, readRange);
    }
    const final = await Filesystem.getUri({ path: finalPath, directory: Directory.Data });
    const webViewUrl = Capacitor.convertFileSrc(final.uri);
    await Filesystem.rename({
      from: temporaryPath,
      to: finalPath,
      directory: Directory.Data,
    });
    return {
      relativePath: finalPath,
      nativeUri: final.uri,
      webViewUrl,
      size: repaired?.length ?? stat.size,
      transferredSize: stat.size,
    };
  } catch (error) {
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => {});
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
