import { describe, expect, it } from 'vitest';
import {
  KavitaPayloadError,
  normalizeLibraries,
  normalizeSeriesDetail,
  normalizeSeriesPage,
} from './normalization';

it.each([null, undefined])(
  'marks a volume with unavailable chapters as incomplete (%s)',
  (chapters) => {
    const normalized = normalizeSeriesDetail({ volumes: [{ id: 7, chapters }] });
    expect(normalized).toMatchObject({ incomplete: true, volumes: [] });
  },
);
import { mapSeriesToBooks } from './mapper';

function series(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    libraryId: 2,
    format: 3,
    pages: 120,
    pagesRead: 15,
    name: 'A Series',
    created: '2024-01-02T00:00:00Z',
    latestReadDate: '2024-03-04T00:00:00Z',
    coverImage: 'cover.jpg',
    ...overrides,
  };
}

function chapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 20,
    volumeId: 10,
    format: 3,
    pages: 80,
    pagesRead: 25,
    title: 'Book One',
    titleName: 'Book One',
    summary: 'Summary',
    files: [{ id: 30, format: 3, bytes: 2048, extension: '.epub' }],
    writers: [{ name: 'Author' }],
    lastReadingProgressUtc: '2024-03-04T00:00:00Z',
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapters: [],
    specials: [],
    volumes: [],
    storylineChapters: [],
    ...overrides,
  };
}

function expectPayloadError(
  callback: () => unknown,
  path: string,
  actualType: string,
  secretValue?: string,
): KavitaPayloadError {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(KavitaPayloadError);
  const error = thrown as KavitaPayloadError;
  expect(error.path).toBe(path);
  expect(error.actualType).toBe(actualType);
  expect(error.expected).toBeTruthy();
  if (secretValue) expect(error.message).not.toContain(secretValue);
  return error;
}

