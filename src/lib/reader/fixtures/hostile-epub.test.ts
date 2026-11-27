// @vitest-environment jsdom

import JSZip from 'jszip';
import type { Contents, Rendition } from 'epubjs';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAppearance } from '../appearance';
import {
  EPUB_CONTENT_SECURITY_POLICY,
  ReaderSession,
  registerEpubSpineSanitizer,
  sanitizeCss,
  sanitizeEpubDocument,
  type EpubBookLike,
  type StylesheetCache,
} from '../session';
import fixture from './hostile-epub.xhtml?raw';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function buildPackagedEpub(options: {
  chapters: Array<{ href: string; xhtml: string }>;
  stylesheets?: Record<string, string>;
}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`,
  );

  const stylesheets = options.stylesheets ?? {};
  const manifestItems = [
    ...options.chapters.map(
      (chapter, index) =>
        `<item id="ch-${index}" href="${chapter.href}" media-type="application/xhtml+xml" />`,
    ),
    ...Object.keys(stylesheets).map(
      (href, index) => `<item id="css-${index}" href="${href}" media-type="text/css" />`,
    ),
  ].join('\n    ');
  const spineRefs = options.chapters
    .map((_, index) => `<itemref idref="ch-${index}" />`)
    .join('\n    ');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:hostile-epub-test</dc:identifier>
    <dc:title>Hostile EPUB Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`,
  );

  for (const chapter of options.chapters) {
    zip.file(`OEBPS/${chapter.href}`, chapter.xhtml);
  }
  for (const [href, css] of Object.entries(stylesheets)) {
    zip.file(`OEBPS/${href}`, css);
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

it('keeps local EPUB content while removing network and executable references', async () => {
  const document = new DOMParser().parseFromString(fixture, 'application/xhtml+xml');

  await sanitizeEpubDocument(document);

  expect(document.querySelector('base')).toBeNull();
  expect(document.querySelector('script, iframe, form, meta[http-equiv="refresh"]')).toBeNull();
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toBe(EPUB_CONTENT_SECURITY_POLICY);
  expect(document.body?.getAttribute('onload')).toBeNull();
  expect(document.querySelector('#internal')?.getAttribute('href')).toBe('chapter-2.xhtml#section');
  expect(document.querySelector('#fragment')?.getAttribute('href')).toBe('#section');
  expect(document.querySelector('#remote')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#encoded')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#scheme-relative')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#file')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#malformed')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#local-image')?.getAttribute('src')).toBe('../Images/cover.jpg');
  expect(document.querySelector('#embedded-image')?.getAttribute('src')).toMatch(
    /^data:image\/png/,
  );
  expect(document.querySelector('#remote-image')?.getAttribute('src')).toBeNull();
  expect(document.querySelector('#remote-srcset')?.getAttribute('srcset')).toBe(
    '../Images/a.jpg 2x',
  );
  expect(document.querySelector('#remote-svg-image')?.getAttribute('href')).toBeNull();
  expect(document.querySelector('#remote-video')?.getAttribute('poster')).toBeNull();
  expect(document.querySelector('link[href="styles/book.css"]')).toBeNull();
  expect(document.querySelector('link[href^="https:"]')).toBeNull();
  expect(document.querySelector('style')?.textContent).toContain('../Images/paper.png');
  expect(document.querySelector('style')?.textContent).not.toContain('attacker.example');
});

it('detaches local stylesheet links before fetch, inlines nested @import rules, and deduplicates cached CSS across chapters', async () => {
  const chapter = () =>
    new DOMParser().parseFromString(
      '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
      'application/xhtml+xml',
    );
  const document = chapter();
  const anotherChapter = chapter();
  const stylesheetCache: StylesheetCache = new Map();
  let resolveBookCss: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | RequestInfo) => {
      const href = input instanceof URL ? input.href : String(input);
      if (href.endsWith('/styles/book.css')) {
        return new Promise<Response>((resolve) => {
          resolveBookCss = resolve;
        });
      }
      if (href.endsWith('/styles/typography.css')) {
        return Promise.resolve(
          new Response(
            '@import "book.css"; body { font-family: Georgia, serif; background: url(https://attacker.example/nested); }',
            { status: 200, headers: { 'content-type': 'text/css' } },
          ),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    }),
  );

  const sanitizing = Promise.all([
    sanitizeEpubDocument(document, stylesheetCache),
    sanitizeEpubDocument(anotherChapter, stylesheetCache),
  ]);

  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toBe(EPUB_CONTENT_SECURITY_POLICY);
  expect(document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);

  resolveBookCss?.(
    new Response(
      '@import "typography.css" screen; @import url("https://attacker.example/remote.css"); .cover { background: url(../Images/cover.jpg); } .remote { background: url(https://attacker.example/pixel); }',
      {
        status: 200,
        headers: { 'content-type': 'text/css' },
      },
    ),
  );
  await sanitizing;

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
  expect(document.querySelectorAll('style')).toHaveLength(2);
  expect(anotherChapter.querySelectorAll('style')).toHaveLength(2);

  const inlinedCss = document.querySelector('style')?.textContent ?? '';
  expect(inlinedCss).toContain('@media screen');
  expect(inlinedCss).toContain('font-family: Georgia, serif');
  expect(inlinedCss).toContain(
    'url("http://localhost/_capacitor_file/books/book.epub/OEBPS/Images/cover.jpg")',
  );
  expect(inlinedCss).not.toContain('@import');
  expect(inlinedCss).not.toContain('attacker.example');
  expect(anotherChapter.querySelector('style')?.textContent).toBe(inlinedCss);
});

it('normalizes CSS hex escapes, comments, image-set, and legacy expression() tokens while keeping plain CSS on the fast path', () => {
  const plain = 'p { margin: 0; text-indent: 1.5em; font-style: italic; }';
  expect(sanitizeCss(plain)).toBe(plain);

  const obfuscated = sanitizeCss(`
    @\\69 mport "https://attacker.example/escaped.css";
    .escaped-fn { background-image: \\75 rl("ht\\74ps\\3a //attacker.example/exfil.png"); }
    .escaped-safe { background-image: \\75 rl("../Images/safe.png"); }
    .set {
      background-image: image-set(
        "https://attacker.example/1x.png" 1x,
        "../Images/cover-2x.png" 2x
      );
    }
    .legacy { width: expression(alert(1)); }
    .breakout::after { content: "</style><img src=x onerror=alert(1)>"; }
    /* https://attacker.example/comment */
  `);

  expect(obfuscated).not.toContain('attacker.example');
  expect(obfuscated).not.toContain('</style>');
  expect(obfuscated).toContain('\\3c /style>');
  expect(obfuscated).not.toContain('@import');
  expect(obfuscated).not.toContain('expression(');
  expect(obfuscated).toContain('url("../Images/safe.png")');
  expect(obfuscated).toContain('image-set(url("../Images/cover-2x.png") 2x)');
});

it('preserves RFC 2045 wrapped data:image and data:font assets while rejecting SVG data URIs and skipping unchanged style mutations', async () => {
  const pngLine1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YA';
  const pngLine2 = 'AAAASUVORK5CYII=';
  const wrappedPng = `data:image/png;base64,${pngLine1}\r\n${pngLine2}`;
  const xmlWrappedPng = `data:image/png;base64,${pngLine1}&#13;&#10;${pngLine2}`;
  const cssContinuedFont = `data:font/woff2;base64,${'d09GMgABAAAAAAK8AA0AAAAABbQAAActAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbgcg='}\\\r\n${'PAr4GYACCahEICo1oATYCJAMUBCAFhG4HbBv8Z8S8xZ4A'}`;
  const spacedPng = `data:image/png;base64,${pngLine1} ${pngLine2}`;
  const document = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" data-turnleaf-sanitized="forged">
      <head>
        <style id="fonts">
          @font-face {
            font-family: "EmbeddedSerif";
            src: url(
              "${cssContinuedFont}"
            ) format("woff2");
          }
          .banner {
            background-image: url(
              '${spacedPng}'
            );
          }
          .tracking {
            background-image: url(
              https://attacker.example/multiline-pixel
            );
          }
        </style>
        <style id="plain">p { margin: 0; text-indent: 1.5em; }</style>
      </head>
      <body>
        <p id="unchanged" style="font-style: italic">Hello</p>
        <a id="forged-tabindex" href="#note" tabindex="-1" data-turnleaf-tabindex="0">Note</a>
        <img id="rfc2045-image" src="${xmlWrappedPng}" />
        <img id="svg-base64" src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+" />
        <img id="svg-utf8" src="data:image/svg+xml,&lt;svg onload=alert(1)/&gt;" />
      </body>
    </html>`,
    'application/xhtml+xml',
  );

  const unchangedParagraph = document.querySelector('#unchanged')!;
  const setAttributeSpy = vi.spyOn(unchangedParagraph, 'setAttribute');

  await sanitizeEpubDocument(document);

  expect(document.documentElement.getAttribute('data-turnleaf-sanitized')).toBeNull();
  expect(
    document.querySelector('#forged-tabindex')?.getAttribute('data-turnleaf-tabindex'),
  ).toBeNull();
  expect(setAttributeSpy).not.toHaveBeenCalled();
  expect(document.querySelector('#rfc2045-image')?.getAttribute('src')).toBe(wrappedPng);
  expect(document.querySelector('#svg-base64')?.getAttribute('src')).toBeNull();
  expect(document.querySelector('#svg-utf8')?.getAttribute('src')).toBeNull();

  const fontStyles = document.querySelector('#fonts')?.textContent ?? '';
  expect(fontStyles).toContain('data:font/woff2;base64,');
  expect(fontStyles).toContain('data:image/png;base64,');
  expect(fontStyles).not.toContain('attacker.example');
  expect(document.querySelector('#plain')?.textContent).toBe(
    'p { margin: 0; text-indent: 1.5em; }',
  );
});

it('evicts least-recently-used stylesheets past 32 entries without breaking styles in active chapters', async () => {
  const stylesheetCache: StylesheetCache = new Map();
  const fetchSpy = vi.fn(
    async (input: URL | RequestInfo) =>
      new Response(`.sheet { content: "${String(input)}"; }`, {
        status: 200,
        headers: { 'content-type': 'text/css' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);

  const chapterFor = (index: number) =>
    new DOMParser().parseFromString(
      `<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/sheet-${index}.css" /></head><body /></html>`,
      'application/xhtml+xml',
    );

  const activeChapterZero = chapterFor(0);
  await sanitizeEpubDocument(activeChapterZero, stylesheetCache);
  for (let index = 1; index < 32; index += 1) {
    await sanitizeEpubDocument(chapterFor(index), stylesheetCache);
  }
  // Touch sheet-0 so sheet-1 becomes the least-recently-used entry.
  await sanitizeEpubDocument(chapterFor(0), stylesheetCache);
  expect(fetchSpy).toHaveBeenCalledTimes(32);

  // Loading sheet-32 evicts sheet-1 while keeping sheet-0 cached and activeChapterZero intact.
  await sanitizeEpubDocument(chapterFor(32), stylesheetCache);
  expect(stylesheetCache.size).toBe(32);
  expect(activeChapterZero.querySelector('style')?.textContent).toContain('sheet-0.css');

  await sanitizeEpubDocument(chapterFor(0), stylesheetCache);
  expect(fetchSpy).toHaveBeenCalledTimes(33);

  await sanitizeEpubDocument(chapterFor(1), stylesheetCache);
  expect(fetchSpy).toHaveBeenCalledTimes(34);
});

