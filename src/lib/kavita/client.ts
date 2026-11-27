import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';
import { Network } from '@capacitor/network';
import type {
  ConnectedServer,
  KavitaAnnotation,
  KavitaAnnotationWrite,
  KavitaCreatePersonalTocRequest,
  KavitaPersonalTocItem,
  KavitaProgress,
  KavitaSeries,
  KavitaSeriesDetail,
} from './types';
import { isKavitaProgress, readHealthVersion } from './validation';
import {
  formatAnnotationCommentFields,
  KavitaPayloadError,
  normalizeAnnotation,
  normalizeAnnotations,
  normalizeLibraries,
  normalizePersonalToc,
  normalizeSeriesPage,
  normalizeSeriesDetail,
} from './normalization';
import { recordDiagnostic } from '../diagnostics/log';
import { advanceRedirect, createRedirectState, KavitaError, nativeHeader } from './redirects';

export { KavitaError };

const REQUEST_TIMEOUT_MS = 12_000;
const BOOK_LIBRARY_TYPE = 2;
const LIGHT_NOVEL_LIBRARY_TYPE = 4;
const BROWSER_PROXY_PREFIX = '/__kavita__/';
const SERIES_PAGE_SIZE = 500;
const MAX_SERIES_RESULTS = 100_000;
const MAX_SERIES_PAGES = MAX_SERIES_RESULTS / SERIES_PAGE_SIZE + 1;

function normalizePayload<T>(endpoint: string, read: () => T, context = ''): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof KavitaPayloadError)) throw error;
    recordDiagnostic({
      category: 'validation',
      endpoint,
      path: context ? `${context}${error.path.slice(1)}` : error.path,
      expected: error.expected,
      actualType: error.actualType,
      detail: 'invalid-field',
    });
    throw new KavitaError(
      `Kavita response at ${endpoint}${context ? ` (${context})` : ''} could not be read: ${error.message}`,
      'invalid-response',
    );
  }
}

