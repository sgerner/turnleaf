import type { VirtualWindow } from '../components/library-virtualization';

export interface TocItem {
  label: string;
  href: string;
  children: TocItem[];
}

export interface FlatTocItem {
  index: number;
  label: string;
  href: string;
  sectionHref: string;
  depth: number;
}

export interface IndexedToc {
  items: FlatTocItem[];
  labels: Map<string, string>;
  firstRowBySectionHref: Map<string, number>;
}

export const TOC_VIRTUALIZATION_THRESHOLD = 100;
export const TOC_ROW_HEIGHT_PX = 48;
export const TOC_OVERSCAN_ROWS = 4;
export const TOC_FALLBACK_VIEWPORT_HEIGHT_PX = TOC_ROW_HEIGHT_PX * 8;

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export function splitEpubHref(href: string): { path: string; fragment: string } {
  const trimmed = href.trim();
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) return { path: trimmed, fragment: '' };
  return {
    path: trimmed.slice(0, hashIndex),
    fragment: trimmed.slice(hashIndex),
  };
}

export function stripHrefFragment(href: string): string {
  return splitEpubHref(href).path;
}

export function safeDecodeEpubPath(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  }
}

export function normalizeEpubPath(
  rawPath: string,
  baseDirSegments: readonly string[] = [],
): string {
  const normalizedSlashes = rawPath.trim().replace(/\\/g, '/');
  if (!normalizedSlashes) return '';
  const segments = normalizedSlashes.startsWith('/') ? [] : [...baseDirSegments];
  for (const segment of normalizedSlashes.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function directorySegments(filePath: string): string[] {
  const trimmed = filePath.trim().replace(/\\/g, '/');
  if (!trimmed) return [];
  const normalized = normalizeEpubPath(trimmed);
  if (!normalized) return [];
  const parts = normalized.split('/');
  if (!trimmed.endsWith('/')) parts.pop();
  return parts;
}

export function canonicalSectionHref(href: string): string {
  const path = stripHrefFragment(href);
  if (!path) return '';
  return safeDecodeEpubPath(normalizeEpubPath(path));
}

function registerSpineLookupKey(lookup: Map<string, string>, key: string, target: string): void {
  if (key && !lookup.has(key)) lookup.set(key, target);
}

export function createSpineHrefLookup(spineHrefs: Iterable<string>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const rawHref of spineHrefs) {
    const href = rawHref.trim();
    if (!href) continue;
    registerSpineLookupKey(lookup, href, href);
    const normalized = normalizeEpubPath(href);
    registerSpineLookupKey(lookup, normalized, href);
    const decoded = safeDecodeEpubPath(normalized || href);
    registerSpineLookupKey(lookup, decoded, href);
    try {
      registerSpineLookupKey(lookup, encodeURI(decoded), href);
    } catch {
      // Malformed surrogate sequences keep their raw and normalized keys.
    }
  }
  return lookup;
}

export function matchSpineHref(
  candidatePath: string,
  spineLookup: ReadonlyMap<string, string>,
): string | null {
  const trimmed = candidatePath.trim();
  if (!trimmed) return null;
  const direct = spineLookup.get(trimmed);
  if (direct !== undefined) return direct;
  const normalized = normalizeEpubPath(trimmed);
  if (normalized) {
    const byNormalized = spineLookup.get(normalized);
    if (byNormalized !== undefined) return byNormalized;
    const decoded = safeDecodeEpubPath(normalized);
    const byDecoded = spineLookup.get(decoded);
    if (byDecoded !== undefined) return byDecoded;
    try {
      const byEncoded = spineLookup.get(encodeURI(decoded));
      if (byEncoded !== undefined) return byEncoded;
    } catch {
      // Ignore malformed URI sequences.
    }
  }
  return null;
}

export function resolveTocHref(
  rawHref: string,
  navBasePath: string,
  spineLookup: ReadonlyMap<string, string>,
): string {
  const trimmed = rawHref.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('epubcfi(') || SCHEME_PATTERN.test(trimmed)) return trimmed;

  const { path, fragment } = splitEpubHref(trimmed);
  if (!path) {
    if (navBasePath) {
      const navSpineHref = matchSpineHref(navBasePath, spineLookup);
      if (navSpineHref !== null) return `${navSpineHref}${fragment}`;
    }
    return fragment;
  }

  const baseDir = navBasePath ? directorySegments(navBasePath) : [];
  if (baseDir.length > 0) {
    const resolvedFromNav = normalizeEpubPath(path, baseDir);
    const matchedFromNav = matchSpineHref(resolvedFromNav, spineLookup);
    if (matchedFromNav !== null) return `${matchedFromNav}${fragment}`;
  }

  const normalizedRaw = normalizeEpubPath(path);
  const matchedRaw = matchSpineHref(normalizedRaw || path, spineLookup);
  if (matchedRaw !== null) return `${matchedRaw}${fragment}`;

  if (baseDir.length > 0) {
    return `${normalizeEpubPath(path, baseDir)}${fragment}`;
  }
  return `${normalizedRaw || path}${fragment}`;
}

