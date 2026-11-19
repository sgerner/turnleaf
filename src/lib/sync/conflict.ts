import { kavitaXPathSteps } from '../reader/kavita-xpath';

export function chooseFurthestProgress(
  localPercentage: number,
  remotePercentage: number,
): 'local' | 'remote' {
  return remotePercentage > localPercentage ? 'remote' : 'local';
}

export function compareKavitaLocations(
  local: string,
  remote: string,
): 'local' | 'remote' | 'same' | 'unknown' {
  const localPath = kavitaXPathSteps(local);
  const remotePath = kavitaXPathSteps(remote);
  if (!localPath || !remotePath) return 'unknown';
  const length = Math.max(localPath.length, remotePath.length);
  for (let index = 0; index < length; index += 1) {
    const localStep = localPath[index];
    const remoteStep = remotePath[index];
    if (!localStep) return 'remote';
    if (!remoteStep) return 'local';
    // XPath indices count siblings of the same tag, so mixed tags have no
    // intrinsic order without inspecting the chapter document.
    if (localStep.tag !== remoteStep.tag) return 'unknown';
    if (remoteStep.index > localStep.index) return 'remote';
    if (localStep.index > remoteStep.index) return 'local';
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
    return !local.xpath || remote?.bookScrollId !== local.xpath ? 'conflict' : 'local';
  }

  if (preferFurthest && remote && bookPages > 0 && remote.pageNum >= bookPages) {
    return local.percentage < 1 ? 'remote' : 'local';
  }

  // Kavita's XPath does not retain EPUB.js's exact CFI. When both snapshots
  // point at the same element, keep the finer local locator even with
  // automatic furthest selection turned off.
  if (local.xpath && remote?.bookScrollId === local.xpath) return 'local';

  if (preferFurthest && remote) {
    if (local.percentage >= 1) return 'local';
    if (local.xpath && remote.bookScrollId) {
      const location = compareKavitaLocations(local.xpath, remote.bookScrollId);
      return location === 'remote' ? 'remote' : 'local';
    }
    const remotePercentage = bookPages ? remote.pageNum / bookPages : 0;
    return chooseFurthestProgress(local.percentage, remotePercentage);
  }

  return 'local';
}
