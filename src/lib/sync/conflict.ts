import { kavitaXPathSteps } from '../reader/kavita-xpath';

export interface ProgressSnapshot {
  cfi: string | null;
  xpath: string | null;
  percentage: number;
  updatedAt: string;
}

export type ProgressDecision =
  | { kind: 'local' }
  | { kind: 'server' }
  | { kind: 'same' }
  | { kind: 'conflict'; local: ProgressSnapshot; server: ProgressSnapshot };

function sameLocation(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  if (a.xpath && b.xpath) return a.xpath === b.xpath;
  if (a.cfi && b.cfi) return a.cfi === b.cfi;
  return Math.abs(a.percentage - b.percentage) < 0.001;
}

export function detectProgressConflict(
  local: ProgressSnapshot,
  server: ProgressSnapshot,
  shared: ProgressSnapshot | null,
): ProgressDecision {
  if (sameLocation(local, server)) return { kind: 'same' };
  if (!shared) return { kind: 'conflict', local, server };

  const localChanged = !sameLocation(local, shared);
  const serverChanged = !sameLocation(server, shared);
  if (localChanged && serverChanged) return { kind: 'conflict', local, server };
  if (localChanged) return { kind: 'local' };
  if (serverChanged) return { kind: 'server' };
  return { kind: 'same' };
}

export function chooseFurthestProgress(
  localPercentage: number,
  remotePercentage: number,
): 'local' | 'remote' {
  return remotePercentage > localPercentage ? 'remote' : 'local';
}

export function compareKavitaLocations(local: string, remote: string): 'local' | 'remote' | 'same' {
  const localPath = kavitaXPathSteps(local);
  const remotePath = kavitaXPathSteps(remote);
  if (!localPath || !remotePath) return 'same';
  const length = Math.max(localPath.length, remotePath.length);
  for (let index = 0; index < length; index += 1) {
    const localStep = localPath[index] ?? 0;
    const remoteStep = remotePath[index] ?? 0;
    if (remoteStep > localStep) return 'remote';
    if (localStep > remoteStep) return 'local';
  }
  return 'same';
}

export function shouldPreferFurthest(autoSync: boolean, manualRequest?: boolean): boolean {
  return autoSync || manualRequest === true;
}

export function toKavitaPageNumber(
  percentage: number,
  totalPages: number,
  spineIndex?: number,
): number {
  if (!Number.isFinite(percentage) || totalPages <= 0) return 0;
  const nearestPage =
    Number.isInteger(spineIndex) && spineIndex !== undefined && spineIndex >= 0
      ? spineIndex + 1
      : Math.round(Math.max(0, percentage) * totalPages);
  return Math.min(Math.max(0, totalPages - 1), nearestPage);
}

export interface OpenLocalProgress {
  cfi?: string;
  percentage: number;
  pendingSync: boolean;
  xpath: string | null;
}

export interface OpenRemoteProgress {
  pageNum: number;
  bookScrollId?: string | null;
}

export type OpenProgressDecision = 'local' | 'remote' | 'conflict' | 'none';

export function chooseOpenProgress(
  local: OpenLocalProgress | null,
  remote: OpenRemoteProgress | null,
  bookPages: number,
  preferFurthest: boolean,
): OpenProgressDecision {
  const hasRemoteLocation = Boolean(remote?.bookScrollId || (remote && remote.pageNum > 0));
  if (!local && hasRemoteLocation) return 'remote';
  if (!local) return 'none';
  if (!hasRemoteLocation) return 'local';

  if (local.pendingSync) {
    return remote?.bookScrollId !== local.xpath ? 'conflict' : 'local';
  }

  // Kavita's XPath does not retain EPUB.js's exact CFI. When both snapshots
  // point at the same element, keep the finer local locator even with
  // automatic furthest selection turned off.
  if (local.xpath && remote?.bookScrollId === local.xpath) return 'local';

  if (preferFurthest && remote) {
    if (local.xpath && remote.bookScrollId) {
      const location = compareKavitaLocations(local.xpath, remote.bookScrollId);
      if (location !== 'same') return location;
    }
    const remotePercentage = bookPages ? remote.pageNum / bookPages : 0;
    return chooseFurthestProgress(local.percentage, remotePercentage);
  }

  return 'remote';
}
