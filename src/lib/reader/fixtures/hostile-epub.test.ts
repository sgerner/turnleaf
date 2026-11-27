// @vitest-environment jsdom

import { crc32 } from 'node:zlib';
import ePub, { Book, EpubCFI, type Contents } from 'epubjs';
import { afterEach, expect, it, vi } from 'vitest';
import indexHtml from '../../../../index.html?raw';
import { defaultAppearance } from '../appearance';
import {
  EPUB_CONTENT_SECURITY_POLICY,
  ReaderSession,
  registerEpubSpineSanitizer,
  sanitizeCss,
  sanitizeEpubDocument,
  type StylesheetCache,
} from '../session';
import fixture from './hostile-epub.xhtml?raw';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

function buildEpubArchive(entries: Array<[string, string | Uint8Array]>): ArrayBuffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const checksum = crc32(dataBytes);
    const flags = name === 'mimetype' ? 0 : 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, dataBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(dataBytes.length, 20);
    central.writeUInt32LE(dataBytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
  return new Uint8Array(archive).buffer;
}

function buildHostileEpubArchive(): ArrayBuffer {
  const chapterTwo = `<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Chapter 2</title>
    <style>
      @import "../Text/styles/book.css";
      @\\69 mport "https://attacker.example/inline-escaped-import.css";
      @import "styles/missing-from-archive.css";
    </style>
  </head>
  <body>
    <section id="section">
      <p class="packaged-local">Second chapter target</p>
      <p>Follow-up paragraph</p>
    </section>
  </body>
</html>`;
  const packagedCss = `
@import url('https://attacker.example/packaged-import.css');
@import'https://attacker.example/compact-import.css';
@\\69 mport "https://attacker.example/escaped-packaged-import.css";
.packaged-local {
  background-image: url('../Images/paper.png');
  color: rgb(18, 52, 86);
}
.packaged-remote {
  background-image: \\75 rl('ht\\74ps\\3a //attacker.example/packaged-bg');
}
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:hostile-epub-fixture</dc:identifier>
    <dc:title>Hostile EPUB Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter-1" href="Text/hostile-epub.xhtml" media-type="application/xhtml+xml" />
    <item id="chapter-2" href="Text/chapter-2.xhtml" media-type="application/xhtml+xml" />
    <item id="book-css" href="Text/styles/book.css" media-type="text/css" />
    <item id="cover-image" href="Images/cover.jpg" media-type="image/png" />
    <item id="paper-image" href="Images/paper.png" media-type="image/png" />
    <item id="srcset-image" href="Images/a.jpg" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
    <itemref idref="chapter-2" />
  </spine>
</package>`;

  return buildEpubArchive([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    ['OEBPS/content.opf', opf],
    ['OEBPS/Text/hostile-epub.xhtml', fixture],
    ['OEBPS/Text/chapter-2.xhtml', chapterTwo],
    ['OEBPS/Text/styles/book.css', packagedCss],
    ['OEBPS/Images/cover.jpg', ONE_PIXEL_PNG],
    ['OEBPS/Images/paper.png', ONE_PIXEL_PNG],
    ['OEBPS/Images/a.jpg', ONE_PIXEL_PNG],
  ]);
}

function parseCspDirectives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, ...values] = entry.split(/\s+/);
        return [name ?? '', values];
      }),
  );
}

function installObjectUrlTracker(): {
  createdUrls: string[];
  revokedUrls: string[];
  restore: () => void;
} {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const createObjectUrl = (blob: Blob | MediaSource): string => {
    const url = nativeCreateObjectURL(blob as Blob);
    createdUrls.push(url);
    return url;
  };
  const revokeObjectUrl = (url: string): void => {
    revokedUrls.push(url);
    nativeRevokeObjectURL(url);
  };
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectUrl,
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectUrl,
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectUrl);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl);

  return {
    createdUrls,
    revokedUrls,
    restore: () => {
      Object.defineProperty(window.URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: nativeCreateObjectURL,
      });
      Object.defineProperty(window.URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: nativeRevokeObjectURL,
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

it('sanitizes a local stylesheet before restoring its safe rules', async () => {
  const chapter = () =>
    new DOMParser().parseFromString(
      '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
      'application/xhtml+xml',
    );
  const document = chapter();
  const anotherChapter = chapter();
  const stylesheetCache: StylesheetCache = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          '.cover { background: url(../Images/cover.jpg); } .remote { background: url(https://attacker.example/pixel); }',
          {
            status: 200,
            headers: { 'content-type': 'text/css' },
          },
        ),
    ),
  );

  await Promise.all([
    sanitizeEpubDocument(document, stylesheetCache),
    sanitizeEpubDocument(anotherChapter, stylesheetCache),
  ]);

  expect(fetch).toHaveBeenCalledOnce();
  expect(anotherChapter.querySelectorAll('style')).toHaveLength(2);
  expect(document.querySelector('base')?.getAttribute('href')).toContain('localhost');
  expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
  expect(document.querySelector('style')?.textContent).toContain('../Images/cover.jpg');
  expect(document.querySelector('style')?.textContent).not.toContain('attacker.example');
  const requested = vi.mocked(fetch).mock.calls[0]?.[0];
  expect(requested instanceof URL ? requested.href : requested).toBe(
    'http://localhost/_capacitor_file/books/book.epub/OEBPS/styles/book.css',
  );
});

