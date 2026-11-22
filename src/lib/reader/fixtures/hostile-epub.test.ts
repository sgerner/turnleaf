// @vitest-environment jsdom

import { resolveObjectURL } from 'node:buffer';
import type { Contents, Rendition } from 'epubjs';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAppearance } from '../appearance';
import { ReaderSession, sanitizeEpubDocument, type StylesheetCache } from '../session';
import fixture from './hostile-epub.xhtml?raw';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps local EPUB content while removing network and executable references', async () => {
  const document = new DOMParser().parseFromString(fixture, 'application/xhtml+xml');

  await sanitizeEpubDocument(document);

  expect(document.querySelector('base')).toBeNull();
  expect(document.querySelector('script, iframe, form, meta[http-equiv="refresh"]')).toBeNull();
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toContain("connect-src 'none'");
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

it('sanitizes a local stylesheet into a shared blob link while keeping links attached until ready', async () => {
  const chapter = () =>
    new DOMParser().parseFromString(
      '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
      'application/xhtml+xml',
    );
  const document = chapter();
  const anotherChapter = chapter();
  const stylesheetCache: StylesheetCache = new Map();
  let resolveFetch: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );

  const sanitizing = Promise.all([
    sanitizeEpubDocument(document, stylesheetCache),
    sanitizeEpubDocument(anotherChapter, stylesheetCache),
  ]);

  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).toContain("style-src 'self' 'unsafe-inline' data: blob:");
  expect(document.querySelectorAll('link[rel="stylesheet"][href="styles/book.css"]')).toHaveLength(
    2,
  );

  resolveFetch?.(
    new Response(
      '@import "typography.css"; @import url("https://attacker.example/remote.css"); .cover { background: url(../Images/cover.jpg); } .remote { background: url(https://attacker.example/pixel); }',
      {
        status: 200,
        headers: { 'content-type': 'text/css' },
      },
    ),
  );
  await sanitizing;

  expect(fetch).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('style')).toHaveLength(0);
  expect(anotherChapter.querySelectorAll('style')).toHaveLength(0);
  expect(document.querySelector('base')?.getAttribute('href')).toContain('localhost');

  const links = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ...anotherChapter.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ];
  expect(links).toHaveLength(4);
  const sharedHref = links[0]?.getAttribute('href') ?? '';
  expect(sharedHref).toMatch(/^blob:/);
  for (const link of links) {
    expect(link.getAttribute('href')).toBe(sharedHref);
  }

  const blobText = await resolveObjectURL(sharedHref)?.text();
  expect(blobText).toContain(
    '@import "http://localhost/_capacitor_file/books/book.epub/OEBPS/styles/typography.css";',
  );
  expect(blobText).toContain(
    'url("http://localhost/_capacitor_file/books/book.epub/OEBPS/Images/cover.jpg")',
  );
  expect(blobText).not.toContain('attacker.example');

  const requested = vi.mocked(fetch).mock.calls[0]?.[0];
  expect(requested instanceof URL ? requested.href : requested).toBe(
    'http://localhost/_capacitor_file/books/book.epub/OEBPS/styles/book.css',
  );
  URL.revokeObjectURL(sharedHref);
});

