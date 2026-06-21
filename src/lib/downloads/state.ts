export type DownloadStatus = 'none' | 'downloading' | 'available' | 'failed';
export type DownloadEvent = 'start' | 'complete' | 'fail' | 'remove' | 'missing';

export function nextDownloadStatus(status: DownloadStatus, event: DownloadEvent): DownloadStatus {
  if (event === 'remove' || event === 'missing') return 'none';
  if (event === 'start' && status !== 'downloading') return 'downloading';
  if (event === 'complete' && status === 'downloading') return 'available';
  if (event === 'fail' && status === 'downloading') return 'failed';
  throw new Error(`Invalid download transition: ${status} -> ${event}`);
}
