import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NoteExportOptions {
  filename: string;
  title: string;
  markdown: string;
}

export interface NoteExportResult {
  status: 'saved' | 'shared' | 'canceled';
  filename?: string;
}

export interface NoteExportPlugin {
  exportMarkdown(options: NoteExportOptions): Promise<NoteExportResult>;
  shareMarkdown(options: NoteExportOptions): Promise<NoteExportResult>;
}

let registeredNoteExport: NoteExportPlugin | null = null;

function getNoteExport(): NoteExportPlugin {
  if (!registeredNoteExport) {
    registeredNoteExport = registerPlugin<NoteExportPlugin>('NoteExport');
  }
  return registeredNoteExport;
}

export const NoteExport: NoteExportPlugin = {
  get exportMarkdown() {
    return getNoteExport().exportMarkdown;
  },
  get shareMarkdown() {
    return getNoteExport().shareMarkdown;
  },
};

export type AnnotationExportMode = 'save' | 'share' | 'copy';

export interface AnnotationExportOutcome {
  message: string;
  fallback: string;
}

function slugifyBookTitle(title: string): string {
  let slug = '';
  let previousDash = false;
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (isAlphaNumeric) {
      slug += title[index];
      previousDash = false;
    } else if (slug.length > 0 && !previousDash) {
      slug += '-';
      previousDash = true;
    }
  }
  if (slug.endsWith('-')) slug = slug.slice(0, -1);
  return slug.slice(0, 80) || 'book';
}

export async function exportAnnotationsMarkdown(
  title: string,
  markdown: string,
  mode: AnnotationExportMode = 'save',
  now = Date.now(),
): Promise<AnnotationExportOutcome> {
  const name = slugifyBookTitle(title);
  try {
    if (mode === 'copy') {
      await navigator.clipboard.writeText(markdown);
      return { message: 'Markdown copied.', fallback: '' };
    }
    if (Capacitor.isNativePlatform()) {
      const filename = `${name}-notes-${now}.md`;
      const result =
        mode === 'share'
          ? await NoteExport.shareMarkdown({ filename, title: `Notes for ${title}`, markdown })
          : await NoteExport.exportMarkdown({ filename, title: `Notes for ${title}`, markdown });
      if (result.status === 'canceled') {
        return {
          message: 'Export canceled. Copy the Markdown from the field below.',
          fallback: markdown,
        };
      }
      const savedName = result.filename || filename;
      return {
        message:
          result.status === 'shared' ? `Shared ${savedName}.` : `Saved notes as ${savedName}.`,
        fallback: '',
      };
    }
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-notes.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { message: `Exported ${name}-notes.md.`, fallback: '' };
  } catch {
    return {
      message: 'Copy the Markdown from the field below.',
      fallback: markdown,
    };
  }
}
