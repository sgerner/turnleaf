<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { getPreference, setPreference } from '../database/database';
  import {
    defaultAppearance,
    parseAppearance,
    serializeAppearance,
    type Appearance,
    type ReadingMode,
  } from '../reader/appearance';
  import { ReaderSession, type ReaderLocation, type TocItem } from '../reader/session';

  let {
    bookUrl,
    title,
    initialCfi = null,
    initialXPath = null,
    onBack,
    onRelocated,
  }: {
    bookUrl: string;
    title: string;
    initialCfi?: string | null;
    initialXPath?: string | null;
    onBack: () => void;
    onRelocated: (location: ReaderLocation) => void;
  } = $props();

  let viewport: HTMLDivElement;
  let session: ReaderSession | null = null;
  let controlsVisible = $state(false);
  let settingsVisible = $state(false);
  let tocVisible = $state(false);
  let toc = $state<TocItem[]>([]);
  let appearance = $state<Appearance>({ ...defaultAppearance });
  let location = $state<ReaderLocation | null>(null);
  let error = $state('');
  let hideTimer: number | null = null;
  let saveTimer: number | null = null;

  onMount(async () => {
    const saved = await getPreference('appearance');
    if (saved) appearance = parseAppearance(saved);
    session = new ReaderSession(bookUrl);
    try {
      await session.open(
        viewport,
        initialCfi,
        initialXPath,
        appearance,
        (next) => {
          location = next;
          onRelocated(next);
        },
        (zone) => {
          if (zone === 'center') {
            if (controlsVisible) controlsVisible = false;
            else showControls();
          } else void turn(zone);
        },
      );
      toc = session.tableOfContents();
    } catch {
      error = 'This EPUB could not be opened. The download may be incomplete or corrupted.';
    }
  });

  onDestroy(() => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    void setPreference('appearance', serializeAppearance(appearance));
    session?.destroy();
  });

  function showControls(): void {
    controlsVisible = true;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      controlsVisible = false;
      settingsVisible = false;
      tocVisible = false;
    }, 5_000);
  }

  function updateAppearance(patch: Partial<Appearance>): void {
    appearance = { ...appearance, ...patch };
    session?.applyAppearance(appearance);
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(
      () => void setPreference('appearance', serializeAppearance(appearance)),
      500,
    );
    showControls();
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
</script>

<div class="reader-shell" data-mode={appearance.mode}>
  <div class="reader-viewport" bind:this={viewport}></div>

  <nav class="tap-zones" aria-label="Page navigation">
    <button type="button" aria-label="Previous page" onclick={() => turn('previous')}></button>
    <button
      type="button"
      aria-label={controlsVisible ? 'Hide reading controls' : 'Show reading controls'}
      onclick={() => (controlsVisible ? (controlsVisible = false) : showControls())}
    ></button>
    <button type="button" aria-label="Next page" onclick={() => turn('next')}></button>
  </nav>

  {#if appearance.progressBar}
    <div class="reader-progress" aria-hidden="true">
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
      <header class="reader-bar reader-top" transition:fly={{ y: -8, duration: 140 }}>
        <div class="grid w-full grid-cols-3 gap-2">
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
            onclick={() => {
              tocVisible = !tocVisible;
              settingsVisible = false;
            }}
            aria-expanded={tocVisible}
          >
            Contents
          </button>
          <button
            class="btn preset-tonal-surface min-h-12"
            type="button"
            onclick={() => {
              settingsVisible = !settingsVisible;
              tocVisible = false;
            }}
            aria-expanded={settingsVisible}
          >
            Text
          </button>
        </div>
        <p class="min-w-0 flex-1 truncate text-center text-sm font-bold text-primary-500">
          {title}
        </p>
      </header>

      {#if settingsVisible}
        <section
          class="reader-settings card preset-filled-surface-50-950"
          transition:fly={{ y: 12, duration: 150 }}
        >
          <h2 class="font-serif text-xl">Reading appearance</h2>
          <div class="mt-4 grid grid-cols-2 gap-2" aria-label="Reading color mode">
            {#each ['light', 'dark'] as mode (mode)}
              <button
                class:active-mode={appearance.mode === mode}
                class="btn preset-outlined-surface-300-700 capitalize"
                type="button"
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
        </section>
      {/if}

      {#if tocVisible}
        <nav
          class="reader-settings card preset-filled-surface-50-950"
          aria-label="Table of contents"
          transition:fly={{ y: 12, duration: 150 }}
        >
          <h2 class="font-serif text-xl">Contents</h2>
          <div class="mt-3 max-h-[55dvh] overflow-auto">
            {#each toc as item (item.href)}
              <button
                class="btn w-full justify-start text-left"
                type="button"
                onclick={() => {
                  void session?.display(item.href);
                  tocVisible = false;
                }}>{item.label}</button
              >
            {/each}
          </div>
        </nav>
      {/if}

      <footer class="reader-bar reader-bottom">
        <span class="truncate text-xs">{location?.href ?? 'Opening book...'}</span>
        <span class="text-xs tabular-nums">{Math.round((location?.percentage ?? 0) * 100)}%</span>
      </footer>
    </div>
  {/if}
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
  }

  .reader-viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
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
    padding-top: max(0.75rem, env(safe-area-inset-top));
  }

  .reader-bottom {
    bottom: 0;
    justify-content: space-between;
    padding-bottom: max(1rem, env(safe-area-inset-bottom));
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
    height: 0.25rem;
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
  }

  .active-mode {
    box-shadow: inset 0 0 0 2px currentColor;
  }
</style>
