<script lang="ts">
  import { App } from '@capacitor/app';
  import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
  import { tick, onDestroy, onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { fade, fly } from 'svelte/transition';
  import { Animation, StatusBar } from '@capacitor/status-bar';
  import { getPreferences, setPreference } from '../database/database';
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
    onRetryDownload,
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
    onRetryDownload?: (() => Promise<void>) | undefined;
    registerBackHandler?: (handler: () => boolean) => () => void;
  } = $props();

  let viewport: HTMLDivElement;
  let readerToolbar = $state<HTMLElement | null>(null);
  let topRevealButton = $state<HTMLButtonElement | null>(null);
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
  let syncConfirmationPanel = $state<HTMLElement | null>(null);
  let settingsOpener: HTMLElement | null = null;
  let tocOpener: HTMLElement | null = null;
  let bookmarksOpener: HTMLElement | null = null;
  let annotationsOpener: HTMLElement | null = null;
  let searchOpener: HTMLElement | null = null;
  let syncConfirmationOpener: HTMLElement | null = null;
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
  let pendingSyncLocation = $state<{ xpath: string | null; percentage: number | null } | null>(
    null,
  );
  let error = $state('');
  let startupOpenFailed = $state(false);
  let retryingReader = $state(false);
  let hideTimer: number | null = null;
  let footerVisible = $state(false);
  let bottomSwipeStart: { id: number; x: number; y: number } | null = null;
  let saveTimer: number | null = null;
  let resumeHandle: PluginListenerHandle | null = null;
  let removeBackHandler: (() => void) | null = null;
  let syncingLatest = $state(false);
  let destroyed = false;
  let localNavigationDuringSession = false;
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
    const preferences = await getPreferences([
      'appearance',
      `readerBookmarks:${bookId}`,
      `readerHistory:${bookId}`,
      `readerAnnotations:${bookId}`,
    ]);
    if (destroyed) return;
    const saved = preferences.get('appearance');
    if (saved) appearance = parseAppearance(saved);
    bookmarks = parseBookmarks(preferences.get(`readerBookmarks:${bookId}`) ?? null);
    locationHistory = parseLocationHistory(preferences.get(`readerHistory:${bookId}`) ?? null);
    annotations = parseAnnotations(preferences.get(`readerAnnotations:${bookId}`) ?? null);
    try {
      await openReaderSession();
    } catch {
      if (destroyed) return;
      startupOpenFailed = true;
      error = 'This EPUB could not be opened. The download may be incomplete or corrupted.';
      session?.destroy();
      session = null;
      return;
    }

    await enableNativeReaderFeatures();
  });

  async function openReaderSession(): Promise<void> {
    const nextSession = new ReaderSession(bookUrl);
    session = nextSession;
    await nextSession.open(
      viewport,
      initialCfi,
      initialXPath,
      initialPercentage,
      appearance,
      (next, origin) => {
        if (destroyed) return;
        location = next;
        if (origin === 'navigation') {
          localNavigationDuringSession = true;
          onRelocated(next);
          locationHistory = recordLocation(locationHistory, next);
          queuePreference(`readerHistory:${bookId}`, JSON.stringify(locationHistory));
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
      handleKeyboardNavigation,
    );
    if (!destroyed) toc = nextSession.tableOfContents();
  }

  async function enableNativeReaderFeatures(): Promise<void> {
    if (!nativeFeatures) return;
    try {
      await nativeFeatures.enable(appearance.keepAwake);
    } catch {
      // Native reader chrome is optional; the reader itself should keep working.
    }
    if (destroyed || resumeHandle) return;

    try {
      const handle = await App.addListener('appStateChange', ({ isActive }) => {
        if (destroyed) return;
        if (isActive) void syncLatestLocation(false);
        else flushPendingPreferences();
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

  async function retryReaderOpen(): Promise<void> {
    if (!startupOpenFailed || !onRetryDownload || retryingReader) return;
    retryingReader = true;
    try {
      await onRetryDownload();
      if (destroyed) return;
      error = '';
      await openReaderSession();
      if (destroyed) return;
      startupOpenFailed = false;
      await enableNativeReaderFeatures();
    } catch (cause) {
      if (destroyed) return;
      session?.destroy();
      session = null;
      startupOpenFailed = true;
      error =
        cause instanceof Error
          ? cause.message
          : 'The EPUB could not be opened after retrying the download.';
    } finally {
      retryingReader = false;
    }
  }

  onDestroy(() => {
    destroyed = true;
    removeBackHandler?.();
    removeBackHandler = null;
    window.removeEventListener('keydown', handleKeyboardNavigation);
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    flushPendingPreferences();
    searchController?.abort();
    const handle = resumeHandle;
    resumeHandle = null;
    void handle?.remove();
    void nativeFeatures?.disable();
    session?.destroy();
  });

  function showControls(): void {
    const restoreToolbarFocus = document.activeElement === topRevealButton;
    controlsVisible = true;
    scheduleChromeHide();
    if (restoreToolbarFocus) void tick().then(() => focusFirstElement(readerToolbar));
  }

  function activeElement(): HTMLElement | null {
    return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  function focusPanel(getPanel: () => HTMLElement | null): void {
    void tick().then(() => focusFirstElement(getPanel()));
  }

  function restorePanelFocus(opener: HTMLElement | null): void {
    void tick().then(() => restoreFocus(opener));
  }

  function focusReaderTarget(panel: HTMLElement | null, target: string, id?: string): void {
    void tick().then(() => {
      const controls = panel?.querySelectorAll<HTMLElement>('[data-reader-focus]') ?? [];
      const element = [...controls].find(
        (control) =>
          control.dataset.readerFocus === target &&
          (id === undefined || control.dataset.readerFocusId === id),
      );
      (element ?? panel)?.focus();
    });
  }

  function hasOpenReaderPanel(): boolean {
    return (
      settingsVisible ||
      tocVisible ||
      bookmarksVisible ||
      annotationsVisible ||
      searchVisible ||
      pendingSyncLocation !== null
    );
  }

  function pauseChromeHide(): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function resumeChromeHide(): void {
    if (controlsVisible && !hasOpenReaderPanel()) scheduleChromeHide();
  }

  function openSettings(): void {
    pauseChromeHide();
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
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function openToc(): void {
    pauseChromeHide();
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
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function openBookmarks(): void {
    pauseChromeHide();
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
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function openAnnotations(): void {
    pauseChromeHide();
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
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function openSearch(): void {
    pauseChromeHide();
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
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function openSyncConfirmation(progress: {
    xpath: string | null;
    percentage: number | null;
  }): void {
    pauseChromeHide();
    syncConfirmationOpener = activeElement();
    pendingSyncLocation = progress;
    focusPanel(() => syncConfirmationPanel);
  }

  function closeSyncConfirmation(): void {
    pendingSyncLocation = null;
    const opener = syncConfirmationOpener;
    syncConfirmationOpener = null;
    restorePanelFocus(opener);
    resumeChromeHide();
  }

  function showFooter(): void {
    footerVisible = true;
    scheduleChromeHide();
  }

  function toggleFooter(): void {
    if (footerVisible) footerVisible = false;
    else showFooter();
  }

  function currentSectionLabel(): string {
    if (!location) return 'Opening book...';
    const sectionHref = location.href.split('#')[0];
    const item = toc.find((entry) => entry.href.split('#')[0] === sectionHref);
    return item?.label || `Section ${location.spineIndex + 1}`;
  }

  function currentProgressLabel(): string {
    return `${Math.round((location?.percentage ?? 0) * 100)}%`;
  }

  function scheduleChromeHide(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (hasOpenReaderPanel()) return;
      const restoreToolbarFocus = Boolean(
        readerToolbar && document.activeElement && readerToolbar.contains(document.activeElement),
      );
      controlsVisible = false;
      footerVisible = false;
      if (restoreToolbarFocus) void tick().then(() => topRevealButton?.focus());
    }, 5_000);
  }

  function updateAppearance(patch: Partial<Appearance>): void {
    appearance = { ...appearance, ...patch };
    session?.applyAppearance(appearance);
    if (patch.keepAwake !== undefined) {
      void nativeFeatures?.setKeepAwake(patch.keepAwake);
    }
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushPendingPreferences, 500);
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

  const pendingPreferences = new SvelteMap<string, string>();
  let preferenceWrite = Promise.resolve();

  function queuePreference(key: string, value: string): void {
    pendingPreferences.set(key, value);
    flushPreferences();
  }

  function flushPreferences(): void {
    preferenceWrite = preferenceWrite.then(async () => {
      for (const [key, value] of [...pendingPreferences]) {
        try {
          await setPreference(key, value);
          if (pendingPreferences.get(key) === value) pendingPreferences.delete(key);
        } catch {
          // Keep this preference pending for the next save or lifecycle flush.
        }
      }
    });
  }

  function flushPendingPreferences(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      pendingPreferences.set('appearance', serializeAppearance(appearance));
    }
    flushPreferences();
  }

  function currentBookmark(): StoredReaderLocation | null {
    if (!location) return null;
    const id = `${location.cfi}|${location.href}`;
    return bookmarks.find((bookmark) => bookmark.id === id) ?? null;
  }

  function toggleCurrentBookmark(): void {
    if (!location) return;
    bookmarks = toggleBookmark(bookmarks, readerLocation(location));
    queuePreference(`readerBookmarks:${bookId}`, JSON.stringify(bookmarks));
    showControls();
  }

  function startBookmarkEdit(bookmark: StoredReaderLocation): void {
    editingBookmarkId = bookmark.id;
    bookmarkDraft = bookmark.label;
    focusReaderTarget(bookmarksPanel, 'bookmark-editor', bookmark.id);
  }

  function saveBookmarkName(bookmark: StoredReaderLocation): void {
    bookmarks = renameBookmark(bookmarks, bookmark.id, bookmarkDraft);
    editingBookmarkId = null;
    queuePreference(`readerBookmarks:${bookId}`, JSON.stringify(bookmarks));
    focusReaderTarget(bookmarksPanel, 'bookmark-rename', bookmark.id);
  }

  function deleteBookmark(bookmark: StoredReaderLocation): void {
    const index = bookmarks.findIndex((entry) => entry.id === bookmark.id);
    bookmarks = removeBookmark(bookmarks, bookmark.id);
    if (editingBookmarkId === bookmark.id) editingBookmarkId = null;
    queuePreference(`readerBookmarks:${bookId}`, JSON.stringify(bookmarks));
    const next = bookmarks[Math.min(Math.max(index, 0), bookmarks.length - 1)];
    focusReaderTarget(bookmarksPanel, next ? 'bookmark-location' : 'bookmark-current', next?.id);
  }

  function saveAnnotation(): void {
    if (!selectedText) return;
    annotations = addAnnotation(annotations, selectedText.cfi, selectedText.text, annotationDraft);
    annotationDraft = '';
    selectedText = null;
    queuePreference(`readerAnnotations:${bookId}`, JSON.stringify(annotations));
  }

  function editAnnotation(annotation: StoredAnnotation): void {
    annotations = updateAnnotation(annotations, annotation.id, annotationDraft);
    editingAnnotationId = null;
    annotationDraft = '';
    queuePreference(`readerAnnotations:${bookId}`, JSON.stringify(annotations));
    focusReaderTarget(annotationsPanel, 'annotation-edit', annotation.id);
  }

  function startAnnotationEdit(annotation: StoredAnnotation): void {
    editingAnnotationId = annotation.id;
    annotationDraft = annotation.note;
    focusReaderTarget(annotationsPanel, 'annotation-editor', annotation.id);
  }

  function deleteAnnotation(annotation: StoredAnnotation): void {
    const index = annotations.findIndex((entry) => entry.id === annotation.id);
    annotations = removeAnnotation(annotations, annotation.id);
    queuePreference(`readerAnnotations:${bookId}`, JSON.stringify(annotations));
    const next = annotations[Math.min(Math.max(index, 0), annotations.length - 1)];
    focusReaderTarget(annotationsPanel, next ? 'annotation-edit' : 'annotations-heading', next?.id);
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

  function normalizeReaderXPath(xpath: string): string {
    return xpath
      .trim()
      .toLowerCase()
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '');
  }

  function hasSyncedLocation(progress: {
    xpath: string | null;
    percentage: number | null;
  }): boolean {
    return (
      Boolean(progress.xpath?.trim()) ||
      (typeof progress.percentage === 'number' &&
        Number.isFinite(progress.percentage) &&
        progress.percentage > 0)
    );
  }

  function hasDivergentSyncLocation(progress: {
    xpath: string | null;
    percentage: number | null;
  }): boolean {
    if (!hasSyncedLocation(progress)) return false;
    if (!location) return true;
    const serverXPath = progress.xpath?.trim();
    const localXPath = location.xpath?.trim();
    if (serverXPath && localXPath) {
      return normalizeReaderXPath(serverXPath) !== normalizeReaderXPath(localXPath);
    }
    if (typeof progress.percentage === 'number' && Number.isFinite(progress.percentage)) {
      return Math.abs(location.percentage - progress.percentage) >= 0.001;
    }
    return true;
  }

  async function displaySyncedLocation(
    reader: ReaderSession,
    progress: { xpath: string | null; percentage: number | null },
  ): Promise<void> {
    if (progress.xpath) {
      const restored = await reader.displayServerLocation(progress.xpath);
      if (restored) return;
    }
    if (
      typeof progress.percentage === 'number' &&
      Number.isFinite(progress.percentage) &&
      progress.percentage > 0
    ) {
      await reader.displayServerPercentage(progress.percentage);
    }
  }

  async function confirmSyncLocation(): Promise<void> {
    const progress = pendingSyncLocation;
    const reader = session;
    closeSyncConfirmation();
    if (!progress || !reader) return;
    try {
      await displaySyncedLocation(reader, progress);
    } catch {
      error = 'Kavita’s latest reading position could not be opened.';
    }
    showControls();
  }

  async function syncLatestLocation(showFeedback = true): Promise<void> {
    if (!session || !onSyncLatest || syncingLatest) return;
    if (!showFeedback && (initialCfi || localNavigationDuringSession)) return;
    const reader = session;
    syncingLatest = true;
    try {
      const progress = await onSyncLatest();
      if (destroyed || session !== reader || (!showFeedback && localNavigationDuringSession))
        return;
      if (progress && showFeedback && hasDivergentSyncLocation(progress)) {
        openSyncConfirmation(progress);
        return;
      }
      if (progress && !showFeedback && hasDivergentSyncLocation(progress)) {
        await displaySyncedLocation(reader, progress);
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
    }
  }

  function handleKeyboardNavigation(event: KeyboardEvent): void {
    if (destroyed || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element | null;
    if (target?.closest?.('button, a, input, select, textarea, [contenteditable="true"]')) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      void turn('previous');
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      void turn('next');
      return;
    }
    if (
      event.key === 'Escape' &&
      (settingsVisible ||
        tocVisible ||
        bookmarksVisible ||
        annotationsVisible ||
        searchVisible ||
        pendingSyncLocation)
    ) {
      event.preventDefault();
      if (pendingSyncLocation) closeSyncConfirmation();
      closeSettings();
      closeToc();
      closeBookmarks();
      closeAnnotations();
      closeSearch();
      showControls();
    }
  }

  function handleBackButton(): boolean {
    if (pendingSyncLocation) closeSyncConfirmation();
    else if (settingsVisible) closeSettings();
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

  <p class="sr-only" aria-live="polite" aria-atomic="true">
    {#if location}
      {currentSectionLabel()}, page {location.pageIndex + 1} of {location.pageCount},
      {currentProgressLabel()} complete.
    {/if}
  </p>

  <p id="reader-keyboard-help" class="sr-only">
    Use Left or Page Up for the previous page. Use Right, Page Down, or Space for the next page.
    Press Escape to close an open reader panel.
  </p>

  <nav
    class="tap-zones"
    aria-label="Page navigation"
    inert={Boolean(
      settingsVisible ||
      tocVisible ||
      bookmarksVisible ||
      annotationsVisible ||
      searchVisible ||
      pendingSyncLocation,
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
      bind:this={topRevealButton}
      aria-label="Show reading controls"
      onclick={showControls}
    ></button>
  {/if}

  {#if error}
    <div class="absolute inset-0 grid place-items-center p-8" role="alert">
      <div class="card preset-tonal-error max-w-sm p-6 text-center">
        <p>{error}</p>
        <div class="mt-5 flex flex-wrap justify-center gap-3">
          {#if startupOpenFailed && onRetryDownload}
            <button
              class="btn preset-filled-primary-700-300"
              type="button"
              disabled={retryingReader}
              onclick={() => void retryReaderOpen()}
            >
              {retryingReader ? 'Retrying download…' : 'Retry download'}
            </button>
          {/if}
          <button class="btn preset-filled-error-500" type="button" onclick={onBack}>Back</button>
        </div>
      </div>
    </div>
  {/if}

  {#if controlsVisible}
    <div class="reader-overlay" data-controls transition:fade={{ duration: 120 }}>
      <header
        bind:this={readerToolbar}
        class="reader-bar reader-top"
        inert={Boolean(
          settingsVisible ||
          tocVisible ||
          bookmarksVisible ||
          annotationsVisible ||
          searchVisible ||
          pendingSyncLocation,
        )}
        transition:fly={{ y: -8, duration: 140 }}
      >
        <div class="reader-toolbar">
          <div class="reader-toolbar-actions">
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={onBack}
              aria-label="Back to library"
              title="Back to library"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"
                />
              </svg>
              <span class="reader-toolbar-label">Back</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={() => (tocVisible ? closeToc() : openToc())}
              aria-label="Contents"
              aria-expanded={tocVisible}
              aria-controls="reader-contents"
              title="Contents"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path fill="currentColor" d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
              </svg>
              <span class="reader-toolbar-label">Contents</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={() => (settingsVisible ? closeSettings() : openSettings())}
              aria-label="Text, reading appearance"
              aria-expanded={settingsVisible}
              aria-controls="reader-appearance"
              title="Reading appearance"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path fill="currentColor" d="M5 4h14v2h-6v14h-2V6H5V4Z" />
              </svg>
              <span class="reader-toolbar-label">Text</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={() => (bookmarksVisible ? closeBookmarks() : openBookmarks())}
              aria-label="Marks, bookmarks and history"
              aria-expanded={bookmarksVisible}
              aria-controls="reader-bookmarks"
              title="Open bookmarks and history"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="m12 3 2.78 5.63 6.22.9-4.5 4.38 1.06 6.2L12 17.18l-5.56 2.93 1.06-6.2L3 9.53l6.22-.9L12 3Z"
                />
              </svg>
              <span class="reader-toolbar-label">Marks</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={() => (annotationsVisible ? closeAnnotations() : openAnnotations())}
              aria-label="Notes: highlights and annotations"
              aria-expanded={annotationsVisible}
              aria-controls="reader-annotations"
              title="Open highlights and notes"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="m4 17.25 9.67-9.67 2.75 2.75L6.75 20H4v-2.75ZM17.12 6.13l.75-.75a1.5 1.5 0 0 1 2.12 0l.63.63a1.5 1.5 0 0 1 0 2.12l-.75.75-2.75-2.75Z"
                />
              </svg>
              <span class="reader-toolbar-label">Notes</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
              type="button"
              onclick={() => (searchVisible ? closeSearch() : openSearch())}
              aria-label="Search this book"
              aria-expanded={searchVisible}
              aria-controls="reader-search"
              title="Search this book"
            >
              <svg class="reader-toolbar-icon" aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="m15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5ZM9.5 14A4.5 4.5 0 1 1 9.5 5a4.5 4.5 0 0 1 0 9Z"
                />
              </svg>
              <span class="reader-toolbar-label">Search</span>
            </button>
            <button
              class="btn min-w-0 preset-tonal-surface min-h-12"
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
                class="reader-toolbar-icon reader-toolbar-icon-always"
              >
                <path
                  fill="currentColor"
                  d="M17.7 6.3A8 8 0 0 0 4.3 10H2l3.5 3.5L9 10H6.4a5.8 5.8 0 0 1 9.8-2.2l1.5-1.5ZM18.5 10.5 15 14h2.6a5.8 5.8 0 0 1-9.8 2.2l-1.5 1.5A8 8 0 0 0 19.7 14H22l-3.5-3.5Z"
                />
              </svg>
              <span class="reader-toolbar-label">Sync</span>
            </button>
          </div>
          <p class="reader-toolbar-title">
            {title}
          </p>
        </div>
      </header>

      {#if settingsVisible || tocVisible || bookmarksVisible || annotationsVisible || searchVisible || pendingSyncLocation}
        <button
          class="reader-panel-backdrop"
          type="button"
          tabindex="-1"
          aria-label="Close reader panel"
          onclick={() =>
            pendingSyncLocation
              ? closeSyncConfirmation()
              : settingsVisible
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

      {#if pendingSyncLocation}
        <div
          bind:this={syncConfirmationPanel}
          class="reader-settings card preset-filled-surface-50-950 relative max-w-sm"
          data-reader-panel
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reader-sync-confirm-title"
          aria-describedby="reader-sync-confirm-description"
          tabindex="-1"
          onkeydown={(event) =>
            trapModalKeydown(event, syncConfirmationPanel!, closeSyncConfirmation)}
          transition:fly={{ y: 12, duration: 150 }}
        >
          <h2 id="reader-sync-confirm-title" class="font-serif text-xl">
            Move to Kavita’s latest position?
          </h2>
          <p id="reader-sync-confirm-description" class="mt-3 text-sm text-surface-700-300">
            Kavita has a different reading position saved. Move this reader there?
          </p>
          <div class="mt-5 flex flex-wrap justify-end gap-2">
            <button class="btn preset-tonal-surface" type="button" onclick={closeSyncConfirmation}>
              Stay here
            </button>
            <button
              class="btn preset-filled-primary-700-300"
              type="button"
              onclick={() => void confirmSyncLocation()}
            >
              Go to latest position
            </button>
          </div>
        </div>
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
          <div class="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="Reading color mode">
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
            <span class="label-text">
              Text size: <span aria-hidden="true">{appearance.fontSize} pixels</span>
            </span>
            <input
              class="range"
              type="range"
              aria-label="Text size"
              aria-valuetext={`${appearance.fontSize} pixels`}
              min="14"
              max="34"
              value={appearance.fontSize}
              oninput={(event) => updateAppearance({ fontSize: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">
              Line height: <span aria-hidden="true">{appearance.lineHeight.toFixed(1)}</span>
            </span>
            <input
              class="range"
              type="range"
              aria-label="Line height"
              aria-valuetext={appearance.lineHeight.toFixed(1)}
              min="1.2"
              max="2"
              step="0.1"
              value={appearance.lineHeight}
              oninput={(event) =>
                updateAppearance({ lineHeight: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">
              Page margins: <span aria-hidden="true">{appearance.margin} pixels</span>
            </span>
            <input
              class="range"
              type="range"
              aria-label="Page margins"
              aria-valuetext={`${appearance.margin} pixels`}
              min="8"
              max="56"
              value={appearance.margin}
              oninput={(event) => updateAppearance({ margin: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">
              Bottom margin: <span aria-hidden="true">{appearance.bottomMargin} pixels</span>
            </span>
            <input
              class="range"
              type="range"
              aria-label="Bottom margin"
              aria-valuetext={`${appearance.bottomMargin} pixels`}
              min="0"
              max="64"
              step="2"
              value={appearance.bottomMargin}
              oninput={(event) =>
                updateAppearance({ bottomMargin: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="label mt-4">
            <span class="label-text">
              Paragraph spacing:
              <span aria-hidden="true">{appearance.paragraphSpacing.toFixed(1)}</span>
            </span>
            <input
              class="range"
              type="range"
              aria-label="Paragraph spacing"
              aria-valuetext={`${appearance.paragraphSpacing.toFixed(1)} em`}
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
              data-reader-focus="bookmark-current"
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
                          data-reader-focus="bookmark-editor"
                          data-reader-focus-id={bookmark.id}
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
                          data-reader-focus="bookmark-location"
                          data-reader-focus-id={bookmark.id}
                          onclick={() => void returnToLocation(bookmark)}
                        >
                          {bookmark.label}
                        </button>
                        <button
                          class="btn btn-sm preset-tonal-surface h-11 w-11 p-0"
                          type="button"
                          aria-label={`Rename ${bookmark.label}`}
                          data-reader-focus="bookmark-rename"
                          data-reader-focus-id={bookmark.id}
                          onclick={() => startBookmarkEdit(bookmark)}
                        >
                          <span aria-hidden="true">✎</span>
                        </button>
                        <button
                          class="btn btn-sm preset-tonal-error h-11 w-11 p-0"
                          type="button"
                          aria-label={`Delete ${bookmark.label}`}
                          data-reader-focus="bookmark-delete"
                          data-reader-focus-id={bookmark.id}
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
            <h3
              class="text-sm font-semibold uppercase tracking-wide"
              tabindex="-1"
              data-reader-focus="annotations-heading"
            >
              Saved highlights
            </h3>
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
                        <textarea
                          class="textarea min-h-20"
                          data-reader-focus="annotation-editor"
                          data-reader-focus-id={annotation.id}
                          bind:value={annotationDraft}></textarea>
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
                            focusReaderTarget(annotationsPanel, 'annotation-edit', annotation.id);
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
                        aria-label={`Edit note for ${annotation.excerpt}`}
                        data-reader-focus="annotation-edit"
                        data-reader-focus-id={annotation.id}
                        onclick={() => startAnnotationEdit(annotation)}
                      >
                        Edit note
                      </button>
                      <button
                        class="btn btn-sm preset-tonal-error"
                        type="button"
                        aria-label={`Delete highlight ${annotation.excerpt}`}
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
      <span class="truncate text-xs">{currentSectionLabel()}</span>
      <span class="text-xs tabular-nums">{currentProgressLabel()}</span>
    </footer>
  {/if}

  <button
    class="reader-progress-reveal btn btn-sm preset-tonal-surface"
    type="button"
    aria-label={`${footerVisible ? 'Hide' : 'Show'} reading details, ${currentProgressLabel()} complete`}
    aria-pressed={footerVisible}
    title={footerVisible ? 'Hide reading details' : 'Show reading details'}
    onclick={toggleFooter}
  >
    {currentProgressLabel()}
  </button>

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
    pointer-events: none;
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

  .reader-settings :global(button),
  .reader-settings :global(input),
  .reader-settings :global(select) {
    min-height: 2.75rem;
  }

  .reader-settings :global(input[type='range']) {
    touch-action: pan-x;
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

  .reader-toolbar {
    display: flex;
    min-width: 0;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
  }

  .reader-toolbar-actions {
    display: grid;
    min-width: 0;
    flex: 1 1 auto;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .reader-toolbar-actions :global(button) {
    min-width: 0;
    overflow: hidden;
  }

  .reader-toolbar-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reader-toolbar-icon {
    display: none;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
  }

  .reader-toolbar-icon-always {
    display: block;
  }

  .reader-toolbar-title {
    min-width: 0;
    max-width: 14rem;
    flex: 0 1 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--color-primary-500);
  }

  @media (max-width: 40rem) {
    .reader-toolbar {
      display: block;
    }

    .reader-toolbar-actions {
      width: 100%;
      gap: 0.25rem;
    }

    .reader-toolbar-label {
      display: none;
    }

    .reader-toolbar-icon {
      display: block;
      margin-inline: auto;
    }

    .reader-toolbar-title {
      display: none;
    }
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

  .reader-progress-reveal {
    position: absolute;
    right: max(1rem, env(safe-area-inset-right));
    bottom: max(0.25rem, env(safe-area-inset-bottom));
    z-index: 19;
    min-width: 3rem;
    min-height: 2.75rem;
    color: var(--reader-bar-text);
  }

  .reader-settings {
    position: absolute;
    left: 1rem;
    right: 1rem;
    bottom: max(4rem, calc(env(safe-area-inset-bottom) + 3rem));
    margin-inline: auto;
    max-width: 30rem;
    max-height: min(75dvh, calc(100dvh - max(4rem, env(safe-area-inset-bottom) + 3rem) - 1rem));
    overflow: auto;
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
