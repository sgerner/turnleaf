export interface StoredAnnotation {
  id: string;
  cfi: string;
  excerpt: string;
  note: string;
  createdAt: string;
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
    typeof annotation.createdAt === 'string'
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
): StoredAnnotation[] {
  const trimmedCfi = cfi.trim();
  const trimmedExcerpt = excerpt.trim();
  if (!trimmedCfi || !trimmedExcerpt) return annotations;
  const trimmedNote = note.trim().slice(0, 2000);
  const existing = annotations.find((annotation) => annotation.cfi === trimmedCfi);
  if (existing) {
    return annotations.map((annotation) =>
      annotation.id === existing.id
        ? { ...annotation, note: trimmedNote || annotation.note }
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
    },
  ];
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
