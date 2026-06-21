import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';

const BOOK_DIRECTORY = 'books';

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
): Promise<string> {
  const directory = 'covers';
  const path = `${directory}/${seriesId}.img`;
  await ensureDataDirectory(directory);
  const existing = await Filesystem.getUri({ path, directory: Directory.Data });
  const valid = await Filesystem.stat({ path, directory: Directory.Data }).catch(() => null);
  if (!valid || valid.size === 0) {
    await FileTransfer.downloadFile({
      url: downloadUrl,
      path: existing.uri,
      headers: { 'x-api-key': apiKey },
    });
  }
  return Capacitor.convertFileSrc(existing.uri);
}

export async function clearCoverCache(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.rmdir({ path: 'covers', directory: Directory.Data, recursive: true }).catch(
    () => {},
  );
}