export function resolveDisplayHref(
  targetHref: string,
  navBasePath: string,
  spineLookup: ReadonlyMap<string, string>,
  currentHref?: string | null,
): string {
  const trimmed = targetHref.trim();
  if (!trimmed) return targetHref;
  if (trimmed.startsWith('epubcfi(') || SCHEME_PATTERN.test(trimmed)) return trimmed;

  const { path, fragment } = splitEpubHref(trimmed);
  if (!path) {
    if (currentHref) {
      const currentSection = stripHrefFragment(currentHref);
      if (currentSection) {
        const matchedCurrent = matchSpineHref(currentSection, spineLookup) ?? currentSection;
        return `${matchedCurrent}${fragment}`;
      }
    }
    if (navBasePath) {
      const navSpineHref = matchSpineHref(navBasePath, spineLookup);
      if (navSpineHref !== null) return `${navSpineHref}${fragment}`;
    }
    return trimmed;
  }

  const matchedDirect = matchSpineHref(path, spineLookup);
  if (matchedDirect !== null) return `${matchedDirect}${fragment}`;

  if (navBasePath) {
    const baseDir = directorySegments(navBasePath);
    if (baseDir.length > 0) {
      const resolvedFromNav = normalizeEpubPath(path, baseDir);
      const matchedFromNav = matchSpineHref(resolvedFromNav, spineLookup);
      if (matchedFromNav !== null) return `${matchedFromNav}${fragment}`;
    }
  }

  const normalized = normalizeEpubPath(path);
  return `${normalized || path}${fragment}`;
}

function canonicalLookupKey(href: string): string {
  const { path, fragment } = splitEpubHref(href);
  if (!path) return fragment;
  const canonicalPath = safeDecodeEpubPath(normalizeEpubPath(path));
  return `${canonicalPath}${fragment}`;
}

export function indexToc(toc: readonly TocItem[]): IndexedToc {
  const items: FlatTocItem[] = [];
  const labels = new Map<string, string>();
  const firstRowBySectionHref = new Map<string, number>();

  const registerLabel = (key: string, label: string) => {
    if (key && !labels.has(key)) labels.set(key, label);
  };

  const visit = (nodes: readonly TocItem[], depth: number) => {
    for (const node of nodes) {
      const sectionHref = canonicalSectionHref(node.href);
      const rawSectionHref = stripHrefFragment(node.href);
      const index = items.length;
      items.push({
        index,
        label: node.label,
        href: node.href,
        sectionHref,
        depth,
      });

      if (sectionHref && !firstRowBySectionHref.has(sectionHref)) {
        firstRowBySectionHref.set(sectionHref, index);
      }
      if (rawSectionHref && !firstRowBySectionHref.has(rawSectionHref)) {
        firstRowBySectionHref.set(rawSectionHref, index);
      }

      if (node.label.trim()) {
        const trimmedHref = node.href.trim();
        registerLabel(trimmedHref, node.label);
        registerLabel(canonicalLookupKey(trimmedHref), node.label);
        registerLabel(rawSectionHref, node.label);
        registerLabel(sectionHref, node.label);
      }

      if (node.children.length > 0) {
        visit(node.children, depth + 1);
      }
    }
  };

  visit(toc, 0);
  return { items, labels, firstRowBySectionHref };
}

export function sectionLabelForHref(
  labels: ReadonlyMap<string, string>,
  href: string,
  spineIndex: number,
): string {
  const trimmed = href.trim();
  if (trimmed) {
    const direct = labels.get(trimmed) ?? labels.get(canonicalLookupKey(trimmed));
    if (direct) return direct;
    const rawSection = stripHrefFragment(trimmed);
    if (rawSection) {
      const byRawSection = labels.get(rawSection);
      if (byRawSection) return byRawSection;
      const canonicalSection = canonicalSectionHref(rawSection);
      if (canonicalSection) {
        const byCanonicalSection = labels.get(canonicalSection);
        if (byCanonicalSection) return byCanonicalSection;
      }
    }
  }
  return `Section ${spineIndex + 1}`;
}

export function getRenderedTocIndices(
  itemCount: number,
  window: VirtualWindow,
  focusedIndex = -1,
): number[] {
  const count = Math.max(0, Math.floor(Number.isFinite(itemCount) ? itemCount : 0));
  if (count === 0) return [];

  const indices: number[] = [];
  const push = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) return;
    if (indices.length === 0 || indices[indices.length - 1]! < index) {
      indices.push(index);
    }
  };

  push(0);
  if (focusedIndex < window.startIndex) push(focusedIndex);
  const start = Math.max(0, window.startIndex);
  const end = Math.min(count, window.endIndex);
  for (let index = start; index < end; index += 1) {
    push(index);
  }
  if (focusedIndex >= window.endIndex) push(focusedIndex);
  push(count - 1);

  return indices;
}
