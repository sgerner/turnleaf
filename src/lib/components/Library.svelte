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
  let diagnostics = $state('');
  let pendingTheme = $state<SkeletonTheme>('vintage');
  let pendingMode = $state<'light' | 'dark'>('dark');
  let syncTimer: number | null = null;
  const cleanups: Array<() => Promise<void>> = [];
  const nativePlatform = Capacitor.isNativePlatform();

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

  function openSettings(): void {
    const downloaded = books.filter((book) => book.downloadPath);
    diagnostics = JSON.stringify(
      {
        app: 'Turnleaf',
        version: '0.1.0',
        server: { baseUrl: server.baseUrl, kavitaVersion: server.kavitaVersion },
        booksCached: books.length,
        booksDownloaded: downloaded.length,
        downloadBytes: downloaded.reduce((sum, book) => sum + (book.fileSize ?? 0), 0),
        offline,
      },
      null,
      2,
    );
    settingsVisible = true;
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
  <main class="mx-auto min-h-dvh max-w-6xl px-5 pb-12 pt-[max(2rem,env(safe-area-inset-top))]">
    <header class="flex items-start justify-between gap-4">
      <div class="flex items-center gap-4">
        <TurnleafLogo size={64} wordmark={false} />
        <div>
          <h1 class="mt-2 font-serif text-4xl text-primary-700-300">Turnleaf</h1>
        </div>
      </div>
      <div class="flex gap-2">
        <button
          class="btn btn-sm preset-tonal-surface"
          type="button"
          onclick={openSettings}
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
          class="btn btn-sm preset-tonal-primary"
          type="button"
          onclick={refresh}
          disabled={refreshing}
          aria-label="Refresh library"
          title="Refresh"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M17.65 6.35A7.95 7.95 0 0 0 12 4c-4.41 0-8 3.59-8 8H2l3.89 3.89.07.14L10 12H7a5 5 0 1 1 1.46 3.54l-1.42 1.42A7 7 0 1 0 17.65 6.35Z"
            />
          </svg>
        </button>
      </div>
    </header>
    <div class="mt-6 flex gap-3">
      <label class="grow">
        <span class="sr-only">Search your library</span>
        <input
          class="input preset-tonal-surface"
          type="search"
          placeholder="Search books or authors"
          bind:value={query}
        />
      </label>
      <button
        class="btn btn-sm preset-tonal-surface"
        class:preset-filled-primary-700={downloadedOnly}
        type="button"
        aria-pressed={downloadedOnly}
        onclick={() => (downloadedOnly = !downloadedOnly)}>Downloaded</button
      >
      <button
        class="btn btn-sm preset-tonal-surface"
        class:preset-filled-primary-700={hideCompleted}
        type="button"
        aria-pressed={hideCompleted}
        onclick={() => (hideCompleted = !hideCompleted)}>Hide completed</button
      >
    </div>
    {#if offline}<div class="alert preset-tonal-warning mt-5" role="status" transition:fade>
        Offline. Saved books remain available.
      </div>{/if}
    {#if message}<div class="alert preset-tonal-surface mt-4" role="status" transition:fade>
        {message}
      </div>{/if}
    {#if loading}<p class="mt-16 text-center text-surface-700-300">Opening your saved library...</p>
    {:else if books.length === 0}<p class="mt-16 text-center text-surface-700-300">
        No EPUB books found.
      </p>
    {:else}<section
        class="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
        aria-label="Books"
      >
        {#each visibleBooks as book (book.id)}
          <button class="group text-left" type="button" onclick={() => (selected = book)}>
            <div
              class="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface-200-800 shadow-md"
            >
              <img
                class="h-full w-full object-cover"
                src={covers[book.seriesId] ?? client.coverUrl(book.seriesId)}
                loading="lazy"
                decoding="async"
                alt=""
              />
              <div
                class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/35 to-transparent p-2"
              >
                <div class="h-1 overflow-hidden rounded-full bg-black/35">
                  <div
                    class="h-full bg-primary-600-400"
                    style:width={`${book.pages ? (book.pagesRead / book.pages) * 100 : 0}%`}
                  ></div>
                </div>
              </div>
            </div>
            <h2 class="mt-3 line-clamp-2 font-serif text-lg leading-tight">{book.title}</h2>
            <p class="mt-1 truncate text-sm text-surface-700-300">
              {book.author ?? 'Unknown author'}
            </p>
          </button>
        {/each}
      </section>{/if}
  </main>
{/if}

{#if selected && !reading}
  <div
    class="fixed inset-0 z-20 bg-black/45 p-4"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && (selected = null)}
  >
    <dialog
      open
      class="card preset-filled-surface-50-950 mx-auto mt-[10dvh] max-h-[80dvh] max-w-lg overflow-auto p-6"
      aria-label={selected.title}
      transition:fly={{ y: 16, duration: 150 }}
    >
      <button
        class="btn preset-tonal-surface float-right"
        type="button"
        onclick={() => (selected = null)}>Close</button
      >
      <h2 class="pr-20 font-serif text-3xl">{selected.title}</h2>
      <p class="mt-2 text-surface-700-300">{selected.author}</p>
      {#if selected.descriptionHtml}<p class="mt-5 whitespace-pre-line leading-relaxed">
          {descriptionText(selected.descriptionHtml)}
        </p>{/if}
      <div class="mt-7 flex flex-wrap gap-3">
        {#if selected.downloadPath}<button
            class="btn preset-filled-primary-700"
            type="button"
            disabled={!nativePlatform}
            onclick={() => open(selected!)}>Read</button
          >
          <button
            class="btn preset-outlined-error-500"
            type="button"
            disabled={!nativePlatform}
            onclick={() => remove(selected!)}>Remove download</button
          >
        {:else}<button
            class="btn preset-filled-primary-700"
            type="button"
            disabled={!nativePlatform}
            onclick={() => download(selected!)}>Download EPUB</button
          >{/if}
      </div>
    </dialog>
  </div>
{/if}

{#if conflict}
  <dialog
    open
    class="fixed inset-0 z-30 grid place-items-center bg-black/55 p-5"
    aria-label="Reading position conflict"
  >
    <div class="card preset-filled-surface-50-950 max-w-sm p-6">
      <h2 class="font-serif text-2xl">Choose where to continue</h2>
      <p class="mt-3 text-surface-600-400">
        This device and Kavita both moved since the last sync.
      </p>
      <div class="mt-6 grid gap-3">
        <button
          class="btn preset-filled-primary-700"
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
  </dialog>
{/if}

{#if settingsVisible}
  <dialog
    open
    class="card preset-filled-surface-50-950 fixed top-4 z-40 mx-auto overflow-auto p-6"
    aria-label="Settings and diagnostics"
  >
    <button
      class="btn preset-filled-error-500 float-right"
      type="button"
      onclick={() => (settingsVisible = false)}>X</button
    >
    <h2 class="font-serif text-3xl">Settings</h2>
    <div class="mt-6 grid gap-4">
      <label class="label">
        <span class="label-text">Theme</span>
        <select
          class="select"
          value={pendingTheme}
          onchange={(event) => void updateTheme(event.currentTarget.value as SkeletonTheme)}
        >
          {#each skeletonThemes as option}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </label>
      <label class="label">
        <span class="label-text">Mode</span>
        <select
          class="select"
          value={pendingMode}
          onchange={(event) => void updateMode(event.currentTarget.value as 'light' | 'dark')}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </div>
    <dl class="mt-6 space-y-3 text-sm">
      <div>
        <dt class="text-surface-700-300">Server</dt>
        <dd>{server.baseUrl}</dd>
      </div>
      <div>
        <dt class="text-surface-700-300">Downloaded storage</dt>
        <dd>
          {(
            books.reduce((sum, book) => sum + (book.downloadPath ? (book.fileSize ?? 0) : 0), 0) /
            1_048_576
          ).toFixed(1)} MB
        </dd>
      </div>
    </dl>
    <div class="mt-6 grid gap-3">
      <button class="btn preset-tonal-primary" type="button" onclick={clearCache}
        >Clear cover cache</button
      >
      <button class="btn preset-outlined-error-500" type="button" onclick={removeAllDownloads}
        >Remove all downloaded books</button
      >
    </div>
  </dialog>
{/if}
