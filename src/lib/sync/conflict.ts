import {
  bodyContentSteps,
  parseKavitaXPath,
  resolveKavitaPageNumber,
} from '../reader/kavita-xpath';

export function chooseFurthestProgress(
  localPercentage: number,
  remotePercentage: number,
): 'local' | 'remote' {
  return remotePercentage > localPercentage ? 'remote' : 'local';
}

export function compareKavitaLocations(
  local: string,
  remote: string,
  localPageNum?: number | null,
  remotePageNum?: number | null,
): 'local' | 'remote' | 'same' | 'unknown' {
  const localTarget = parseKavitaXPath(local, localPageNum);
  const remoteTarget = parseKavitaXPath(remote, remotePageNum);
  if (!localTarget || !remoteTarget) return 'unknown';

  if (remoteTarget.spineIndex > localTarget.spineIndex) return 'remote';
  if (localTarget.spineIndex > remoteTarget.spineIndex) return 'local';
  if (localTarget.contentXPath === remoteTarget.contentXPath) return 'same';

  const localSteps = bodyContentSteps(localTarget.contentXPath);
  const remoteSteps = bodyContentSteps(remoteTarget.contentXPath);
  if (!localSteps || !remoteSteps) return 'unknown';

  const length = Math.max(localSteps.length, remoteSteps.length);
  for (let index = 0; index < length; index += 1) {
    const localStep = localSteps[index];
    const remoteStep = remoteSteps[index];
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
      ? spineIndex
      : Math.floor(Math.max(0, percentage) * totalPages + 1e-9);
  return Math.min(Math.max(0, totalPages - 1), nearestPage);
}

export interface OpenLocalProgress {
  cfi?: string;
  pageNum?: number | null;
  percentage: number;
  pendingSync: boolean;
  xpath: string | null;
}

export interface OpenRemoteProgress {
  pageNum: number;
  bookScrollId?: string | null;
}

export type OpenProgressDecision = 'local' | 'remote' | 'conflict' | 'none';

function sameKavitaLocation(
  local: OpenLocalProgress,
  remote: OpenRemoteProgress,
  bookPages: number,
): boolean {
  const localXPath = local.xpath?.trim();
  const remoteXPath = remote.bookScrollId?.trim();
  if (bookPages > 0) {
    const localCompleted = local.pageNum != null && local.pageNum >= bookPages && !localXPath;
    const remoteCompleted = remote.pageNum >= bookPages;
    if (localCompleted || remoteCompleted) return localCompleted && remoteCompleted;
  }
  if (!localXPath && !remoteXPath) {
    return local.pageNum != null && local.pageNum === remote.pageNum && remote.pageNum > 0;
  }
  if (!localXPath || !remoteXPath) return false;

  const localTarget = parseKavitaXPath(localXPath, local.pageNum);
  const remoteTarget = parseKavitaXPath(remoteXPath, remote.pageNum);
  if (localTarget && remoteTarget) {
    return (
      localTarget.spineIndex === remoteTarget.spineIndex &&
      localTarget.contentXPath === remoteTarget.contentXPath
    );
  }
  if (localTarget || remoteTarget) return local.pageNum == null && localXPath === remoteXPath;
  return (local.pageNum == null || local.pageNum === remote.pageNum) && localXPath === remoteXPath;
}

export function chooseOpenProgress(
  local: OpenLocalProgress | null,
  remote: OpenRemoteProgress | null,
  bookPages: number,
  preferFurthest: boolean,
): OpenProgressDecision {
  const hasRemoteLocation = Boolean(remote?.bookScrollId?.trim() || (remote && remote.pageNum > 0));
  if (!local && hasRemoteLocation) return 'remote';
  if (!local) return 'none';
  if (!hasRemoteLocation || !remote) return 'local';

  if (local.pendingSync) {
    return sameKavitaLocation(local, remote, bookPages) ? 'local' : 'conflict';
  }

  if (preferFurthest && bookPages > 0 && remote.pageNum >= bookPages) {
    return local.percentage < 1 ? 'remote' : 'local';
  }

  // Kavita's XPath does not retain EPUB.js's exact CFI. When both snapshots
  // point at the same element, keep the finer local locator even with
  // automatic furthest selection turned off.
  if (sameKavitaLocation(local, remote, bookPages)) return 'local';

  if (preferFurthest) {
    if (local.percentage >= 1) return 'local';
    if (local.xpath && remote.bookScrollId) {
      const location = compareKavitaLocations(
        local.xpath,
        remote.bookScrollId,
        local.pageNum,
        remote.pageNum,
      );
      return location === 'remote' ? 'remote' : 'local';
    }
    const remotePage = resolveKavitaPageNumber(remote.pageNum, remote.bookScrollId, bookPages) ?? 0;
    const localPage = local.xpath?.trim()
      ? resolveKavitaPageNumber(local.pageNum, local.xpath, bookPages)
      : null;
    if (localPage !== null) {
      if (remotePage > localPage) return 'remote';
      if (localPage > remotePage) return 'local';
      if (!remote.bookScrollId?.trim()) return 'local';
    }
    const remotePercentage = bookPages > 0 ? remotePage / bookPages : 0;
    return chooseFurthestProgress(local.percentage, remotePercentage);
  }

  return 'local';
}
