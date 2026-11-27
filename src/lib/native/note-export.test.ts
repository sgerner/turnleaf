// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  native: true,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
  },
  registerPlugin: () => ({
    exportMarkdown: vi.fn(),
    shareMarkdown: vi.fn(),
  }),
}));

import { NoteExport, exportAnnotationsMarkdown } from './note-export';

describe('native and web annotation Markdown export', () => {
  const sampleMarkdown = '# Notes for Sample Book\n\n> Highlighted line\n';

  beforeEach(() => {
    runtime.native = true;
    vi.mocked(NoteExport.exportMarkdown).mockReset();
    vi.mocked(NoteExport.shareMarkdown).mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
  });

  it('saves Markdown through the native system picker without fallback text', async () => {
    vi.mocked(NoteExport.exportMarkdown).mockResolvedValueOnce({
      status: 'saved',
      filename: 'Sample-Book-notes-1000.md',
    });

    await expect(
      exportAnnotationsMarkdown('Sample Book!', sampleMarkdown, 'save', 1000),
    ).resolves.toEqual({
      message: 'Saved notes as Sample-Book-notes-1000.md.',
      fallback: '',
    });
    expect(NoteExport.exportMarkdown).toHaveBeenCalledExactlyOnceWith({
      filename: 'Sample-Book-notes-1000.md',
      title: 'Notes for Sample Book!',
      markdown: sampleMarkdown,
    });
  });

  it('shares Markdown through the native share sheet', async () => {
    vi.mocked(NoteExport.shareMarkdown).mockResolvedValueOnce({
      status: 'shared',
      filename: 'Sample-Book-notes-1000.md',
    });

    await expect(
      exportAnnotationsMarkdown('Sample Book', sampleMarkdown, 'share', 1000),
    ).resolves.toEqual({
      message: 'Shared Sample-Book-notes-1000.md.',
      fallback: '',
    });
  });

  it('keeps the Markdown copy field populated when the user cancels system export', async () => {
    vi.mocked(NoteExport.exportMarkdown).mockResolvedValueOnce({
      status: 'canceled',
    });

    await expect(
      exportAnnotationsMarkdown('Sample Book', sampleMarkdown, 'save', 1000),
    ).resolves.toEqual({
      message: 'Export canceled. Copy the Markdown from the field below.',
      fallback: sampleMarkdown,
    });
  });

  it('falls back to the Markdown copy field if native export rejects', async () => {
    vi.mocked(NoteExport.exportMarkdown).mockRejectedValueOnce(new Error('No export provider'));

    await expect(
      exportAnnotationsMarkdown('Sample Book', sampleMarkdown, 'save', 1000),
    ).resolves.toEqual({
      message: 'Copy the Markdown from the field below.',
      fallback: sampleMarkdown,
    });
  });

  it('preserves clipboard copy on native platforms', async () => {
    await expect(
      exportAnnotationsMarkdown('Sample Book', sampleMarkdown, 'copy', 1000),
    ).resolves.toEqual({
      message: 'Markdown copied.',
      fallback: '',
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(sampleMarkdown);
  });

  it('triggers a Blob download when running in a browser', async () => {
    runtime.native = false;
    const createObjectURL = vi.fn(() => 'blob:notes');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await expect(
      exportAnnotationsMarkdown('Sample Book', sampleMarkdown, 'save', 1000),
    ).resolves.toEqual({
      message: 'Exported Sample-Book-notes.md.',
      fallback: '',
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    clickSpy.mockRestore();
  });
});
