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
import {
  canSendCredential,
  getCredentialState,
  markCredentialRejected,
  resolveCredentialEpoch,
} from '../native/credentials';
import {
  advanceRedirect,
  assertSafeTransferTarget,
  createRedirectState,
  KavitaError,
  nativeHeader,
} from './redirects';

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

export interface KavitaClientOptions {
  credentialEpoch?: number | undefined;
  probe?: boolean | undefined;
}

export class KavitaClient {
  private readonly credentialEpoch: number | undefined;
  private readonly probe: boolean;
  private localRejectedStatus: number | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    options: KavitaClientOptions = {},
  ) {
    this.probe = options.probe === true;
    this.credentialEpoch = this.probe
      ? undefined
      : resolveCredentialEpoch(apiKey, options.credentialEpoch);
  }

  canSendRequests(): boolean {
    if (!this.apiKey.trim()) return false;
    if (this.localRejectedStatus !== undefined) return false;
    if (this.probe) return true;
    return canSendCredential(this.apiKey, this.credentialEpoch);
  }

  private assertCredentialReady(probe = this.probe): void {
    if (!this.apiKey.trim()) {
      throw new KavitaError('Enter a Kavita auth key.', 'authentication');
    }
    if (probe) return;
    if (
      this.localRejectedStatus !== undefined ||
      !canSendCredential(this.apiKey, this.credentialEpoch)
    ) {
      const status = this.localRejectedStatus ?? getCredentialState().statusCode;
      throw new KavitaError('Kavita rejected this auth key.', 'authentication', status);
    }
  }

  private rejectCredential(status: number, probe = this.probe): never {
    if (!probe) {
      this.localRejectedStatus = status;
      markCredentialRejected(this.credentialEpoch, status);
    }
    throw new KavitaError('Kavita rejected this auth key.', 'authentication', status);
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectedServer> {
    const options = signal ? { signal } : {};
    const [libraries, health] = await Promise.all([
      this.request<unknown>('/api/Library/libraries', options, true).then((payload) =>
        normalizePayload('/api/Library/libraries', () => normalizeLibraries(payload)),
      ),
      this.request<unknown>('/api/Health', options, true).catch(() => null),
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
    this.assertCredentialReady();
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
      if (signal?.aborted || !retryable || !this.canSendRequests()) throw error;
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

  private async request<T>(path: string, init: RequestInit = {}, probe = this.probe): Promise<T> {
    this.assertCredentialReady(probe);
    if (Capacitor.isNativePlatform()) return this.nativeRequest<T>(path, init, probe);
    return this.withBrowserTimeout(init.signal, async (signal, timeoutSignal) => {
      try {
        const response = await this.browserFetchWithRedirects(
          this.resolveUrl(path),
          {
            ...init,
            signal,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              ...init.headers,
              'x-api-key': this.apiKey,
            },
          },
          probe,
        );

        this.assertStatus(response.status, path, probe);
        if (response.status === 204 || response.headers.get('content-length') === '0') {
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

  private async nativeRequest<T>(path: string, init: RequestInit, probe = this.probe): Promise<T> {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.assertCredentialReady(probe);
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
        this.assertCredentialReady(probe);
        response = await CapacitorHttp.request({ ...options, url: redirects.currentUrl });
        if (!probe && (response.status === 401 || response.status === 403)) {
          this.localRejectedStatus = response.status;
          markCredentialRejected(this.credentialEpoch, response.status);
          if (init.signal?.aborted) {
            recordDiagnostic({ category: 'response', endpoint: path, status: response.status });
          }
        }
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (
          !advanceRedirect(redirects, response.status, nativeHeader(response.headers, 'location'))
        ) {
          break;
        }
      }
      this.assertStatus(response.status, path, probe);
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

  private async browserFetchWithRedirects(
    url: string,
    init: RequestInit,
    probe = this.probe,
  ): Promise<Response> {
    const redirects = createRedirectState(url, new URL(this.baseUrl).origin, init.method ?? 'GET');
    while (true) {
      this.assertCredentialReady(probe);
      const response = await fetch(redirects.currentUrl, { ...init, redirect: 'manual' });
      if (!probe && init.signal?.aborted && (response.status === 401 || response.status === 403)) {
        this.localRejectedStatus = response.status;
        markCredentialRejected(this.credentialEpoch, response.status);
      }
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

  private assertStatus(status: number, endpoint?: string, probe = this.probe): void {
    if (endpoint !== undefined && status >= 400) {
      recordDiagnostic({ category: 'response', endpoint, status });
    }
    if (status === 401 || status === 403) {
      this.rejectCredential(status, probe);
    }
    if (status < 200 || status >= 300) {
      throw new KavitaError(`Kavita returned an error (${status}).`, 'server', status);
    }
  }

  private parseBaseOrigin(): URL {
    let parsed: URL;
    try {
      parsed = new URL(this.baseUrl);
    } catch {
      throw new KavitaError('Invalid Kavita server address.', 'server');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new KavitaError('Invalid Kavita server address.', 'server');
    }
    return parsed;
  }

  private resolveUrl(path: string): string {
    const parsedBase = this.parseBaseOrigin();
    const baseUrl = this.baseUrl.replace(/\/+$/, '') + '/';
    const absolute = new URL(path.replace(/^\/+/, ''), baseUrl).toString();
    assertSafeTransferTarget(absolute, parsedBase.origin, 'Invalid Kavita server address.');
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
