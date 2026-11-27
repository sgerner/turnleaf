export interface AnnotationMetadata {
  href?: string | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

export interface AnnotationRepair {
  id: string;
  cfi: string;
  href?: string | undefined;
}

export interface StoredAnnotation {
  id: string;
  cfi: string;
  excerpt: string;
  note: string;
  createdAt: string;
  href?: string;
  prefix?: string;
  suffix?: string;
}

const MAX_CONTEXT_LENGTH = 120;

function optionalText(value: string | undefined, maxLength?: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return maxLength !== undefined ? normalized.slice(0, maxLength) : normalized;
}

function optionalPrefix(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(-MAX_CONTEXT_LENGTH);
}

export const MAX_ANNOTATIONS = 200;

function isAnnotation(value: unknown): value is StoredAnnotation {
  if (!value || typeof value !== 'object') return false;
  const annotation = value as Partial<StoredAnnotation>;
  return (
    typeof annotation.id === 'string' &&
    typeof annotation.cfi === 'string' &&
    typeof annotation.excerpt === 'string' &&
    typeof annotation.note === 'string' &&
    typeof annotation.createdAt === 'string' &&
    (annotation.href === undefined || typeof annotation.href === 'string') &&
    (annotation.prefix === undefined || typeof annotation.prefix === 'string') &&
    (annotation.suffix === undefined || typeof annotation.suffix === 'string')
  );
}

export function parseAnnotations(raw: string | null): StoredAnnotation[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isAnnotation) : [];
  } catch {
    return [];
  }
}

export function addAnnotation(
  annotations: StoredAnnotation[],
  cfi: string,
  excerpt: string,
  note: string,
  createdAt = new Date().toISOString(),
  metadata?: AnnotationMetadata,
): StoredAnnotation[] {
  const trimmedCfi = cfi.trim();
  const trimmedExcerpt = excerpt.trim();
  if (!trimmedCfi || !trimmedExcerpt) return annotations;
  const trimmedNote = note.trim().slice(0, 2000);
  const href = optionalText(metadata?.href?.split('#', 1)[0]);
  const prefix = optionalPrefix(metadata?.prefix);
  const suffix = optionalText(metadata?.suffix, MAX_CONTEXT_LENGTH);
  const optionalFields: Partial<Pick<StoredAnnotation, 'href' | 'prefix' | 'suffix'>> = {
    ...(href ? { href } : {}),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
  const existing = annotations.find((annotation) => annotation.cfi === trimmedCfi);
  if (existing) {
    return annotations.map((annotation) =>
      annotation.id === existing.id
        ? { ...annotation, ...optionalFields, note: trimmedNote || annotation.note }
        : annotation,
    );
  }
  if (annotations.length >= MAX_ANNOTATIONS) return annotations;
  return [
    ...annotations,
    {
      id: `${createdAt}:${trimmedCfi}`,
      cfi: trimmedCfi,
      excerpt: trimmedExcerpt.slice(0, 500),
      note: trimmedNote,
      createdAt,
      ...optionalFields,
    },
  ];
}

export function repairAnnotations(
  annotations: StoredAnnotation[],
  repairs: readonly AnnotationRepair[],
): StoredAnnotation[] {
  if (!repairs.length) return annotations;
  const byId = new Map(repairs.map((repair) => [repair.id, repair]));
  const occupiedAnchors: Array<{ id: string; cfi: string; href: string | undefined }> = [];
  for (const annotation of annotations) {
    if (!byId.has(annotation.id)) {
      occupiedAnchors.push({
        id: annotation.id,
        cfi: annotation.cfi.trim(),
        href: annotation.href,
      });
    }
  }
  const hasAnchorCollision = (id: string, cfi: string, href: string | undefined): boolean =>
    occupiedAnchors.some(
      (anchor) =>
        anchor.id !== id && anchor.cfi === cfi && (!href || !anchor.href || href === anchor.href),
    );

  let changed = false;
  const next = annotations.map((annotation) => {
    const repair = byId.get(annotation.id);
    if (!repair) return annotation;
    const trimmedCfi = repair.cfi.trim();
    if (!trimmedCfi) {
      occupiedAnchors.push({
        id: annotation.id,
        cfi: annotation.cfi.trim(),
        href: annotation.href,
      });
      return annotation;
    }
    const href = optionalText(repair.href?.split('#', 1)[0]) ?? annotation.href;
    if (trimmedCfi === annotation.cfi && href === annotation.href) {
      occupiedAnchors.push({ id: annotation.id, cfi: trimmedCfi, href });
      return annotation;
    }
    if (hasAnchorCollision(annotation.id, trimmedCfi, href)) {
      occupiedAnchors.push({
        id: annotation.id,
        cfi: annotation.cfi.trim(),
        href: annotation.href,
      });
      return annotation;
    }
    occupiedAnchors.push({ id: annotation.id, cfi: trimmedCfi, href });
    changed = true;
    return {
      ...annotation,
      cfi: trimmedCfi,
      ...(href ? { href } : {}),
    };
  });
  return changed ? next : annotations;
}

export function updateAnnotation(
  annotations: StoredAnnotation[],
  id: string,
  note: string,
): StoredAnnotation[] {
  return annotations.map((annotation) =>
    annotation.id === id ? { ...annotation, note: note.trim().slice(0, 2000) } : annotation,
  );
}

export function removeAnnotation(annotations: StoredAnnotation[], id: string): StoredAnnotation[] {
  return annotations.filter((annotation) => annotation.id !== id);
}

export function annotationsMarkdown(title: string, annotations: StoredAnnotation[]): string {
  const lines = [`# Notes for ${title}`, ''];
  for (const annotation of annotations) {
    lines.push(
      `## ${annotation.createdAt}`,
      '',
      `> ${annotation.excerpt.replaceAll('\n', ' ')}`,
      '',
    );
    if (annotation.note) lines.push(annotation.note, '');
  }
  return `${lines.join('\n').trim()}\n`;
}