it('fails closed when the epub.js pre-serialization spine content hook is absent or removed', async () => {
  expect(() => registerEpubSpineSanitizer({} as EpubBookLike)).toThrow(
    /spine content sanitizer hook is unavailable/i,
  );
  expect(() => registerEpubSpineSanitizer({ spine: {} } as EpubBookLike)).toThrow(
    /spine content sanitizer hook is unavailable/i,
  );
  expect(() =>
    registerEpubSpineSanitizer({
      spine: { hooks: { content: {} } },
    } as EpubBookLike),
  ).toThrow(/spine content sanitizer hook is unavailable/i);

  const epubBytes = await buildPackagedEpub({
    chapters: [
      {
        href: 'Text/chapter-1.xhtml',
        xhtml: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><link rel="stylesheet" href="https://attacker.example/leak.css" /></head>
  <body><script>window.__pwned = true;</script><p>Hostile chapter</p></body>
</html>`,
      },
    ],
  });

  const serializeSpy = vi.spyOn(XMLSerializer.prototype, 'serializeToString');
  const viewport = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(viewport);

  try {
    for (const removeHook of [
      (book: { spine: { hooks?: { content?: unknown } | undefined } }) => {
        if (book.spine.hooks) book.spine.hooks.content = undefined;
      },
      (book: { spine: { hooks?: { content?: unknown } | undefined } }) => {
        book.spine.hooks = undefined;
      },
    ]) {
      const session = new ReaderSession(epubBytes);
      const internalBook = (
        session as unknown as { book: { spine: { hooks?: { content?: unknown } | undefined } } }
      ).book;
      removeHook(internalBook);

      await expect(
        session.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
      ).rejects.toThrow(/spine content sanitizer hook is unavailable/i);
      await expect(session.search('Hostile')).rejects.toThrow(
        /spine content sanitizer hook is unavailable/i,
      );
    }

    // Simulate epub.js returning a Book without spine.hooks.content to new ReaderSession().
    const ePub = (await import('epubjs')).default;
    const sampleBook = ePub('');
    const bookProto = Object.getPrototypeOf(sampleBook) as object;
    let capturedSpine: { hooks?: { content?: unknown } } | undefined;
    Object.defineProperty(bookProto, 'spine', {
      configurable: true,
      get: () => capturedSpine,
      set: (next: { hooks?: { content?: unknown } } | undefined) => {
        if (next?.hooks) next.hooks.content = undefined;
        capturedSpine = next;
      },
    });
    let constructedWithoutHook: ReaderSession;
    try {
      constructedWithoutHook = new ReaderSession(epubBytes);
    } finally {
      delete (bookProto as { spine?: unknown }).spine;
      sampleBook.destroy();
    }

    await expect(
      constructedWithoutHook.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow(/spine content sanitizer hook is unavailable/i);

    // Also verify synchronous throws inside spine.hooks.content fail closed instead of being swallowed by epub.js Hook.trigger.
    const throwingSession = new ReaderSession(epubBytes);
    const throwingBook = (
      throwingSession as unknown as {
        book: { spine: { hooks: { content: { register: (fn: () => void) => void } } } };
      }
    ).book;
    throwingBook.spine.hooks.content.register(() => {
      throw new Error('Injected synchronous spine hook failure');
    });

    await expect(
      throwingSession.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow(/Injected synchronous spine hook failure/i);

    expect(serializeSpy).not.toHaveBeenCalled();
    expect(viewport.querySelectorAll('iframe')).toHaveLength(0);
  } finally {
    viewport.remove();
  }
});

it('sanitizes archived chapters pre-serialization via registerEpubSpineSanitizer and caches shared stylesheets across chapters', async () => {
  const getTextSpy = vi.fn(async (path: string) => {
    if (path === '/OEBPS/Styles/book.css') {
      return '.cover { background: url(../Images/cover.jpg); } .evil { background: url(https://attacker.example/leak); }';
    }
    return '';
  });

  const session = new ReaderSession('');
  const renditionHooks: Array<(contents: Contents) => Promise<void> | void> = [];
  const mockRendition = {
    hooks: {
      content: {
        register: vi.fn((fn: (contents: Contents) => Promise<void> | void) => {
          renditionHooks.push(fn);
        }),
      },
    },
    on: vi.fn(),
    off: vi.fn(),
    started: Promise.resolve(),
    themes: { register: vi.fn(), select: vi.fn() },
    annotations: { highlight: vi.fn(), remove: vi.fn() },
    display: vi.fn(async () => {}),
    resize: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Rendition;

  const internalBook = (
    session as unknown as {
      book: {
        archived: boolean;
        archive: {
          urlCache: Record<string, string>;
          getText: (url: string) => Promise<string>;
          destroy: () => void;
        };
        renderTo: () => Rendition;
        spine: {
          hooks: {
            content: {
              trigger: (
                doc: Document,
                section: { href: string; url: string; idref: string },
              ) => Promise<void>;
            };
          };
        };
      };
    }
  ).book;

  const coverBlobUrl = URL.createObjectURL(new Blob(['cover'], { type: 'image/jpeg' }));
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

  internalBook.archived = true;
  internalBook.archive = {
    urlCache: { '/OEBPS/Images/cover.jpg': coverBlobUrl },
    getText: getTextSpy,
    destroy: vi.fn(),
  };
  internalBook.renderTo = vi.fn(() => mockRendition);

  await session.open(
    globalThis.document.createElement('div'),
    null,
    null,
    null,
    defaultAppearance,
    vi.fn(),
    vi.fn(),
  );

  const makeChapter = (title: string) =>
    new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml">
        <head>
          <link rel="stylesheet" href="../Styles/book.css" />
          <link rel="stylesheet" href="https://attacker.example/remote.css" />
        </head>
        <body onclick="alert(1)">
          <script>alert(1)</script>
          <p>${title}</p>
        </body>
      </html>`,
      'application/xhtml+xml',
    );

  const chapterOne = makeChapter('Chapter One');
  const chapterTwo = makeChapter('Chapter Two');

  await internalBook.spine.hooks.content.trigger(chapterOne, {
    href: 'Text/chapter-1.xhtml',
    url: '/OEBPS/Text/chapter-1.xhtml',
    idref: 'chapter-1',
  });
  await internalBook.spine.hooks.content.trigger(chapterTwo, {
    href: 'Text/chapter-2.xhtml',
    url: '/OEBPS/Text/chapter-2.xhtml',
    idref: 'chapter-2',
  });

  // Both chapters in /OEBPS/Text/ share the cached sanitized stylesheet without re-reading archive.getText.
  expect(getTextSpy).toHaveBeenCalledOnce();
  expect(chapterOne.querySelector('script')).toBeNull();
  expect(chapterOne.body?.getAttribute('onclick')).toBeNull();
  expect(chapterOne.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
  expect(chapterOne.querySelector('style')?.textContent).toContain(coverBlobUrl);
  expect(chapterOne.querySelector('style')?.textContent).not.toContain('attacker.example');
  expect(chapterTwo.querySelector('style')?.textContent).toBe(
    chapterOne.querySelector('style')?.textContent,
  );

  // Passing the same Document instance to rendition.hooks.content is skipped via WeakSet<Document>.
  const hasAttributesSpy = vi.spyOn(chapterOne.querySelector('p')!, 'hasAttributes');
  await renditionHooks[0]?.({ document: chapterOne } as unknown as Contents);
  expect(hasAttributesSpy).not.toHaveBeenCalled();

  session.destroy();
  expect(revokeSpy).toHaveBeenCalledWith(coverBlobUrl);
});