it('normalizes CSS escapes, comments, string boundaries, and CSS4 functions before checking the EPUB allowlist', async () => {
  const hostileCss = [
    '@\\69 mport "https://attacker.example/escaped-import.css";',
    '@\\000069mport url("https://attacker.example/padded-import.css");',
    "@\\49\\4d\\50\\4f\\52\\54 'https://attacker.example/upper-import.css';",
    '@import/*comment*/"https://attacker.example/comment-import.css";',
    '@import \\75 rl("https://attacker.example/escaped-url-in-import.css");',
    '@import "https:\\\n//attacker.example/import-line-continuation.css";',
    '@\\69 mport "typography.css" screen and (min-width: 20em);',
    '<!-- @import "https://attacker.example/cdo-import.css";',
    '.hex-fn { background-image: \\75 rl("https://attacker.example/hex-fn.png"); }',
    '.mid-fn { background-image: u\\72 l("https://attacker.example/mid-fn.png"); }',
    '.padded-fn { background-image: \\000075rl(https://attacker.example/padded-fn.png); }',
    '.upper-fn { background-image: \\55\\52\\4c("https://attacker.example/upper-fn.png"); }',
    '.escaped-scheme-str { background-image: url("ht\\74ps\\3a //attacker.example/scheme-str.png"); }',
    '.escaped-scheme-raw { background-image: url(ht\\74ps://attacker.example/scheme-raw.png); }',
    '.escaped-js { background-image: url("java\\73 cript:alert(1)"); }',
    '.escaped-js-padded { background-image: url("java\\000073cript:alert(1)"); }',
    '.escaped-proto-rel { background-image: url("\\2f\\2fattacker.example/proto-rel.png"); }',
    '.escaped-foreign-blob { background-image: url("blob\\3a https://attacker.example/id"); }',
    '.line-continued { background-image: url("https:\\\r\n//attacker.example/continued.png"); }',
    '.css4-src { background-image: \\73 rc("https://attacker.example/css4-src.png"); }',
    '.css4-src-local { background-image: \\73 rc("../Images/local-src.png"); }',
    '.img-set-mixed { background-image: \\69 mage-set("https://attacker.example/1x.png" 1x, "../Images/local-2x.png" 2x); }',
    '.img-set-bad { background-image: -webkit-image-set(url("https://attacker.example/only-bad.png") 1x); }',
    '.ie-expr { width: \\65 xpression(alert(1)); }',
    'a::before { content: "/*"; }',
    '.after-comment-token-in-string { background-image: url("https://attacker.example/after-quote.png"); }',
    '/* url("https://attacker.example/inside-comment.png") */',
    '.bad-commented-url { background-image: url(/*c1*/ "https://attacker.example/bad-url.png"); }',
    '.commented-local { background-image: url( "../Images/paper.png" /*c2*/); }',
    '#fn\\:1 { font-weight: 700; } -->',
  ].join('\n');

  const sanitized = sanitizeCss(hostileCss, 'http://localhost/OEBPS/styles/book.css');
  expect(sanitized).not.toContain('attacker.example');
  expect(sanitized).not.toContain('javascript:');
  expect(sanitized).not.toContain('alert(1)');
  expect(sanitized).not.toContain('<!--');
  expect(sanitized).not.toContain('-->');
  expect(sanitized).toContain('@import "typography.css" screen and (min-width: 20em);');
  expect(sanitized).toContain('url("../Images/local-src.png")');
  expect(sanitized).toContain('image-set(url("../Images/local-2x.png") 2x)');
  expect(sanitized).toContain('.img-set-bad { background-image: none; }');
  expect(sanitized).toContain('.ie-expr { width: none; }');
  expect(sanitized).toContain('content: "/*"');
  expect(sanitized).toContain('.after-comment-token-in-string { background-image: none; }');
  expect(sanitized).toContain('.commented-local { background-image: url("../Images/paper.png"); }');
  expect(sanitized).toContain('#fn\\:1 { font-weight: 700; }');

  // Unclosed strings and URL tokens at EOF are auto-closed by CSS Syntax Level 3 parsers.
  expect(
    sanitizeCss(
      '@import "https://attacker.example/eof-import.css',
      'http://localhost/OEBPS/styles/book.css',
    ),
  ).toBe('');
  expect(
    sanitizeCss(
      'body { background: \\75 rl("ht\\74ps://attacker.example/eof-url.png',
      'http://localhost/OEBPS/styles/book.css',
    ),
  ).toBe('body { background: none');

  // Verify inline style="" attributes and <style> elements both normalize escaped tokens.
  const doc = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>${hostileCss}</style></head><body><p id="styled" style="font-style: italic; background-image: \\75 rl('ht\\74ps://attacker.example/inline-escaped.png')">Text</p></body></html>`,
    'application/xhtml+xml',
  );
  await sanitizeEpubDocument(doc);
  expect(doc.documentElement.outerHTML).not.toContain('attacker.example');
  expect(doc.querySelector('#styled')?.getAttribute('style')).toBe(
    'font-style: italic; background-image: none',
  );
});

it('enforces explicit EPUB and parent CSP directives and preserves every local permission sanitized EPUBs require', async () => {
  const epubDirectives = parseCspDirectives(EPUB_CONTENT_SECURITY_POLICY);
  expect(epubDirectives.get('default-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('script-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('connect-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('form-action')).toEqual(["'none'"]);
  expect(epubDirectives.get('frame-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('object-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('manifest-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('worker-src')).toEqual(["'none'"]);
  expect(epubDirectives.get('base-uri')).toEqual(["'self'"]);

  expect(epubDirectives.get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'data:', 'blob:']);
  expect(epubDirectives.get('font-src')).toEqual(["'self'", 'data:', 'blob:']);
  expect(epubDirectives.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  expect(epubDirectives.get('media-src')).toEqual(["'self'", 'data:', 'blob:']);

  for (const [, sources] of epubDirectives) {
    for (const forbidden of ['http:', 'https:', '*', "'unsafe-eval'", 'ws:', 'wss:']) {
      expect(sources).not.toContain(forbidden);
    }
  }

  const parsedIndex = new DOMParser().parseFromString(indexHtml, 'text/html');
  const parentCsp =
    parsedIndex
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? '';
  const parentDirectives = parseCspDirectives(parentCsp);
  expect(parentDirectives.get('img-src')).toEqual(["'self'", 'capacitor:', 'data:', 'blob:']);
  expect(parentDirectives.get('frame-src')).toEqual(["'self'", 'capacitor:', 'blob:']);
  expect(parentDirectives.get('base-uri')).toEqual(["'self'"]);
  expect(parentDirectives.get('object-src')).toEqual(["'none'"]);

  // Exercise every local asset permission required by sanitized EPUBs vs remote counterparts.
  const tracker = installObjectUrlTracker();
  const blobCssUrl = URL.createObjectURL(
    new Blob(
      [
        [
          "@font-face { font-family: 'BlobFont'; src: url('blob:http://localhost/local-font') format('woff2'), url('data:font/woff2;base64,d09GMgABAAAAAA==') format('woff2'), url('https://attacker.example/font.woff2') format('woff2'); }",
          '.blob-styled { border-top: 2px solid rgb(180, 83, 9); }',
        ].join('\n'),
      ],
      { type: 'text/css' },
    ),
  );
  const blobImgUrl = 'blob:http://localhost/local-image';
  const blobAudioUrl = 'blob:http://localhost/local-audio';
  try {
    const doc = new DOMParser().parseFromString(
      [
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<base href="http://localhost/OEBPS/text/chapter1.xhtml" />',
        `<link rel="stylesheet" href="${blobCssUrl}" />`,
        '<link rel="stylesheet" href="data:text/css,.data-styled%7Bcolor%3Argb(12%2C34%2C56)%3B%7D" />',
        '<link rel="stylesheet" href="https://attacker.example/remote.css" />',
        '<style>.inline-styled { font-weight: 600; }</style>',
        '</head>',
        '<body>',
        '<p id="inline-attr" class="blob-styled data-styled inline-styled" style="font-style: italic">Local styling</p>',
        `<img id="blob-img" src="${blobImgUrl}" />`,
        '<img id="data-img" src="data:image/png;base64,iVBORw0KGgo=" />',
        '<img id="remote-img" src="https://attacker.example/remote.png" />',
        `<audio id="blob-audio" src="${blobAudioUrl}" />`,
        '<audio id="remote-audio" src="https://attacker.example/remote.mp3" />',
        '</body>',
        '</html>',
      ].join(''),
      'application/xhtml+xml',
    );
    await sanitizeEpubDocument(doc);

    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toBe(EPUB_CONTENT_SECURITY_POLICY);
    expect(doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    const allStyles = [...doc.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(allStyles).toContain('blob:http://localhost/local-font');
    expect(allStyles).toContain('data:font/woff2;base64,d09GMgABAAAAAA==');
    expect(allStyles).toContain('color:rgb(12,34,56)');
    expect(allStyles).toContain('.inline-styled { font-weight: 600; }');
    expect(allStyles).not.toContain('attacker.example');
    expect(doc.querySelector('#inline-attr')?.getAttribute('style')).toBe('font-style: italic');
    expect(doc.querySelector('#blob-img')?.getAttribute('src')).toBe(blobImgUrl);
    expect(doc.querySelector('#data-img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(doc.querySelector('#remote-img')?.getAttribute('src')).toBeNull();
    expect(doc.querySelector('#blob-audio')?.getAttribute('src')).toBe(blobAudioUrl);
    expect(doc.querySelector('#remote-audio')?.getAttribute('src')).toBeNull();
  } finally {
    URL.revokeObjectURL(blobCssUrl);
    tracker.restore();
  }
});

it('retains local blob stylesheets and @font-face rules while stripping remote CSS targets', async () => {
  const tracker = installObjectUrlTracker();
  const fontBlobUrl = 'blob:http://localhost/font-asset-id';
  const css = [
    "@import url('https://attacker.example/import-url.css');",
    '@import "https://attacker.example/import-string.css" screen;',
    '@import"https://attacker.example/no-space.css";',
    '@import/**/"https://attacker.example/comment-bypass.css";',
    "@import 'typography.css';",
    `@font-face { font-family: 'BookFont'; src: url('${fontBlobUrl}') format('woff2'), url('https://attacker.example/font.woff2') format('woff2'); }`,
    ".foreign-blob { background-image: url('blob:https://attacker.example/foreign-id'); }",
    ".callout { border-left: 4px solid rgb(180, 83, 9); background-image: url('https://attacker.example/pixel.png'); }",
  ].join('\n');

  const sanitized = sanitizeCss(css, 'http://localhost/OEBPS/styles/book.css');
  expect(sanitized).toContain('@import "typography.css";');
  expect(sanitized).toContain(fontBlobUrl);
  expect(sanitized).toContain('border-left: 4px solid rgb(180, 83, 9)');
  expect(sanitized).not.toContain('attacker.example');

  const styleBlobUrl = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
  try {
    const doc = new DOMParser().parseFromString(
      `<html><head><base href="http://localhost/OEBPS/text/chapter1.xhtml" /><link rel="stylesheet" href="${styleBlobUrl}" /><link rel="stylesheet" href="blob:https://attacker.example/evil-css" /></head><body><p class="callout">Text</p></body></html>`,
      'application/xhtml+xml',
    );
    await sanitizeEpubDocument(doc);

    const styles = [...doc.querySelectorAll('style')]
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(styles).toContain(fontBlobUrl);
    expect(styles).not.toContain('attacker.example');
  } finally {
    URL.revokeObjectURL(styleBlobUrl);
    tracker.restore();
  }
});

it('sanitizes Section.render output and packaged stylesheets before iframe serialization', async () => {
  const tracker = installObjectUrlTracker();
  const fetchSpy = vi.fn(async () => {
    throw new Error('Unexpected network fetch during Section.render');
  });
  vi.stubGlobal('fetch', fetchSpy);
  const book = ePub(buildHostileEpubArchive());
  registerEpubSpineSanitizer(book as unknown as Parameters<typeof registerEpubSpineSanitizer>[0]);

  try {
    await book.opened;
    const section = book.spine.get(0);
    const rendered = await section.render(book.load.bind(book));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rendered).toContain('http-equiv="Content-Security-Policy"');
    expect(rendered).toContain("img-src 'self' data: blob:");
    expect(rendered).not.toContain('attacker.example');

    const serializedDoc = new DOMParser().parseFromString(rendered, 'text/html');
    expect(
      serializedDoc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
    ).toHaveLength(1);
    expect(
      serializedDoc.querySelector(
        'script, iframe, form, meta[http-equiv="refresh"], link[rel="stylesheet"]',
      ),
    ).toBeNull();
    expect(serializedDoc.querySelector('#internal')?.getAttribute('href')).toBe(
      'chapter-2.xhtml#section',
    );
    expect(serializedDoc.querySelector('#fragment')?.getAttribute('href')).toBe('#section');
    expect(serializedDoc.querySelector('#remote')?.getAttribute('href')).toBeNull();
    expect(serializedDoc.querySelector('#local-image')?.getAttribute('src')).toMatch(/^blob:/);
    expect(serializedDoc.querySelector('#embedded-image')?.getAttribute('src')).toMatch(
      /^data:image\/png/,
    );
    expect(serializedDoc.querySelector('#remote-image')?.getAttribute('src')).toBeNull();
    expect(serializedDoc.querySelector('#remote-srcset')?.getAttribute('srcset')).toMatch(
      /^blob:\S+\s+2x$/,
    );
    expect(serializedDoc.querySelector('#remote-svg-image')?.getAttribute('href')).toBeNull();
    expect(serializedDoc.querySelector('#remote-video')?.getAttribute('poster')).toBeNull();

    const combinedStyles = [...serializedDoc.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(combinedStyles).toContain('color: rgb(18, 52, 86)');
    expect(combinedStyles).toMatch(/url\(['"]?blob:/);
    expect(combinedStyles).not.toContain('attacker.example');
    expect(combinedStyles).not.toMatch(/@import/i);

    // Chapter 2 uses inline <style>@import "../Text/styles/book.css";</style> + missing/escaped imports.
    const sectionTwo = book.spine.get(1);
    const renderedTwo = await sectionTwo.render(book.load.bind(book));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(renderedTwo).toContain('color: rgb(18, 52, 86)');
    expect(renderedTwo).not.toContain('attacker.example');
    expect(renderedTwo).not.toContain('missing-from-archive.css');
    expect(renderedTwo).not.toMatch(/@import/i);
  } finally {
    book.destroy();
    for (const url of tracker.createdUrls) URL.revokeObjectURL(url);
    tracker.restore();
  }
});

it('fails closed on cyclic, diamond, media-scoped, and excessive packaged @import chains without hanging', async () => {
  const tracker = installObjectUrlTracker();
  const fetchSpy = vi.fn(async () => {
    throw new Error('Unexpected network fetch during packaged stylesheet import resolution');
  });
  vi.stubGlobal('fetch', fetchSpy);

  const fanoutEntries: Array<[string, string]> = Array.from({ length: 22 }, (_, idx) => {
    const nextImport = idx < 21 ? `@import "chain-${idx + 1}.css";\n` : '';
    return [`OEBPS/Text/styles/chain-${idx}.css`, `${nextImport}.step-${idx} { z-index: ${idx}; }`];
  });
  const fanoutManifest = fanoutEntries
    .map(
      ([path], idx) =>
        `<item id="chain-${idx}" href="${path.replace(/^OEBPS\//, '')}" media-type="text/css" />`,
    )
    .join('\n    ');

  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Complex Imports</title>
    <link rel="stylesheet" href="styles/a.css" />
    <link rel="stylesheet" href="styles/diamond.css" />
    <link rel="stylesheet" href="styles/chain-0.css" />
  </head>
  <body>
    <p class="cycle-a cycle-b shared">Complex stylesheet chapter</p>
  </body>
</html>`;
  const cssA = `
@\\69 mport url('nested/b.css');
@import url('https://attacker.example/cycle-a-remote.css');
.cycle-a {
  color: rgb(11, 22, 33);
  background-image: url('../../Images/paper.png');
}
`;
  const cssB = `
@import '../a.css';
@import url('b.css');
@import url('https://attacker.example/cycle-b-remote.css');
.cycle-b {
  border-color: rgb(44, 55, 66);
  background-image: url('../../../Images/cover.jpg');
  list-style-image: \\75 rl('https://attacker.example/cycle-b-bg.png');
}
`;
  const diamondCss = `
@import "shared.css";
@import "theme.css" screen;
`;
  const themeCss = `
@import "shared.css";
.theme-only { font-variant: small-caps; }
`;
  const sharedCss = `.shared { letter-spacing: 0.05em; }`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:cyclic-epub-fixture</dc:identifier>
    <dc:title>Cyclic Stylesheet Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter-1" href="Text/chapter-1.xhtml" media-type="application/xhtml+xml" />
    <item id="css-a" href="Text/styles/a.css" media-type="text/css" />
    <item id="css-b" href="Text/styles/nested/b.css" media-type="text/css" />
    <item id="css-diamond" href="Text/styles/diamond.css" media-type="text/css" />
    <item id="css-theme" href="Text/styles/theme.css" media-type="text/css" />
    <item id="css-shared" href="Text/styles/shared.css" media-type="text/css" />
    ${fanoutManifest}
    <item id="cover-image" href="Images/cover.jpg" media-type="image/png" />
    <item id="paper-image" href="Images/paper.png" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter-1" />
  </spine>
</package>`;

  const archive = buildEpubArchive([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    ['OEBPS/content.opf', opf],
    ['OEBPS/Text/chapter-1.xhtml', chapter],
    ['OEBPS/Text/styles/a.css', cssA],
    ['OEBPS/Text/styles/nested/b.css', cssB],
    ['OEBPS/Text/styles/diamond.css', diamondCss],
    ['OEBPS/Text/styles/theme.css', themeCss],
    ['OEBPS/Text/styles/shared.css', sharedCss],
    ...fanoutEntries,
    ['OEBPS/Images/cover.jpg', ONE_PIXEL_PNG],
    ['OEBPS/Images/paper.png', ONE_PIXEL_PNG],
  ]);

  const stylesheetCache: StylesheetCache = new Map();
  const book = ePub(archive);
  registerEpubSpineSanitizer(
    book as unknown as Parameters<typeof registerEpubSpineSanitizer>[0],
    stylesheetCache,
  );

  try {
    await book.opened;
    const getTextSpy = vi.spyOn(
      (book as unknown as { archive: { getText: (path: string) => Promise<string> } }).archive,
      'getText',
    );
    const section = book.spine.get(0);
    const rendered = await Promise.race([
      section.render(book.load.bind(book)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out rendering cyclic stylesheet chapter')), 2000),
      ),
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rendered).not.toContain('attacker.example');
    expect(rendered).not.toMatch(/@import/i);

    const serializedDoc = new DOMParser().parseFromString(rendered, 'text/html');
    expect(serializedDoc.querySelector('link[rel="stylesheet"]')).toBeNull();
    const combinedStyles = [...serializedDoc.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(combinedStyles).toContain('color: rgb(11, 22, 33)');
    expect(combinedStyles).toContain('border-color: rgb(44, 55, 66)');
    expect(combinedStyles).toContain('.shared { letter-spacing: 0.05em; }');
    expect(combinedStyles).toContain('@media screen');
    expect(combinedStyles).toContain('.theme-only { font-variant: small-caps; }');
    // Depth/fanout budget caps deep chain imports cleanly without throwing or hanging.
    expect(combinedStyles).toContain('.step-0 { z-index: 0; }');
    expect(combinedStyles).toContain('.step-4 { z-index: 4; }');
    expect(combinedStyles).not.toContain('.step-10');
    expect(combinedStyles).toMatch(/url\(['"]?blob:/);
    expect(combinedStyles).not.toContain('attacker.example');

    // Re-rendering the chapter hits stylesheetCache with zero additional CSS archive.getText reads.
    const cssCallsAfterFirstRender = getTextSpy.mock.calls.filter(([path]) =>
      path.endsWith('.css'),
    ).length;
    section.unload();
    const renderedAgain = await section.render(book.load.bind(book));
    const cssCallsAfterSecondRender = getTextSpy.mock.calls.filter(([path]) =>
      path.endsWith('.css'),
    ).length;
    expect(cssCallsAfterSecondRender).toBe(cssCallsAfterFirstRender);
    expect(renderedAgain).toContain('color: rgb(11, 22, 33)');
  } finally {
    book.destroy();
    for (const url of tracker.createdUrls) URL.revokeObjectURL(url);
    tracker.restore();
  }
});

it('fails closed when epub.js Resources hooks or resource table shapes differ', async () => {
  const tracker = installObjectUrlTracker();
  const session = new ReaderSession(buildHostileEpubArchive());
  try {
    const installSanitizer = (
      session as unknown as { installResourceCssSanitizer: (target: unknown) => void }
    ).installResourceCssSanitizer.bind(session);

    const unsanitizedCreateCss = vi.fn(
      async (href: string): Promise<string | undefined> => `blob:http://localhost/${href}`,
    );
    const unsanitizedReplaceCss = vi.fn(async () => ['blob:http://localhost/unsanitized-css']);
    const rawPrepopulatedCssBlob = URL.createObjectURL(
      new Blob(['@import "https://attacker.example/raw.css";'], { type: 'text/css' }),
    );
    const nonCssAssetBlob = URL.createObjectURL(new Blob([ONE_PIXEL_PNG], { type: 'image/png' }));
    const archiveCache: Record<string, string> = {
      '/OEBPS/styles/book.css': rawPrepopulatedCssBlob,
      '/OEBPS/Images/cover.jpg': nonCssAssetBlob,
    };

    // Case 1: Malformed table shapes & missing resolver never delegate to original methods and purge raw CSS blobs.
    const malformedResources = {
      urls: ['styles/book.css', 'Images/cover.jpg'],
      cssUrls: ['styles/book.css'],
      replacementUrls: [rawPrepopulatedCssBlob, nonCssAssetBlob],
      settings: {
        archive: { urlCache: archiveCache },
        resolver: null,
      },
      createUrl: vi.fn(async (href: string) => `blob:http://localhost/raw-${href}`),
      createCssFile: unsanitizedCreateCss,
      replaceCss: unsanitizedReplaceCss,
    };
    installSanitizer(malformedResources);

    expect(await malformedResources.createUrl('styles/book.css')).toBe('');
    expect(await malformedResources.createCssFile('styles/book.css')).toBeUndefined();
    expect(await malformedResources.replaceCss()).toEqual(['', nonCssAssetBlob]);
    expect(unsanitizedCreateCss).not.toHaveBeenCalled();
    expect(unsanitizedReplaceCss).not.toHaveBeenCalled();
    expect(malformedResources.replacementUrls[0]).toBe('');
    expect(malformedResources.replacementUrls[1]).toBe(nonCssAssetBlob);
    expect(tracker.revokedUrls).toContain(rawPrepopulatedCssBlob);
    expect(archiveCache['/OEBPS/styles/book.css']).toBeUndefined();
    expect(archiveCache['/OEBPS/Images/cover.jpg']).toBe(nonCssAssetBlob);

    // Non-array urls/cssUrls also fail closed to [] and purge replacementUrls.
    const brokenArraysResources = {
      urls: null,
      cssUrls: [123],
      replacementUrls: [rawPrepopulatedCssBlob],
      replaceCss: unsanitizedReplaceCss,
    };
    installSanitizer(brokenArraysResources);
    expect(await brokenArraysResources.replaceCss()).toEqual([]);
    expect(brokenArraysResources.replacementUrls).toEqual(['']);
    expect(unsanitizedReplaceCss).not.toHaveBeenCalled();

    // Case 2: Unarchived resources missing substitute or request fail closed without throwing or delegating.
    const unarchivedMissingHooks = {
      urls: ['styles/book.css'],
      cssUrls: ['styles/book.css'],
      replacementUrls: ['blob:http://localhost/stale-css'],
      settings: {
        resolver: (href: string) => `/OEBPS/${href}`,
      },
    } as Record<string, unknown>;
    installSanitizer(unarchivedMissingHooks);
    const wrappedCreateCss = unarchivedMissingHooks.createCssFile as (
      href: string,
    ) => Promise<string | undefined>;
    const wrappedReplaceCss = unarchivedMissingHooks.replaceCss as () => Promise<string[]>;
    expect(await wrappedCreateCss('styles/book.css')).toBeUndefined();
    expect(await wrappedReplaceCss()).toEqual(['']);
    expect((unarchivedMissingHooks.replacementUrls as string[])[0]).toBe('');
  } finally {
    session.destroy();
    for (const url of tracker.createdUrls) URL.revokeObjectURL(url);
    tracker.restore();
  }
});

