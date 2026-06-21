<script lang="ts">
  import { App } from '@capacitor/app';
  import { Capacitor } from '@capacitor/core';
  import { Network } from '@capacitor/network';
  import DOMPurify from 'dompurify';
  import { onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import {
    getBooks,
    getReadingState,
    getPreference,
    markDownloaded,
    removeDownload,
    replaceBooks,
    saveLocalProgress,
    setPreference,
    type BookRecord,
    type ServerConfig,
  } from '../database/database';
  import {
    cacheCover,
    clearCoverCache,
    deleteDownloadedEpub,
    downloadEpub,
    verifyDownloadedEpub,
  } from '../downloads/native-download';
  import { KavitaClient } from '../kavita/client';
  import { mapSeriesToBook } from '../kavita/mapper';
  import type { KavitaProgress } from '../kavita/types';
  import type { ReaderLocation } from '../reader/session';
  import { flushProgress } from '../sync/sync';
  import Reader from './Reader.svelte';
  import TurnleafLogo from './TurnleafLogo.svelte';

  const skeletonThemes = [
    'catppuccin',
    'cerberus',
    'concord',
    'crimson',
    'fennec',
    'hamlindigo',
    'legacy',
    'mint',
    'modern',
    'mona',
    'nosh',
    'nouveau',
    'pine',
    'reign',
    'rocket',
    'rose',
    'sahara',
    'seafoam',
    'terminus',
    'vintage',
    'vox',
    'wintry',
  ] as const;
  type SkeletonTheme = (typeof skeletonThemes)[number];

  // Primary/secondary/tertiary-500 colors for each Skeleton theme, extracted from
  // node_modules/@skeletonlabs/skeleton/src/themes/*.css. Hardcoded because Skeleton v4
  // switches theme variables globally; arbitrary child elements with data-theme do not
  // inherit a different theme's palette.
  const themeColors: Record<SkeletonTheme, [string, string, string]> = {
    catppuccin: [
      'oklch(66.37% 0.18 273.14deg)',
      'oklch(72.56% 0.17 338.45deg)',
      'oklch(60.23% 0.1 201.09deg)',
    ],
    cerberus: ['oklch(0.57 0.21 258.29)', 'oklch(0.49 0.23 300.45)', 'oklch(0.65 0.26 2.47)'],
    concord: [
      'oklch(57.74% 0.21 273.85deg)',
      'oklch(65.34% 0.22 351.93deg)',
      'oklch(69.62% 0.15 247.99deg)',
    ],
    crimson: [
      'oklch(55.71% 0.21 19.55deg)',
      'oklch(59.26% 0.09 239.95deg)',
      'oklch(78.4% 0.01 31.17deg)',
    ],
    fennec: [
      'oklch(65.88% 0.21 38.25deg)',
      'oklch(87.53% 0.1 74.15deg)',
      'oklch(57.22% 0.05 185.36deg)',
    ],
    hamlindigo: [
      'oklch(80.28% 0.08 266.51deg)',
      'oklch(65.46% 0.07 87.04deg)',
      'oklch(64.32% 0.06 213.24deg)',
    ],
    legacy: [
      'oklch(69.84% 0.15 162.21deg)',
      'oklch(51.06% 0.23 276.97deg)',
      'oklch(68.47% 0.15 237.31deg)',
    ],
    mint: [
      'oklch(83.57% 0.18 148.98deg)',
      'oklch(59.27% 0.21 282.75deg)',
      'oklch(44.74% 0.03 322.1deg)',
    ],
    modern: [
      'oklch(65.59% 0.21 354.32deg)',
      'oklch(71.48% 0.13 215.21deg)',
      'oklch(70.37% 0.12 182.49deg)',
    ],
    mona: [
      'oklch(56.31% 0.21 294.98deg)',
      'oklch(63.43% 0.16 148.39deg)',
      'oklch(81.11% 0.1 190.5deg)',
    ],
    nosh: [
      'oklch(56.22% 0.23 24.62deg)',
      'oklch(89.23% 0.04 17.93deg)',
      'oklch(42.89% 0.04 161.33deg)',
    ],
    nouveau: [
      'oklch(83.44% 0.16 97deg)',
      'oklch(56.7% 0.19 256.45deg)',
      'oklch(62.5% 0.15 284.38deg)',
    ],
    pine: [
      'oklch(62.15% 0.08 79.85deg)',
      'oklch(31.9% 0.11 347.8deg)',
      'oklch(61.68% 0.02 103.61deg)',
    ],
    reign: [
      'oklch(94.82% 0.17 110.7deg)',
      'oklch(94.82% 0.17 110.7deg)',
      'oklch(94.82% 0.17 110.7deg)',
    ],
    rocket: [
      'oklch(71.48% 0.13 215.21deg)',
      'oklch(62.31% 0.19 259.81deg)',
      'oklch(62.68% 0.23 303.91deg)',
    ],
    rose: [
      'oklch(69.89% 0.13 348.12deg)',
      'oklch(46.75% 0.22 272.16deg)',
      'oklch(78.41% 0.08 291.85deg)',
    ],
    sahara: [
      'oklch(78.19% 0.15 76.87deg)',
      'oklch(76.32% 0.12 183.49deg)',
      'oklch(85.72% 0.12 126.76deg)',
    ],
    seafoam: [
      'oklch(80.78% 0.07 190.34deg)',
      'oklch(32.36% 0.07 262.2deg)',
      'oklch(65.36% 0.23 34.04deg)',
    ],
    terminus: [
      'oklch(48.65% 0.3 279.02deg)',
      'oklch(89.36% 0.16 171.7deg)',
      'oklch(91.3% 0.21 117.7deg)',
    ],
    vintage: [
      'oklch(71.39% 0.16 59.66deg)',
      'oklch(80.21% 0.08 152.14deg)',
      'oklch(71.48% 0.13 215.21deg)',
    ],
    vox: [
      'oklch(82.71% 0.1 51.5deg)',
      'oklch(92.54% 0.17 123.36deg)',
      'oklch(80.24% 0.12 298.53deg)',
    ],
    wintry: [
      'oklch(62.31% 0.19 259.81deg)',
      'oklch(68.47% 0.15 237.31deg)',
      'oklch(66.28% 0.18 280.87deg)',
    ],
  };

  let {
    server,
    apiKey,
    theme,
    mode,
    onThemeChange,
    onModeChange,
  }: {
    server: ServerConfig;
    apiKey: string;
    theme: string;
    mode: 'light' | 'dark';
    onThemeChange: (theme: SkeletonTheme) => void;
    onModeChange: (mode: 'light' | 'dark') => void;
  } = $props();
  const client = $derived(new KavitaClient(server.baseUrl, apiKey));
  let books = $state<BookRecord[]>([]);
  let query = $state('');
  let downloadedOnly = $state(false);
  let hideCompleted = $state(true);
  let visibleBooks = $derived(
    books.filter((book) => {
      const matchesQuery = `${book.title} ${book.author ?? ''} ${book.series ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
      const completed = book.pages > 0 && book.pagesRead >= book.pages;
      return (
        matchesQuery &&
        (!downloadedOnly || Boolean(book.downloadPath)) &&
        (!hideCompleted || !completed)
      );
    }),
  );
  // Surface the most recently read, downloaded, in-progress book as a one-tap resume.
  let continueBook = $derived(
    books
      .filter(
        (book) =>
          book.downloadPath && book.pages > 0 && book.pagesRead < book.pages && book.lastReadAt,
      )
      .sort((a, b) => (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? ''))[0] ?? null,
  );
  let selected = $state<BookRecord | null>(null);
  let reading = $state<{
    book: BookRecord;
    url: string;
    cfi: string | null;
    xpath: string | null;
  } | null>(null);
  let conflict = $state<{
    book: BookRecord;
    url: string;
    localCfi: string;
    remote: KavitaProgress;
  } | null>(null);
  let covers = $state<Record<number, string>>({});
  let loading = $state(true);
  let refreshing = $state(false);
  let offline = $state(false);
  let message = $state('');
  let settingsVisible = $state(false);
  let pendingTheme = $state<SkeletonTheme>('vintage');
  let pendingMode = $state<'light' | 'dark'>('dark');
  let syncTimer: number | null = null;
  const cleanups: Array<() => Promise<void>> = [];
  const nativePlatform = Capacitor.isNativePlatform();

  function progressOf(book: BookRecord): number {
    return book.pages ? Math.min(100, (book.pagesRead / book.pages) * 100) : 0;
  }

  onMount(async () => {
    const savedTheme = await getPreference('uiTheme');
    const savedMode = await getPreference('uiMode');
    pendingTheme = (savedTheme as SkeletonTheme | null) ?? (theme as SkeletonTheme);
    pendingMode = savedMode === 'light' ? 'light' : mode;
    books = await getBooks(server.id);
    loading = false;
    offline = !(await Network.getStatus()).connected;
    if (!offline) await refresh();
    cleanups.push(
      (
        await Network.addListener('networkStatusChange', ({ connected }) => {
          offline = !connected;
          if (connected)
            void flushProgress(client)
              .then(refresh)
              .catch(() => {});
        })
      ).remove,
    );
    cleanups.push(
      (
        await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) void flushProgress(client).catch(() => {});
        })
      ).remove,
    );
    cleanups.push(
      (
        await App.addListener('backButton', () => {
          if (reading) reading = null;
          else if (selected) selected = null;
          else if (settingsVisible) settingsVisible = false;
          else void App.exitApp();
        })
      ).remove,
    );
  });

  onDestroy(() => {
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    Object.values(covers).forEach(URL.revokeObjectURL);
    cleanups.forEach((remove) => void remove());
  });

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    message = '';
    try {
      const series = await client.getBookSeries();
      const mapped = await Promise.all(
        series.map(async (item) =>
          mapSeriesToBook(server.id, item, await client.getSeriesDetail(item.id)),
        ),
      );
      await replaceBooks(
        server.id,
        mapped.filter((item): item is BookRecord => item !== null),
      );
      books = await getBooks(server.id);
      void loadCovers(books);
      offline = false;
    } catch {
      offline = true;
      message = books.length
        ? 'Kavita is unavailable. Showing your saved library.'
        : 'Kavita could not be reached.';
    } finally {
      refreshing = false;
    }
  }

  async function loadCovers(items: BookRecord[]): Promise<void> {
    if (!nativePlatform) return;
    for (const book of items) {
      if (covers[book.seriesId]) continue;
      try {
        covers = {
          ...covers,
          [book.seriesId]: await cacheCover(client.coverUrl(book.seriesId), apiKey, book.seriesId),
        };
      } catch {
        /* Metadata remains useful without decorative covers. */
      }
    }
  }

  async function download(book: BookRecord): Promise<void> {
    message = `Downloading ${book.title}...`;
    try {
      const file = await downloadEpub(
        client.downloadUrl(book.chapterId),
        apiKey,
        book.id.replaceAll(':', '-'),
      );
      await markDownloaded(book.id, file.relativePath, file.size);
      await reloadSelection(book.id);
      message = `${book.title} is ready offline.`;
    } catch {
      message = 'The download was interrupted. Try again when Kavita is available.';
    }
  }

  async function remove(book: BookRecord): Promise<void> {
    if (book.downloadPath) await deleteDownloadedEpub(book.downloadPath).catch(() => {});
    await removeDownload(book.id);
    await reloadSelection(book.id);
  }

  async function reloadSelection(bookId: string): Promise<void> {
    books = await getBooks(server.id);
    selected = books.find((item) => item.id === bookId) ?? null;
  }

  async function open(book: BookRecord): Promise<void> {
    if (!book.downloadPath) return;
    const file = await verifyDownloadedEpub(book.downloadPath);
    if (!file) {
      await removeDownload(book.id);
      message = 'The downloaded file is missing. Download it again.';
      books = await getBooks(server.id);
      return;
    }
    const local = await getReadingState(book.id);
    const remote = offline ? null : await client.getProgress(book.chapterId).catch(() => null);
    const remoteChanged = Boolean(
      local?.pendingSync &&
      remote?.lastModifiedUtc &&
      local.serverUpdatedAt &&
      Date.parse(remote.lastModifiedUtc) > Date.parse(local.serverUpdatedAt),
    );
    if (local && remote && remoteChanged && remote.bookScrollId !== local.xpath) {
      conflict = { book, url: file.webViewUrl, localCfi: local.cfi, remote };
      return;
    }
    reading = {
      book,
      url: file.webViewUrl,
      cfi: local?.cfi ?? null,
      xpath: local ? null : (remote?.bookScrollId ?? null),
    };
  }

  async function relocated(book: BookRecord, location: ReaderLocation): Promise<void> {
    await saveLocalProgress(book, location.cfi, location.xpath, location.percentage);
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => void flushProgress(client).catch(() => {}), 2_500);
  }

  function descriptionText(html: string): string {
    const clean = DOMPurify.sanitize(html);
    return new DOMParser().parseFromString(clean, 'text/html').body.textContent ?? '';
  }

  async function removeAllDownloads(): Promise<void> {
    for (const book of books.filter((item) => item.downloadPath)) await remove(book);
    message = 'Downloaded books removed. Kavita was not changed.';
    settingsVisible = false;
  }

  async function clearCache(): Promise<void> {
    await clearCoverCache();
    covers = {};
    message = 'Cover cache cleared.';
    settingsVisible = false;
  }

  async function updateTheme(next: SkeletonTheme): Promise<void> {
    pendingTheme = next;
    onThemeChange(next);
    await setPreference('uiTheme', next);
  }

  async function updateMode(next: 'light' | 'dark'): Promise<void> {
    pendingMode = next;
    onModeChange(next);
    await setPreference('uiMode', next);
  }
</script>

{#if reading}
  <Reader
    bookUrl={reading.url}
    title={reading.book.title}
    initialCfi={reading.cfi}
    initialXPath={reading.xpath}
    onBack={() => (reading = null)}
    onRelocated={(location) => relocated(reading!.book, location)}
  />
{:else}
  <main
    class="mx-auto min-h-dvh max-w-6xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-6"
  >
    <header class="flex items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3">
        <TurnleafLogo size={36} wordmark={false} />
        <div class="min-w-0 leading-tight">
          <h1 class="truncate font-serif text-3xl text-primary-950-50">Turnleaf</h1>
        </div>
      </div>
      <div class="card preset-tonal-surface flex shrink-0 gap-1 p-1">
        <button
          class="btn btn-sm preset-tonal-surface h-8 w-8 !p-0"
          type="button"
          onclick={() => (settingsVisible = true)}
          aria-label="Open settings"
          title="Settings"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.4 7.4 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.43h-3.84a.5.5 0 0 0-.5.43l-.36 2.54c-.57.23-1.11.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.77 8.85a.5.5 0 0 0 .12.63l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.89 14.52a.5.5 0 0 0-.12.63l1.92 3.32c.12.21.37.3.6.22l2.39-.96c.51.4 1.06.72 1.63.94l.36 2.54c.04.24.25.43.5.43h3.84c.25 0 .46-.19.5-.43l.36-2.54c.57-.23 1.11-.54 1.63-.94l2.39.96c.23.08.48-.01.6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58ZM12 15.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z"
            />
          </svg>
        </button>
        <button
          class="btn btn-sm preset-tonal-surface h-8 w-8 !p-0"
          type="button"
          onclick={refresh}
          disabled={refreshing}
          aria-label="Refresh library"
          title="Refresh"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            class="h-5 w-5"
            class:animate-spin={refreshing}
          >
            <path
              fill="currentColor"
              d="M17.65 6.35A7.95 7.95 0 0 0 12 4c-4.41 0-8 3.59-8 8H2l3.89 3.89.07.14L10 12H7a5 5 0 1 1 1.46 3.54l-1.42 1.42A7 7 0 1 0 17.65 6.35Z"
            />
          </svg>
        </button>
      </div>
    </header>

    {#if continueBook}
      <section
        class="card preset-tonal-surface mt-6 flex items-center gap-4 p-3 sm:gap-5 sm:p-4"
        aria-label="Continue reading"
        transition:fade
      >
        <button
          class="preset-tonal-surface overflow-hidden rounded-lg shadow-md"
          type="button"
          onclick={() => open(continueBook!)}
          aria-label={`Continue reading ${continueBook.title}`}
        >
          <img
            class="h-24 w-16 shrink-0 object-cover sm:h-28 sm:w-20"
            src={covers[continueBook.seriesId] ?? client.coverUrl(continueBook.seriesId)}
            loading="lazy"
            decoding="async"
            alt=""
          />
        </button>
        <div class="min-w-0 flex-1">
          <p class="text-xs uppercase tracking-wider text-surface-700-300">Continue reading</p>
          <h2 class="mt-0.5 truncate font-serif text-xl leading-tight text-surface-950-50">
            {continueBook.title}
          </h2>
          <p class="mt-0.5 truncate text-sm text-surface-700-300">
            {continueBook.author ?? 'Unknown author'}
          </p>
          <div class="mt-2 flex items-center gap-2">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full preset-filled-surface-200-800">
              <div
                class="h-full preset-filled-primary-600-400"
                style:width={`${progressOf(continueBook)}%`}
              ></div>
            </div>
            <span class="text-xs tabular-nums text-surface-700-300"
              >{Math.round(progressOf(continueBook))}%</span
            >
          </div>
        </div>
        <button
          class="btn preset-filled-primary-700-300 shrink-0"
          type="button"
          onclick={() => open(continueBook!)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M8 5v14l11-7z" />
          </svg>
          <span class="hidden sm:inline">Read</span>
        </button>
      </section>
    {/if}

    <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
      <label class="relative grow">
        <span class="sr-only">Search your library</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          class="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-surface-700-300"
        >
          <path
            fill="currentColor"
            d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z"
          />
        </svg>
        <input
          class="input preset-tonal-surface pl-10 pr-10"
          type="search"
          placeholder="Search books or authors"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="btn btn-sm absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 preset-filled-surface-200-800"
            onclick={() => (query = '')}
            aria-label="Clear search"
            title="Clear search"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        {/if}
      </label>
      <div class="flex flex-wrap gap-2">
        <button
          class="chip {downloadedOnly ? 'preset-filled-primary-700-300' : 'preset-tonal-surface'}"
          type="button"
          aria-pressed={downloadedOnly}
          onclick={() => (downloadedOnly = !downloadedOnly)}
          title="Show only downloaded books"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
            <path fill="currentColor" d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
          </svg>
          <span>Downloaded</span>
        </button>
        <button
          class="chip {hideCompleted ? 'preset-filled-primary-700-300' : 'preset-tonal-surface'}"
          type="button"
          aria-pressed={hideCompleted}
          onclick={() => (hideCompleted = !hideCompleted)}
          title="Hide books you have finished"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
            <path
              fill="currentColor"
              d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
            />
          </svg>
          <span>Hide completed</span>
        </button>
      </div>
    </div>

    {#if offline}
      <div class="alert preset-tonal-warning mt-5" role="status" transition:fade>
        Offline. Saved books remain available.
      </div>
    {/if}
    {#if message}
      <div class="alert preset-tonal-surface mt-4" role="status" transition:fade>
        {message}
      </div>
    {/if}

    {#if loading}
      <div class="mt-20 flex flex-col items-center gap-4 text-surface-700-300" transition:fade>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          class="h-8 w-8 animate-spin text-primary-500-700"
        >
          <path fill="currentColor" d="M12 4V2a10 10 0 0 0-7.07 17.07l1.42-1.42A8 8 0 1 1 12 4Z" />
        </svg>
        <p class="text-sm">Opening your saved library...</p>
      </div>
    {:else if books.length === 0}
      <div
        class="mt-20 flex flex-col items-center gap-3 text-center text-surface-700-300"
        transition:fade
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" class="h-12 w-12 text-surface-400-600">
          <path
            fill="currentColor"
            d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-6 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"
          />
        </svg>
        <p>No EPUB books found.</p>
      </div>
    {:else if visibleBooks.length === 0}
      <div
        class="mt-20 flex flex-col items-center gap-3 text-center text-surface-700-300"
        transition:fade
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" class="h-12 w-12 text-surface-400-600">
          <path
            fill="currentColor"
            d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z"
          />
        </svg>
        <p>No books match your search.</p>
      </div>
    {:else}
      <section
        class="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
        aria-label="Books"
      >
        {#each visibleBooks as book (book.id)}
          <button class="group text-left" type="button" onclick={() => (selected = book)}>
            <div
              class="preset-tonal-surface relative aspect-[2/3] overflow-hidden rounded-lg shadow-md transition-shadow duration-300 group-hover:shadow-xl"
            >
              <img
                class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                src={covers[book.seriesId] ?? client.coverUrl(book.seriesId)}
                loading="lazy"
                decoding="async"
                alt=""
              />
              {#if book.downloadPath}
                <span
                  class="badge-icon preset-filled-success-500 absolute right-2 top-2 h-7 w-7 p-0 shadow-md"
                  title="Available offline"
                  aria-label="Available offline"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
                    <path
                      fill="currentColor"
                      d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
                    />
                  </svg>
                </span>
              {/if}
              {#if progressOf(book) > 0}
                <div class="absolute inset-x-0 bottom-0 h-1.5">
                  <div
                    class="h-full preset-filled-primary-600-400"
                    style:width={`${progressOf(book)}%`}
                  ></div>
                </div>
              {/if}
            </div>
            <h2 class="mt-3 line-clamp-2 font-serif text-base leading-snug text-surface-950-50">
              {book.title}
            </h2>
            <p class="mt-1 truncate text-sm text-surface-700-300">
              {book.author ?? 'Unknown author'}
            </p>
          </button>
        {/each}
      </section>
    {/if}
  </main>
{/if}

{#if selected && !reading}
  <div
    class="fixed inset-0 z-30 grid place-items-center bg-black/55 p-4"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && (selected = null)}
  >
    <article
      class="card preset-filled-surface-50-950 relative w-full max-w-lg max-h-[88dvh] overflow-auto p-6"
      aria-label={selected.title}
      transition:fly={{ y: 16, duration: 150 }}
    >
      <button
        class="btn btn-sm preset-tonal-surface absolute right-4 top-4 h-9 w-9 p-0"
        type="button"
        onclick={() => (selected = null)}
        aria-label="Close"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
          <path
            fill="currentColor"
            d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
          />
        </svg>
      </button>

      <div class="flex flex-col gap-5 sm:flex-row">
        <img
          class="mx-auto h-44 w-28 shrink-0 rounded-lg object-cover shadow-lg sm:mx-0 sm:h-52 sm:w-36"
          src={covers[selected.seriesId] ?? client.coverUrl(selected.seriesId)}
          loading="lazy"
          decoding="async"
          alt=""
        />
        <div class="min-w-0 flex-1 pr-8 sm:pr-0">
          <h2 class="font-serif text-2xl leading-tight text-surface-950-50 sm:text-3xl">
            {selected.title}
          </h2>
          <p class="mt-2 text-surface-700-300">{selected.author ?? 'Unknown author'}</p>
          {#if selected.series}
            <p class="mt-1 text-sm text-surface-600-400">{selected.series}</p>
          {/if}
          {#if selected.pages > 0}
            <div class="mt-4 flex items-center gap-2">
              <div class="h-1.5 flex-1 overflow-hidden rounded-full preset-filled-surface-200-800">
                <div
                  class="h-full preset-filled-primary-600-400"
                  style:width={`${progressOf(selected)}%`}
                ></div>
              </div>
              <span class="text-xs tabular-nums text-surface-700-300"
                >{Math.round(progressOf(selected))}%</span
              >
            </div>
          {/if}
        </div>
      </div>

      {#if selected.descriptionHtml}
        <p class="mt-6 whitespace-pre-line text-sm leading-relaxed text-surface-800-200">
          {descriptionText(selected.descriptionHtml)}
        </p>
      {/if}

      <div class="mt-7 flex flex-wrap gap-3">
        {#if selected.downloadPath}
          <button
            class="btn preset-filled-primary-700-300"
            type="button"
            disabled={!nativePlatform}
            onclick={() => open(selected!)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path fill="currentColor" d="M8 5v14l11-7z" />
            </svg>
            Read
          </button>
          <button
            class="btn preset-outlined-error-500"
            type="button"
            disabled={!nativePlatform}
            onclick={() => remove(selected!)}>Remove download</button
          >
        {:else}
          <button
            class="btn preset-filled-primary-700-300"
            type="button"
            disabled={!nativePlatform}
            onclick={() => download(selected!)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path fill="currentColor" d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
            </svg>
            Download EPUB
          </button>
        {/if}
      </div>
      {#if !nativePlatform}
        <p class="mt-4 text-xs text-surface-600-400">
          Reading and downloads are available in the Turnleaf app.
        </p>
      {/if}
    </article>
  </div>
{/if}

{#if conflict}
  <div
    class="fixed inset-0 z-40 grid place-items-center bg-black/55 p-5"
    role="presentation"
    transition:fade
  >
    <div
      class="card preset-filled-surface-50-950 w-full max-w-sm p-6"
      transition:fly={{ y: 16, duration: 150 }}
    >
      <h2 class="font-serif text-2xl">Choose where to continue</h2>
      <p class="mt-3 text-surface-600-400">
        This device and Kavita both moved since the last sync.
      </p>
      <div class="mt-6 grid gap-3">
        <button
          class="btn preset-filled-primary-700-300"
          type="button"
          onclick={() => {
            reading = {
              book: conflict!.book,
              url: conflict!.url,
              cfi: conflict!.localCfi,
              xpath: null,
            };
            conflict = null;
          }}>Continue from this device</button
        >
        <button
          class="btn preset-tonal-primary"
          type="button"
          onclick={() => {
            reading = {
              book: conflict!.book,
              url: conflict!.url,
              cfi: null,
              xpath: conflict!.remote.bookScrollId ?? null,
            };
            conflict = null;
          }}>Continue from Kavita</button
        >
      </div>
    </div>
  </div>
{/if}

{#if settingsVisible}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && (settingsVisible = false)}
  >
    <section
      class="card preset-filled-surface-50-950 relative w-full max-w-md max-h-[88dvh] overflow-auto p-6"
      aria-label="Settings"
      transition:fly={{ y: 16, duration: 150 }}
    >
      <button
        class="btn btn-sm preset-tonal-surface absolute right-4 top-4 h-9 w-9 p-0"
        type="button"
        onclick={() => (settingsVisible = false)}
        aria-label="Close settings"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
          <path
            fill="currentColor"
            d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
          />
        </svg>
      </button>

      <h2 class="font-serif text-3xl">Settings</h2>

      <div class="mt-6">
        <p class="text-xs uppercase tracking-wider text-surface-700-300">Appearance</p>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button
            class="btn {pendingMode === 'light'
              ? 'preset-filled-primary-700-300'
              : 'preset-tonal-surface'}"
            type="button"
            aria-pressed={pendingMode === 'light'}
            onclick={() => void updateMode('light')}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path
                fill="currentColor"
                d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"
              />
            </svg>
            Light
          </button>
          <button
            class="btn {pendingMode === 'dark'
              ? 'preset-filled-primary-700-300'
              : 'preset-tonal-surface'}"
            type="button"
            aria-pressed={pendingMode === 'dark'}
            onclick={() => void updateMode('dark')}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path
                fill="currentColor"
                d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
              />
            </svg>
            Dark
          </button>
        </div>

        <p class="mt-6 text-xs uppercase tracking-wider text-surface-700-300">Theme</p>
        <div class="mt-3 flex flex-wrap gap-2">
          {#each skeletonThemes as option (option)}
            <button
              class="inline-flex h-8 w-10 items-center justify-center overflow-hidden rounded-md {pendingTheme ===
              option
                ? 'preset-filled-primary-700-300'
                : 'preset-tonal-surface'}"
              type="button"
              aria-pressed={pendingTheme === option}
              aria-label={option}
              title={option}
              onclick={() => void updateTheme(option)}
            >
              <span class="flex h-full w-full">
                {#each themeColors[option] as color, index (index)}
                  <span class="h-full flex-1" style:background-color={color}></span>
                {/each}
              </span>
            </button>
          {/each}
        </div>
      </div>

      <div class="mt-7">
        <p class="text-xs uppercase tracking-wider text-surface-700-300">Library</p>
        <dl class="mt-3 space-y-2 text-sm">
          <div class="flex items-center justify-between gap-3">
            <dt class="text-surface-700-300">Server</dt>
            <dd class="truncate text-right">{server.baseUrl}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-surface-700-300">Downloaded storage</dt>
            <dd class="tabular-nums">
              {(
                books.reduce(
                  (sum, book) => sum + (book.downloadPath ? (book.fileSize ?? 0) : 0),
                  0,
                ) / 1_048_576
              ).toFixed(1)} MB
            </dd>
          </div>
        </dl>
      </div>

      <div class="mt-7">
        <p class="text-xs uppercase tracking-wider text-surface-700-300">Maintenance</p>
        <div class="mt-3 grid gap-2">
          <button class="btn preset-tonal-primary" type="button" onclick={clearCache}
            >Clear cover cache</button
          >
          <button class="btn preset-outlined-error-500" type="button" onclick={removeAllDownloads}
            >Remove all downloaded books</button
          >
        </div>
      </div>
    </section>
  </div>
{/if}
