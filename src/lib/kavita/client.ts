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
          statements: [],
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
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    try {
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const response = await this.browserFetchWithRedirects(url, {
        signal: combined,
        headers: { 'x-api-key': this.apiKey },
      });
      this.assertStatus(response.status);
      return await response.blob();
    } finally {
      window.clearTimeout(timer);
    }
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
    if (Capacitor.isNativePlatform()) return this.nativeRequest<T>(path, init);
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;

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

      if (response.status >= 400) {
        recordDiagnostic({ category: 'response', endpoint: path, status: response.status });
      }
      if (response.status === 401 || response.status === 403) {
        throw new KavitaError('Kavita rejected this auth key.', 'authentication', response.status);
      }
      if (!response.ok) {
        throw new KavitaError(
          `Kavita returned an error (${response.status}).`,
          'server',
          response.status,
        );
      }
      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return undefined as T;
      }
      try {
        return (await response.json()) as T;
      } catch {
        if (path === '/api/Health') return undefined as T;
        recordDiagnostic({ category: 'validation', endpoint: path, detail: 'invalid-json' });
        throw new KavitaError(
          `Kavita returned malformed JSON at ${path.split('?')[0]}.`,
          'invalid-response',
        );
      }
    } catch (error) {
      if (error instanceof KavitaError) throw error;
      recordDiagnostic({ category: 'request', endpoint: path, detail: 'network-error' });
      const message = timeout.signal.aborted
        ? 'Kavita did not respond in time.'
        : 'Kavita could not be reached. Check the address and network.';
      throw new KavitaError(message, 'network');
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async nativeRequest<T>(path: string, init: RequestInit): Promise<T> {
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
      if (response.status >= 400) {
        recordDiagnostic({ category: 'response', endpoint: path, status: response.status });
      }
      this.assertStatus(response.status);
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (typeof response.data === 'string') {
        if (!response.data.trim()) return undefined as T;
        try {
          return JSON.parse(response.data) as T;
        } catch {
          if (path === '/api/Health') return undefined as T;
          recordDiagnostic({ category: 'validation', endpoint: path, detail: 'invalid-json' });
          throw new KavitaError(
            `Kavita returned malformed JSON at ${path.split('?')[0]}.`,
            'invalid-response',
          );
        }
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

  private assertStatus(status: number): void {
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
