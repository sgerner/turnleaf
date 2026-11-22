// @vitest-environment jsdom

import { Book, Contents, Rendition } from 'epubjs';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppearance } from './appearance';
import { parseKavitaXPath, resolveContentXPath, toKavitaXPath } from './kavita-xpath';

const { mockBook, mockRendition, activeContents } = vi.hoisted(() => {
  const activeContents: unknown[] = [];
  const rendition = {
    hooks: { content: { register: vi.fn() } },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() } as {
      register: (...args: unknown[]) => void;
      select: (name: string) => void;
    },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    getContents: vi.fn(() => activeContents),
    location: undefined as { start: { cfi: string } } | undefined,
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const book = {
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
    spine: { each: vi.fn() },
  };
  return { mockBook: book, mockRendition: rendition, activeContents };
});

vi.mock('epubjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: vi.fn(() => mockBook),
  };
});

import { ReaderSession } from './session';

describe('Kavita EPUB locations', () => {
  it('adds the one-based Kavita spine fragment to an EPUB content path', () => {
    expect(toKavitaXPath('/html/body/section[1]/p[4]', 2)).toBe(
      '//body/DocFragment[3]/body/section[1]/p[4]',
    );
  });

  it('removes indexed HTML and body roots produced by EPUB documents', () => {
    expect(toKavitaXPath('/html[1]/body[1]/div[2]/p[3]', 0)).toBe(
      '//body/DocFragment[1]/body/div[2]/p[3]',
    );
  });

  it('maps a Kavita location back to a zero-based EPUB spine and content path', () => {
    expect(parseKavitaXPath('//body/DocFragment[3]/body/section[1]/p[4]')).toEqual({
      spineIndex: 2,
      contentXPath: '/html/body/section[1]/p[4]',
    });
  });

  it('accepts Kavita chapter-body locations with a trailing slash', () => {
    expect(parseKavitaXPath('//body/DocFragment[2]/body/')).toEqual({
      spineIndex: 1,
      contentXPath: '/html/body',
    });
  });

  it('rejects unscoped and invalid locations instead of opening the wrong chapter', () => {
    expect(parseKavitaXPath('/html/body/p[1]')).toBeNull();
    expect(parseKavitaXPath('//body/DocFragment[0]/body/p[1]')).toBeNull();
  });

  it('resolves Kavita paths through XHTML-style element names', () => {
    const document = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><section><p>one</p><p>two</p></section></body></html>',
      'application/xhtml+xml',
    );
    expect(resolveContentXPath(document, '/html/body/section[1]/p[2]')?.textContent).toBe('two');
    expect(resolveContentXPath(document, '/html/body')?.localName).toBe('body');
  });

  it('counts XPath indices among siblings of the requested tag', () => {
    const document = new DOMParser().parseFromString(
      '<html><body><p>first</p><h2>heading</h2><p>second</p></body></html>',
      'text/html',
    );
    expect(resolveContentXPath(document, '/html/body/p[2]')?.textContent).toBe('second');
    expect(resolveContentXPath(document, '/html/body/h2[1]')?.textContent).toBe('heading');
  });
});

describe('ReaderSession publisher formatting cascade', () => {
  it('preserves .scene-break and .epigraph styles when publisherStyles is true and overrides cleanly on toggle', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const chapterDoc = frame.contentDocument!;
    chapterDoc.open();
    chapterDoc.write(`<!doctype html><html><head><style>
      .scene-break { text-align: center; margin: 1.5em 0; }
      .epigraph { text-align: right; margin: 1.5em 2em; }
      .epigraph p { margin-bottom: 0.25em; }
    </style></head><body>
      <p id="body-copy">Ordinary paragraph</p>
      <p id="scene-break" class="scene-break">* * *</p>
      <blockquote class="epigraph"><p id="epigraph-line">Epigraph quote</p></blockquote>
    </body></html>`);
    chapterDoc.close();

    const contents = Object.assign(Object.create(Contents.prototype) as Contents, {
      document: chapterDoc,
      content: chapterDoc.body,
    });
    activeContents.splice(0, activeContents.length, contents);

    const realThemes = new Rendition(new Book(), {})
      .themes as unknown as typeof mockRendition.themes & {
      rendition: unknown;
    };
    realThemes.rendition = mockRendition;
    mockRendition.themes = realThemes;
    mockRendition.location = { start: { cfi: 'epubcfi(/6/2!/4/2:0)' } };
    mockRendition.display.mockClear();

    const session = new ReaderSession('book.epub');
    await session.open(
      document.createElement('div'),
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );
    mockRendition.display.mockClear();

    const styleOf = (id: string) =>
      frame.contentWindow!.getComputedStyle(chapterDoc.getElementById(id)!);

    expect(styleOf('body-copy').textAlign).toBe('start');
    expect(styleOf('body-copy').marginBottom).toBe('10.8px');
    expect(styleOf('scene-break').textAlign).toBe('center');
    expect(styleOf('scene-break').marginBottom).toBe('27px');
    expect(styleOf('epigraph-line').textAlign).toBe('right');
    expect(styleOf('epigraph-line').marginBottom).toBe('4.5px');

    session.applyAppearance({
      ...defaultAppearance,
      alignment: 'justify',
      publisherStyles: false,
    });

    expect(styleOf('body-copy').textAlign).toBe('justify');
    expect(styleOf('scene-break').textAlign).toBe('justify');
    expect(styleOf('scene-break').marginBottom).toBe('10.8px');
    expect(styleOf('epigraph-line').textAlign).toBe('justify');
    expect(styleOf('epigraph-line').marginBottom).toBe('10.8px');
    expect(mockRendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/2:0)');

    mockRendition.display.mockClear();
    session.applyAppearance({
      ...defaultAppearance,
      alignment: 'justify',
      publisherStyles: true,
    });

    expect(chapterDoc.querySelectorAll('#epubjs-inserted-css-turnleaf')).toHaveLength(1);
    expect(styleOf('body-copy').textAlign).toBe('justify');
    expect(styleOf('scene-break').textAlign).toBe('center');
    expect(styleOf('scene-break').marginBottom).toBe('27px');
    expect(styleOf('epigraph-line').textAlign).toBe('right');
    expect(styleOf('epigraph-line').marginBottom).toBe('4.5px');
    expect(mockRendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/2:0)');

    session.destroy();
    activeContents.length = 0;
    frame.remove();
  });
});
