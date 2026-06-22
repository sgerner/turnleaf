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

export function shouldPreferFurthest(autoSync: boolean, manualRequest?: boolean): boolean {
  return autoSync || manualRequest === true;
}
