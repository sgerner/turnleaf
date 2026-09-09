<script lang="ts">
  import { App } from '@capacitor/app';
  import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
  import { tick, onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { Animation, StatusBar } from '@capacitor/status-bar';
  import { getPreference, setPreference } from '../database/database';
  import { KeepAwake } from '../native/keep-awake';
  import { ReaderChrome } from '../native/reader-chrome';
  import { VolumeButtons } from '../native/volume-buttons';
  import { createReaderNativeFeatures } from '../native/reader-native-features';
  import {
    defaultAppearance,
    parseAppearance,
    serializeAppearance,
    type Appearance,
    type ReadingMode,
  } from '../reader/appearance';
  import {
    ReaderSession,
    type ReaderLocation,
    type ReaderSelection,
    type TocItem,
  } from '../reader/session';
  import type { ReaderSearchResult } from '../reader/search';
  import {
    addAnnotation,
    annotationsMarkdown,
    parseAnnotations,
    removeAnnotation,
    updateAnnotation,
    type StoredAnnotation,
  } from '../reader/annotations';
  import {
    parseBookmarks,
    parseLocationHistory,
    recordLocation,
    removeBookmark,
    renameBookmark,
    toggleBookmark,
    type StoredReaderLocation,
  } from '../reader/bookmarks';
  import { focusFirstElement, restoreFocus, trapModalKeydown } from '../a11y/modal-focus';

  let {
    bookUrl,
    bookId,
    title,
    initialCfi = null,
    initialXPath = null,
    initialPercentage = null,
    onBack,
    onRelocated,
    onSyncLatest,
    registerBackHandler,
  }: {
    bookUrl: string;
    bookId: string;
    title: string;
    initialCfi?: string | null;
    initialXPath?: string | null;
    initialPercentage?: number | null;
    onBack: () => void;
    onRelocated: (location: ReaderLocation) => void;
    onSyncLatest?: () => Promise<{ xpath: string | null; percentage: number | null } | null>;
    registerBackHandler?: (handler: () => boolean) => () => void;
  } = $props();

  let viewport: HTMLDivElement;
  let session: ReaderSession | null = null;
  let controlsVisible = $state(false);
  let settingsVisible = $state(false);
  let tocVisible = $state(false);
  let bookmarksVisible = $state(false);
  let annotationsVisible = $state(false);
  let searchVisible = $state(false);
  let settingsPanel = $state<HTMLElement | null>(null);
  let tocPanel = $state<HTMLElement | null>(null);
  let bookmarksPanel = $state<HTMLElement | null>(null);
  let annotationsPanel = $state<HTMLElement | null>(null);
  let searchPanel = $state<HTMLElement | null>(null);
  let settingsOpener: HTMLElement | null = null;
  let tocOpener: HTMLElement | null = null;
  let bookmarksOpener: HTMLElement | null = null;
  let annotationsOpener: HTMLElement | null = null;
  let searchOpener: HTMLElement | null = null;
  let toc = $state<TocItem[]>([]);
  let bookmarks = $state<StoredReaderLocation[]>([]);
  let locationHistory = $state<StoredReaderLocation[]>([]);
  let editingBookmarkId = $state<string | null>(null);
  let bookmarkDraft = $state('');
  let annotations = $state<StoredAnnotation[]>([]);
  let selectedText = $state<ReaderSelection | null>(null);
  let editingAnnotationId = $state<string | null>(null);
  let annotationDraft = $state('');
  let searchQuery = $state('');
  let searchResults = $state<ReaderSearchResult[]>([]);
  let searching = $state(false);
  let searchError = $state('');
  let searchController: AbortController | null = null;
  let appearance = $state<Appearance>({ ...defaultAppearance });
  let location = $state<ReaderLocation | null>(null);
  let error = $state('');
  let hideTimer: number | null = null;
  let footerVisible = $state(false);
  let bottomSwipeStart: { id: number; x: number; y: number } | null = null;
  let saveTimer: number | null = null;
  let resumeHandle: PluginListenerHandle | null = null;
  let removeBackHandler: (() => void) | null = null;
  let syncingLatest = $state(false);
  let destroyed = false;
  let appearanceLoaded = false;
  const nativeFeatures = Capacitor.isNativePlatform()
    ? createReaderNativeFeatures({
        hideStatusBar: () => StatusBar.hide({ animation: Animation.None }),
        showStatusBar: () => StatusBar.show({ animation: Animation.None }),
        setReaderChrome: (enabled) => ReaderChrome.setEnabled({ enabled }),
        setVolumeButtons: (enabled) => VolumeButtons.setEnabled({ enabled }),
        setKeepAwake: (enabled) => KeepAwake.setEnabled({ enabled }),
      })
    : null;

  onMount(async () => {
    if (registerBackHandler) removeBackHandler = registerBackHandler(handleBackButton);
    window.addEventListener('keydown', handleKeyboardNavigation);
    document.addEventListener('backbutton', handleDocumentBackButton);
    const saved = await getPreference('appearance');
    if (destroyed) return;
    if (saved) appearance = parseAppearance(saved);
    const savedBookmarks = await getPreference(`readerBookmarks:${bookId}`);
    if (destroyed) return;
    const savedHistory = await getPreference(`readerHistory:${bookId}`);
    if (destroyed) return;
    const savedAnnotations = await getPreference(`readerAnnotations:${bookId}`);
    if (destroyed) return;
    bookmarks = parseBookmarks(savedBookmarks);
    locationHistory = parseLocationHistory(savedHistory);
    annotations = parseAnnotations(savedAnnotations);
    appearanceLoaded = true;
    session = new ReaderSession(bookUrl);
    try {
      await session.open(
        viewport,
        initialCfi,
        initialXPath,
        initialPercentage,
        appearance,
        (next, origin) => {
          if (destroyed) return;
          location = next;
          if (origin === 'navigation') {
            onRelocated(next);
            locationHistory = recordLocation(locationHistory, next);
            void persistReaderLocations();
          }
        },
        (zone) => {
          if (destroyed) return;
          if (zone === 'center') {
            if (controlsVisible) controlsVisible = false;
            else showControls();
          } else void turn(zone);
        },
        (selection) => {
          if (destroyed) return;
          selectedText = selection;
          showControls();
        },
      );
      if (destroyed) return;
      toc = session.tableOfContents();
    } catch {
      if (destroyed) return;
      error = 'This EPUB could not be opened. The download may be incomplete or corrupted.';
      return;
    }

    if (nativeFeatures) {
      await nativeFeatures.enable(appearance.keepAwake);
      if (destroyed) return;

      try {
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (!destroyed && isActive) void syncLatestLocation(false);
        });
        if (destroyed) {
          await handle.remove();
          return;
        }
        resumeHandle = handle;
      } catch {
        // Resume syncing is optional; the reader itself should keep working.
      }
    }
  });

  onDestroy(() => {
    destroyed = true;
    removeBackHandler?.();
    removeBackHandler = null;
    window.removeEventListener('keydown', handleKeyboardNavigation);
    document.removeEventListener('backbutton', handleDocumentBackButton);
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    searchController?.abort();
    const handle = resumeHandle;
    resumeHandle = null;
    void handle?.remove();
    if (appearanceLoaded) void setPreference('appearance', serializeAppearance(appearance));
    void nativeFeatures?.disable();
    session?.destroy();
  });

  function showControls(): void {
    controlsVisible = true;
    scheduleChromeHide();
  }

  function activeElement(): HTMLElement | null {
    return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  function focusPanel(getPanel: () => HTMLElement | null): void {
    void tick().then(() => focusFirstElement(getPanel()));
  }

  function openSettings(): void {
    settingsOpener = activeElement();
    settingsVisible = true;
    tocVisible = false;
    bookmarksVisible = false;
    annotationsVisible = false;
    searchVisible = false;
    tocOpener = null;
    bookmarksOpener = null;
    annotationsOpener = null;
    searchOpener = null;
    focusPanel(() => settingsPanel);
  }

  function closeSettings(): void {
    settingsVisible = false;
    const opener = settingsOpener;
    settingsOpener = null;
    restoreFocus(opener);
  }

  function openToc(): void {
    tocOpener = activeElement();
    tocVisible = true;
    settingsVisible = false;
    bookmarksVisible = false;
    annotationsVisible = false;
    searchVisible = false;
    settingsOpener = null;
    bookmarksOpener = null;
    annotationsOpener = null;
    searchOpener = null;
    focusPanel(() => tocPanel);
  }

  function closeToc(): void {
    tocVisible = false;
    const opener = tocOpener;
    tocOpener = null;
    restoreFocus(opener);
  }

  function openBookmarks(): void {
    bookmarksOpener = activeElement();
    bookmarksVisible = true;
    settingsVisible = false;
    tocVisible = false;
    annotationsVisible = false;
    searchVisible = false;
    settingsOpener = null;
    tocOpener = null;
    annotationsOpener = null;
    searchOpener = null;
    focusPanel(() => bookmarksPanel);
  }

  function closeBookmarks(): void {
    bookmarksVisible = false;
    editingBookmarkId = null;
    const opener = bookmarksOpener;
    bookmarksOpener = null;
    restoreFocus(opener);
  }

  function openAnnotations(): void {
    annotationsOpener = activeElement();
    annotationsVisible = true;
    settingsVisible = false;
    tocVisible = false;
    bookmarksVisible = false;
    settingsOpener = null;
    tocOpener = null;
    bookmarksOpener = null;
    focusPanel(() => annotationsPanel);
  }

  function closeAnnotations(): void {
    annotationsVisible = false;
    editingAnnotationId = null;
    const opener = annotationsOpener;
    annotationsOpener = null;
    restoreFocus(opener);
  }

  function openSearch(): void {
    searchOpener = activeElement();
    searchVisible = true;
    settingsVisible = false;
    tocVisible = false;
    bookmarksVisible = false;
    annotationsVisible = false;
    settingsOpener = null;
    tocOpener = null;
    bookmarksOpener = null;
    annotationsOpener = null;
    searchError = '';
    focusPanel(() => searchPanel);
  }

  function closeSearch(): void {
    searchVisible = false;
    searchController?.abort();
    searchController = null;
    const opener = searchOpener;
    searchOpener = null;
    restoreFocus(opener);
  }

  function showFooter(): void {
    footerVisible = true;
    scheduleChromeHide();
  }

  function scheduleChromeHide(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      controlsVisible = false;
      closeSettings();
      closeToc();
      closeBookmarks();
      closeAnnotations();
      closeSearch();
      footerVisible = false;
    }, 5_000);
  }

  function updateAppearance(patch: Partial<Appearance>): void {
    appearance = { ...appearance, ...patch };
    session?.applyAppearance(appearance);
    if (patch.keepAwake !== undefined) {
      void nativeFeatures?.setKeepAwake(patch.keepAwake);
    }
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(
      () => void setPreference('appearance', serializeAppearance(appearance)),
      500,
    );
    showControls();
  }

  function readerLocation(
    next: ReaderLocation,
  ): Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'> {
    return {
      cfi: next.cfi,
      href: next.href,
      percentage: next.percentage,
    };
  }

  let locationWrite: Promise<void> = Promise.resolve();

  function persistReaderLocations(): void {
    locationWrite = locationWrite
      .then(async () => {
        await setPreference(`readerBookmarks:${bookId}`, JSON.stringify(bookmarks));
        await setPreference(`readerHistory:${bookId}`, JSON.stringify(locationHistory));
        await setPreference(`readerAnnotations:${bookId}`, JSON.stringify(annotations));
      })
      .catch(() => {
        // The reader remains usable when a preference write is temporarily unavailable.
      });
  }

  function currentBookmark(): StoredReaderLocation | null {
    if (!location) return null;
    const id = `${location.cfi}|${location.href}`;
    return bookmarks.find((bookmark) => bookmark.id === id) ?? null;
  }

  function toggleCurrentBookmark(): void {
    if (!location) return;
    bookmarks = toggleBookmark(bookmarks, readerLocation(location));
    persistReaderLocations();
    showControls();
  }

  function startBookmarkEdit(bookmark: StoredReaderLocation): void {
    editingBookmarkId = bookmark.id;
    bookmarkDraft = bookmark.label;
  }

  function saveBookmarkName(bookmark: StoredReaderLocation): void {
    bookmarks = renameBookmark(bookmarks, bookmark.id, bookmarkDraft);
    editingBookmarkId = null;
    persistReaderLocations();
  }

  function deleteBookmark(bookmark: StoredReaderLocation): void {
    bookmarks = removeBookmark(bookmarks, bookmark.id);
    if (editingBookmarkId === bookmark.id) editingBookmarkId = null;
    persistReaderLocations();
  }

  function saveAnnotation(): void {
    if (!selectedText) return;
    annotations = addAnnotation(annotations, selectedText.cfi, selectedText.text, annotationDraft);
    annotationDraft = '';
    selectedText = null;
    persistReaderLocations();
  }

  function editAnnotation(annotation: StoredAnnotation): void {
    annotations = updateAnnotation(annotations, annotation.id, annotationDraft);
    editingAnnotationId = null;
    annotationDraft = '';
    persistReaderLocations();
  }

  function startAnnotationEdit(annotation: StoredAnnotation): void {
    editingAnnotationId = annotation.id;
    annotationDraft = annotation.note;
  }

  function deleteAnnotation(annotation: StoredAnnotation): void {
    annotations = removeAnnotation(annotations, annotation.id);
    persistReaderLocations();
  }

  function exportAnnotations(): void {
    if (!annotations.length) return;
    const blob = new Blob([annotationsMarkdown(title, annotations)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'book'}-notes.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function runSearch(): Promise<void> {
    if (!session || !searchQuery.trim()) {
      searchResults = [];
      searchError = searchQuery.trim() ? 'The reader is still opening.' : '';
      return;
    }
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searching = true;
    searchError = '';
    try {
      searchResults = await session.search(searchQuery, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        searchResults = [];
        searchError = cause instanceof Error ? cause.message : 'Search could not be completed.';
      }
    } finally {
      if (searchController === controller) {
        searching = false;
        searchController = null;
      }
    }
  }

  async function openSearchResult(result: ReaderSearchResult): Promise<void> {
    if (!session) return;
    try {
      await session.displayCfi(result.cfi);
      closeSearch();
      showControls();
    } catch {
      searchError = 'This search result is no longer available in the current EPUB.';
    }
  }

  async function returnToLocation(saved: StoredReaderLocation): Promise<void> {
    if (!session) return;
    try {
      const restored = await session.displayCfi(saved.cfi);
      if (!restored && saved.href) await session.display(saved.href);
      closeBookmarks();
      showControls();
    } catch {
      error = 'This saved location is no longer available in the current EPUB.';
    }
  }

  async function turn(direction: 'next' | 'previous'): Promise<void> {
    try {
      if (!session) throw new Error('Reader session is unavailable.');
      if (direction === 'next') await session.next();
      else await session.previous();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'This page could not be displayed. Try reopening the book.';
    }
  }

  async function syncLatestLocation(showFeedback = true): Promise<void> {
    if (!session || !onSyncLatest || syncingLatest) return;
    syncingLatest = true;
    try {
      const progress = await onSyncLatest();
      if (progress?.xpath) {
        const restored = await session.displayServerLocation(progress.xpath);
        if (!restored && progress.percentage && progress.percentage > 0) {
          await session.displayServerPercentage(progress.percentage);
        }
      } else if (progress?.percentage && progress.percentage > 0) {
        await session.displayServerPercentage(progress.percentage);
      }
      if (showFeedback) showControls();
    } catch {
      // Opening the reader should stay quiet when the device is offline.
    } finally {
      syncingLatest = false;
    }
  }

  function handleVolumeButton(event: Event): void {
    const detail = (event as CustomEvent<{ direction?: string }>).detail;
    if (detail?.direction === 'next' || detail?.direction === 'previous') {
      void turn(detail.direction);
      showControls();
    }
  }

  function handleKeyboardNavigation(event: KeyboardEvent): void {
    if (destroyed || event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('button, a, input, select, textarea, [contenteditable="true"]')
    ) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      void turn('previous');
      showControls();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      void turn('next');
      showControls();
      return;
    }
    if (
      event.key === 'Escape' &&
      (settingsVisible || tocVisible || bookmarksVisible || annotationsVisible || searchVisible)
    ) {
      event.preventDefault();
      closeSettings();
      closeToc();
      closeBookmarks();
      closeAnnotations();
      closeSearch();
      showControls();
    }
  }

  function handleBackButton(): boolean {
    if (settingsVisible) closeSettings();
    else if (tocVisible) closeToc();
    else if (bookmarksVisible) closeBookmarks();
    else if (annotationsVisible) closeAnnotations();
    else if (searchVisible) closeSearch();
    else {
      onBack();
      return true;
    }
    showControls();
    return true;
  }

  function handleDocumentBackButton(event: Event): void {
    if (handleBackButton()) event.preventDefault();
  }

  function handleBottomSwipeStart(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    bottomSwipeStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function handleBottomSwipeMove(event: PointerEvent): void {
    if (!bottomSwipeStart || bottomSwipeStart.id !== event.pointerId) return;
    const deltaX = event.clientX - bottomSwipeStart.x;
    const deltaY = event.clientY - bottomSwipeStart.y;
    if (deltaY < -24 && Math.abs(deltaY) > Math.abs(deltaX)) {
      bottomSwipeStart = null;
      showFooter();
    }
  }

  function handleBottomSwipeEnd(event: PointerEvent): void {
    if (bottomSwipeStart?.id === event.pointerId) bottomSwipeStart = null;
  }

  if (Capacitor.isNativePlatform()) {
    window.addEventListener('turnleafVolumeButton', handleVolumeButton);
  }

  onDestroy(() => {
    if (Capacitor.isNativePlatform()) {
      window.removeEventListener('turnleafVolumeButton', handleVolumeButton);
    }
  });
</script>

<div class="reader-shell" data-mode={appearance.mode} aria-describedby="reader-keyboard-help">
  <div class="reader-viewport" bind:this={viewport}></div>

  <p id="reader-keyboard-help" class="sr-only">
    Use Left or Page Up for the previous page. Use Right, Page Down, or Space for the next page.
    Press Escape to close an open reader panel.
  </p>

  <nav
    class="tap-zones"
    aria-label="Page navigation"
    inert={Boolean(
      settingsVisible || tocVisible || bookmarksVisible || annotationsVisible || searchVisible,
    )}
  >
    <button
      type="button"
      aria-label="Previous page"
      aria-keyshortcuts="ArrowLeft PageUp"
      onclick={() => turn('previous')}
    ></button>
    <button
      type="button"
      aria-label={controlsVisible ? 'Hide reading controls' : 'Show reading controls'}
      aria-keyshortcuts="Escape"
      onclick={() => (controlsVisible ? (controlsVisible = false) : showControls())}
    ></button>
    <button
      type="button"
      aria-label="Next page"
      aria-keyshortcuts="ArrowRight PageDown Space"
      onclick={() => turn('next')}
    ></button>
  </nav>

  {#if appearance.progressBar}
    <div
      class="reader-progress"
      role="progressbar"
      aria-label="Book reading progress"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round((location?.percentage ?? 0) * 100)}
      aria-valuetext={`${Math.round((location?.percentage ?? 0) * 100)}% complete`}
    >
      <div class="reader-progress-track">
        <div
          class="reader-progress-fill"
          style:width={`${Math.round((location?.percentage ?? 0) * 100)}%`}
        ></div>
      </div>
    </div>
  {/if}

  {#if !controlsVisible}
    <button
      type="button"
      class="reader-top-reveal"
      aria-label="Show reading controls"
      onclick={showControls}
    ></button>
  {/if}

  {#if error}
    <div class="absolute inset-0 grid place-items-center p-8" role="alert">
      <div class="card preset-tonal-error max-w-sm p-6 text-center">
        <p>{error}</p>
        <button class="btn preset-filled-error-500 mt-5" type="button" onclick={onBack}>Back</button
        >
      </div>
    </div>
  {/if}

  {#if controlsVisible}
    <div class="reader-overlay" data-controls transition:fade={{ duration: 120 }}>
      <header
        class="reader-bar reader-top"
        inert={Boolean(
          settingsVisible || tocVisible || bookmarksVisible || annotationsVisible || searchVisible,
        )}
        transition:fly={{ y: -8, duration: 140 }}
      >
        <div class="grid w-full grid-cols-7 gap-2">
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={onBack}
            aria-label="Back to library"
          >
            Back
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => (tocVisible ? closeToc() : openToc())}
            aria-expanded={tocVisible}
            aria-controls="reader-contents"
          >
            Contents
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => (settingsVisible ? closeSettings() : openSettings())}
            aria-expanded={settingsVisible}
            aria-controls="reader-appearance"
          >
            Text
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => (bookmarksVisible ? closeBookmarks() : openBookmarks())}
            aria-label="Open bookmarks and history"
            aria-expanded={bookmarksVisible}
            aria-controls="reader-bookmarks"
          >
            <span class="sr-only sm:not-sr-only">Marks</span>
            <span class="sm:sr-only" aria-hidden="true">★</span>
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => (annotationsVisible ? closeAnnotations() : openAnnotations())}
            aria-label="Open highlights and notes"
            aria-expanded={annotationsVisible}
            aria-controls="reader-annotations"
          >
            <span class="sr-only sm:not-sr-only">Notes</span>
            <span class="sm:sr-only" aria-hidden="true">✎</span>
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => (searchVisible ? closeSearch() : openSearch())}
            aria-expanded={searchVisible}
            aria-controls="reader-search"
          >
            Search
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => syncLatestLocation()}
            aria-label="Sync latest reading position"
            title="Sync latest reading position"
            disabled={syncingLatest}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              class:animate-spin={syncingLatest}
              class="h-5 w-5"
            >
              <path
                fill="currentColor"
                d="M17.7 6.3A8 8 0 0 0 4.3 10H2l3.5 3.5L9 10H6.4a5.8 5.8 0 0 1 9.8-2.2l1.5-1.5ZM18.5 10.5 15 14h2.6a5.8 5.8 0 0 1-9.8 2.2l-1.5 1.5A8 8 0 0 0 19.7 14H22l-3.5-3.5Z"
              />
            </svg>
          </button>
        </div>
        <p class="min-w-0 flex-1 truncate text-center text-sm font-bold text-primary-500">
          {title}
        </p>
      </header>

      {#if settingsVisible || tocVisible || bookmarksVisible || annotationsVisible || searchVisible}
        <button
          class="reader-panel-backdrop"
          type="button"
          tabindex="-1"
          aria-label="Close reader panel"
          onclick={() =>
            settingsVisible
              ? closeSettings()
              : tocVisible
                ? closeToc()
                : bookmarksVisible
                  ? closeBookmarks()
                  : annotationsVisible
                    ? closeAnnotations()
                    : closeSearch()}
        ></button>
      {/if}

      {#if settingsVisible}
        <div
          bind:this={settingsPanel}
          class="reader-settings card preset-filled-surface-50-950 relative"
          data-reader-panel
          id="reader-appearance"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reader-appearance-title"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, settingsPanel!, closeSettings)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <button
            class="btn btn-sm preset-tonal-surface absolute right-3 top-3 h-11 w-11 p-0"
            type="button"
            onclick={closeSettings}
            aria-label="Close reading appearance"
            title="Close"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
          <h2 id="reader-appearance-title" class="font-serif text-xl">Reading appearance</h2>
          <div class="mt-4 grid grid-cols-2 gap-2" aria-label="Reading color mode">
            {#each ['light', 'dark'] as mode (mode)}
              <button
                class:active-mode={appearance.mode === mode}
                class="btn preset-outlined-surface-300-700 capitalize"
                type="button"
                aria-pressed={appearance.mode === mode}
                onclick={() => updateAppearance({ mode: mode as ReadingMode })}>{mode}</button
              >
            {/each}
          </div>
          <label class="label mt-5">
            <span class="label-text">Font</span>
            <select
              class="select"
              value={appearance.fontFamily}
              onchange={(event) =>
                updateAppearance({
                  fontFamily: event.currentTarget.value as Appearance['fontFamily'],
                })}
            >
              <option value="book">Book serif</option>
              <option value="sans">Modern sans</option>
              <option value="accessible">Accessible</option>
            </select>
          </label>
          <label class="label mt-5">
            <span class="label-text">Text size: {appearance.fontSize} pixels</span>
            <input
              class="range"
              type="range"
              min="14"
              max="34"
              value={appearance.fontSize}
              oninput={(event) => updateAppearance({ fontSize: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">Line height: {appearance.lineHeight.toFixed(1)}</span>
            <input
              class="range"
              type="range"
              min="1.2"
              max="2"
              step="0.1"
              value={appearance.lineHeight}
              oninput={(event) =>
                updateAppearance({ lineHeight: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">Page margins: {appearance.margin} pixels</span>
            <input
              class="range"
              type="range"
              min="8"
              max="56"
              value={appearance.margin}
              oninput={(event) => updateAppearance({ margin: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text"
              >Paragraph spacing: {appearance.paragraphSpacing.toFixed(1)}</span
            >
            <input
              class="range"
              type="range"
              min="0"
              max="1.5"
              step="0.1"
              value={appearance.paragraphSpacing}
              oninput={(event) =>
                updateAppearance({ paragraphSpacing: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">Alignment</span>
            <select
              class="select"
              value={appearance.alignment}
              onchange={(event) =>
                updateAppearance({
                  alignment: event.currentTarget.value as Appearance['alignment'],
                })}
            >
              <option value="start">Natural</option>
              <option value="justify">Justified</option>
            </select>
          </label>
          <label class="mt-4 flex min-h-12 items-center gap-3">
            <input
              class="checkbox"
              type="checkbox"
              checked={appearance.hyphenation}
              onchange={(event) => updateAppearance({ hyphenation: event.currentTarget.checked })}
            />
            Hyphenation
          </label>
          <label class="mt-4 flex min-h-12 items-center gap-3">
            <input
              class="checkbox"
              type="checkbox"
              checked={appearance.progressBar}
              onchange={(event) => updateAppearance({ progressBar: event.currentTarget.checked })}
            />
            Progress bar
          </label>
          <label class="mt-4 flex min-h-12 items-center gap-3">
            <input
              class="checkbox"
              type="checkbox"
              checked={appearance.keepAwake}
              onchange={(event) => updateAppearance({ keepAwake: event.currentTarget.checked })}
            />
            Keep screen on while reading
          </label>
        </div>
      {/if}

      {#if tocVisible}
        <div
          bind:this={tocPanel}
          class="reader-settings card preset-filled-surface-50-950 relative"
          data-reader-panel
          id="reader-contents"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reader-contents-title"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, tocPanel!, closeToc)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <button
            class="btn btn-sm preset-tonal-surface absolute right-3 top-3 h-11 w-11 p-0"
            type="button"
            onclick={closeToc}
            aria-label="Close table of contents"
            title="Close"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
          <h2 id="reader-contents-title" class="font-serif text-xl">Contents</h2>
          <div class="mt-3 max-h-[55dvh] overflow-auto">
            {#each toc as item (item.href)}
              <button
                class="btn w-full justify-start text-left"
                type="button"
                onclick={() => {
                  void session?.display(item.href);
                  closeToc();
                }}>{item.label}</button
              >
            {/each}
          </div>
        </div>
      {/if}

      {#if searchVisible}
        <div
          bind:this={searchPanel}
          class="reader-settings card preset-filled-surface-50-950 relative max-h-[75dvh] overflow-auto"
          data-reader-panel
          id="reader-search"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reader-search-title"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, searchPanel!, closeSearch)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <button
            class="btn btn-sm preset-tonal-surface absolute right-3 top-3 h-11 w-11 p-0"
            type="button"
            onclick={closeSearch}
            aria-label="Close book search"
            title="Close"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
          <h2 id="reader-search-title" class="font-serif text-xl">Search this book</h2>
          <form
            class="mt-4 flex gap-2"
            onsubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <label class="sr-only" for="reader-search-query">Search this book</label>
            <input
              id="reader-search-query"
              class="input min-w-0 flex-1"
              type="search"
              bind:value={searchQuery}
              placeholder="Find a word or phrase"
              autocomplete="off"
            />
            <button class="btn preset-filled-primary-700-300" type="submit" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
          {#if searchError}
            <p class="mt-3 text-sm text-error-700-300" role="alert">{searchError}</p>
          {:else if !searching && searchQuery.trim() && searchResults.length === 0}
            <p class="mt-3 text-sm text-surface-700-300" role="status">No matches found.</p>
          {/if}
          {#if searchResults.length > 0}
            <ol class="mt-4 grid gap-2" aria-label="Search results">
              {#each searchResults as result, index (result.cfi)}
                <li>
                  <button
                    class="btn w-full justify-start text-left"
                    type="button"
                    onclick={() => void openSearchResult(result)}
                  >
                    <span class="mr-2 text-xs text-surface-700-300">{index + 1}</span>
                    <span class="line-clamp-3">{result.excerpt}</span>
                  </button>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      {/if}

      {#if bookmarksVisible}
        <div
          bind:this={bookmarksPanel}
          class="reader-settings card preset-filled-surface-50-950 relative max-h-[75dvh] overflow-auto"
          data-reader-panel
          id="reader-bookmarks"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reader-bookmarks-title"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, bookmarksPanel!, closeBookmarks)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <button
            class="btn btn-sm preset-tonal-surface absolute right-3 top-3 h-11 w-11 p-0"
            type="button"
            onclick={closeBookmarks}
            aria-label="Close bookmarks and history"
            title="Close"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
          <h2 id="reader-bookmarks-title" class="font-serif text-xl">Bookmarks and history</h2>
          <p class="mt-2 text-sm text-surface-700-300">
            Saved on this device with EPUB locations. They are not sent to Kavita.
          </p>
          {#if location}
            <button
              class="btn mt-4 w-full preset-tonal-primary"
              type="button"
              onclick={toggleCurrentBookmark}
            >
              {currentBookmark() ? 'Remove bookmark at this page' : 'Bookmark this page'}
            </button>
          {/if}

          <section class="mt-5" aria-labelledby="reader-bookmark-list-title">
            <h3
              id="reader-bookmark-list-title"
              class="text-sm font-semibold uppercase tracking-wide"
            >
              Bookmarks
            </h3>
            {#if bookmarks.length === 0}
              <p class="mt-2 text-sm text-surface-700-300">No bookmarks yet.</p>
            {:else}
              <div class="mt-2 grid gap-2">
                {#each bookmarks as bookmark (bookmark.id)}
                  <div class="rounded-lg preset-tonal-surface p-2">
                    {#if editingBookmarkId === bookmark.id}
                      <form
                        class="flex gap-2"
                        onsubmit={(event) => {
                          event.preventDefault();
                          saveBookmarkName(bookmark);
                        }}
                      >
                        <input
                          class="input min-w-0 flex-1"
                          aria-label="Bookmark name"
                          bind:value={bookmarkDraft}
                        />
                        <button class="btn btn-sm preset-filled-primary-700-300" type="submit"
                          >Save</button
                        >
                      </form>
                    {:else}
                      <div class="flex items-center gap-2">
                        <button
                          class="min-w-0 flex-1 truncate text-left text-sm font-medium"
                          type="button"
                          onclick={() => void returnToLocation(bookmark)}
                        >
                          {bookmark.label}
                        </button>
                        <button
                          class="btn btn-sm preset-tonal-surface h-10 w-10 p-0"
                          type="button"
                          aria-label={`Rename ${bookmark.label}`}
                          onclick={() => startBookmarkEdit(bookmark)}
                        >
                          <span aria-hidden="true">✎</span>
                        </button>
                        <button
                          class="btn btn-sm preset-tonal-error h-10 w-10 p-0"
                          type="button"
                          aria-label={`Delete ${bookmark.label}`}
                          onclick={() => deleteBookmark(bookmark)}
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <section class="mt-5" aria-labelledby="reader-history-list-title">
            <h3
              id="reader-history-list-title"
              class="text-sm font-semibold uppercase tracking-wide"
            >
              Recent locations
            </h3>
            {#if locationHistory.length === 0}
              <p class="mt-2 text-sm text-surface-700-300">Recent page turns will appear here.</p>
            {:else}
              <div class="mt-2 grid gap-1">
                {#each locationHistory as entry (entry.id + entry.savedAt)}
                  <button
                    class="btn w-full justify-start text-left text-sm"
                    type="button"
                    onclick={() => void returnToLocation(entry)}
                  >
                    {entry.label}
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        </div>
      {/if}

      {#if annotationsVisible}
        <div
          bind:this={annotationsPanel}
          class="reader-settings card preset-filled-surface-50-950 relative max-h-[75dvh] overflow-auto"
          data-reader-panel
          id="reader-annotations"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reader-annotations-title"
          tabindex="-1"
          onkeydown={(event) => trapModalKeydown(event, annotationsPanel!, closeAnnotations)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <button
            class="btn btn-sm preset-tonal-surface absolute right-3 top-3 h-11 w-11 p-0"
            type="button"
            onclick={closeAnnotations}
            aria-label="Close highlights and notes"
            title="Close"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
          <h2 id="reader-annotations-title" class="font-serif text-xl">Highlights and notes</h2>
          <p class="mt-2 text-sm text-surface-700-300">
            Saved on this device. Select text in the book to add a highlight and an optional note.
          </p>

          {#if selectedText}
            <form
              class="mt-4 rounded-lg preset-tonal-primary p-3"
              onsubmit={(event) => {
                event.preventDefault();
                saveAnnotation();
              }}
            >
              <p class="text-sm italic">“{selectedText.text}”</p>
              <label class="label mt-3">
                <span class="label-text">Note (optional)</span>
                <textarea class="textarea min-h-20" bind:value={annotationDraft}></textarea>
              </label>
              <div class="mt-3 flex gap-2">
                <button class="btn preset-filled-primary-700-300 flex-1" type="submit">
                  Save highlight
                </button>
                <button
                  class="btn preset-tonal-surface"
                  type="button"
                  onclick={() => {
                    selectedText = null;
                    annotationDraft = '';
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          {/if}

          <div class="mt-4 flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold uppercase tracking-wide">Saved highlights</h3>
            <button
              class="btn btn-sm preset-tonal-surface"
              type="button"
              onclick={exportAnnotations}
              disabled={annotations.length === 0}
            >
              Export Markdown
            </button>
          </div>
          {#if annotations.length === 0}
            <p class="mt-2 text-sm text-surface-700-300">No highlights yet.</p>
          {:else}
            <div class="mt-2 grid gap-2">
              {#each annotations as annotation (annotation.id)}
                <article class="rounded-lg preset-tonal-surface p-3">
                  <button
                    class="w-full text-left text-sm italic"
                    type="button"
                    onclick={() => {
                      void session?.displayCfi(annotation.cfi);
                      closeAnnotations();
                    }}
                  >
                    “{annotation.excerpt}”
                  </button>
                  {#if editingAnnotationId === annotation.id}
                    <form
                      class="mt-2 grid gap-2"
                      onsubmit={(event) => {
                        event.preventDefault();
                        editAnnotation(annotation);
                      }}
                    >
                      <label class="label">
                        <span class="label-text">Note</span>
                        <textarea class="textarea min-h-20" bind:value={annotationDraft}></textarea>
                      </label>
                      <div class="flex gap-2">
                        <button class="btn btn-sm preset-filled-primary-700-300" type="submit">
                          Save
                        </button>
                        <button
                          class="btn btn-sm preset-tonal-surface"
                          type="button"
                          onclick={() => {
                            editingAnnotationId = null;
                            annotationDraft = '';
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  {:else}
                    {#if annotation.note}
                      <p class="mt-2 whitespace-pre-wrap text-sm">{annotation.note}</p>
                    {/if}
                    <div class="mt-2 flex justify-end gap-2">
                      <button
                        class="btn btn-sm preset-tonal-surface"
                        type="button"
                        onclick={() => startAnnotationEdit(annotation)}
                      >
                        Edit note
                      </button>
                      <button
                        class="btn btn-sm preset-tonal-error"
                        type="button"
                        onclick={() => deleteAnnotation(annotation)}
                      >
                        Delete
                      </button>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if footerVisible}
    <footer class="reader-bar reader-bottom" transition:fly={{ y: 8, duration: 140 }}>
      <span class="truncate text-xs">{location?.href ?? 'Opening book...'}</span>
      <span class="text-xs tabular-nums">{Math.round((location?.percentage ?? 0) * 100)}%</span>
    </footer>
  {/if}

  <div
    class="reader-bottom-reveal"
    aria-hidden="true"
    onpointerdown={handleBottomSwipeStart}
    onpointermove={handleBottomSwipeMove}
    onpointerup={handleBottomSwipeEnd}
    onpointercancel={handleBottomSwipeEnd}
  ></div>
</div>

<style>
  .reader-shell {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: var(--reader-background);
    color: var(--reader-text);
    touch-action: pan-y;
    user-select: none;
    --reader-background: var(--color-surface-50);
    --reader-text: var(--color-surface-950);
    --reader-overlay-top: color-mix(in oklab, var(--reader-text) 34%, transparent);
    --reader-overlay-bottom: color-mix(in oklab, var(--reader-text) 28%, transparent);
    --reader-bar-text: var(--color-surface-950);
    --reader-safe-top: max(0.5rem, env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px));
    --reader-safe-bottom: max(
      1rem,
      env(safe-area-inset-bottom, 0px),
      var(--safe-area-inset-bottom, 0px)
    );
    --reader-progress-height: 0.25rem;
  }

  .reader-viewport {
    position: absolute;
    inset: var(--reader-safe-top) 0 var(--reader-safe-bottom) 0;
    overflow: hidden;
    width: 100%;
    height: auto;
    min-width: 0;
    max-width: 100%;
    contain: layout paint;
  }

  .reader-viewport :global(.epub-container) {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    max-width: 100% !important;
    overflow: hidden !important;
  }

  .reader-viewport :global(iframe) {
    display: block;
    border: 0 !important;
  }

  .reader-shell[data-mode='dark'] {
    --reader-background: var(--color-surface-950);
    --reader-text: var(--color-surface-50);
    --reader-overlay-top: color-mix(in oklab, var(--reader-text) 38%, transparent);
    --reader-overlay-bottom: color-mix(in oklab, var(--reader-text) 32%, transparent);
    --reader-bar-text: var(--color-surface-50);
  }

  .reader-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      var(--reader-overlay-top),
      transparent 18%,
      transparent 78%,
      var(--reader-overlay-bottom)
    );
  }

  .tap-zones {
    position: absolute;
    z-index: 10;
    inset: 0;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
  }

  .reader-top-reveal {
    position: absolute;
    z-index: 11;
    top: 0;
    left: 0;
    right: 0;
    height: max(4rem, calc(env(safe-area-inset-top) + 3rem));
    border: 0;
    background: transparent;
    -webkit-tap-highlight-color: transparent;
  }

  .reader-bottom-reveal {
    position: absolute;
    z-index: 11;
    left: 0;
    right: 0;
    bottom: 0;
    height: max(2.5rem, calc(env(safe-area-inset-bottom) + 1.5rem));
    border: 0;
    background: transparent;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
  }

  .tap-zones button {
    border: 0;
    background: transparent;
    -webkit-tap-highlight-color: transparent;
  }

  .reader-overlay {
    z-index: 20;
  }

  .reader-bar,
  .reader-settings {
    pointer-events: auto;
  }

  .reader-bar {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding-inline: max(1rem, env(safe-area-inset-left));
    color: var(--reader-bar-text);
  }

  .reader-top {
    top: 0;
    padding-top: env(safe-area-inset-top);
  }

  .reader-bottom {
    bottom: calc(var(--reader-progress-height) + max(1.5rem, env(safe-area-inset-bottom) + 1rem));
    justify-content: space-between;
    padding-bottom: 0;
  }

  .reader-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 18;
    pointer-events: none;
  }

  .reader-progress-track {
    height: var(--reader-progress-height);
    overflow: hidden;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--reader-text) 12%, transparent);
  }

  .reader-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--reader-text);
    transition: width 120ms linear;
  }

  .reader-settings {
    position: absolute;
    left: 1rem;
    right: 1rem;
    bottom: max(4rem, calc(env(safe-area-inset-bottom) + 3rem));
    margin-inline: auto;
    max-width: 30rem;
    padding: 1.25rem;
    z-index: 1;
  }

  .reader-panel-backdrop {
    position: absolute;
    z-index: 0;
    inset: 0;
    border: 0;
    background: hsl(0 0% 0% / 0.24);
    pointer-events: auto;
  }

  .active-mode {
    box-shadow: inset 0 0 0 2px currentColor;
  }
</style>
