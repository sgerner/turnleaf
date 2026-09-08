import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';

const BOOK_DIRECTORY = 'books';

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
  await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
}

export async function downloadEpub(
  downloadUrl: string,
  apiKey: string,
  bookId: string,
): Promise<DownloadedBookFile> {
  if (!Capacitor.isNativePlatform()) throw new Error('Downloads require the native application.');
  if (!/^https?:\/\//i.test(downloadUrl)) throw new Error('Invalid Kavita download address.');

  await ensureDataDirectory(BOOK_DIRECTORY);
  const finalPath = `${BOOK_DIRECTORY}/${bookId}.epub`;
  const temporaryPath = `${finalPath}.partial`;
  const destination = await Filesystem.getUri({ path: temporaryPath, directory: Directory.Data });

  try {
    await FileTransfer.downloadFile({
      url: downloadUrl,
      path: destination.uri,
      headers: { 'x-api-key': apiKey },
      progress: true,
    });
    const stat = await Filesystem.stat({ path: temporaryPath, directory: Directory.Data });
    if (stat.type !== 'file' || stat.size < 22)
      throw new Error('Kavita returned an empty EPUB file.');
    await Filesystem.rename({
      from: temporaryPath,
      to: finalPath,
      directory: Directory.Data,
    });
    const final = await Filesystem.getUri({ path: finalPath, directory: Directory.Data });
    return {
      relativePath: finalPath,
      nativeUri: final.uri,
      webViewUrl: Capacitor.convertFileSrc(final.uri),
      size: stat.size,
    };
  } catch (error) {
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => {});
    throw error;
  }
}

export async function verifyDownloadedEpub(
  relativePath: string,
): Promise<DownloadedBookFile | null> {
  try {
    const stat = await Filesystem.stat({ path: relativePath, directory: Directory.Data });
    if (stat.type !== 'file' || stat.size < 22) return null;
    const uri = await Filesystem.getUri({ path: relativePath, directory: Directory.Data });
    return {
      relativePath,
      nativeUri: uri.uri,
      webViewUrl: Capacitor.convertFileSrc(uri.uri),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

export async function deleteDownloadedEpub(relativePath: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data });
}

export async function cacheCover(
  downloadUrl: string,
  apiKey: string,
  seriesId: number,
  signal?: AbortSignal,
  cacheNamespace = 'default',
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const directory = 'covers';
  const namespace = safeCoverNamespace(cacheNamespace);
  const path = `${directory}/${namespace}/${seriesId}.img`;
  const temporaryPath = `${path}.partial`;
  await ensureDataDirectory(directory);
  await ensureDataDirectory(`${directory}/${namespace}`);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const existing = await Filesystem.getUri({ path, directory: Directory.Data });
  const valid = await Filesystem.stat({ path, directory: Directory.Data }).catch(() => null);
  if (!valid || valid.type !== 'file' || valid.size === 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => {});
    const temporary = await Filesystem.getUri({ path: temporaryPath, directory: Directory.Data });
    try {
      await FileTransfer.downloadFile({
        url: downloadUrl,
        path: temporary.uri,
        headers: { 'x-api-key': apiKey },
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
  return Capacitor.convertFileSrc(existing.uri);
}

export async function clearCoverCache(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.rmdir({ path: 'covers', directory: Directory.Data, recursive: true }).catch(
    () => {},
  );
}