it('revokes in-flight blob URLs and aborts cleanly when destroyed during a pending chapter load', async () => {
  const tracker = installObjectUrlTracker();
  const archive = buildHostileEpubArchive();
  const session = new ReaderSession(archive);

  const viewport = document.createElement('div');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 360, 640),
  );
  document.body.appendChild(viewport);

  try {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    const internalBook = (
      session as unknown as {
        book: {
          archive: {
            getBlob: (url: string, mimeType?: string) => Promise<Blob>;
          };
        };
      }
    ).book;
    const archiveRef = internalBook.archive;

    let releasePendingBlobs!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePendingBlobs = resolve;
    });
    const pendingSettled: Array<Promise<Blob>> = [];
    let blobCallCount = 0;
    const originalGetBlob = archiveRef.getBlob;
    archiveRef.getBlob = (url: string, mimeType?: string) => {
      const index = blobCallCount++;
      const blobPromise = originalGetBlob.call(archiveRef, url, mimeType);
      if (index === 0) return blobPromise;
      const delayed = blobPromise.then((blob) => gate.then(() => blob));
      pendingSettled.push(delayed);
      return delayed;
    };

    const openPromise = session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      vi.fn(),
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(tracker.createdUrls.length).toBeGreaterThan(0);
      expect(pendingSettled.length).toBeGreaterThan(0);
    });
    const urlsBeforeDestroy = tracker.createdUrls.length;

    // Tear down session while remaining archive.getBlob -> createUrl promises are still pending.
    session.destroy();
    await openPromise;

    // Release pending archive.getBlob calls so late blob URL creations settle after destroy().
    releasePendingBlobs();
    await Promise.all(pendingSettled);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(tracker.createdUrls.length).toBeGreaterThan(urlsBeforeDestroy);
    for (const url of tracker.createdUrls) {
      expect(tracker.revokedUrls).toContain(url);
    }
  } finally {
    viewport.remove();
    tracker.restore();
  }
});