it('preserves RFC 2045 wrapped data:image and data:font assets while rejecting SVG data URIs', async () => {
  const pngLine1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YA';
  const pngLine2 = 'AAAASUVORK5CYII=';
  const wrappedPng = `data:image/png;base64,${pngLine1}\r\n${pngLine2}`;
  const xmlWrappedPng = `data:image/png;base64,${pngLine1}&#13;&#10;${pngLine2}`;
  const wrappedFont = `data:font/woff2;base64,${'d09GMgABAAAAAAK8AA0AAAAABbQAAActAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbgcg='}\r\n${'PAr4GYACCahEICo1oATYCJAMUBCAFhG4HbBv8Z8S8xZ4A'}`;
  const document = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" data-turnleaf-sanitized="forged">
      <head>
        <style id="fonts">
          @font-face {
            font-family: "EmbeddedSerif";
            src: url(
              "${wrappedFont}"
            ) format("woff2");
          }
          .banner {
            background-image: url(
              '${wrappedPng}'
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

it('revokes evicted stylesheet blobs when cache capacity is exceeded', async () => {
  const stylesheetCache: StylesheetCache = new Map();
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (input: URL | RequestInfo) =>
        new Response(`.sheet { content: "${String(input)}"; }`, {
          status: 200,
          headers: { 'content-type': 'text/css' },
        }),
    ),
  );

  const createdBlobs: string[] = [];
  for (let index = 0; index < 33; index += 1) {
    const doc = new DOMParser().parseFromString(
      `<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/sheet-${index}.css" /></head><body /></html>`,
      'application/xhtml+xml',
    );
    await sanitizeEpubDocument(doc, stylesheetCache);
    createdBlobs.push(doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href') ?? '');
  }

  expect(stylesheetCache.size).toBe(32);
  expect(revokeSpy).toHaveBeenCalledWith(createdBlobs[0]);
  for (const url of createdBlobs.slice(1)) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
});

it('hardens chapters in spine.hooks.content, skips sanitized documents in rendition.hooks.content, and revokes blobs on destroy', async () => {
  const unsanitizedArchiveCssBlob = URL.createObjectURL(
    new Blob(
      [
        '.cover { background: url(blob:http://localhost/cover-asset); } .evil { background: url(https://attacker.example/leak); }',
      ],
      { type: 'text/css' },
    ),
  );
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

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
        archive: { getText: (url: string) => Promise<string>; destroy: () => void };
        renderTo: () => Rendition;
        resources: {
          urls: string[];
          cssUrls: string[];
          replacementUrls: string[];
          settings: { resolver: (href: string) => string };
          substitute: (content: string) => string;
          destroy: () => void;
        };
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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo) => {
      const href = String(input);
      if (href.startsWith('blob:')) throw new TypeError('CSP connect-src blocks blob: fetch');
      return new Response('body { color: inherit; }', {
        status: 200,
        headers: { 'content-type': 'text/css' },
      });
    }),
  );

  internalBook.archived = true;
  internalBook.archive = {
    getText: vi.fn(
      async () =>
        '.cover { background: url(../Images/cover.jpg); } .evil { background: url(https://attacker.example/leak); }',
    ),
    destroy: vi.fn(),
  };
  internalBook.resources = {
    urls: ['Styles/book.css'],
    cssUrls: ['Styles/book.css'],
    replacementUrls: [unsanitizedArchiveCssBlob],
    settings: { resolver: (href: string) => `/OEBPS/${href}` },
    substitute: (content: string) =>
      content.replace('../Images/cover.jpg', 'blob:http://localhost/cover-asset'),
    destroy: vi.fn(),
  };
  internalBook.renderTo = vi.fn(() => mockRendition);

  await session.open(
    document.createElement('div'),
    null,
    null,
    null,
    defaultAppearance,
    vi.fn(),
    vi.fn(),
  );

  const sanitizedArchiveCssBlob = internalBook.resources.replacementUrls[0] ?? '';
  expect(sanitizedArchiveCssBlob).toMatch(/^blob:/);
  expect(sanitizedArchiveCssBlob).not.toBe(unsanitizedArchiveCssBlob);
  expect(revokeSpy).toHaveBeenCalledWith(unsanitizedArchiveCssBlob);
  const sanitizedArchiveCss = await resolveObjectURL(sanitizedArchiveCssBlob)?.text();
  expect(sanitizedArchiveCss).toContain('blob:http://localhost/cover-asset');
  expect(sanitizedArchiveCss).not.toContain('attacker.example');

  const spineChapter = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" data-turnleaf-sanitized="forged-nonce">
      <head>
        <link rel="stylesheet" href="../Styles/book.css" />
        <link rel="stylesheet" href="../Styles/missing.css" />
      </head>
      <body onclick="alert(1)">
        <script>alert(1)</script>
        <p>Chapter text</p>
      </body>
    </html>`,
    'application/xhtml+xml',
  );

  await internalBook.spine.hooks.content.trigger(spineChapter, {
    href: 'Text/chapter-1.xhtml',
    url: '/OEBPS/Text/chapter-1.xhtml',
    idref: 'chapter-1',
  });

  const nonce = spineChapter.documentElement.getAttribute('data-turnleaf-sanitized');
  expect(nonce).toBeTruthy();
  expect(nonce).not.toBe('forged-nonce');
  expect(spineChapter.querySelector('script')).toBeNull();
  expect(spineChapter.body?.getAttribute('onclick')).toBeNull();
  expect(spineChapter.querySelector('link[href="../Styles/book.css"]')).not.toBeNull();
  expect(spineChapter.querySelector('link[href="../Styles/missing.css"]')).toBeNull();

  // Simulate XMLSerializer -> iframe.srcdoc -> rendition.hooks.content
  const serialized = new XMLSerializer().serializeToString(spineChapter.documentElement);
  const iframeDocument = new DOMParser().parseFromString(serialized, 'text/html');
  const paragraph = iframeDocument.querySelector('p')!;
  const hasAttributesSpy = vi.spyOn(paragraph, 'hasAttributes');

  await renditionHooks[0]?.({ document: iframeDocument } as unknown as Contents);
  expect(hasAttributesSpy).not.toHaveBeenCalled();

  // Fallback hardening in rendition.hooks.content still sanitizes uncached documents with forged nonces
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('body { color: inherit; }', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        }),
    ),
  );
  const uncachedDocument = new DOMParser().parseFromString(
    '<html data-turnleaf-sanitized="forged"><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/local.css" /></head><body><script>evil()</script></body></html>',
    'application/xhtml+xml',
  );
  await renditionHooks[0]?.({ document: uncachedDocument } as unknown as Contents);
  expect(uncachedDocument.querySelector('script')).toBeNull();
  const cachedBlobHref =
    uncachedDocument.querySelector('link[rel="stylesheet"]')?.getAttribute('href') ?? '';
  expect(cachedBlobHref).toMatch(/^blob:/);

  session.destroy();
  expect(revokeSpy).toHaveBeenCalledWith(sanitizedArchiveCssBlob);
  expect(revokeSpy).toHaveBeenCalledWith(cachedBlobHref);
});
