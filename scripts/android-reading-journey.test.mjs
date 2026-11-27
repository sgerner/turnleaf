// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KavitaClient } from '../src/lib/kavita/client';
import { markBookCompleted, saveLocalProgress } from '../src/lib/database/database';
import { flushProgress } from '../src/lib/sync/sync';
import { startFixture } from './android-reading-journey.mjs';

const STORAGE_KEY = 'turnleaf_browser_database_v1';

class MemoryStorage {
  values = new Map();
  clear() {
    this.values.clear();
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  removeItem(key) {
    this.values.delete(key);
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

const book = {
  id: 'server:1:1',
  serverId: 'server',
  libraryId: 1,
  seriesId: 1,
  volumeId: 1,
  chapterId: 1,
  title: 'Turnleaf Journey Fixture',
  author: 'Turnleaf Test',
  series: 'Turnleaf Journey Fixture',
  descriptionHtml: null,
  format: 'epub',
  pages: 2,
  pagesRead: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReadAt: null,
  downloadPath: null,
  downloadStatus: 'none',
  fileSize: null,
};

describe('Kavita ProgressDto journey fixture contract', () => {
  let fixture;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      localStorage: storage,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        serverConfig: { id: 'server' },
        books: [{ ...book }],
        readingState: {},
        syncQueue: {},
        preferences: {},
      }),
    );
    fixture = await startFixture();
  });

  afterEach(() => {
    fixture?.close();
    vi.unstubAllGlobals();
  });

  it.each([
    { pageNum: 0, bookScrollId: '//body/DocFragment[1]/body/p[1]' },
    { pageNum: 0, bookScrollId: 'epubcfi(/6/2!/4/2)' },
    { pageNum: 3, bookScrollId: null },
  ])('rejects invalid progress payload %o with HTTP 400', async (override) => {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/Reader/progress`, {
      method: 'POST',
      headers: { 'x-api-key': 'turnleaf-ci-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        libraryId: 1,
        seriesId: 1,
        volumeId: 1,
        chapterId: 1,
        ...override,
      }),
    });
    expect(response.status).toBe(400);
  });

  it('enforces Kavita page-zero unstarted guard while flushProgress bootstraps and completes', async () => {
    const client = new KavitaClient(`http://127.0.0.1:${fixture.port}`, 'turnleaf-ci-only');
    await client.saveProgress({
      libraryId: 1,
      seriesId: 1,
      volumeId: 1,
      chapterId: 1,
      pageNum: 0,
      bookScrollId: '//body/p[2]',
    });
    expect(await client.getProgress(1)).toMatchObject({ pageNum: 0, bookScrollId: null });

    await saveLocalProgress(book, 'epubcfi(/6/2!/4/4)', '//body/p[2]', 0.25, 0);
    await flushProgress(client, 'server');
    expect(await client.getProgress(1)).toMatchObject({ pageNum: 0, bookScrollId: '//body/p[2]' });

    await markBookCompleted(book);
    await flushProgress(client, 'server');
    expect(await client.getProgress(1)).toMatchObject({ pageNum: 2, bookScrollId: null });
  });
});

describe('Android reading journey fixture', () => {
  const fixtures = [];

  afterEach(() => {
    while (fixtures.length > 0) {
      fixtures.pop()?.close();
    }
  });

  it('serves series covers as PNG with zero 404 responses and enforces the API key', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);

    const unauthorized = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
    );
    expect(unauthorized.status).toBe(401);

    const response = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(fixture.covers).toBe(1);
    expect(fixture.notFoundPaths).toEqual([]);
  });

  it('tracks cross-origin redirect isolation for cover and EPUB endpoints', async () => {
    const fixture = await startFixture({ crossOriginRedirects: true });
    fixtures.push(fixture);

    const coverRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Image/series-cover?seriesId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(coverRedirect.status).toBe(302);
    expect(coverRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Image/series-cover?seriesId=1`,
    );

    const downloadRedirect = await fetch(
      `http://127.0.0.1:${fixture.port}/api/Download/chapter?chapterId=1`,
      {
        headers: { 'x-api-key': 'turnleaf-ci-only' },
        redirect: 'manual',
      },
    );
    expect(downloadRedirect.status).toBe(302);
    expect(downloadRedirect.headers.get('location')).toBe(
      `http://127.0.0.1:${fixture.foreignPort}/api/Download/chapter?chapterId=1`,
    );
    expect(fixture.coverRedirects).toBe(1);
    expect(fixture.downloadRedirects).toBe(1);
    expect(fixture.foreignRequests).toEqual([]);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe`);
    expect(fixture.foreignRequests).toEqual(['/probe']);
    expect(fixture.foreignAuthHeaders).toBe(0);

    await fetch(`http://127.0.0.1:${fixture.foreignPort}/probe-auth`, {
      headers: { 'x-api-key': 'turnleaf-ci-only' },
    });
    expect(fixture.foreignRequests).toEqual(['/probe', '/probe-auth']);
    expect(fixture.foreignAuthHeaders).toBe(1);
  });
});