it('opens a zipped EPUB in ReaderSession with zero outbound requests, aligned search CFIs, publisherStyles toggling, and blob cleanup', async () => {
  const tracker = installObjectUrlTracker();
  const outboundRequests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      outboundRequests.push(target);
      throw new Error(`Unexpected outbound fetch: ${target}`);
    }),
  );

  const originalRangeRect = Range.prototype.getBoundingClientRect;
  const originalRangeRects = Range.prototype.getClientRects;
  const rectList = () =>
    ({
      length: 1,
      item: () => new DOMRect(0, 0, 320, 24),
      0: new DOMRect(0, 0, 320, 24),
      [Symbol.iterator]: function* () {
        yield new DOMRect(0, 0, 320, 24);
      },
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 320, 480);
  Range.prototype.getClientRects ??= rectList;
  const nativeCreateElement = document.createElement.bind(document);
  const assignedSrcdocs: string[] = [];
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = nativeCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'iframe') {
      const frame = element as HTMLIFrameElement;
      const srcdocDescriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        'srcdoc',
      );
      if (srcdocDescriptor?.set && srcdocDescriptor.get) {
        Object.defineProperty(frame, 'srcdoc', {
          configurable: true,
          get: () => srcdocDescriptor.get!.call(frame),
          set: (value: string) => {
            assignedSrcdocs.push(value);
            srcdocDescriptor.set!.call(frame, value);
          },
        });
      }
      element.addEventListener(
        'load',
        () => {
          const frameWin = frame.contentWindow as (Window & typeof globalThis) | null;
          const frameDoc = frame.contentDocument;
          if (!frameWin || !frameDoc) return;
          if (frame.srcdoc && !frameDoc.body?.children.length) {
            const parsed = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
            frameDoc.documentElement.replaceWith(frameDoc.importNode(parsed.documentElement, true));
          }
          frameWin.scrollTo = () => {};
          frameWin.Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 320, 480);
          frameWin.Range.prototype.getClientRects ??= rectList;
        },
        true,
      );
    }
    return element;
  }) as typeof document.createElement);

  const epubArchive = buildEpubArchive([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    [
      'OEBPS/content.opf',
      '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">hostile-zip-test</dc:identifier><dc:title>Hostile Styled EPUB</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles/book.css" media-type="text/css"/><item id="subcss" href="styles/typography.css" media-type="text/css"/><item id="font" href="fonts/sample.woff2" media-type="font/woff2"/><item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    ],
    [
      'OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">Chapter 1</a></li><li><a href="text/chapter2.xhtml">Chapter 2</a></li></ol></nav></body></html>',
    ],
    ['OEBPS/fonts/sample.woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00])],
    [
      'OEBPS/styles/book.css',
      [
        '@import "https://attacker.example/remote-import.css";',
        '@\\69 mport "typography.css";',
        'h1 { font-family: EmbeddedTestFont, serif; border-bottom: 2px solid rgb(180, 83, 9); }',
        ".callout { border-left: 4px solid rgb(180, 83, 9); background-image: \\75 rl('https://attacker.example/tracker.png'); }",
      ].join('\n'),
    ],
    [
      'OEBPS/styles/typography.css',
      [
        '@import "https://attacker.example/nested-import.css";',
        "@font-face { font-family: 'EmbeddedTestFont'; src: url('../fonts/sample.woff2') format('woff2'), url('https://attacker.example/evil.woff2') format('woff2'); }",
      ].join('\n'),
    ],
    [
      'OEBPS/text/chapter1.xhtml',
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<base href="https://attacker.example/hijack/" />',
        '<link rel="stylesheet" type="text/css" href="../styles/book.css" />',
        '<link rel="stylesheet" type="text/css" href="https://attacker.example/external.css" />',
        '</head>',
        '<body onload="fetch(\'https://attacker.example/onload\')">',
        '<script>fetch("https://attacker.example/script")</script>',
        '<h1>Chapter 1</h1>',
        '<p class="callout" style="font-style: italic; background-image: \\75 rl(https://attacker.example/inline.png)">Styled paragraph with <a id="internal" href="chapter2.xhtml">Continue</a>.</p>',
        '<p>Supporting body paragraph one.</p>',
        '<p>Supporting body paragraph two.</p>',
        '<img id="remote" src="https://attacker.example/remote.jpg" />',
        '</body>',
        '</html>',
      ].join(''),
    ],
    [
      'OEBPS/text/chapter2.xhtml',
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<link rel="stylesheet" type="text/css" href="../styles/book.css" />',
        '</head>',
        '<body>',
        '<h1>Chapter 2</h1>',
        '<p class="callout" style="font-style: italic">Second chapter target paragraph.</p>',
        '</body>',
        '</html>',
      ].join(''),
    ],
  ]);

  const viewport = document.createElement('div');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 360, 640),
  );
  document.body.appendChild(viewport);

  const locations: string[] = [];
  const session = new ReaderSession(epubArchive);
  try {
    await session.open(
      viewport,
      null,
      null,
      null,
      defaultAppearance,
      (loc) => {
        locations.push(loc.cfi);
      },
      vi.fn(),
    );

    expect(outboundRequests).toEqual([]);
    expect(assignedSrcdocs.length).toBeGreaterThan(0);
    for (const srcdoc of assignedSrcdocs) {
      expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
      expect(srcdoc).not.toContain('attacker.example');
      expect(srcdoc).not.toContain('<script');
    }

    const frame = viewport.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(String(frame?.sandbox)).toBe('allow-same-origin');

    const chapterDoc = frame!.contentDocument!;
    const chapterWin = frame!.contentWindow!;
    let authorStyleText = '';
    await vi.waitFor(() => {
      expect(chapterDoc.querySelector('link[rel="stylesheet"]')).toBeNull();
      authorStyleText = [...chapterDoc.querySelectorAll('style')]
        .filter((style) => !style.id.startsWith('epubjs-inserted-css-'))
        .map((style) => style.textContent ?? '')
        .join('\n');
      expect(authorStyleText).toContain('border-bottom: 2px solid rgb(180, 83, 9)');
    });
    expect(authorStyleText).toContain('EmbeddedTestFont');
    expect(authorStyleText).toMatch(/url\("blob:/);
    expect(authorStyleText).not.toContain('attacker.example');
    expect(authorStyleText).not.toMatch(/@import/i);

    const heading = chapterDoc.querySelector('h1')!;
    const callout = chapterDoc.querySelector('p.callout')!;
    expect(chapterWin.getComputedStyle(heading).borderBottomWidth).toBe('2px');
    expect(chapterWin.getComputedStyle(callout).borderLeftWidth).toBe('4px');
    expect(chapterWin.getComputedStyle(callout).fontStyle).toBe('italic');

    const results = await session.search('Continue');
    expect(results).toHaveLength(1);
    expect(results[0]?.spineIndex).toBe(0);
    const rendition = (session as unknown as { rendition: { getContents: () => unknown } })
      .rendition;
    const contents = rendition.getContents() as Contents[];
    expect(contents[0]?.range(results[0]!.cfi)?.toString()).toBe('Continue');
    expect(new EpubCFI(results[0]!.cfi).toRange(chapterDoc)?.toString()).toBe('Continue');
    session.updateHighlights([{ cfi: results[0]!.cfi }]);

    await vi.waitFor(() => {
      expect(locations.length).toBeGreaterThan(0);
    });
    const activeCfi = locations.at(-1)!;
    expect(activeCfi).toMatch(/^epubcfi\(/);

    session.applyAppearance({ ...defaultAppearance, publisherStyles: false });
    expect(chapterWin.getComputedStyle(heading).borderBottomWidth).toBe('0px');
    expect(chapterWin.getComputedStyle(callout).borderLeftWidth).toBe('0px');
    expect(chapterWin.getComputedStyle(callout).fontStyle).toBe('normal');
    expect(chapterDoc.getElementById('epubjs-inserted-css-turnleaf')).not.toBeNull();
    expect(locations.at(-1)).toBe(activeCfi);

    await session.display('text/chapter2.xhtml');
    const ch2Frame = viewport.querySelector('iframe')!;
    await vi.waitFor(() => {
      expect(ch2Frame.contentDocument?.querySelector('h1')?.textContent).toBe('Chapter 2');
      expect(ch2Frame.contentDocument?.querySelector('link[rel="stylesheet"]')).toBeNull();
    });
    expect(
      ch2Frame.contentWindow!.getComputedStyle(ch2Frame.contentDocument!.querySelector('h1')!)
        .borderBottomWidth,
    ).toBe('0px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).fontStyle,
    ).toBe('normal');

    session.applyAppearance({ ...defaultAppearance, publisherStyles: true });
    expect(
      ch2Frame.contentWindow!.getComputedStyle(ch2Frame.contentDocument!.querySelector('h1')!)
        .borderBottomWidth,
    ).toBe('2px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).borderLeftWidth,
    ).toBe('4px');
    expect(
      ch2Frame.contentWindow!.getComputedStyle(
        ch2Frame.contentDocument!.querySelector('p.callout')!,
      ).fontStyle,
    ).toBe('italic');
    expect(outboundRequests).toEqual([]);
  } finally {
    session.destroy();
    viewport.remove();
    Range.prototype.getBoundingClientRect = originalRangeRect;
    Range.prototype.getClientRects = originalRangeRects;
  }

  expect(tracker.createdUrls.length).toBeGreaterThan(0);
  for (const url of tracker.createdUrls) {
    expect(tracker.revokedUrls).toContain(url);
  }
  tracker.restore();
});

it('blocks XHTML-to-srcdoc parser differentials, noscript/SMIL vectors, style tag breakouts, and encoded data:text/css imports', async () => {
  const embeddedHostile = Buffer.from(
    "@import url('https://attacker.example/embedded-import.css'); .embedded-ok { color: rgb(9, 8, 7); } .embedded-bad { background: url('https://attacker.example/embedded-bg.png'); }",
    'utf8',
  ).toString('base64');
  const cssWithBreakoutAndDataImport = [
    `@import "data:text/css;base64,${embeddedHostile}" screen;`,
    '@import "data:text/css;base64,%%%invalid%%%";',
    '.quote-breakout::after { content: "</style><script id=\'escaped-script\'>window.__xss=1</script>"; }',
    'a </style><img id="escaped-img" src="/escaped.png"> { font-weight: 600; }',
  ].join('\n');

  const sanitizedCssText = sanitizeCss(
    cssWithBreakoutAndDataImport,
    'http://localhost/OEBPS/styles/book.css',
  );
  expect(sanitizedCssText).toContain('@media screen');
  expect(sanitizedCssText).toContain('.embedded-ok { color: rgb(9, 8, 7); }');
  expect(sanitizedCssText).not.toContain('attacker.example');
  expect(sanitizedCssText.toLowerCase()).not.toContain('</style');

  const xhtml = [
    "<!DOCTYPE html [ <!ENTITY x \">&#60;img id='doctype-breakout' src='https://attacker.example/doctype.png'>\"> ]>",
    '<?pi ><img id="pi-breakout" src="https://attacker.example/pi.png" ?>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:base="https://attacker.example/xml-base/">',
    '<head>',
    '<TITLE><!-- </TITLE><img id="title-comment-breakout" src="https://attacker.example/title-comment.png" /> --></TITLE>',
    '<BASE HREF="https://attacker.example/xhtml-base/" />',
    '<META HTTP-EQUIV="refresh" CONTENT="0;url=https://attacker.example/xhtml-refresh" />',
    '<META name="referrer" content="unsafe-url" />',
    '<LINK REL="preload" AS="style" HREF="styles/untrusted.css" />',
    '<LINK REL="dns-prefetch" HREF="//attacker.example" />',
    '<style>@import "https://attacker.example/empty-after-sanitize.css";</style>',
    `<STYLE><![CDATA[${cssWithBreakoutAndDataImport}]]></STYLE>`,
    '</head>',
    '<body>',
    '<!-- ><img id="comment-breakout" src="https://attacker.example/comment.png" /> -->',
    '<p id="cdata-paragraph">Safe <![CDATA[><img id="cdata-breakout" src="/cdata-probe.png" />]]> text</p>',
    '<SCRIPT>fetch("https://attacker.example/upper-script")</SCRIPT>',
    '<IFRAME SRC="https://attacker.example/upper-frame"></IFRAME>',
    '<noscript><img src="https://attacker.example/noscript.png" /></noscript>',
    '<template><img src="https://attacker.example/template.png" /></template>',
    '<xmp><img src="https://attacker.example/xmp.png" /></xmp>',
    '<textarea><img src="https://attacker.example/textarea.png" /></textarea>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a id="svg-link" href="#safe"><set attributeName="href" to="https://attacker.example/smil" /><animate attributeName="href" values="https://attacker.example/anim" /></a></svg>',
    '<A id="upper-internal" HREF="chapter-2.xhtml#section">Internal</A>',
    '<A id="upper-remote" HREF="https://attacker.example/upper-link">Remote</A>',
    '</body>',
    '</html>',
  ].join('');
  const xhtmlDoc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  expect(xhtmlDoc.querySelector('parsererror')).toBeNull();
  await sanitizeEpubDocument(xhtmlDoc);

  // Reparse serialized XHTML as text/html just like iframe.srcdoc does in browsers.
  const serialized = new XMLSerializer().serializeToString(xhtmlDoc);
  const srcdocParsed = new DOMParser().parseFromString(serialized, 'text/html');
  expect(srcdocParsed.documentElement.outerHTML).not.toContain('attacker.example');
  expect(srcdocParsed.documentElement.hasAttribute('xml:base')).toBe(false);
  expect(
    srcdocParsed.querySelector(
      'base, script, iframe, img, noscript, template, xmp, textarea, set, animate, link, meta[http-equiv="refresh"], meta[name="referrer"]',
    ),
  ).toBeNull();
  expect(srcdocParsed.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(
    1,
  );
  // Empty-after-sanitization <style> and empty <TITLE> must not emit self-closing <style/> or <title/> that swallow <body>.
  expect(srcdocParsed.querySelectorAll('style')).toHaveLength(1);
  expect(srcdocParsed.querySelector('#cdata-paragraph')?.textContent).toContain('Safe >');
  expect(srcdocParsed.querySelector('#upper-internal')?.getAttribute('href')).toBe(
    'chapter-2.xhtml#section',
  );
  expect(srcdocParsed.querySelector('#upper-remote')?.getAttribute('href')).toBeNull();
  expect(srcdocParsed.querySelector('style')?.textContent).toContain('.embedded-ok');

  // Malformed XML producing a <parsererror> document is replaced with a clean CSP-protected shell.
  const malformedXmlDoc = new DOMParser().parseFromString(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><!-- --!><img src="https://attacker.example/malformed.png"/></body></html>',
    'application/xhtml+xml',
  );
  await sanitizeEpubDocument(malformedXmlDoc);
  const malformedSerialized = new XMLSerializer().serializeToString(malformedXmlDoc);
  expect(malformedSerialized).not.toContain('attacker.example');
  expect(malformedSerialized).not.toContain('parsererror');
  expect(malformedSerialized).toContain('http-equiv="Content-Security-Policy"');
});

it('throws from registerEpubSpineSanitizer when the epub.js pre-serialization content hook is absent or invalid', () => {
  const reportedErrors: string[] = [];
  const recordError = (error: Error) => reportedErrors.push(error.message);

  expect(() =>
    registerEpubSpineSanitizer({} as never, new Map(), { onError: recordError }),
  ).toThrow(/spine content sanitizer hook is unavailable/i);
  expect(() =>
    registerEpubSpineSanitizer({ spine: {} }, new Map(), { onError: recordError }),
  ).toThrow(/spine content sanitizer hook is unavailable/i);
  expect(() =>
    registerEpubSpineSanitizer({ spine: { hooks: {} } }, new Map(), { onError: recordError }),
  ).toThrow(/spine content sanitizer hook is unavailable/i);
  expect(() =>
    registerEpubSpineSanitizer({ spine: { hooks: { content: {} } } }, new Map(), {
      onError: recordError,
    }),
  ).toThrow(/spine content sanitizer hook is unavailable/i);
  expect(() =>
    registerEpubSpineSanitizer(
      {
        spine: {
          hooks: {
            content: {
              register: () => {},
              trigger: 'invalid' as unknown as () => Promise<unknown>,
            },
          },
        },
      },
      new Map(),
      { onError: recordError },
    ),
  ).toThrow(/trigger hook is invalid/i);
  expect(() =>
    registerEpubSpineSanitizer(
      {
        spine: {
          hooks: {
            content: {
              register: () => {
                throw new Error('direct register failure');
              },
            },
          },
        },
      },
      new Map(),
      { onError: recordError },
    ),
  ).toThrow('direct register failure');
  expect(() =>
    registerEpubSpineSanitizer(
      {
        spine: {
          hooks: {
            content: {
              register: () => {},
              list: () => [],
            },
          },
        },
      },
      new Map(),
      { onError: recordError },
    ),
  ).toThrow(/failed to register/i);
  expect(reportedErrors).toHaveLength(7);
});

it('aborts EPUB open before chapter serialization when the pre-serialization spine content hook is missing or throws', async () => {
  const tracker = installObjectUrlTracker();
  const outboundRequests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      outboundRequests.push(target);
      throw new Error(`Unexpected outbound fetch: ${target}`);
    }),
  );
  const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(((
    method: string,
    url: string | URL,
  ) => {
    outboundRequests.push(`${method} ${String(url)}`);
    throw new Error(`Unexpected XHR request: ${String(url)}`);
  }) as typeof XMLHttpRequest.prototype.open);

  const serializeSpy = vi.spyOn(XMLSerializer.prototype, 'serializeToString');
  const assignedSrcdocs: string[] = [];
  const nativeCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = nativeCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'iframe') {
      const frame = element as HTMLIFrameElement;
      const srcdocDescriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        'srcdoc',
      );
      if (srcdocDescriptor?.set && srcdocDescriptor.get) {
        Object.defineProperty(frame, 'srcdoc', {
          configurable: true,
          get: () => srcdocDescriptor.get!.call(frame),
          set: (value: string) => {
            assignedSrcdocs.push(value);
            srcdocDescriptor.set!.call(frame, value);
          },
        });
      }
    }
    return element;
  }) as typeof document.createElement);

  const archive = buildHostileEpubArchive();
  const viewport = document.createElement('div');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 360, 640),
  );
  document.body.appendChild(viewport);

  const templateBook = new Book();
  const HookProto = Object.getPrototypeOf(
    (templateBook as unknown as { spine: { hooks: { content: object } } }).spine.hooks.content,
  ) as { register: (...args: unknown[]) => void };
  templateBook.destroy();

  try {
    // Case 1: Spine content hook missing at Book construction time (epub.js omits spine.hooks.content).
    const originalBookOpen = (
      Book.prototype as unknown as { open: (...args: unknown[]) => Promise<unknown> }
    ).open;
    const openSpyMissingHook = vi
      .spyOn(
        Book.prototype as unknown as { open: (...args: unknown[]) => Promise<unknown> },
        'open',
      )
      .mockImplementation(function (
        this: { spine?: { hooks?: { content?: unknown } } },
        ...args: unknown[]
      ) {
        if (this.spine?.hooks) {
          delete this.spine.hooks.content;
        }
        return originalBookOpen.apply(this, args);
      });
    const missingAtConstructSession = new ReaderSession(archive);
    openSpyMissingHook.mockRestore();

    await expect(
      missingAtConstructSession.open(
        viewport,
        null,
        null,
        null,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow(/spine content sanitizer hook/i);
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    missingAtConstructSession.destroy();

    // Case 2: Spine content hook register() throws when ReaderSession installs the pre-serialization sanitizer.
    const originalHookRegister = HookProto.register;
    let hookRegisterCount = 0;
    const registerThrowSpy = vi.spyOn(HookProto, 'register').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      hookRegisterCount += 1;
      // Spine constructor registers replaceBase, replaceCanonical, replaceMeta (calls 1..3).
      if (hookRegisterCount === 4) {
        throw new Error('spine register threw');
      }
      return originalHookRegister.apply(this, args);
    });
    const registerThrowSession = new ReaderSession(archive);
    registerThrowSpy.mockRestore();

    await expect(
      registerThrowSession.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow('spine register threw');
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    registerThrowSession.destroy();

    // Case 3: Spine content hook cleared or deleted after construction before open() renders any chapter.
    const clearedHookSession = new ReaderSession(archive);
    (
      clearedHookSession as unknown as {
        book: { spine: { hooks: { content: { clear: () => void } } } };
      }
    ).book.spine.hooks.content.clear();
    await expect(
      clearedHookSession.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow(/spine content sanitizer hook/i);
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    clearedHookSession.destroy();

    // Case 4: Spine content hook throws synchronously during chapter load (not swallowed by epub.js Hook.trigger).
    const syncThrowSession = new ReaderSession(archive);
    (
      syncThrowSession as unknown as {
        book: { spine: { hooks: { content: { register: (fn: () => void) => void } } } };
      }
    ).book.spine.hooks.content.register(() => {
      throw new Error('spine sync hook threw');
    });
    await expect(
      syncThrowSession.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow('spine sync hook threw');
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    syncThrowSession.destroy();

    // Case 5: Spine content hook rejects asynchronously during chapter load even when initial cfi/XPath/percentage are passed.
    const asyncThrowSession = new ReaderSession(archive);
    (
      asyncThrowSession as unknown as {
        book: {
          spine: { hooks: { content: { register: (fn: () => Promise<void>) => void } } };
        };
      }
    ).book.spine.hooks.content.register(async () => {
      throw new Error('spine async hook threw');
    });
    await expect(
      asyncThrowSession.open(
        viewport,
        'epubcfi(/6/2!/4/2:0)',
        '//body/DocFragment[1]/body/p[1]',
        0.5,
        defaultAppearance,
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow('spine async hook threw');
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    asyncThrowSession.destroy();

    // Case 6: Spine content hook trigger silently resolves without running the sanitizer.
    const noopTriggerSession = new ReaderSession(archive);
    (
      noopTriggerSession as unknown as {
        book: { spine: { hooks: { content: { trigger: () => Promise<void> } } } };
      }
    ).book.spine.hooks.content.trigger = async () => {};
    await expect(
      noopTriggerSession.open(viewport, null, null, null, defaultAppearance, vi.fn(), vi.fn()),
    ).rejects.toThrow(/not sanitized before serialization/i);
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(assignedSrcdocs).toEqual([]);
    expect(outboundRequests).toEqual([]);
    noopTriggerSession.destroy();

    for (const url of tracker.createdUrls) {
      expect(tracker.revokedUrls).toContain(url);
    }
  } finally {
    viewport.remove();
    tracker.restore();
  }
});
