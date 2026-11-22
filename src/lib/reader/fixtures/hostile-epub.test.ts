// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import fixture from './hostile-epub.xhtml?raw';
import { sanitizeEpubDocument } from '../session';

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
  expect(document.querySelector('#remote')?.getAttribute('role')).toBe('link');
  expect(document.querySelector('#remote')?.getAttribute('tabindex')).toBe('0');
  expect(document.querySelector('#remote')?.getAttribute('data-turnleaf-external-href')).toBe(
    'https://attacker.example/leave',
  );
  for (const unsafeId of ['#encoded', '#scheme-relative', '#file', '#malformed']) {
    expect(document.querySelector(unsafeId)?.getAttribute('role')).toBeNull();
    expect(document.querySelector(unsafeId)?.getAttribute('tabindex')).toBeNull();
    expect(
      document.querySelector(unsafeId)?.getAttribute('data-turnleaf-external-href'),
    ).toBeNull();
  }
  expect(document.querySelector('#local-image')?.getAttribute('role')).toBe('button');
  expect(document.querySelector('#local-image')?.getAttribute('tabindex')).toBe('0');
  expect(document.querySelector('#remote-image')?.getAttribute('role')).toBeNull();
  expect(document.querySelector('svg')?.getAttribute('role')).toBeNull();
});

it('preserves focusable link semantics for https and mailto anchors with zero network requests', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const document = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </head>
      <body>
        <a id="web" href="https://example.org/reference?p=1" tabindex="-1">Reference</a>
        <a id="mail" href="mailto:author@example.org?subject=Errata">Email author</a>
        <a id="spoof" href="javascript:alert(1)" role="link" tabindex="0" data-turnleaf-external-href="https://evil.example">Spoof</a>
        <a id="bare" role="link" tabindex="0">Plain text anchor</a>
      </body>
    </html>`,
    'application/xhtml+xml',
  );
  const spoofBefore = document.querySelector('#spoof') as HTMLElement;
  spoofBefore.onclick = () => {};

  await sanitizeEpubDocument(document);

  expect(fetchSpy).not.toHaveBeenCalled();
  const web = document.querySelector('#web');
  expect(web?.getAttribute('href')).toBeNull();
  expect(web?.getAttribute('role')).toBe('link');
  expect(web?.getAttribute('tabindex')).toBe('0');
  expect(web?.getAttribute('data-turnleaf-external-href')).toBe(
    'https://example.org/reference?p=1',
  );

  const mail = document.querySelector('#mail');
  expect(mail?.getAttribute('href')).toBeNull();
  expect(mail?.getAttribute('role')).toBe('link');
  expect(mail?.getAttribute('tabindex')).toBe('0');
  expect(mail?.getAttribute('data-turnleaf-external-href')).toBe(
    'mailto:author@example.org?subject=Errata',
  );

  const spoof = document.querySelector('#spoof') as HTMLElement | null;
  expect(spoof?.getAttribute('href')).toBeNull();
  expect(spoof?.getAttribute('role')).toBeNull();
  expect(spoof?.getAttribute('tabindex')).toBeNull();
  expect(spoof?.getAttribute('data-turnleaf-external-href')).toBeNull();
  expect(spoof?.onclick).toBeNull();

  const bare = document.querySelector('#bare');
  expect(bare?.getAttribute('role')).toBeNull();
  expect(bare?.getAttribute('tabindex')).toBeNull();

  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  expect(viewport).toContain('user-scalable=yes');
  expect(viewport).not.toContain('maximum-scale');
  expect(viewport).not.toContain('user-scalable=no');
  vi.unstubAllGlobals();
});

it('sanitizes a local stylesheet before restoring its safe rules', async () => {
  const chapter = () =>
    new DOMParser().parseFromString(
      '<html><head><base href="http://localhost/_capacitor_file/books/book.epub/OEBPS/" /><link rel="stylesheet" href="styles/book.css" /><link rel="stylesheet" href="styles/book.css" /></head><body /></html>',
      'application/xhtml+xml',
    );
  const document = chapter();
  const anotherChapter = chapter();
  const stylesheetCache = new Map();
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
  vi.unstubAllGlobals();
});
