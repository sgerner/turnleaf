import type { BookRecord } from '../database/database';
import type { KavitaChapter, KavitaSeries, KavitaSeriesDetail } from './types';

const EMPTY_DATE = '0001-01-01T00:00:00';

export function mapSeriesToBook(
  serverId: string,
  series: KavitaSeries,
  detail: KavitaSeriesDetail,
): BookRecord | null {
  const chapters = [...detail.chapters, ...detail.specials, ...detail.storylineChapters];
  const chapter = chapters.find(isEpubChapter);
  if (!chapter) return null;
  const file = chapter.files.find((item) => item.extension.toLowerCase() === '.epub');
  if (!file) return null;
  return {
    id: `${serverId}:${series.id}:${chapter.id}`,
    serverId,
    libraryId: series.libraryId,
    seriesId: series.id,
    volumeId: chapter.volumeId,
    chapterId: chapter.id,
    title: chapter.titleName || chapter.title || series.name,
    author: chapter.writers.map((writer) => writer.name).join(', ') || null,
    series: chapter.titleName && chapter.titleName !== series.name ? series.name : null,
    descriptionHtml: chapter.summary || null,
    format: 'epub',
    pages: chapter.pages || series.pages,
    pagesRead: chapter.pagesRead || series.pagesRead,
    createdAt: series.created,
    lastReadAt: series.latestReadDate.startsWith(EMPTY_DATE) ? null : series.latestReadDate,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: file.bytes,
  };
}

function isEpubChapter(chapter: KavitaChapter): boolean {
  return (
    chapter.format === 3 && chapter.files.some((file) => file.extension.toLowerCase() === '.epub')
  );
}
