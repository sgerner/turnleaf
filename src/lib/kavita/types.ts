export interface KavitaLibrary {
  id: number;
  name: string | null;
  type: number;
}

export interface KavitaUser {
  id: number;
  username: string;
  token: string;
  kavitaVersion: string;
}

export interface KavitaProgress {
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  pageNum: number;
  bookScrollId?: string | null;
  lastModifiedUtc?: string;
}

export interface ConnectedServer {
  version: string | null;
  bookLibraries: KavitaLibrary[];
}

export interface KavitaSeries {
  id: number;
  name: string;
  libraryId: number;
  format: number;
  pages: number;
  pagesRead: number;
  created: string;
  latestReadDate: string;
  coverImage: string;
}

export interface KavitaPerson {
  name: string;
}

export interface KavitaFile {
  id: number;
  bytes: number;
  extension: string;
  format: number;
}

export interface KavitaChapter {
  id: number;
  title: string;
  titleName: string;
  volumeId: number;
  pages: number;
  pagesRead: number;
  summary: string;
  format: number;
  files: KavitaFile[];
  writers: KavitaPerson[];
  lastReadingProgressUtc: string;
}

export interface KavitaSeriesDetail {
  chapters: KavitaChapter[];
  specials: KavitaChapter[];
  storylineChapters: KavitaChapter[];
}