export class KavitaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly canRequest?: () => boolean | Promise<boolean>,
  ) {}

  async testConnection(signal?: AbortSignal): Promise<ConnectedServer> {
    const options = signal ? { signal } : {};
    const [libraries, health] = await Promise.all([
      this.request<unknown>('/api/Library/libraries', options).then((payload) =>
        normalizePayload('/api/Library/libraries', () => normalizeLibraries(payload)),
      ),
      this.request<unknown>('/api/Health', options).catch(() => null),
    ]);
    return {
      version: readHealthVersion(health),
      bookLibraries: libraries.filter(
        (library) =>
          library.type === BOOK_LIBRARY_TYPE || library.type === LIGHT_NOVEL_LIBRARY_TYPE,
      ),
    };
  }

  async getBookSeries(signal?: AbortSignal): Promise<KavitaSeries[]> {
    const series: KavitaSeries[] = [];
    const seenSeriesIds = new Set<number>();
    for (let pageNumber = 1; pageNumber <= MAX_SERIES_PAGES; pageNumber += 1) {
      const options: RequestInit = {
        method: 'POST',
        body: JSON.stringify({
          statements: [{ field: 21, comparison: 5, value: '3' }],
          combination: 0,
          sortOptions: { sortField: 1, isAscending: true },
          limitTo: 0,
        }),
      };
      if (signal) options.signal = signal;
      const payload = await this.request<unknown>(
        `/api/Series/v2?PageNumber=${pageNumber}&PageSize=${SERIES_PAGE_SIZE}`,
        options,
      );
      const page = normalizePayload('/api/Series/v2', () => normalizeSeriesPage(payload));
      const rawPageLength = (payload as unknown[]).length;
      if (rawPageLength > SERIES_PAGE_SIZE)
        throw new KavitaError('Kavita returned an oversized series page.', 'invalid-response');
      const pageIds = new Set<number>();
      page.forEach((item) => {
        if (pageIds.has(item.id) || seenSeriesIds.has(item.id)) {
          throw new KavitaError('Kavita returned a repeated series page.', 'invalid-response');
        }
        pageIds.add(item.id);
        seenSeriesIds.add(item.id);
      });
      series.push(...page);
      if (series.length > MAX_SERIES_RESULTS) {
        throw new KavitaError('Kavita returned too many series.', 'invalid-response');
      }
      if (rawPageLength < SERIES_PAGE_SIZE) return series;
    }
    throw new KavitaError('Kavita returned too many series pages.', 'invalid-response');
  }

  async getSeriesDetail(seriesId: number, signal?: AbortSignal): Promise<KavitaSeriesDetail> {
    const detail = await this.request<unknown>(
      `/api/Series/series-detail?seriesId=${seriesId}`,
      signal ? { signal } : {},
    );
    return normalizePayload(
      '/api/Series/series-detail',
      () => normalizeSeriesDetail(detail),
      `series[${seriesId}]`,
    );
  }

  downloadUrl(chapterId: number): string {
    return this.resolveUrl(`/api/Download/chapter?chapterId=${chapterId}`);
  }

  coverUrl(seriesId: number): string {
    return this.resolveUrl(`/api/Image/series-cover?seriesId=${seriesId}`);
  }

  async getCover(seriesId: number, signal?: AbortSignal): Promise<Blob> {
    if (Capacitor.isNativePlatform()) {
      throw new Error('Covers on native platforms must use cacheCover.');
    }
    const url = this.coverUrl(seriesId);
    return this.withBrowserTimeout(signal, async (combined) => {
      const response = await this.browserFetchWithRedirects(url, {
        signal: combined,
        headers: { 'x-api-key': this.apiKey },
      });
      this.assertStatus(response.status);
      return await response.blob();
    });
  }

  async getProgress(chapterId: number, signal?: AbortSignal): Promise<KavitaProgress> {
    const path = `/api/Reader/get-progress?chapterId=${chapterId}`;
    const options = signal ? { signal } : {};
    try {
      const progress = await this.request<unknown>(path, options);
      if (!isKavitaProgress(progress)) {
        throw new KavitaError(
          'Kavita returned an invalid reading progress response.',
          'invalid-response',
        );
      }
      return progress;
    } catch (error) {
      const retryable =
        error instanceof KavitaError &&
        (error.kind === 'network' ||
          (error.kind === 'server' &&
            error.status !== undefined &&
            error.status >= 500 &&
            error.status < 600));
      if (signal?.aborted || !retryable) throw error;
      if (this.canRequest && !(await this.canRequest())) throw error;
      const progress = await this.request<unknown>(path, options);
      if (!isKavitaProgress(progress)) {
        throw new KavitaError(
          'Kavita returned an invalid reading progress response.',
          'invalid-response',
        );
      }
      return progress;
    }
  }

  saveProgress(progress: KavitaProgress, signal?: AbortSignal): Promise<void> {
    const options: RequestInit = {
      method: 'POST',
      body: JSON.stringify(progress),
    };
    if (signal) options.signal = signal;
    return this.request('/api/Reader/progress', options, false);
  }

  async getAnnotations(chapterId: number, signal?: AbortSignal): Promise<KavitaAnnotation[]> {
    const endpoint = '/api/Annotation/all';
    const payload = await this.request<unknown>(
      `${endpoint}?chapterId=${chapterId}`,
      signal ? { signal } : {},
    );
    return normalizePayload(endpoint, () => normalizeAnnotations(payload, endpoint));
  }

  async getSeriesAnnotations(seriesId: number, signal?: AbortSignal): Promise<KavitaAnnotation[]> {
    const endpoint = '/api/Annotation/all-for-series';
    const payload = await this.request<unknown>(
      `${endpoint}?seriesId=${seriesId}`,
      signal ? { signal } : {},
    );
    return normalizePayload(endpoint, () => normalizeAnnotations(payload, endpoint));
  }

  async createAnnotation(
    annotation: KavitaAnnotationWrite & { note?: string },
    signal?: AbortSignal,
  ): Promise<KavitaAnnotation> {
    const endpoint = '/api/Annotation/create';
    const selectedText = annotation.selectedText.trim();
    const commentFields =
      annotation.comment !== undefined || annotation.commentHtml !== undefined
        ? {
            comment: annotation.comment ?? '',
            commentHtml: annotation.commentHtml ?? '',
          }
        : formatAnnotationCommentFields(annotation.note ?? '');
    const now = new Date().toISOString();
    const body = {
      id: annotation.id ?? 0,
      chapterId: annotation.chapterId,
      volumeId: annotation.volumeId,
      seriesId: annotation.seriesId,
      libraryId: annotation.libraryId,
      ownerUserId: annotation.ownerUserId ?? 0,
      xPath: annotation.xPath,
      endingXPath: annotation.endingXPath ?? annotation.xPath,
      selectedText,
      comment: commentFields.comment,
      commentHtml: commentFields.commentHtml,
      chapterTitle: annotation.chapterTitle ?? null,
      context: annotation.context ?? selectedText,
      highlightCount: Math.max(1, annotation.highlightCount ?? selectedText.length),
      containsSpoiler: annotation.containsSpoiler ?? false,
      pageNumber: Math.max(0, annotation.pageNumber),
      selectedSlotIndex: annotation.selectedSlotIndex ?? 0,
      createdUtc: annotation.createdUtc ?? now,
      lastModifiedUtc: annotation.lastModifiedUtc ?? now,
    };
    const options: RequestInit = {
      method: 'POST',
      body: JSON.stringify(body),
    };
    if (signal) options.signal = signal;
    const payload = await this.request<unknown>(endpoint, options);
    return normalizePayload(endpoint, () => normalizeAnnotation(payload, endpoint));
  }

  async updateAnnotation(
    annotation: KavitaAnnotationWrite & { id: number; note?: string },
    signal?: AbortSignal,
  ): Promise<KavitaAnnotation> {
    const endpoint = '/api/Annotation/update';
    const selectedText = annotation.selectedText.trim();
    const commentFields =
      annotation.comment !== undefined || annotation.commentHtml !== undefined
        ? {
            comment: annotation.comment ?? '',
            commentHtml: annotation.commentHtml ?? '',
          }
        : formatAnnotationCommentFields(annotation.note ?? '');
    const now = new Date().toISOString();
    const body = {
      id: annotation.id,
      chapterId: annotation.chapterId,
      volumeId: annotation.volumeId,
      seriesId: annotation.seriesId,
      libraryId: annotation.libraryId,
      ownerUserId: annotation.ownerUserId ?? 0,
      xPath: annotation.xPath,
      endingXPath: annotation.endingXPath ?? annotation.xPath,
      selectedText,
      comment: commentFields.comment,
      commentHtml: commentFields.commentHtml,
      chapterTitle: annotation.chapterTitle ?? null,
      context: annotation.context ?? selectedText,
      highlightCount: Math.max(1, annotation.highlightCount ?? selectedText.length),
      containsSpoiler: annotation.containsSpoiler ?? false,
      pageNumber: Math.max(0, annotation.pageNumber),
      selectedSlotIndex: annotation.selectedSlotIndex ?? 0,
      createdUtc: annotation.createdUtc ?? now,
      lastModifiedUtc: annotation.lastModifiedUtc ?? now,
    };
    const options: RequestInit = {
      method: 'POST',
      body: JSON.stringify(body),
    };
    if (signal) options.signal = signal;
    const payload = await this.request<unknown>(endpoint, options);
    return normalizePayload(endpoint, () => normalizeAnnotation(payload, endpoint));
  }

  deleteAnnotation(annotationId: number, signal?: AbortSignal): Promise<void> {
    const options: RequestInit = { method: 'DELETE' };
    if (signal) options.signal = signal;
    return this.request(`/api/Annotation?annotationId=${annotationId}`, options, false);
  }

  async getPersonalToc(chapterId: number, signal?: AbortSignal): Promise<KavitaPersonalTocItem[]> {
    const endpoint = '/api/Reader/ptoc';
    const payload = await this.request<unknown>(
      `${endpoint}?chapterId=${chapterId}`,
      signal ? { signal } : {},
    );
    return normalizePayload(endpoint, () => normalizePersonalToc(payload, endpoint));
  }

  createPersonalToc(entry: KavitaCreatePersonalTocRequest, signal?: AbortSignal): Promise<void> {
    const options: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        libraryId: entry.libraryId,
        seriesId: entry.seriesId,
        volumeId: entry.volumeId,
        chapterId: entry.chapterId,
        pageNumber: Math.max(0, entry.pageNumber),
        title: entry.title.trim(),
        bookScrollId: entry.bookScrollId ?? null,
        selectedText: entry.selectedText ?? '',
      }),
    };
    if (signal) options.signal = signal;
    return this.request('/api/Reader/create-ptoc', options, false);
  }

  deletePersonalToc(
    chapterId: number,
    pageNum: number,
    title: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const options: RequestInit = { method: 'DELETE' };
    if (signal) options.signal = signal;
    return this.request(
      `/api/Reader/ptoc?chapterId=${chapterId}&pageNum=${Math.max(0, pageNum)}&title=${encodeURIComponent(title.trim())}`,
      options,
      false,
    );
  }

  private assertNotAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  private assertCanRequest(signal?: AbortSignal | null): void | Promise<void> {
    this.assertNotAborted(signal);
    if (!this.canRequest) return;
    const allowed = this.canRequest();
    if (typeof allowed === 'boolean') {
      if (!allowed) {
        this.assertNotAborted(signal);
        throw new KavitaError(
          'Kavita could not be reached. Check the address and network.',
          'network',
        );
      }
      return;
    }
    return allowed.then((ok) => {
      if (!ok) {
        this.assertNotAborted(signal);
        throw new KavitaError(
          'Kavita could not be reached. Check the address and network.',
          'network',
        );
      }
      this.assertNotAborted(signal);
    });
  }

  private async request<T>(path: string, init: RequestInit = {}, expectJson = true): Promise<T> {
    if (Capacitor.isNativePlatform()) return this.nativeRequest<T>(path, init, expectJson);
    return this.withBrowserTimeout(init.signal, async (signal, timeoutSignal) => {
      try {
        const response = await this.browserFetchWithRedirects(this.resolveUrl(path), {
          ...init,
          signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            ...init.headers,
          },
        });

        this.assertStatus(response.status, path);
        if (
          !expectJson ||
          response.status === 204 ||
          response.headers.get('content-length') === '0'
        ) {
          return undefined as T;
        }
        return await this.parseJsonPayload<T>(path, () => response.json() as Promise<T>);
      } catch (error) {
        if (error instanceof KavitaError) throw error;
        recordDiagnostic({ category: 'request', endpoint: path, detail: 'network-error' });
        const message = timeoutSignal.aborted
          ? 'Kavita did not respond in time.'
          : 'Kavita could not be reached. Check the address and network.';
        throw new KavitaError(message, 'network');
      }
    });
  }

  private async nativeRequest<T>(path: string, init: RequestInit, expectJson = true): Promise<T> {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const method = init.method ?? 'GET';
    const options: HttpOptions = {
      url: this.resolveUrl(path),
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      disableRedirects: true,
    };
    if (typeof init.body === 'string') options.data = JSON.parse(init.body) as unknown;
    try {
      const redirects = createRedirectState(options.url, new URL(this.baseUrl).origin, method);
      let response: HttpResponse;
      while (true) {
        const guard = this.assertCanRequest(init.signal);
        if (guard) await guard;
        const networkStatus = await Network.getStatus().catch(() => null);
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (networkStatus?.connected !== true || navigator.onLine === false) {
          throw new KavitaError('Kavita could not be reached while offline.', 'network');
        }
        response = await CapacitorHttp.request({ ...options, url: redirects.currentUrl });
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (
          !advanceRedirect(redirects, response.status, nativeHeader(response.headers, 'location'))
        ) {
          break;
        }
      }
      this.assertStatus(response.status, path);
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!expectJson) return undefined as T;
      if (typeof response.data === 'string') {
        if (!response.data.trim()) return undefined as T;
        return await this.parseJsonPayload<T>(path, () => JSON.parse(response.data) as T);
      }
      return response.data as T;
    } catch (error) {
      if (error instanceof KavitaError || error instanceof DOMException) throw error;
      recordDiagnostic({ category: 'request', endpoint: path, detail: 'network-error' });
      throw new KavitaError(
        'Kavita could not be reached. Check the address and network.',
        'network',
      );
    }
  }

  private async browserFetchWithRedirects(url: string, init: RequestInit): Promise<Response> {
    const redirects = createRedirectState(url, new URL(this.baseUrl).origin, init.method ?? 'GET');
    while (true) {
      const guard = this.assertCanRequest(init.signal);
      if (guard) await guard;
      const response = await fetch(redirects.currentUrl, { ...init, redirect: 'manual' });
      if (
        !advanceRedirect(
          redirects,
          response.status,
          response.headers.get('location'),
          response.type === 'opaqueredirect',
        )
      ) {
        return response;
      }
    }
  }

  private async withBrowserTimeout<T>(
    signal: AbortSignal | null | undefined,
    run: (combinedSignal: AbortSignal, timeoutSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    try {
      const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      return await run(combinedSignal, timeout.signal);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async parseJsonPayload<T>(endpoint: string, parse: () => T | Promise<T>): Promise<T> {
    try {
      return await parse();
    } catch {
      if (endpoint === '/api/Health') return undefined as T;
      recordDiagnostic({ category: 'validation', endpoint, detail: 'invalid-json' });
      throw new KavitaError(
        `Kavita returned malformed JSON at ${endpoint.split('?')[0]}.`,
        'invalid-response',
      );
    }
  }

  private assertStatus(status: number, endpoint?: string): void {
    if (endpoint !== undefined && status >= 400) {
      recordDiagnostic({ category: 'response', endpoint, status });
    }
    if (status === 401 || status === 403) {
      throw new KavitaError('Kavita rejected this auth key.', 'authentication', status);
    }
    if (status < 200 || status >= 300) {
      throw new KavitaError(`Kavita returned an error (${status}).`, 'server', status);
    }
  }

  private resolveUrl(path: string): string {
    const baseUrl = this.baseUrl.replace(/\/+$/, '') + '/';
    const absolute = new URL(path.replace(/^\/+/, ''), baseUrl).toString();
    if (
      !Capacitor.isNativePlatform() &&
      import.meta.env.DEV &&
      import.meta.env.MODE === 'development'
    ) {
      return `${BROWSER_PROXY_PREFIX}${encodeURIComponent(absolute)}`;
    }
    return absolute;
  }
}
