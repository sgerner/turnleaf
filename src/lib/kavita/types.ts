export interface KavitaLibrary {
  id: number;
  name?: string | null;
  type: number;
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
  name?: string | null;
  libraryId: number;
  format: number;
  pages: number;
  pagesRead?: number;
  created: string;
  latestReadDate: string;
  coverImage?: string | null;
}

export interface KavitaPerson {
  name: string;
}

export interface KavitaFile {
  id: number;
  bytes: number;
  extension?: string | null;
  format: number;
}

export interface KavitaChapter {
  id: number;
  title: string;
  titleName: string;
  volumeId: number;
  pages: number;
  pagesRead?: number;
  summary: string;
  format?: number | null;
  files: KavitaFile[];
  writers: KavitaPerson[];
  lastReadingProgressUtc?: string | null;
}

export interface KavitaVolume {
  id: number;
  chapters: KavitaChapter[];
}

export interface KavitaSeriesDetail {
  /** A partial response can update known books but must not remove missing local entries. */
  incomplete?: boolean;
  chapters: KavitaChapter[];
  specials: KavitaChapter[];
  volumes?: KavitaVolume[];
  storylineChapters: KavitaChapter[];
}

export interface KavitaAnnotation {
  id: number;
  chapterId: number;
  volumeId: number;
  seriesId: number;
  libraryId: number;
  ownerUserId: number;
  xPath: string;
  endingXPath: string | null;
  selectedText: string;
  comment: string;
  commentHtml: string;
  commentPlainText: string;
  chapterTitle: string | null;
  context: string | null;
  highlightCount: number;
  containsSpoiler: boolean;
  pageNumber: number;
  selectedSlotIndex: number;
  createdUtc: string;
  lastModifiedUtc: string;
}

export interface KavitaAnnotationWrite {
  id?: number;
  chapterId: number;
  volumeId: number;
  seriesId: number;
  libraryId: number;
  ownerUserId?: number;
  xPath: string;
  endingXPath?: string | null;
  selectedText: string;
  comment?: string;
  commentHtml?: string;
  chapterTitle?: string | null | undefined;
  context?: string | null | undefined;
  highlightCount?: number;
  containsSpoiler?: boolean;
  pageNumber: number;
  selectedSlotIndex?: number;
  createdUtc?: string;
  lastModifiedUtc?: string;
}

export interface KavitaPersonalTocItem {
  id: number;
  chapterId: number;
  pageNumber: number;
  title: string;
  bookScrollId: string | null;
  selectedText: string | null;
  chapterTitle: string | null;
}

export interface KavitaCreatePersonalTocRequest {
  libraryId: number;
  seriesId: number;
  volumeId: number;
  chapterId: number;
  pageNumber: number;
  title: string;
  bookScrollId?: string | null;
  selectedText?: string | null;
}
