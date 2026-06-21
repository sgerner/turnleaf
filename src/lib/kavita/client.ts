import type {
  ConnectedServer,
  KavitaLibrary,
  KavitaProgress,
  KavitaSeries,
  KavitaSeriesDetail,
} from './types';

const REQUEST_TIMEOUT_MS = 12_000;
const BOOK_LIBRARY_TYPE = 2;

export class KavitaError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'authentication' | 'server' | 'invalid-response',
    readonly status?: number,
  ) {
    super(message);
  }
}

export class KavitaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async testConnection(signal?: AbortSignal): Promise<ConnectedServer> {
    const options = signal ? { signal } : {};
    const libraries = await this.request<KavitaLibrary[]>('/api/Library/libraries', options);
    if (!Array.isArray(libraries)) {
      throw new KavitaError('Kavita returned an unexpected library response.', 'invalid-response');
    }

    const health = await this.request<{ version?: string }>('/api/Health', options).catch(
      () => null,
    );
    return {
      version: health?.version ?? null,
      bookLibraries: libraries.filter((library) => library.type === BOOK_LIBRARY_TYPE),
    };
  }

  async getBookSeries(signal?: AbortSignal): Promise<KavitaSeries[]> {
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
    const series = await this.request<KavitaSeries[]>(
      '/api/Series/v2?PageNumber=1&PageSize=500',
      options,
    );
    return series.filter((item) => item.format === 3);
  }

  getSeriesDetail(seriesId: number, signal?: AbortSignal): Promise<KavitaSeriesDetail> {
    return this.request(`/api/Series/series-detail?seriesId=${seriesId}`, signal ? { signal } : {});
  }

  downloadUrl(chapterId: number): string {
    return `${this.baseUrl}/api/Download/chapter?chapterId=${chapterId}`;
  }

  coverUrl(seriesId: number): string {
    return `${this.baseUrl}/api/Image/series-cover?seriesId=${seriesId}&apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  async getCover(seriesId: number, signal?: AbortSignal): Promise<Blob> {
    const url = this.coverUrl(seriesId);
    if (Capacitor.isNativePlatform()) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const response = await CapacitorHttp.get({
        url,
        responseType: 'blob',
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
      });
      this.assertStatus(response.status);
      const encoded = String(response.data);
      const binary = atob(encoded.includes(',') ? (encoded.split(',').pop() ?? '') : encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes]);
    }
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    try {
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const response = await fetch(url, { signal: combined });
      if (!response.ok) throw new KavitaError('The book cover could not be loaded.', 'server');
      return await response.blob();
    } finally {
      window.clearTimeout(timer);
    }
  }

  getProgress(chapterId: number, signal?: AbortSignal): Promise<KavitaProgress> {
    return this.request(
      `/api/Reader/get-progress?chapterId=${chapterId}`,
      signal ? { signal } : {},
    );
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
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          ...init.headers,
        },
      });

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
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof KavitaError) throw error;
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
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    };
    if (typeof init.body === 'string') options.data = JSON.parse(init.body) as unknown;
    try {
      const response = await CapacitorHttp.request(options);
      this.assertStatus(response.status);
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return response.data as T;
    } catch (error) {
      if (error instanceof KavitaError || error instanceof DOMException) throw error;
      throw new KavitaError(
        'Kavita could not be reached. Check the address and network.',
        'network',
      );
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
}
import { Capacitor, CapacitorHttp, type HttpOptions } from '@capacitor/core';