describe('normalizeSeriesPage', () => {
  it('normalizes an EPUB series page and accepts harmless unknown fields', () => {
    const [normalized] = normalizeSeriesPage([
      series({
        unexpectedKavitaMetadata: { nested: true },
        id: '9007199254740991',
        libraryId: '2',
        pages: '120',
        pagesRead: '15',
      }),
    ]);

    expect(normalized).toMatchObject({
      id: Number.MAX_SAFE_INTEGER,
      libraryId: 2,
      format: 3,
      pages: 120,
      pagesRead: 15,
      name: 'A Series',
    });
  });

  it('filters known non-EPUB formats before validating their other fields', () => {
    const normalized = normalizeSeriesPage([
      { id: 'malformed-image', format: 0, files: 'not used' },
      { id: 'malformed-archive', format: 1, libraryId: null },
      { id: 'malformed-pdf', format: 4, libraryId: null },
      series({ id: '3', format: 3 }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.id).toBe(3);
  });

  it('keeps unknown formats as candidates and defaults missing or malformed format to -1', () => {
    const normalized = normalizeSeriesPage([
      series({ id: 11, format: undefined }),
      series({ id: 12, format: 2 }),
      series({ id: 13, format: 'future-format' }),
      series({ id: 14, format: 88 }),
    ]);

    expect(normalized.map(({ id, format }) => [id, format])).toEqual([
      [11, -1],
      [12, -1],
      [13, -1],
      [14, -1],
    ]);
  });

  it('leaves missing pagesRead undefined while defaulting absent page totals to zero', () => {
    const [normalized] = normalizeSeriesPage([series({ pages: undefined, pagesRead: undefined })]);

    expect(normalized!.pages).toBe(0);
    expect(normalized!.pagesRead).toBeUndefined();
  });

  it('defaults null or wrong-type optional display metadata without leaking its value', () => {
    const secret = 'PRIVATE-INVALID-TITLE-4821';
    const [normalized] = normalizeSeriesPage([
      series({
        name: { private: secret },
        created: { internal: secret },
        latestReadDate: false,
        coverImage: 17,
      }),
    ]);

    expect(normalized!.name).toBeNull();
    expect(normalized!.created).toBe('');
    expect(normalized!.latestReadDate).toBe('');
    expect(normalized!.coverImage).toBeNull();
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it('reports the exact missing series ID path and expected shape', () => {
    expectPayloadError(
      () => normalizeSeriesPage([series({ id: undefined })]),
      '$[0].id',
      'missing',
    );
  });

  it('rejects unsafe numeric strings for required IDs without exposing their value', () => {
    const secret = '9007199254740992';
    const error = expectPayloadError(
      () => normalizeSeriesPage([series({ id: secret })]),
      '$[0].id',
      'string',
      secret,
    );
    expect(error.expected).toBeTruthy();
  });

  it('rejects negative and fractional required IDs', () => {
    expectPayloadError(
      () => normalizeSeriesPage([series({ libraryId: -1 })]),
      '$[0].libraryId',
      'number',
    );
    expectPayloadError(() => normalizeSeriesPage([series({ id: 1.5 })]), '$[0].id', 'number');
  });
});

describe('normalizeLibraries', () => {
  it('accepts numeric strings for IDs and counters and ignores unknown fields', () => {
    expect(
      normalizeLibraries([{ id: '4', type: '2', name: 'Books', unrelated: 'future Kavita field' }]),
    ).toEqual([{ id: 4, type: 2, name: 'Books' }]);
  });

  it('defaults absent or wrong-type library names to null', () => {
    expect(
      normalizeLibraries([
        { id: 1, type: 2 },
        { id: 2, type: 4, name: { private: 'do not serialize' } },
        { id: 3, type: 2, name: null },
      ]).map(({ name }) => name),
    ).toEqual([null, null, null]);
  });

  it('reports invalid library IDs with a path and type, without including raw data', () => {
    const secret = 'bad-library-id-do-not-leak';
    expectPayloadError(
      () => normalizeLibraries([{ id: secret, type: 2 }]),
      '$[0].id',
      'string',
      secret,
    );
  });
});

describe('normalizeSeriesDetail', () => {
  it('normalizes a complete empty detail payload', () => {
    expect(normalizeSeriesDetail(detail())).toEqual({
      chapters: [],
      specials: [],
      volumes: [],
      storylineChapters: [],
    });
  });

  it('marks explicit null collections incomplete while filling them with empty arrays', () => {
    expect(normalizeSeriesDetail({ chapters: [], specials: null })).toEqual({
      chapters: [],
      specials: [],
      volumes: [],
      storylineChapters: [],
      incomplete: true,
    });
  });

  it('fills omitted auxiliary collections without marking them incomplete', () => {
    expect(normalizeSeriesDetail({ volumes: [] })).toEqual({
      chapters: [],
      specials: [],
      volumes: [],
      storylineChapters: [],
    });
  });

  it('rejects detail payloads where every present collection is null or missing', () => {
    expectPayloadError(
      () => normalizeSeriesDetail({ chapters: null, specials: undefined }),
      '$',
      'object',
    );
  });

  it('rejects a detail object with no collection keys', () => {
    expectPayloadError(() => normalizeSeriesDetail({ unrelated: [] }), '$', 'object');
  });

  it('rejects a malformed collection instead of silently replacing it', () => {
    expectPayloadError(
      () => normalizeSeriesDetail({ chapters: { unexpected: true }, specials: [] }),
      '$.chapters',
      'object',
    );
  });

  it('skips known non-EPUB chapters before validating their metadata or files', () => {
    const normalized = normalizeSeriesDetail(
      detail({ chapters: [{ format: 1, id: 'bad', files: 'malformed' }] }),
    );

    expect(normalized.chapters).toEqual([]);
    expect(normalized.incomplete).toBe(true);
  });

  it('keeps available EPUBs and marks the detail incomplete when a known non-EPUB row has malformed files', () => {
    const normalized = normalizeSeriesDetail(
      detail({
        chapters: [
          { format: 0, id: 'malformed-image', files: 'not an array' },
          chapter({ id: 22 }),
        ],
      }),
    );

    expect(normalized.chapters.map(({ id }) => id)).toEqual([22]);
    expect(normalized.incomplete).toBe(true);
  });

  it('keeps EPUBs from available volumes when another collection is null and marks detail incomplete', () => {
    const normalized = normalizeSeriesDetail({
      chapters: null,
      volumes: [{ id: '10', chapters: [chapter()] }],
    });

    expect(normalized.volumes).toHaveLength(1);
    expect(normalized.volumes![0]!.chapters.map(({ id }) => id)).toEqual([20]);
    expect(
      mapSeriesToBooks(
        'server',
        {
          id: 10,
          libraryId: 2,
          format: 3,
          pages: 120,
          pagesRead: 0,
          name: 'A Series',
          created: '2024-01-02T00:00:00Z',
          latestReadDate: '2024-03-04T00:00:00Z',
        },
        normalized,
      ).map(({ chapterId }) => chapterId),
    ).toEqual([20]);
    expect(normalized.incomplete).toBe(true);
  });

  it('uses a nested parent volume ID when an EPUB chapter omits volumeId', () => {
    const normalized = normalizeSeriesDetail(
      detail({ volumes: [{ id: '10', chapters: [chapter({ volumeId: undefined })] }] }),
    );

    expect(normalized.volumes![0]!.id).toBe(10);
    expect(normalized.volumes![0]!.chapters[0]!.volumeId).toBe(10);
  });

  it('recognizes EPUB from file format or extension even when chapter format differs', () => {
    const byFileFormat = chapter({
      id: '21',
      format: 1,
      files: [{ id: '31', format: '3', bytes: 2048, extension: '.cbz' }],
    });
    const byExtension = chapter({
      id: '22',
      format: 2,
      files: [{ id: '32', format: 88, bytes: 2048, extension: '.EPUB' }],
    });
    const normalized = normalizeSeriesDetail(detail({ chapters: [byFileFormat, byExtension] }));

    expect(normalized.chapters.map(({ id }) => id)).toEqual([21, 22]);
  });

  it('uses file format 3 when a valid EPUB omits chapter format', () => {
    const normalized = normalizeSeriesDetail(
      detail({ chapters: [chapter({ format: undefined })] }),
    );

    expect(normalized.chapters[0]!.format).toBe(3);
  });

  it('rejects an EPUB candidate whose file format and extension are both unrecognized', () => {
    expectPayloadError(
      () =>
        normalizeSeriesDetail(
          detail({
            chapters: [
              chapter({
                format: 88,
                files: [{ id: 30, format: 88, bytes: 2048, extension: null }],
              }),
            ],
          }),
        ),
      '$.chapters[0].files[0].format',
      'number',
    );
  });

  it('validates IDs and files for detected EPUB chapters at their precise paths', () => {
    expectPayloadError(
      () => normalizeSeriesDetail(detail({ chapters: [chapter({ id: undefined })] })),
      '$.chapters[0].id',
      'missing',
    );
    expectPayloadError(
      () => normalizeSeriesDetail(detail({ chapters: [chapter({ volumeId: undefined })] })),
      '$.chapters[0].volumeId',
      'missing',
    );
    expectPayloadError(
      () => normalizeSeriesDetail(detail({ chapters: [chapter({ files: undefined })] })),
      '$.chapters[0].files',
      'missing',
    );
    expectPayloadError(
      () =>
        normalizeSeriesDetail(
          detail({ chapters: [chapter({ files: [{ format: 3, extension: '.epub' }] })] }),
        ),
      '$.chapters[0].files[0].id',
      'missing',
    );
  });

  it('defaults null or missing pages and bytes to zero and leaves missing pagesRead undefined', () => {
    const normalized = normalizeSeriesDetail(
      detail({
        chapters: [
          chapter({
            pages: null,
            pagesRead: undefined,
            files: [{ id: 30, format: 3, bytes: null, extension: '.epub' }],
          }),
          chapter({
            id: 21,
            volumeId: 10,
            pages: undefined,
            files: [{ id: 31, format: '3', bytes: undefined, extension: '.epub' }],
          }),
        ],
      }),
    );

    expect(normalized.chapters[0]!.pages).toBe(0);
    expect(normalized.chapters[0]!.pagesRead).toBeUndefined();
    expect(normalized.chapters[0]!.files[0]!.bytes).toBe(0);
    expect(normalized.chapters[1]!.pages).toBe(0);
    expect(normalized.chapters[1]!.files[0]).toMatchObject({ format: 3, bytes: 0 });
  });

  it('defaults malformed optional text metadata and cover-like values', () => {
    const normalized = normalizeSeriesDetail(
      detail({
        chapters: [
          chapter({
            title: 17,
            titleName: null,
            summary: { internal: 'private summary' },
            lastReadingProgressUtc: false,
            files: [{ id: 30, format: 3, bytes: 1, extension: 99 }],
          }),
        ],
      }),
    );

    expect(normalized.chapters[0]).toMatchObject({
      title: '',
      titleName: '',
      summary: '',
      lastReadingProgressUtc: null,
    });
    expect(normalized.chapters[0]!.files[0]!.extension).toBeNull();
    expect(JSON.stringify(normalized)).not.toContain('private summary');
  });

  it('ignores malformed writer entries while preserving usable names', () => {
    const normalized = normalizeSeriesDetail(
      detail({
        chapters: [
          chapter({
            writers: [null, 'bad writer', { name: 88 }, { name: 'Useful Author' }, {}],
          }),
        ],
      }),
    );

    expect(normalized.chapters[0]!.writers).toEqual([{ name: 'Useful Author' }]);
  });

  it('reports malformed nested chapter IDs without leaking the raw value', () => {
    const secret = 'bad-chapter-id-do-not-leak';
    expectPayloadError(
      () => normalizeSeriesDetail(detail({ chapters: [chapter({ id: secret })] })),
      '$.chapters[0].id',
      'string',
      secret,
    );
  });
});
