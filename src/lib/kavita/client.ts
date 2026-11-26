import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';
import type { ConnectedServer, KavitaProgress, KavitaSeries, KavitaSeriesDetail } from './types';
import { isKavitaProgress, readHealthVersion } from './validation';
import {
  KavitaPayloadError,
  normalizeLibraries,
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
const SERIES_PAGE_CONCURRENCY = 4;
const MAX_SERIES_RESULTS = 100_000;
const MAX_SERIES_PAGES = MAX_SERIES_RESULTS / SERIES_PAGE_SIZE + 1;
const SERIES_QUERY_BODY = JSON.stringify({
  statements: [{ field: 21, comparison: 5, value: '3' }],
  combination: 0,
  sortOptions: { sortField: 1, isAscending: true },
  limitTo: 0,
});

interface KavitaResponse<T> {
  data: T;
  getHeader: (name: string) => string | null;
}

interface SeriesPageResult {
  page: KavitaSeries[];
  rawPageLength: number;
  totalPages: number | null;
}

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

function parsePaginationTotalPages(rawHeader: string | null): number | null {
  if (!rawHeader) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawHeader);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const totalPages = (parsed as Record<string, unknown>).totalPages;
  if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 0) {
    return null;
  }
  if (totalPages > MAX_SERIES_PAGES) {
    throw new KavitaError('Kavita returned too many series pages.', 'invalid-response');
  }
  return totalPages;
}

export class KavitaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
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
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const series: KavitaSeries[] = [];
    const seenSeriesIds = new Set<number>();

    const appendPage = (page: KavitaSeries[]): void => {
      const pageIds = new Set<number>();
      for (const item of page) {
        if (pageIds.has(item.id) || seenSeriesIds.has(item.id)) {
          throw new KavitaError('Kavita returned a repeated series page.', 'invalid-response');
        }
        pageIds.add(item.id);
        seenSeriesIds.add(item.id);
      }
      series.push(...page);
      if (series.length > MAX_SERIES_RESULTS) {
        throw new KavitaError('Kavita returned too many series.', 'invalid-response');
      }
    };

    const firstPage = await this.fetchSeriesPage(1, signal);
    appendPage(firstPage.page);
    if (
      firstPage.rawPageLength < SERIES_PAGE_SIZE ||
      (firstPage.totalPages !== null && firstPage.totalPages <= 1)
    ) {
      return series;
    }

    let nextSequentialPage = 2;
    if (firstPage.totalPages !== null && firstPage.totalPages > 1) {
      const initialTotalPages = firstPage.totalPages;
      const pages = new Array<SeriesPageResult>(initialTotalPages);
      pages[0] = firstPage;

      const batchController = new AbortController();
      const onCallerAbort = (): void => batchController.abort(signal?.reason);
      if (signal) {
        if (signal.aborted) {
          batchController.abort(signal.reason);
        } else {
          signal.addEventListener('abort', onCallerAbort, { once: true });
        }
      }

      let nextPageNumber = 2;
      let failed = false;
      let firstError: unknown;

      const workerCount = Math.min(SERIES_PAGE_CONCURRENCY, initialTotalPages - 1);
      try {
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (!batchController.signal.aborted) {
              const pageNumber = nextPageNumber;
              if (pageNumber > initialTotalPages) break;
              nextPageNumber += 1;
              try {
                pages[pageNumber - 1] = await this.fetchSeriesPage(
                  pageNumber,
                  batchController.signal,
                );
              } catch (error) {
                if (!failed && !signal?.aborted) {
                  failed = true;
                  firstError = error;
                }
                batchController.abort();
                throw firstError ?? error;
              }
            }
          }),
        );
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        throw error;
      } finally {
        signal?.removeEventListener('abort', onCallerAbort);
      }

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (failed) throw firstError;

      let maxTotalPages = initialTotalPages;
      for (let pageNumber = 2; pageNumber <= initialTotalPages; pageNumber += 1) {
        const result = pages[pageNumber - 1];
        if (!result) {
          throw new KavitaError('Kavita returned an incomplete series page.', 'invalid-response');
        }
        appendPage(result.page);
        if (result.totalPages !== null && result.totalPages > maxTotalPages) {
          maxTotalPages = result.totalPages;
        }
      }

      const lastPage = pages[initialTotalPages - 1];
      if (!lastPage) return series;
      const needsTrailingPages =
        (lastPage.totalPages !== null && lastPage.totalPages > initialTotalPages) ||
        (lastPage.rawPageLength === SERIES_PAGE_SIZE &&
          (lastPage.totalPages === null || maxTotalPages > initialTotalPages));
      if (!needsTrailingPages) return series;
      nextSequentialPage = initialTotalPages + 1;
    }

    for (let pageNumber = nextSequentialPage; pageNumber <= MAX_SERIES_PAGES; pageNumber += 1) {
      const trailingPage = await this.fetchSeriesPage(pageNumber, signal);
      appendPage(trailingPage.page);
      if (
        trailingPage.rawPageLength < SERIES_PAGE_SIZE ||
        (trailingPage.totalPages !== null && pageNumber >= trailingPage.totalPages)
      ) {
        return series;
      }
    }
    throw new KavitaError('Kavita returned too many series pages.', 'invalid-response');
  }

  private async fetchSeriesPage(
    pageNumber: number,
    signal?: AbortSignal,
  ): Promise<SeriesPageResult> {
    const options: RequestInit = {
      method: 'POST',
      body: SERIES_QUERY_BODY,
    };
    if (signal) options.signal = signal;
    const { data: payload, getHeader } = await this.requestWithHeaders<unknown>(
      `/api/Series/v2?PageNumber=${pageNumber}&PageSize=${SERIES_PAGE_SIZE}`,
      options,
    );
    const page = normalizePayload('/api/Series/v2', () => normalizeSeriesPage(payload));
    const rawPageLength = (payload as unknown[]).length;
    if (rawPageLength > SERIES_PAGE_SIZE) {
      throw new KavitaError('Kavita returned an oversized series page.', 'invalid-response');
    }
    const totalPages = parsePaginationTotalPages(getHeader('Pagination'));
    return { page, rawPageLength, totalPages };
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
    return this.request('/api/Reader/progress', options);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(path, init);
    return data;
  }

  private async requestWithHeaders<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<KavitaResponse<T>> {
    if (Capacitor.isNativePlatform()) return this.nativeRequest<T>(path, init);
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

        const getHeader = (name: string): string | null => response.headers.get(name);
        this.assertStatus(response.status, path);
        if (response.status === 204 || getHeader('content-length') === '0') {
          return { data: undefined as T, getHeader };
        }
        const data = await this.parseJsonPayload<T>(path, () => response.json() as Promise<T>);
        return { data, getHeader };
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

  private async nativeRequest<T>(path: string, init: RequestInit): Promise<KavitaResponse<T>> {
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
      const headers = response.headers ?? {};
      const getHeader = (name: string): string | null => nativeHeader(headers, name);
      if (typeof response.data === 'string') {
        if (!response.data.trim()) return { data: undefined as T, getHeader };
        const data = await this.parseJsonPayload<T>(path, () => JSON.parse(response.data) as T);
        return { data, getHeader };
      }
      return { data: response.data as T, getHeader };
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
