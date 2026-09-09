<script lang="ts">
  import { App } from '@capacitor/app';
  import { Capacitor } from '@capacitor/core';
  import { Network } from '@capacitor/network';
  import { tick, onDestroy, onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { fade, fly } from 'svelte/transition';
  import {
    getBooks,
    getReadingState,
    getPreference,
    getSyncStatus,
    markDownloaded,
    markBookCompleted,
    removeDownload,
    removeServer,
    reconcileBooks,
    saveLocalProgress,
    saveServer,
    setPreference,
    type BookRecord,
    type ServerConfig,
    type SyncStatus,
  } from '../database/database';
  import {
    cacheCover,
    clearCoverCache,
    deleteDownloadedEpub,
    downloadEpub,
    verifyDownloadedEpub,
  } from '../downloads/native-download';
  import {
    createSharedCoverLoader,
    loadCoversWithConcurrency,
    type CoverLoadItem,
  } from '../downloads/cover-loader';
  import { KavitaClient } from '../kavita/client';
  import { mapSeriesToBooks } from '../kavita/mapper';
  import type { KavitaProgress } from '../kavita/types';
  import type { ReaderLocation } from '../reader/session';
  import { removeApiKey, saveApiKey } from '../native/credentials';
  import { chooseOpenProgress, shouldPreferFurthest, toKavitaPageNumber } from '../sync/conflict';
  import { flushProgress } from '../sync/sync';
  import Reader from './Reader.svelte';
  import TurnleafLogo from './TurnleafLogo.svelte';
  import { calculateVirtualWindow, type VirtualWindow } from './library-virtualization';
  import { focusFirstElement, restoreFocus, trapModalKeydown } from '../a11y/modal-focus';

  const skeletonThemes = [
    'catppuccin',
    'cerberus',
    'concord',
    'crimson',
    'eink',
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

  // Primary/secondary/tertiary-500 colors for each Skeleton theme (extracted from
  // node_modules/@skeletonlabs/skeleton/src/themes/*.css and src/lib/themes/*.css
  // - for locally authored themes). Hardcoded because Skeleton v4 switches theme
  // variables globally; arbitrary child elements with data-theme do not inherit a
  // different theme's palette.
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
    eink: ['oklch(0.5 0 0)', 'oklch(0.5 0 0)', 'oklch(0.5 0 0)'],
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
    onApiKeyChange,
    onServerDeleted,
  }: {
    server: ServerConfig;
    apiKey: string;
    theme: string;
    mode: 'light' | 'dark';
    onThemeChange: (theme: SkeletonTheme) => void;
    onModeChange: (mode: 'light' | 'dark') => void;
    onApiKeyChange: (apiKey: string) => void;
    onServerDeleted: () => void;
  } = $props();
  type LibrarySortOrder = 'title' | 'author' | 'recent';
  type LibraryViewMode = 'grid' | 'list';
  const client = $derived(new KavitaClient(server.baseUrl, apiKey));
  const sharedCoverLoader = createSharedCoverLoader<string>(async (seriesId, signal) => {
    if (Capacitor.isNativePlatform()) {
      return cacheCover(client.coverUrl(seriesId), apiKey, seriesId, signal, server.id);
    }
    const blob = await client.getCover(seriesId, signal);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return URL.createObjectURL(blob);
  });
  let books = $state<BookRecord[]>([]);
  let query = $state('');
  let downloadedOnly = $state(false);
  let hideCompleted = $state(true);
  let normalizedQuery = $derived(query.trim().toLowerCase());
  let sortOrder = $state<LibrarySortOrder>('title');
  let authorFilter = $state('');
  let seriesFilter = $state('');
  let filtersVisible = $state(false);
  let viewMode = $state<LibraryViewMode>('grid');
  let advancedFiltersActive = $derived(
    sortOrder !== 'title' || Boolean(authorFilter) || Boolean(seriesFilter),
  );
  let libraryFiltersActive = $derived(
    Boolean(query.trim()) || downloadedOnly || hideCompleted || advancedFiltersActive,
  );
  let authors = $derived(
    [
      ...new Set(
        books.map((book) => book.author).filter((author): author is string => Boolean(author)),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  );
  let seriesNames = $derived(
    [
      ...new Set(
        books.map((book) => book.series).filter((series): series is string => Boolean(series)),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  );
  let visibleBooks = $derived.by(() => {
    const filtered = books.filter((book) => {
      const matchesQuery = `${book.title} ${book.author ?? ''} ${book.series ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery);
      const retainedOffline = book.remoteAvailable === false && Boolean(book.downloadPath);
      const completed = book.pages > 0 && book.pagesRead >= book.pages;
      return (
        matchesQuery &&
        (book.remoteAvailable !== false || retainedOffline) &&
        (!downloadedOnly || Boolean(book.downloadPath)) &&
        (!hideCompleted || !completed) &&
        (!authorFilter || book.author === authorFilter) &&
        (!seriesFilter || book.series === seriesFilter)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortOrder === 'recent') {
        return (
          (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '') || a.title.localeCompare(b.title)
        );
      }
      if (sortOrder === 'author') {
        return (
          (a.author ?? '').localeCompare(b.author ?? '') ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id)
        );
      }
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
  });
  // Surface the most recently read, downloaded, in-progress book as a one-tap resume.
  let continueBook = $derived.by(() => {
    let latest: BookRecord | null = null;
    for (const book of books) {
      if (!book.downloadPath || book.pages <= 0 || book.pagesRead >= book.pages || !book.lastReadAt)
        continue;
      if (!latest || book.lastReadAt.localeCompare(latest.lastReadAt ?? '') > 0) latest = book;
    }
    return latest;
  });
  let reading = $state<{
    book: BookRecord;
    url: string;
    cfi: string | null;
    xpath: string | null;
    percentage: number | null;
  } | null>(null);
  let readerBackHandler: (() => boolean) | null = null;
  let conflict = $state<{
    book: BookRecord;
    url: string;
    localCfi: string;
    remote: KavitaProgress;
  } | null>(null);
  let covers = $state<Record<number, string>>({});
  let loading = $state(true);
  let refreshing = $state(false);
  let downloadingBookId = $state<string | null>(null);
  let offline = $state(false);
  let message = $state('');
  let syncStatus = $state<SyncStatus>({
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
    lastUpdatedAt: null,
  });
  let syncing = $state(false);
  let settingsVisible = $state(false);
  let pendingTheme = $state<SkeletonTheme>('vintage');
  let pendingMode = $state<'light' | 'dark'>('dark');
  let pendingAutoSync = $state(false);
  let replacementApiKey = $state('');
  let settingsError = $state('');
  let replacingApiKey = $state(false);
  let deletingServer = $state(false);
  let confirmDeleteServer = $state(false);
  let credentialCleanupComplete = false;
  let actionMenuBook = $state<BookRecord | null>(null);
  let actionMenuDialog = $state<HTMLElement | null>(null);
  let conflictDialog = $state<HTMLElement | null>(null);
  let settingsDialog = $state<HTMLElement | null>(null);
  let actionMenuOpener: HTMLElement | null = null;
  let conflictOpener: HTMLElement | null = null;
  let settingsOpener: HTMLElement | null = null;
  let libraryMain = $state<HTMLElement | null>(null);
  let virtualGrid = $state<HTMLElement | null>(null);
  let gridColumns = $state(2);
  let rowHeight = $state(400);
  let virtualWindow = $state<VirtualWindow>(calculateVirtualWindow(0, 2, 400, 0, 0));
  let scrollTarget: HTMLElement | Window | null = null;
  let virtualizationFrame: number | null = null;
  let syncTimer: number | null = null;
  const cleanups: Array<() => Promise<void>> = [];
  const SERIES_DETAIL_BATCH_SIZE = 8;
  const VIRTUALIZATION_OVERSCAN_ROWS = 2;
  const GRID_GAP_PX = 16;
  const GRID_ROW_GAP_PX = 32;
  const CARD_TEXT_HEIGHT_PX = 80;
  const COVER_LOAD_CONCURRENCY = 6;
  let destroyed = false;
  let coverLoadController: AbortController | null = null;
  let coverLoadGeneration = 0;

  function progressOf(book: BookRecord): number {
    return book.pages ? Math.min(100, (book.pagesRead / book.pages) * 100) : 0;
  }

  function parseSortOrder(value: string | null): LibrarySortOrder {
    return value === 'author' || value === 'recent' ? value : 'title';
  }

  function parseViewMode(value: string | null): LibraryViewMode {
    return value === 'list' ? 'list' : 'grid';
  }

  function handleSortChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    sortOrder = parseSortOrder(value);
    void setPreference('librarySort', sortOrder);
  }

  function handleAuthorChange(event: Event): void {
    authorFilter = (event.currentTarget as HTMLSelectElement).value;
    void setPreference('libraryAuthor', authorFilter);
  }

  function handleSeriesChange(event: Event): void {
    seriesFilter = (event.currentTarget as HTMLSelectElement).value;
    void setPreference('librarySeries', seriesFilter);
  }

  function handleViewModeChange(next: LibraryViewMode): void {
    viewMode = next;
    void setPreference('libraryView', next);
    scheduleVirtualWindow();
  }

  function clearFilters(): void {
    query = '';
    downloadedOnly = false;
    hideCompleted = false;
    authorFilter = '';
    seriesFilter = '';
    sortOrder = 'title';
    void setPreference('librarySort', sortOrder);
    void setPreference('libraryAuthor', authorFilter);
    void setPreference('librarySeries', seriesFilter);
  }

  function activeElement(): HTMLElement | null {
    return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  function focusModal(getDialog: () => HTMLElement | null): void {
    void tick().then(() => focusFirstElement(getDialog()));
  }

  function insecureServer(): boolean {
    return server.baseUrl.toLowerCase().startsWith('http://');
  }

  function columnsForWidth(width: number): number {
    if (viewMode === 'list') return 1;
    if (width >= 1024) return 5;
    if (width >= 768) return 4;
    if (width >= 640) return 3;
    return 2;
  }

  function rowHeightFor(width: number, columns: number): number {
    if (viewMode === 'list') return 112;
    const cardWidth = Math.max(0, (width - (columns - 1) * GRID_GAP_PX) / columns);
    return Math.max(1, Math.ceil(cardWidth * 1.5 + CARD_TEXT_HEIGHT_PX + GRID_ROW_GAP_PX));
  }

  function scheduleVirtualWindow(): void {
    if (
      destroyed ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      virtualizationFrame !== null
    ) {
      return;
    }
    virtualizationFrame = window.requestAnimationFrame(() => {
      virtualizationFrame = null;
      updateVirtualWindow();
    });
  }

  function updateVirtualWindow(): void {
    if (destroyed || !virtualGrid) return;
    const width = virtualGrid.clientWidth;
    const nextColumns = width > 0 ? columnsForWidth(width) : gridColumns;
    const nextRowHeight = width > 0 ? rowHeightFor(width, nextColumns) : rowHeight;
    if (gridColumns !== nextColumns) gridColumns = nextColumns;
    if (rowHeight !== nextRowHeight) rowHeight = nextRowHeight;

    const gridRect = virtualGrid.getBoundingClientRect();
    const scrollContainer = libraryMain?.closest<HTMLElement>('.app-stage');
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const listTop = gridRect.top - containerRect.top + scrollContainer.scrollTop;
      virtualWindow = preserveFocusedRow(
        calculateVirtualWindow(
          visibleBooks.length,
          nextColumns,
          nextRowHeight,
          scrollContainer.scrollTop - listTop,
          scrollContainer.clientHeight,
          VIRTUALIZATION_OVERSCAN_ROWS,
        ),
      );
      return;
    }
    if (typeof window === 'undefined') return;
    virtualWindow = preserveFocusedRow(
      calculateVirtualWindow(
        visibleBooks.length,
        nextColumns,
        nextRowHeight,
        -gridRect.top,
        window.innerHeight,
        VIRTUALIZATION_OVERSCAN_ROWS,
      ),
    );
  }

  function preserveFocusedRow(next: VirtualWindow): VirtualWindow {
    if (next.totalRows === 0 || typeof document === 'undefined') return next;
    const activeBookId =
      document.activeElement?.closest<HTMLElement>('[data-book-id]')?.dataset.bookId;
    if (!activeBookId) return next;
    const bookIndex = visibleBooks.findIndex((book) => book.id === activeBookId);
    if (bookIndex < 0) return next;
    const focusedRow = Math.floor(bookIndex / gridColumns);
    const firstRow = Math.min(next.firstRow, focusedRow);
    const lastRow = Math.max(next.lastRow, focusedRow);
    return {
      ...next,
      firstRow,
      lastRow,
      startIndex: firstRow * gridColumns,
      endIndex: Math.min(visibleBooks.length, (lastRow + 1) * gridColumns),
    };
  }

  $effect(() => {
    if (visibleBooks.length > 0) scheduleVirtualWindow();
  });

  $effect(() => {
    if (viewMode === 'grid' || viewMode === 'list') scheduleVirtualWindow();
  });

  $effect(() => {
    if (!virtualGrid || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => scheduleVirtualWindow());
    observer.observe(virtualGrid);
    scheduleVirtualWindow();
    return () => observer.disconnect();
  });

  onMount(async () => {
    const scrollContainer = libraryMain?.closest<HTMLElement>('.app-stage');
    scrollTarget = scrollContainer ?? window;
    scrollTarget.addEventListener('scroll', scheduleVirtualWindow, { passive: true });
    window.addEventListener('resize', scheduleVirtualWindow);
    scheduleVirtualWindow();

    const savedTheme = await getPreference('uiTheme');
    if (destroyed) return;
    const savedMode = await getPreference('uiMode');
    if (destroyed) return;
    const savedAutoSync = await getPreference('syncFurthest');
    if (destroyed) return;
    const savedSort = await getPreference('librarySort');
    if (destroyed) return;
    const savedAuthor = await getPreference('libraryAuthor');
    if (destroyed) return;
    const savedSeries = await getPreference('librarySeries');
    if (destroyed) return;
    const savedView = await getPreference('libraryView');
    if (destroyed) return;
    pendingTheme = (savedTheme as SkeletonTheme | null) ?? (theme as SkeletonTheme);
    pendingMode = savedMode === 'light' ? 'light' : mode;
    pendingAutoSync = savedAutoSync === null ? true : savedAutoSync === 'true';
    sortOrder = parseSortOrder(savedSort);
    authorFilter = savedAuthor ?? '';
    seriesFilter = savedSeries ?? '';
    viewMode = parseViewMode(savedView);
    books = await getBooks(server.id);
    if (destroyed) return;
    await refreshSyncStatus();
    if (destroyed) return;
    retainCoversFor(books);
    void loadCovers(books);
    loading = false;
    offline = !(await Network.getStatus()).connected;
    if (destroyed) return;
    if (!offline) await refresh();
    if (destroyed) return;
    cleanups.push(
      await registerListener(
        await Network.addListener('networkStatusChange', ({ connected }) => {
          if (destroyed) return;
          offline = !connected;
          if (connected)
            void syncProgress(false)
              .then(refresh)
              .catch(() => {});
        }),
      ),
    );
    cleanups.push(
      await registerListener(
        await App.addListener('appStateChange', ({ isActive }) => {
          if (!destroyed && !isActive) void syncProgress(false);
        }),
      ),
    );
    cleanups.push(
      await registerListener(
        await App.addListener('backButton', () => {
          if (destroyed) return;
          if (actionMenuBook) closeMenu();
          else if (reading) {
            if (readerBackHandler || document.querySelector('[data-reader-panel]')) return;
            reading = null;
          } else if (settingsVisible) closeSettings();
          else void App.exitApp();
        }),
      ),
    );
  });

  async function registerListener(handle: {
    remove: () => Promise<void>;
  }): Promise<() => Promise<void>> {
    if (destroyed) {
      await handle.remove();
      return async () => {};
    }
    return handle.remove;
  }

  async function refreshSyncStatus(): Promise<void> {
    try {
      syncStatus = await getSyncStatus();
    } catch {
      // A status read must not block opening the saved library.
    }
  }

  async function syncProgress(showFeedback = true): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      if (offline) {
        if (showFeedback)
          message = 'Offline. Reading progress will retry when Kavita is available.';
        return;
      }
      await flushProgress(client);
      if (showFeedback) message = 'Reading progress synced.';
    } catch {
      if (showFeedback)
        message = 'Some reading progress is waiting to sync. Try again when online.';
    } finally {
      await refreshSyncStatus();
      syncing = false;
    }
  }

  onDestroy(() => {
    destroyed = true;
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    if (virtualizationFrame !== null) window.cancelAnimationFrame(virtualizationFrame);
    scrollTarget?.removeEventListener('scroll', scheduleVirtualWindow);
    window.removeEventListener('resize', scheduleVirtualWindow);
    cancelCoverLoading();
    clearCovers();
    sharedCoverLoader.cancel();
    cleanups.forEach((remove) => void remove());
  });

  async function refresh(): Promise<void> {
    if (destroyed || refreshing) return;
    refreshing = true;
    cancelCoverLoading();
    message = '';
    try {
      const series = await client.getBookSeries();
      const mapped: BookRecord[] = [];
      for (let index = 0; index < series.length; index += SERIES_DETAIL_BATCH_SIZE) {
        if (destroyed) return;
        const batch = series.slice(index, index + SERIES_DETAIL_BATCH_SIZE);
        mapped.push(
          ...(
            await Promise.all(
              batch.map(async (item) =>
                mapSeriesToBooks(server.id, item, await client.getSeriesDetail(item.id)),
              ),
            )
          ).flat(),
        );
      }
      if (destroyed) return;
      // Reconcile only after every series page and detail batch completed.
      // Errors and lifecycle cancellation leave the last known local library intact.
      await reconcileBooks(server.id, mapped);
      if (destroyed) return;
      books = await getBooks(server.id);
      retainCoversFor(books);
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

  function cancelCoverLoading(): void {
    coverLoadController?.abort();
    coverLoadController = null;
    coverLoadGeneration += 1;
  }

  function revokeBrowserCover(cover: string): void {
    if (cover.startsWith('blob:')) URL.revokeObjectURL(cover);
  }

  function clearCovers(): void {
    for (const cover of Object.values(covers)) revokeBrowserCover(cover);
    covers = {};
  }

  function retainCoversFor(items: BookRecord[]): void {
    const seriesIds = new Set(items.map((item) => item.seriesId));
    const retained = Object.fromEntries(
      Object.entries(covers).filter(([seriesId]) => seriesIds.has(Number(seriesId))),
    );
    for (const [seriesId, cover] of Object.entries(covers)) {
      if (!seriesIds.has(Number(seriesId))) revokeBrowserCover(cover);
    }
    covers = retained;
  }

  async function loadCovers(items: BookRecord[]): Promise<void> {
    if (destroyed) return;
    cancelCoverLoading();
    const controller = new AbortController();
    const generation = coverLoadGeneration;
    coverLoadController = controller;
    const priority: BookRecord[] = [];
    if (continueBook) priority.push(continueBook);
    const firstVisibleIndex =
      virtualWindow.endIndex > virtualWindow.startIndex ? virtualWindow.startIndex : 0;
    const visibleEndIndex =
      virtualWindow.endIndex > virtualWindow.startIndex
        ? virtualWindow.endIndex
        : Math.min(visibleBooks.length, gridColumns * 3);
    priority.push(...visibleBooks.slice(firstVisibleIndex, visibleEndIndex));
    const ordered = [...priority, ...items];
    const prioritizedItems: CoverLoadItem[] = [];
    const seenSeries = new SvelteSet<number>();
    for (const book of ordered) {
      if (seenSeries.has(book.seriesId)) continue;
      seenSeries.add(book.seriesId);
      prioritizedItems.push({ seriesId: book.seriesId });
    }
    try {
      await loadCoversWithConcurrency(prioritizedItems, {
        signal: controller.signal,
        concurrency: COVER_LOAD_CONCURRENCY,
        hasCover: (seriesId) => Boolean(covers[seriesId]),
        load: (seriesId) => sharedCoverLoader.load(seriesId),
        dispose: revokeBrowserCover,
        onLoaded: (seriesId, cover) => {
          if (destroyed || controller.signal.aborted || generation !== coverLoadGeneration) {
            revokeBrowserCover(cover);
            return;
          }
          const previous = covers[seriesId];
          if (previous && previous !== cover) revokeBrowserCover(previous);
          covers = {
            ...covers,
            [seriesId]: cover,
          };
        },
      });
    } finally {
      if (coverLoadController === controller) coverLoadController = null;
    }
  }

  async function download(book: BookRecord): Promise<BookRecord | null> {
    if (downloadingBookId) return null;
    downloadingBookId = book.id;
    message = `Downloading ${book.title}...`;
    try {
      const file = await downloadEpub(
        client.downloadUrl(book.chapterId),
        apiKey,
        book.id.replaceAll(':', '-'),
      );
      await markDownloaded(book.id, file.relativePath, file.size);
      const refreshed = {
        ...book,
        downloadPath: file.relativePath,
        downloadStatus: 'downloaded',
        fileSize: file.size,
      };
      books = books.map((item) => (item.id === book.id ? refreshed : item));
      message = `${book.title} is ready offline.`;
      return refreshed;
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error === 'object' && error !== null
            ? String('code' in error ? error.code : 'native error')
            : String(error);
      console.error(`EPUB download failed: ${detail}`);
      message = 'The download was interrupted. Try again when Kavita is available.';
      return null;
    } finally {
      downloadingBookId = null;
    }
  }

  async function remove(book: BookRecord): Promise<boolean> {
    try {
      if (book.downloadPath) await deleteDownloadedEpub(book.downloadPath);
      await removeDownload(book.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'storage error';
      message = `Could not remove ${book.title}: ${detail}`;
      return false;
    }
    books = books.map((item) =>
      item.id === book.id
        ? {
            ...item,
            downloadPath: null,
            downloadStatus: 'missing',
            fileSize: null,
          }
        : item,
    );
    return true;
  }

  async function open(book: BookRecord, options: { preferFurthest?: boolean } = {}): Promise<void> {
    if (!book.downloadPath) {
      const refreshed = await download(book);
      if (refreshed) await open(refreshed, options);
      return;
    }
    const file = await verifyDownloadedEpub(book.downloadPath);
    if (!file) {
      await removeDownload(book.id);
      message = 'The downloaded file is missing. Download it again.';
      books = await getBooks(server.id);
      const refreshed = books.find((item) => item.id === book.id) ?? null;
      if (refreshed) await open(refreshed, options);
      return;
    }
    const local = await getReadingState(book.id);
    const remote = offline ? null : await client.getProgress(book.chapterId).catch(() => null);
    const preferFurthest = shouldPreferFurthest(pendingAutoSync, options.preferFurthest);
    const openProgress = chooseOpenProgress(local, remote, book.pages, preferFurthest);
    if (openProgress === 'remote') {
      reading = {
        book,
        url: file.webViewUrl,
        cfi: null,
        xpath: remote?.bookScrollId ?? null,
        percentage: remote ? remotePercentage(remote, book) : null,
      };
      return;
    }
    if (openProgress === 'local') {
      reading = {
        book,
        url: file.webViewUrl,
        cfi: local?.cfi ?? null,
        xpath: null,
        percentage: null,
      };
      if (preferFurthest) void syncProgress(false);
      return;
    }
    if (openProgress === 'conflict' && local && remote) {
      openConflict({ book, url: file.webViewUrl, localCfi: local.cfi, remote });
      return;
    }
    reading = {
      book,
      url: file.webViewUrl,
      cfi: local?.cfi ?? null,
      xpath: local ? null : (remote?.bookScrollId ?? null),
      percentage:
        !local && remote
          ? remotePercentage(remote, book)
          : !local
            ? metadataPercentage(book)
            : null,
    };
  }

  function remotePercentage(remote: KavitaProgress, book: BookRecord): number | null {
    if (!book.pages || remote.pageNum <= 0) return null;
    return Math.max(0, Math.min(0.999, remote.pageNum / book.pages));
  }

  function metadataPercentage(book: BookRecord): number | null {
    if (!book.pages || book.pagesRead <= 0) return null;
    return Math.max(0, Math.min(0.999, book.pagesRead / book.pages));
  }

  async function relocated(book: BookRecord, location: ReaderLocation): Promise<void> {
    await saveLocalProgress(
      book,
      location.cfi,
      location.xpath,
      location.percentage,
      location.spineIndex,
    );
    const pagesRead = toKavitaPageNumber(location.percentage, book.pages, location.spineIndex);
    const lastReadAt = new Date().toISOString();
    books = books.map((item) => (item.id === book.id ? { ...item, pagesRead, lastReadAt } : item));
    await refreshSyncStatus();
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => void syncProgress(false), 2_500);
  }

  async function syncLatestForReader(
    book: BookRecord,
  ): Promise<{ xpath: string | null; percentage: number | null } | null> {
    if (offline) return null;
    const remote = await client.getProgress(book.chapterId).catch(() => null);
    if (!remote) return null;
    return {
      xpath: remote.bookScrollId ?? null,
      percentage: remotePercentage(remote, book),
    };
  }

  async function markDone(book: BookRecord): Promise<void> {
    const readingState = await getReadingState(book.id);
    await markBookCompleted(book, readingState);
    books = books.map((item) =>
      item.id === book.id
        ? {
            ...item,
            pagesRead: book.pages,
            lastReadAt: new Date().toISOString(),
          }
        : item,
    );
    void syncProgress(false);
    message = `${book.title} marked as read.`;
    closeMenu();
  }

  async function syncFurthest(book: BookRecord): Promise<void> {
    closeMenu();
    await open(book, { preferFurthest: true });
  }

  function openMenu(book: BookRecord): void {
    actionMenuOpener = activeElement();
    actionMenuBook = book;
    focusModal(() => actionMenuDialog);
  }

  function closeMenu(): void {
    actionMenuBook = null;
    const opener = actionMenuOpener;
    actionMenuOpener = null;
    restoreFocus(opener);
  }

  function openConflict(next: NonNullable<typeof conflict>): void {
    conflictOpener = activeElement();
    conflict = next;
    focusModal(() => conflictDialog);
  }

  function closeConflict(): void {
    conflict = null;
    const opener = conflictOpener;
    conflictOpener = null;
    restoreFocus(opener);
  }

  function openSettings(): void {
    settingsOpener = activeElement();
    settingsVisible = true;
    focusModal(() => settingsDialog);
  }

  function closeSettings(): void {
    settingsVisible = false;
    const opener = settingsOpener;
    settingsOpener = null;
    restoreFocus(opener);
  }

  async function removeAllDownloads(): Promise<void> {
    const candidates = books.filter((item) => item.downloadPath);
    const failed: string[] = [];
    for (const book of candidates) {
      if (!(await remove(book))) failed.push(book.title);
    }
    if (failed.length === 0) {
      message = candidates.length
        ? `Removed ${candidates.length} downloaded book${candidates.length === 1 ? '' : 's'}. Kavita was not changed.`
        : 'No downloaded books to remove.';
    } else {
      const succeeded = candidates.length - failed.length;
      const names = failed.slice(0, 2).join(', ');
      message = `${succeeded} download${succeeded === 1 ? '' : 's'} removed; ${failed.length} could not be removed (${names}${failed.length > 2 ? ', …' : ''}). Try again.`;
    }
    closeSettings();
  }

  async function clearCache(): Promise<void> {
    cancelCoverLoading();
    await sharedCoverLoader.waitForIdle();
    if (destroyed) return;
    await clearCoverCache();
    if (destroyed) return;
    clearCovers();
    void loadCovers(books);
    message = 'Cover cache cleared.';
    closeSettings();
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

  async function updateAutoSync(next: boolean): Promise<void> {
    pendingAutoSync = next;
    await setPreference('syncFurthest', String(next));
  }

  function handleRelocated(location: ReaderLocation): void {
    if (!reading) return;
    void relocated(reading.book, location);
  }

  function registerReaderBackHandler(handler: () => boolean): () => void {
    readerBackHandler = handler;
    return () => {
      if (readerBackHandler === handler) readerBackHandler = null;
    };
  }

  async function updateApiKey(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    settingsError = '';
    replacingApiKey = true;
    try {
      const nextKey = replacementApiKey.trim();
      if (!nextKey) throw new Error('Enter a new Kavita auth key.');

      const result = await new KavitaClient(server.baseUrl, nextKey).testConnection();
      if (result.bookLibraries.length === 0) {
        throw new Error(
          'This account has no book or light novel libraries. Only EPUB books are supported.',
        );
      }

      const updatedServer: ServerConfig = {
        ...server,
        kavitaVersion: result.version,
        lastConnectedAt: new Date().toISOString(),
      };
      await saveApiKey(server.credentialRef, nextKey);
      await saveServer(updatedServer);
      onApiKeyChange(nextKey);
      replacementApiKey = '';
      message = 'API key updated.';
      closeSettings();
    } catch (cause) {
      settingsError =
        cause instanceof Error ? cause.message : 'Turnleaf could not update the API key.';
    } finally {
      replacingApiKey = false;
    }
  }

  async function deleteServer(): Promise<void> {
    settingsError = '';
    deletingServer = true;
    try {
      for (const book of books.filter((item) => item.downloadPath)) await remove(book);
      cancelCoverLoading();
      await clearCoverCache().catch(() => {});
      clearCovers();
      if (!credentialCleanupComplete) {
        await removeApiKey(server.credentialRef);
        credentialCleanupComplete = true;
      }
      await removeServer(server.id);
      onServerDeleted();
      message = 'Server removed. Add it again to browse the library.';
      closeSettings();
    } catch (cause) {
      settingsError = credentialCleanupComplete
        ? 'The auth key was removed, but the local server configuration could not be cleared. Retry Delete server to finish cleanup.'
        : cause instanceof Error
          ? `Could not remove the server safely: ${cause.message} The connection was left in place; retry Delete server.`
          : 'Could not remove the server safely. The connection was left in place; retry Delete server.';
    } finally {
      deletingServer = false;
      confirmDeleteServer = false;
    }
  }
</script>

{#if reading}
  <Reader
    bookUrl={reading.url}
    bookId={reading.book.id}
    title={reading.book.title}
    initialCfi={reading.cfi}
    initialXPath={reading.xpath}
    initialPercentage={reading.percentage}
    onBack={() => (reading = null)}
    onRelocated={handleRelocated}
    onSyncLatest={() => syncLatestForReader(reading!.book)}
    registerBackHandler={registerReaderBackHandler}
  />
{:else}
  <main
    bind:this={libraryMain}
    class="mx-auto min-h-full max-w-6xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-6"
    inert={Boolean(actionMenuBook || conflict || settingsVisible)}
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
          class="btn btn-sm preset-tonal-surface h-11 w-11 !p-0"
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
          class="btn btn-sm preset-tonal-surface h-11 w-11 !p-0"
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
      <button
        class="card preset-tonal-surface mt-6 flex w-full cursor-pointer items-center gap-4 p-3 text-left sm:gap-5 sm:p-4"
        type="button"
        aria-label={`Continue reading ${continueBook.title}`}
        onclick={() => void open(continueBook!)}
        transition:fade
      >
        {#if covers[continueBook.seriesId]}
          <img
            class="h-24 w-16 shrink-0 rounded-lg object-cover shadow-md sm:h-28 sm:w-20"
            src={covers[continueBook.seriesId]}
            loading="lazy"
            decoding="async"
            alt=""
          />
        {:else}
          <div
            class="h-24 w-16 shrink-0 rounded-lg shadow-md preset-filled-surface-200-800 sm:h-28 sm:w-20"
            aria-hidden="true"
          ></div>
        {/if}
        <div class="min-w-0 flex-1">
          <p class="text-xs uppercase tracking-wider text-surface-700-300">Continue reading</p>
          <h2 class="mt-0.5 truncate font-serif text-xl leading-tight text-surface-950-50">
            {continueBook.title}
          </h2>
          <p class="mt-0.5 truncate text-sm text-surface-700-300">
            {continueBook.author ?? 'Unknown author'}
          </p>
          <div class="mt-2 flex items-center gap-2">
            <div
              class="h-2 flex-1 overflow-hidden rounded-full preset-filled-surface-200-800"
              role="progressbar"
              aria-label={`Reading progress for ${continueBook.title}`}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.round(progressOf(continueBook))}
              aria-valuetext={`${Math.round(progressOf(continueBook))}% complete`}
            >
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
      </button>
    {/if}

    <div class="mt-5 flex flex-col sm:flex-row sm:items-center">
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
          class="input preset-tonal-surface h-10 pl-10 pr-10 text-sm"
          type="search"
          placeholder="Search books or authors"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="btn btn-sm absolute right-1 top-1/2 h-11 w-11 -translate-y-1/2 p-0 preset-filled-surface-200-800"
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
      <div
        class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
        role="group"
        aria-label="Library filters"
      >
        <button
          class="h-10 !px-2 !py-0 btn btn-sm !text-sm rounded-none {downloadedOnly
            ? 'preset-filled-primary-700-300'
            : 'preset-filled-tertiary-100-900'}"
          type="button"
          aria-pressed={downloadedOnly}
          onclick={() => (downloadedOnly = !downloadedOnly)}
          title="Show only downloaded books"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
            <path fill="currentColor" d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
          </svg>
          <span>Downloaded Only</span>
        </button>
        <button
          class="h-10 !px-2 !py-0 btn btn-sm !text-sm rounded-none {hideCompleted
            ? 'preset-filled-secondary-100-900'
            : 'preset-filled-primary-700-300'}"
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
        <button
          class="btn btn-sm h-10 w-11 !p-0 rounded-none {filtersVisible || advancedFiltersActive
            ? 'preset-filled-primary-700-300'
            : 'preset-filled-tertiary-100-900'}"
          type="button"
          aria-expanded={filtersVisible}
          aria-controls="library-filter-panel"
          aria-label={filtersVisible ? 'Hide library filters' : 'Show library filters'}
          title="More filters and sorting"
          onclick={() => (filtersVisible = !filtersVisible)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M3 5h18v2H3V5zm3 6h12v2H6v-2zm3 6h6v2H9v-2z" />
          </svg>
        </button>
        {#if libraryFiltersActive}
          <button
            class="btn btn-sm h-10 w-11 !p-0 rounded-none preset-tonal-surface"
            type="button"
            onclick={clearFilters}
            aria-label="Clear library filters"
            title="Clear filters"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        {/if}
      </div>
      {#if filtersVisible}
        <div
          id="library-filter-panel"
          class="preset-tonal-surface mt-3 rounded-xl border border-surface-300/40 p-4"
          role="region"
          aria-labelledby="library-filter-panel-title"
          transition:fly={{ y: -8, duration: 160 }}
        >
          <div class="flex items-center justify-between gap-3">
            <h2 id="library-filter-panel-title" class="text-sm font-medium">More filters</h2>
            {#if advancedFiltersActive}
              <span class="text-xs text-surface-700-300">Filters active</span>
            {/if}
          </div>
          <div class="mt-3 grid gap-3 sm:grid-cols-3">
            <label class="label">
              <span class="label-text">Sort order</span>
              <select
                class="select preset-tonal-surface"
                aria-label="Sort books"
                value={sortOrder}
                onchange={handleSortChange}
              >
                <option value="title">Title</option>
                <option value="author">Author</option>
                <option value="recent">Recently read</option>
              </select>
            </label>
            <label class="label">
              <span class="label-text">Author</span>
              <select
                class="select preset-tonal-surface"
                aria-label="Filter by author"
                value={authorFilter}
                onchange={handleAuthorChange}
              >
                <option value="">All authors</option>
                {#each authors as author (author)}
                  <option value={author}>{author}</option>
                {/each}
              </select>
            </label>
            <label class="label">
              <span class="label-text">Series</span>
              <select
                class="select preset-tonal-surface"
                aria-label="Filter by series"
                value={seriesFilter}
                onchange={handleSeriesChange}
              >
                <option value="">All series</option>
                {#each seriesNames as series (series)}
                  <option value={series}>{series}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>
      {/if}
    </div>

    {#if !loading && books.length > 0}
      <div
        class="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-surface-700-300"
      >
        <p>{visibleBooks.length} of {books.length} books</p>
        <div class="flex items-center gap-1" role="group" aria-label="Library view">
          <button
            class="btn btn-sm h-10 {viewMode === 'grid'
              ? 'preset-filled-primary-700-300'
              : 'preset-tonal-surface'}"
            type="button"
            aria-pressed={viewMode === 'grid'}
            onclick={() => handleViewModeChange('grid')}
          >
            Grid
          </button>
          <button
            class="btn btn-sm h-10 {viewMode === 'list'
              ? 'preset-filled-primary-700-300'
              : 'preset-tonal-surface'}"
            type="button"
            aria-pressed={viewMode === 'list'}
            onclick={() => handleViewModeChange('list')}
          >
            List
          </button>
        </div>
      </div>
    {/if}

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
    {#if syncStatus.pendingCount > 0}
      <div
        class="alert preset-tonal-warning mt-4 flex flex-wrap items-center justify-between gap-3"
        role="status"
      >
        <div class="min-w-0">
          <p>
            {syncStatus.failedCount > 0
              ? `${syncStatus.failedCount} reading progress update${syncStatus.failedCount === 1 ? '' : 's'} failed and remain queued.`
              : `${syncStatus.pendingCount} reading progress update${syncStatus.pendingCount === 1 ? '' : 's'} waiting to sync.`}
          </p>
          {#if syncStatus.lastError}
            <p class="mt-1 truncate text-xs opacity-80">Last error: {syncStatus.lastError}</p>
          {/if}
        </div>
        <button
          class="btn btn-sm preset-tonal-warning h-10 shrink-0"
          type="button"
          onclick={() => void syncProgress()}
          disabled={syncing || offline}
        >
          {syncing ? 'Retrying...' : 'Retry sync'}
        </button>
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
        bind:this={virtualGrid}
        class="relative mt-8"
        style={`height: ${Math.max(0, virtualWindow.totalHeight - GRID_ROW_GAP_PX)}px`}
        aria-label="Books"
      >
        {#each Array.from( { length: virtualWindow.lastRow - virtualWindow.firstRow + 1 } ) as _, rowOffset (rowOffset)}
          {@const rowIndex = virtualWindow.firstRow + rowOffset}
          {@const rowStart = rowIndex * gridColumns}
          {@const rowEnd = Math.min(visibleBooks.length, rowStart + gridColumns)}
          <div
            class="absolute inset-x-0 grid gap-x-4"
            style={`height: ${rowHeight}px; top: ${rowIndex * rowHeight}px; grid-template-columns: repeat(${gridColumns}, minmax(0, 1fr));`}
          >
            {#each visibleBooks.slice(rowStart, rowEnd) as book (book.id)}
              <article class="relative text-left" data-book-id={book.id}>
                <button
                  class="group block w-full text-left"
                  type="button"
                  onclick={() => void open(book)}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    openMenu(book);
                  }}
                  disabled={downloadingBookId === book.id}
                >
                  {#if viewMode === 'list'}
                    <div
                      class="preset-tonal-surface flex min-h-24 items-center gap-4 rounded-lg p-3 text-left shadow-md transition-shadow duration-300 group-hover:shadow-xl"
                    >
                      <div class="relative h-20 w-14 shrink-0 overflow-hidden rounded-md">
                        {#if covers[book.seriesId]}
                          <img
                            class="h-full w-full object-cover"
                            src={covers[book.seriesId]}
                            loading="lazy"
                            decoding="async"
                            alt=""
                          />
                        {/if}
                        {#if book.remoteAvailable === false && book.downloadPath}
                          <span
                            class="badge-icon preset-filled-warning-500 absolute left-1 top-1 h-6 w-6 p-0"
                            title="Saved offline; no longer available on Kavita"
                            aria-label="Saved offline; no longer available on Kavita"
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
                              <path
                                fill="currentColor"
                                d="M12 2 1 21h22L12 2Zm0 4.2L19.5 19h-15L12 6.2ZM11 10v4h2v-4h-2Zm0 5v2h2v-2h-2Z"
                              />
                            </svg>
                          </span>
                        {/if}
                      </div>
                      <div class="min-w-0 flex-1">
                        <h2
                          class="line-clamp-2 font-serif text-base leading-snug text-surface-950-50"
                        >
                          {book.title}
                        </h2>
                        <p class="mt-1 truncate text-sm text-surface-700-300">
                          {book.author ?? 'Unknown author'}
                        </p>
                        {#if book.series}
                          <p class="mt-1 truncate text-xs text-surface-700-300">{book.series}</p>
                        {/if}
                        {#if progressOf(book) > 0}
                          <div
                            class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-300-700"
                            role="progressbar"
                            aria-label={`Reading progress for ${book.title}`}
                            aria-valuemin="0"
                            aria-valuemax="100"
                            aria-valuenow={Math.round(progressOf(book))}
                            aria-valuetext={`${Math.round(progressOf(book))}% complete`}
                          >
                            <div
                              class="h-full preset-filled-primary-600-400"
                              style:width={`${progressOf(book)}%`}
                            ></div>
                          </div>
                        {/if}
                      </div>
                    </div>
                  {:else}
                    <div
                      class="preset-tonal-surface relative aspect-[2/3] overflow-hidden rounded-lg shadow-md transition-shadow duration-300 group-hover:shadow-xl"
                    >
                      {#if covers[book.seriesId]}
                        <img
                          class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                          src={covers[book.seriesId]}
                          loading="lazy"
                          decoding="async"
                          alt=""
                        />
                      {/if}
                      {#if book.remoteAvailable === false && book.downloadPath}
                        <span
                          class="badge-icon preset-filled-warning-500 absolute left-2 top-2 h-7 w-7 p-0 shadow-md"
                          title="Saved offline; no longer available on Kavita"
                          aria-label="Saved offline; no longer available on Kavita"
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
                            <path
                              fill="currentColor"
                              d="M12 2 1 21h22L12 2Zm0 4.2L19.5 19h-15L12 6.2ZM11 10v4h2v-4h-2Zm0 5v2h2v-2h-2Z"
                            />
                          </svg>
                        </span>
                      {/if}
                      {#if downloadingBookId === book.id}
                        <span
                          class="badge-icon preset-filled-primary-600-400 absolute left-2 top-2 h-7 w-7 p-0 shadow-md"
                          title="Downloading"
                          aria-label="Downloading"
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4 animate-spin">
                            <path
                              fill="currentColor"
                              d="M12 4V2a10 10 0 0 0-7.07 17.07l1.42-1.42A8 8 0 1 1 12 4Z"
                            />
                          </svg>
                        </span>
                      {/if}
                      {#if progressOf(book) > 0}
                        <div
                          class="absolute inset-x-0 bottom-0 h-2"
                          role="progressbar"
                          aria-label={`Reading progress for ${book.title}`}
                          aria-valuemin="0"
                          aria-valuemax="100"
                          aria-valuenow={Math.round(progressOf(book))}
                          aria-valuetext={`${Math.round(progressOf(book))}% complete`}
                        >
                          <div
                            class="h-full preset-filled-primary-600-400"
                            style:width={`${progressOf(book)}%`}
                          ></div>
                        </div>
                      {/if}
                    </div>
                    <h2
                      class="mt-3 line-clamp-2 font-serif text-base leading-snug text-surface-950-50"
                    >
                      {book.title}
                    </h2>
                    <p class="mt-1 truncate text-sm text-surface-700-300">
                      {book.author ?? 'Unknown author'}
                    </p>
                  {/if}
                </button>
                <button
                  class="btn btn-sm preset-tonal-tertiary absolute right-2 bottom-0 z-10 h-11 w-11 !p-0 shadow-md"
                  type="button"
                  onclick={() => openMenu(book)}
                  aria-label={`Book actions for ${book.title}`}
                  title="More actions"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
                    <path
                      fill="currentColor"
                      d="M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
                    />
                  </svg>
                </button>
              </article>
            {/each}
          </div>
        {/each}
      </section>
    {/if}
  </main>
{/if}

{#if actionMenuBook}
  <div
    class="fixed inset-0 z-40 grid place-items-center bg-black/45 p-4"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && closeMenu()}
  >
    <div
      bind:this={actionMenuDialog}
      class="card preset-filled-surface-50-950 w-full max-w-md overflow-hidden p-4 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-actions-title"
      tabindex="-1"
      onkeydown={(event) => trapModalKeydown(event, actionMenuDialog!, closeMenu)}
      transition:fly={{ y: 16, duration: 150 }}
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs uppercase tracking-wider text-surface-700-300">Book actions</p>
          <h2 id="book-actions-title" class="mt-1 truncate font-serif text-2xl text-surface-950-50">
            {actionMenuBook.title}
          </h2>
          <p class="truncate text-sm text-surface-700-300">
            {actionMenuBook.author ?? 'Unknown author'}
          </p>
        </div>
        <button
          class="btn btn-sm h-8 w-8 !p-0"
          type="button"
          onclick={closeMenu}
          aria-label="Close book actions"
          title="Close"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
      </div>

      <div class="mt-4 grid gap-2">
        <button
          class="btn preset-filled-primary-700-300 justify-start"
          type="button"
          onclick={() => {
            const book = actionMenuBook;
            closeMenu();
            if (book) void open(book);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M8 5v14l11-7z" />
          </svg>
          <span>{actionMenuBook.downloadPath ? 'Open book' : 'Download and open'}</span>
        </button>
        <button
          class="btn preset-tonal-primary justify-start"
          type="button"
          onclick={() => {
            const book = actionMenuBook;
            closeMenu();
            if (book) void syncFurthest(book);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M12 4V2a10 10 0 0 0-7.07 17.07l1.42-1.42A8 8 0 1 1 12 4Z"
            />
          </svg>
          <span>Sync furthest read</span>
        </button>
        <button
          class="btn preset-tonal-tertiary justify-start"
          type="button"
          onclick={() => {
            const book = actionMenuBook;
            closeMenu();
            if (book) void markDone(book);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19l12-12-1.41-1.41z" />
          </svg>
          <span>Mark as read</span>
        </button>
        {#if actionMenuBook.downloadPath}
          <button
            class="btn preset-outlined-error-500 justify-start"
            type="button"
            onclick={() => {
              const book = actionMenuBook;
              closeMenu();
              if (book) void remove(book);
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
            <span>Remove download</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if conflict}
  <div
    class="fixed inset-0 z-40 grid place-items-center bg-black/55 p-5"
    role="presentation"
    transition:fade
    onclick={(event) => event.target === event.currentTarget && closeConflict()}
  >
    <div
      bind:this={conflictDialog}
      class="card preset-filled-surface-50-950 w-full max-w-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-conflict-title"
      tabindex="-1"
      onkeydown={(event) => trapModalKeydown(event, conflictDialog!, closeConflict)}
      transition:fly={{ y: 16, duration: 150 }}
    >
      <h2 id="sync-conflict-title" class="font-serif text-2xl">Choose where to continue</h2>
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
              percentage: null,
            };
            closeConflict();
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
              percentage: remotePercentage(conflict!.remote, conflict!.book),
            };
            closeConflict();
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
    onclick={(event) => event.target === event.currentTarget && closeSettings()}
  >
    <div
      bind:this={settingsDialog}
      class="card preset-filled-surface-50-950 relative max-h-[88dvh] w-full max-w-md overflow-auto p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-settings-title"
      tabindex="-1"
      onkeydown={(event) => trapModalKeydown(event, settingsDialog!, closeSettings)}
      transition:fly={{ y: 16, duration: 150 }}
    >
      <div
        class="sticky top-0 z-10 -mx-6 -mt-6 mb-6 flex items-center justify-between gap-3 bg-inherit px-6 pb-3 pt-6"
      >
        <h2 id="library-settings-title" class="font-serif text-3xl">Settings</h2>
        <button
          class="btn btn-sm preset-tonal-surface h-9 w-9 shrink-0 p-0"
          type="button"
          onclick={closeSettings}
          aria-label="Close settings"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
            <path
              fill="currentColor"
              d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
      </div>

      <div class="mt-6" aria-labelledby="library-settings-appearance-title">
        <h3 id="library-settings-appearance-title" class="text-lg font-medium">
          Reading appearance
        </h3>
        <p class="mt-1 text-sm text-surface-700-300">
          Choose the colors and theme that make reading comfortable. Changes apply immediately.
        </p>
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

        <p class="mt-6 text-xs uppercase tracking-wider text-surface-700-300">Theme palette</p>
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

        <p class="mt-6 text-xs uppercase tracking-wider text-surface-700-300">Sync</p>
        <p class="mt-1 text-sm text-surface-700-300">
          Turnleaf always saves your latest position on this device. Auto-sync furthest read also
          lets a newer local position replace an older Kavita position when progress is uploaded.
        </p>
        <div
          class="mt-2 flex min-h-12 items-center justify-between gap-4 rounded-xl preset-tonal-surface px-3 py-3"
        >
          <span class="min-w-0 flex-1 font-medium text-surface-950-50">Auto-sync furthest read</span
          >
          <button
            class={`switch-track ${
              pendingAutoSync ? 'preset-filled-primary-700-300' : 'preset-filled-secondary-700-300'
            }`}
            type="button"
            role="switch"
            aria-checked={pendingAutoSync}
            aria-label="Auto-sync furthest read"
            onclick={() => void updateAutoSync(!pendingAutoSync)}
          >
            <span class="switch-thumb preset-filled-tertiary-100-900" aria-hidden="true"></span>
          </button>
        </div>
      </div>

      <div class="mt-7" aria-labelledby="library-settings-connection-title">
        <h3 id="library-settings-connection-title" class="text-lg font-medium">Connection</h3>
        <p class="mt-1 text-sm text-surface-700-300">
          Update the server address or replace the key used to access this library.
        </p>
        <dl class="mt-3 space-y-2 text-sm">
          <div class="flex items-center justify-between gap-3">
            <dt class="text-surface-700-300">Server</dt>
            <dd class="truncate text-right">{server.displayName}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-surface-700-300">Address</dt>
            <dd class="truncate text-right">{server.baseUrl}</dd>
          </div>
        </dl>
        {#if insecureServer()}
          <div class="alert preset-tonal-warning mt-4" role="alert">
            Plain HTTP is enabled. Anyone on this network may be able to observe your reading
            traffic and Kavita auth key. HTTPS is strongly recommended.
          </div>
        {/if}

        <form class="mt-4 grid gap-3" onsubmit={updateApiKey}>
          <label class="label">
            <span class="label-text">Replace API key</span>
            <span class="flex">
              <input
                class="input min-w-0 flex-1 max-w-96"
                type="password"
                spellcheck="false"
                autocomplete="off"
                bind:value={replacementApiKey}
                placeholder="Enter a new Kavita key"
                required
              />
              <button
                class="btn preset-filled-primary-700-300 shrink-0"
                type="submit"
                disabled={replacingApiKey}
              >
                {replacingApiKey ? 'Testing...' : 'Save'}
              </button>
            </span>
            <span class="label-text text-xs text-surface-700-300">
              The new key is tested before it is saved.
            </span>
          </label>
          {#if settingsError}
            <div class="alert preset-tonal-error" role="alert" transition:fade>{settingsError}</div>
          {/if}
          <button
            class="btn preset-tonal-error"
            type="button"
            onclick={() => (confirmDeleteServer = true)}
            disabled={deletingServer}
          >
            Delete server
          </button>
        </form>
      </div>

      <div class="mt-7" aria-labelledby="library-settings-storage-title">
        <h3 id="library-settings-storage-title" class="text-lg font-medium">
          Storage and maintenance
        </h3>
        <p class="mt-1 text-sm text-surface-700-300">
          Downloads and reading progress stay on this device. Clearing covers is safe; removing
          downloads deletes local EPUB files but does not change Kavita.
        </p>
        <div class="mt-3 grid gap-2">
          <button class="btn preset-outlined-error-500" type="button" onclick={clearCache}
            >Clear cover cache</button
          >
          <button class="btn preset-tonal-error" type="button" onclick={removeAllDownloads}
            >Remove all downloaded books</button
          >
        </div>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-surface-700-300">Downloaded storage</dt>
        <dd class="tabular-nums">
          {(
            books.reduce((sum, book) => sum + (book.downloadPath ? (book.fileSize ?? 0) : 0), 0) /
            1_048_576
          ).toFixed(1)} MB
        </dd>
      </div>
      {#if confirmDeleteServer}
        <div class="mt-7 rounded-xl border border-error-500/35 p-4" transition:fade>
          <p class="text-sm font-medium text-error-700-300">Delete this server?</p>
          <p class="mt-2 text-sm text-surface-700-300">
            This removes the server connection, downloaded books, cached covers, and local progress
            from this device.
          </p>
          <div class="mt-4 flex gap-2">
            <button
              class="btn preset-outlined-error-500"
              type="button"
              onclick={() => void deleteServer()}
              disabled={deletingServer}
            >
              {deletingServer ? 'Deleting...' : 'Delete now'}
            </button>
            <button
              class="btn preset-tonal-surface"
              type="button"
              onclick={() => (confirmDeleteServer = false)}
              disabled={deletingServer}
            >
              Cancel
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .switch-track {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 3rem;
    height: 1.75rem;
    flex: none;
    border-radius: 9999px;
    border: 1px solid hsl(var(--color-primary-900) / 0.35);
    padding: 0.2rem;
    box-shadow:
      inset 0 1px 1px hsl(0 0% 100% / 0.08),
      0 1px 4px hsl(0 0% 0% / 0.2);
    cursor: pointer;
    transition:
      background-color 160ms ease,
      border-color 160ms ease,
      box-shadow 160ms ease;
  }

  .switch-thumb {
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 9999px;
    box-shadow:
      inset 0 1px 1px hsl(0 0% 100% / 0.3),
      0 1px 2px hsl(0 0% 0% / 0.28);
    transform: translateX(0);
    transition: transform 160ms ease;
  }

  .switch-track[aria-checked='true'] .switch-thumb {
    transform: translateX(1.2rem);
  }

  .switch-track:focus-visible {
    outline: 0;
    box-shadow:
      0 0 0 3px hsl(var(--color-primary-500) / 0.35),
      inset 0 1px 1px hsl(0 0% 100% / 0.08),
      0 1px 4px hsl(0 0% 0% / 0.2);
  }
</style>
