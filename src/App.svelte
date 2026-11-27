<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import Onboarding from './lib/components/Onboarding.svelte';
  import Library from './lib/components/Library.svelte';
  import DiagnosticsPanel from './lib/components/DiagnosticsPanel.svelte';
  import TurnleafLogo from './lib/components/TurnleafLogo.svelte';
  import { clearDiagnostics, hydrateDiagnostics, recordDiagnostic } from './lib/diagnostics/log';
  import { fetchLatestGithubRelease, type ReleaseBanner } from './lib/github/releases';
  import * as database from './lib/database/database';
  import type { ServerConfig } from './lib/database/database';
  import { getApiKey } from './lib/native/credentials';
  import {
    collectLibraryReadingNotes,
    exportTextDocument,
    readingNotesBackupMarkdown,
    serializeReadingNotesBackup,
    type BookNoteMetadata,
    type ReadingNotesBookBackup,
  } from './lib/reader/notes-backup';
  import {
    DEFAULT_MODE,
    DEFAULT_THEME,
    isSkeletonTheme,
    loadTheme,
    normalizeUiMode,
    readBootThemeCache,
    syncShellAppearanceChrome,
    writeBootThemeCache,
    type SkeletonTheme,
    type UiMode,
  } from './lib/themes/themes';

  const themePreferenceKey = 'uiTheme';
  const modePreferenceKey = 'uiMode';

  let {
    initialTheme,
    initialMode,
  }: {
    initialTheme?: SkeletonTheme | undefined;
    initialMode?: UiMode | undefined;
  } = $props();

  function resolveInitialAppearance(): { theme: SkeletonTheme; mode: UiMode } {
    const cached = readBootThemeCache();
    if (cached) return { theme: cached.theme, mode: cached.mode };
    if (typeof document !== 'undefined') {
      const domTheme = document.documentElement.dataset.theme;
      const domMode = document.documentElement.dataset.mode;
      return {
        theme: domTheme && isSkeletonTheme(domTheme) ? domTheme : DEFAULT_THEME,
        mode: normalizeUiMode(domMode),
      };
    }
    return { theme: DEFAULT_THEME, mode: DEFAULT_MODE };
  }

  const bootAppearance = resolveInitialAppearance();

  let server = $state<ServerConfig | null>(null);
  let booting = $state(Capacitor.isNativePlatform());
  let startupError = $state('');
  let repairing = $state(false);
  let salvagedNotes = $state<ReadingNotesBookBackup[]>([]);
  let salvagedPreferences = $state<Map<string, string> | null>(null);
  let salvagedRestorePending = $state(false);
  let startupExportMessage = $state('');
  let startupExportFallback = $state('');
  let exportingStartupNotes = $state(false);
  let changingServerAddress = $state(false);
  let apiKey = $state<string | null>(null);
  let uiTheme = $state<SkeletonTheme>(untrack(() => initialTheme ?? bootAppearance.theme));
  let uiMode = $state<UiMode>(untrack(() => initialMode ?? bootAppearance.mode));
  let readerOpen = $state(false);
  let releaseBanner = $state<ReleaseBanner | null>(null);
  let stageOverlayActive = $state(false);

  async function trySalvageReadingNotes(): Promise<{
    preferences: Map<string, string>;
    books: BookNoteMetadata[];
  } | null> {
    try {
      if (!('salvageOpenReadingNotePreferences' in database)) return null;
      return await database.salvageOpenReadingNotePreferences();
    } catch {
      return null;
    }
  }

  async function restoreSalvagedPreferences(prefs: ReadonlyMap<string, string>): Promise<void> {
    if (!('setPreferences' in database)) return;
    await database.setPreferences(prefs);
  }

  async function loadLocalData(): Promise<void> {
    booting = true;
    startupError = '';
    server = null;
    apiKey = null;
    readerOpen = false;
    void checkForRelease();
    try {
      const [saved, preferences] = await Promise.all([
        database.getServer(),
        database.getPreferences([themePreferenceKey, modePreferenceKey]),
      ]);
      const savedTheme = preferences.get(themePreferenceKey);
      const savedMode = preferences.get(modePreferenceKey);
      const requestedTheme = savedTheme && isSkeletonTheme(savedTheme) ? savedTheme : DEFAULT_THEME;
      const resolvedTheme: SkeletonTheme = (await loadTheme(requestedTheme).catch(() => false))
        ? requestedTheme
        : DEFAULT_THEME;
      const resolvedMode = normalizeUiMode(savedMode);
      uiTheme = resolvedTheme;
      uiMode = resolvedMode;
      if (savedTheme !== undefined || savedMode !== undefined) {
        writeBootThemeCache(resolvedTheme, resolvedMode);
      }
      if (saved) {
        server = saved;
        try {
          apiKey = await getApiKey(saved.credentialRef);
        } catch {
          recordDiagnostic({
            category: 'startup',
            endpoint: 'local/credentials',
            detail: 'credential-read-failed',
          });
          startupError =
            'Turnleaf could not read the saved Kavita key. Retry or enter the key again.';
        }
      }
    } catch {
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'database-open-failed',
      });
      const salvaged = await trySalvageReadingNotes();
      if (salvaged && salvaged.preferences.size > 0) {
        salvagedPreferences = salvaged.preferences;
        salvagedNotes = collectLibraryReadingNotes(salvaged.preferences, salvaged.books);
      }
      startupError =
        'Turnleaf could not open its local data. Retry first; resetting is a last resort and clears saved reading progress and settings.';
    } finally {
      booting = false;
    }
  }

  onMount(() => {
    void hydrateDiagnostics();
    void loadLocalData();
  });

  async function exportSalvagedStartupNotes(
    format: 'json' | 'markdown',
    copy = false,
  ): Promise<void> {
    if (!salvagedNotes.length || exportingStartupNotes) return;
    exportingStartupNotes = true;
    startupExportMessage = '';
    startupExportFallback = '';
    try {
      const content =
        format === 'json'
          ? serializeReadingNotesBackup(salvagedNotes)
          : readingNotesBackupMarkdown(salvagedNotes);
      const ext = format === 'json' ? 'json' : 'md';
      const mimeType = format === 'json' ? 'application/json' : 'text/markdown';
      const filename = Capacitor.isNativePlatform()
        ? `turnleaf-reading-notes-${Date.now()}.${ext}`
        : `turnleaf-reading-notes.${ext}`;
      const result = await exportTextDocument({
        filename,
        content,
        mimeType,
        copy,
        copiedLabel: 'Reading notes backup copied to clipboard.',
      });
      startupExportMessage = result.message;
      startupExportFallback = result.fallbackText;
    } finally {
      exportingStartupNotes = false;
    }
  }

  async function repairLocalData(): Promise<void> {
    repairing = true;
    try {
      if (!salvagedPreferences) {
        const salvaged = await trySalvageReadingNotes();
        if (salvaged && salvaged.preferences.size > 0) {
          salvagedPreferences = salvaged.preferences;
          if (salvagedNotes.length === 0) {
            salvagedNotes = collectLibraryReadingNotes(salvaged.preferences, salvaged.books);
          }
        }
      }
      if (!salvagedRestorePending) {
        await database.resetLocalDatabase();
        await clearDiagnostics();
        if (salvagedPreferences && salvagedPreferences.size > 0) {
          salvagedRestorePending = true;
        }
      }
      if (salvagedPreferences && salvagedPreferences.size > 0) {
        try {
          await restoreSalvagedPreferences(salvagedPreferences);
        } catch {
          recordDiagnostic({
            category: 'startup',
            endpoint: 'local/database',
            detail: 'notes-restore-failed',
          });
          if (salvagedNotes.length === 0) {
            salvagedNotes = collectLibraryReadingNotes(salvagedPreferences, []);
          }
          server = null;
          apiKey = null;
          startupError =
            'Local data was reset, but Turnleaf could not restore your saved bookmarks and notes. Export or copy a backup below, or retry restoring them.';
          return;
        }
      }
      await loadLocalData();
      if (!startupError) {
        salvagedRestorePending = false;
        salvagedPreferences = null;
        salvagedNotes = [];
        startupExportMessage = '';
        startupExportFallback = '';
      }
    } catch {
      recordDiagnostic({
        category: 'startup',
        endpoint: 'local/database',
        detail: 'database-reset-failed',
      });
      startupError =
        'Local data could not be reset. Your downloaded EPUB files were left in place; try again or reinstall the app.';
      return;
    } finally {
      repairing = false;
    }
  }

  function retryStartupAction(): void {
    if (salvagedRestorePending) {
      void repairLocalData();
      return;
    }
    void loadLocalData();
  }

  async function checkForRelease(): Promise<void> {
    const latest = await fetchLatestGithubRelease(__APP_VERSION__);
    if (latest) releaseBanner = latest;
  }

  function displayVersion(version: string): string {
    return version.split('+', 1)[0] ?? version;
  }

  $effect(() => {
    document.documentElement.dataset.theme = uiTheme;
    document.documentElement.dataset.mode = uiMode;
    syncShellAppearanceChrome(uiTheme, uiMode, { readerActive: readerOpen });
  });
</script>

<div class="app-shell">
  {#if !readerOpen && uiTheme !== 'eink'}
    <div class="app-ambient" aria-hidden="true">
      <div class="orb orb-primary"></div>
      <div class="orb orb-secondary"></div>
      <div class="orb orb-tertiary"></div>
      <div class="vignette"></div>
    </div>
  {/if}

  {#if releaseBanner}
    <div class="release-banner" inert={stageOverlayActive} transition:fade>
      <div class="mx-auto w-full max-w-4xl px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <div
          class="flex flex-col gap-3 rounded-2xl preset-filled-surface-50-950 px-4 py-3 shadow-2xl sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="text-xs uppercase tracking-[0.3em] text-surface-700-300">Update available</p>
            <p class="mt-1 font-medium text-surface-950-50">
              Turnleaf {displayVersion(releaseBanner.version)}{releaseBanner.title
                ? ` · ${releaseBanner.title}`
                : ''}
            </p>
            <p class="text-sm text-surface-700-300">A newer GitHub release was found at startup.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {#if releaseBanner.downloadUrl}
              <a
                class="btn btn-sm preset-filled-success-500 !text-sm"
                href={releaseBanner.downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                Download APK <span class="sr-only">(opens in a new tab)</span>
              </a>
            {/if}
            <a
              class="btn btn-sm preset-filled-tertiary-500 !text-sm"
              href={releaseBanner.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              Release notes <span class="sr-only">(opens in a new tab)</span>
            </a>
            <button
              class="btn btn-sm preset-tonal-error !text-sm"
              type="button"
              onclick={() => (releaseBanner = null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <div class="app-stage">
    {#if booting}
      <main class="grid min-h-full place-items-center" aria-label="Opening Turnleaf">
        <div class="grid justify-items-center gap-4">
          <TurnleafLogo size={104} />
          <p class="text-sm tracking-wide text-surface-700-300">Opening your library...</p>
        </div>
      </main>
    {:else if server && apiKey && !changingServerAddress}
      <Library
        {server}
        {apiKey}
        theme={uiTheme}
        mode={uiMode}
        onThemeChange={(value) => (uiTheme = value)}
        onModeChange={(value) => (uiMode = value)}
        onApiKeyChange={(value) => (apiKey = value)}
        onReaderOpenChange={(open) => (readerOpen = open)}
        onChangeServerAddress={() => {
          readerOpen = false;
          changingServerAddress = true;
        }}
        onServerDeleted={() => {
          readerOpen = false;
          server = null;
          apiKey = null;
        }}
        onOverlayActiveChange={(active) => (stageOverlayActive = active)}
      />
    {:else if startupError}
      <div class="alert preset-tonal-error mx-auto mt-6 max-w-lg flex flex-col gap-3" role="alert">
        <p>{startupError}</p>
        {#if salvagedNotes.length > 0 && !server}
          <div class="rounded-lg preset-tonal-surface p-3">
            <p class="text-sm text-surface-950-50">
              {salvagedRestorePending
                ? 'Your salvaged bookmarks and notes are still held in memory. Export or copy a backup before closing Turnleaf, or retry saving them.'
                : 'Readable bookmarks or notes were found and will be kept if possible. Export a backup before resetting local data.'}
            </p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button
                class="btn btn-sm preset-tonal-primary !text-sm"
                type="button"
                disabled={repairing || exportingStartupNotes}
                onclick={() => void exportSalvagedStartupNotes('json')}
              >
                Export JSON backup
              </button>
              <button
                class="btn btn-sm preset-tonal-surface !text-sm"
                type="button"
                disabled={repairing || exportingStartupNotes}
                onclick={() => void exportSalvagedStartupNotes('markdown')}
              >
                Export Markdown
              </button>
              <button
                class="btn btn-sm preset-tonal-surface !text-sm"
                type="button"
                disabled={repairing || exportingStartupNotes}
                onclick={() => void exportSalvagedStartupNotes('json', true)}
              >
                Copy JSON
              </button>
            </div>
            {#if startupExportMessage}
              <p class="mt-2 text-sm" role="status">{startupExportMessage}</p>
            {/if}
            {#if startupExportFallback}
              <label class="label mt-2">
                <span class="label-text text-xs">Exported reading notes</span>
                <textarea class="textarea min-h-24 text-xs" readonly value={startupExportFallback}
                ></textarea>
              </label>
            {/if}
          </div>
        {/if}
        <div class="flex flex-wrap gap-2">
          <button
            class="btn btn-sm preset-filled-error-500 !text-sm"
            type="button"
            onclick={retryStartupAction}
            disabled={repairing}
          >
            Retry
          </button>
          {#if server}
            <button
              class="btn btn-sm preset-tonal-surface !text-sm"
              type="button"
              onclick={() => (startupError = '')}
            >
              Enter auth key
            </button>
          {:else if !salvagedRestorePending}
            <button
              class="btn btn-sm preset-tonal-error !text-sm"
              type="button"
              disabled={repairing}
              onclick={() => {
                if (
                  window.confirm(
                    'Reset local data? This clears saved reading progress, settings, and server configuration. Downloaded EPUB files stay on this device but may need to be downloaded again.',
                  )
                ) {
                  void repairLocalData();
                }
              }}
            >
              {repairing ? 'Resetting...' : 'Reset local data'}
            </button>
          {/if}
        </div>
        <DiagnosticsPanel compact kavitaVersion={server?.kavitaVersion} />
      </div>
    {:else}
      <Onboarding
        savedServer={server}
        editAddress={changingServerAddress}
        onCancel={changingServerAddress ? () => (changingServerAddress = false) : undefined}
        onConnected={(connected, key) => {
          apiKey = key;
          server = connected;
          changingServerAddress = false;
        }}
      />
    {/if}
  </div>
</div>

<style>
  .app-shell {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    isolation: isolate;
    overflow: hidden;
    background-color: color-mix(
      in oklab,
      var(--color-root-bg-light) 72%,
      var(--color-surface-50-950) 28%
    );
    background:
      radial-gradient(
        circle at 18% 16%,
        color-mix(in oklab, var(--color-primary-300-700) 42%, var(--color-surface-50-950) 58%),
        transparent 44%
      ),
      radial-gradient(
        circle at 82% 18%,
        color-mix(in oklab, var(--color-secondary-300-700) 34%, var(--color-surface-50-950) 66%),
        transparent 42%
      ),
      radial-gradient(
        circle at 52% 80%,
        color-mix(in oklab, var(--color-tertiary-300-700) 38%, var(--color-surface-50-950) 62%),
        transparent 46%
      ),
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--color-surface-100-900) 30%, transparent),
        transparent 30%,
        transparent 70%,
        color-mix(in oklab, var(--color-surface-50-950) 20%, transparent)
      );
  }

  :global([data-mode='dark']) .app-shell {
    background-color: color-mix(
      in oklab,
      var(--color-root-bg-dark) 92%,
      var(--color-surface-950) 8%
    );
    background:
      radial-gradient(
        circle at 18% 16%,
        color-mix(in oklab, var(--color-primary-300-700) 74%, var(--color-surface-950) 26%),
        transparent 38%
      ),
      radial-gradient(
        circle at 82% 18%,
        color-mix(in oklab, var(--color-secondary-300-700) 64%, var(--color-surface-950) 36%),
        transparent 36%
      ),
      radial-gradient(
        circle at 52% 80%,
        color-mix(in oklab, var(--color-tertiary-300-700) 70%, var(--color-surface-950) 30%),
        transparent 40%
      ),
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--color-surface-50-950) 72%, transparent),
        transparent 28%,
        transparent 66%,
        color-mix(in oklab, var(--color-surface-50-950) 46%, transparent)
      );
  }

  .app-ambient {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 0;
  }

  .orb {
    position: absolute;
    border-radius: 9999px;
    opacity: 0.66;
  }

  .orb-primary {
    width: clamp(14rem, 28vw, 26rem);
    height: clamp(14rem, 28vw, 26rem);
    left: 8vw;
    top: 12vh;
    background: radial-gradient(
      circle at 32% 30%,
      color-mix(in oklab, var(--color-primary-300-700) 58%, var(--color-surface-50-950) 42%),
      transparent 66%
    );
  }

  .orb-secondary {
    width: clamp(12rem, 24vw, 22rem);
    height: clamp(12rem, 24vw, 22rem);
    right: 10vw;
    top: 20vh;
    background: radial-gradient(
      circle at 38% 34%,
      color-mix(in oklab, var(--color-secondary-300-700) 46%, var(--color-surface-50-950) 54%),
      transparent 68%
    );
  }

  .orb-tertiary {
    width: clamp(12rem, 22vw, 20rem);
    height: clamp(12rem, 22vw, 20rem);
    left: 24vw;
    bottom: 10vh;
    background: radial-gradient(
      circle at 36% 34%,
      color-mix(in oklab, var(--color-tertiary-300-700) 52%, var(--color-surface-50-950) 48%),
      transparent 68%
    );
  }

  .vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      circle at center,
      transparent 42%,
      color-mix(in oklab, var(--color-surface-50-950) 48%, transparent) 100%
    );
  }

  .release-banner {
    position: relative;
    flex: 0 0 auto;
    min-height: 0;
    max-height: 50%;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scroll-padding-block: 8px;
    z-index: 1;
  }

  .app-stage {
    position: relative;
    flex: 1 1 0%;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scroll-padding-block: 8px;
    z-index: 1;
  }

  :global([data-mode='dark']) .orb {
    opacity: 0.84;
  }

  :global([data-mode='dark']) .orb-primary {
    background: radial-gradient(
      circle at 32% 30%,
      color-mix(in oklab, var(--color-primary-300-700) 82%, var(--color-surface-950) 18%),
      transparent 62%
    );
  }

  :global([data-mode='dark']) .orb-secondary {
    background: radial-gradient(
      circle at 38% 34%,
      color-mix(in oklab, var(--color-secondary-300-700) 74%, var(--color-surface-950) 26%),
      transparent 60%
    );
  }

  :global([data-mode='dark']) .orb-tertiary {
    background: radial-gradient(
      circle at 36% 34%,
      color-mix(in oklab, var(--color-tertiary-300-700) 78%, var(--color-surface-950) 22%),
      transparent 60%
    );
  }

  :global([data-mode='dark']) .vignette {
    background: radial-gradient(
      circle at center,
      transparent 38%,
      color-mix(in oklab, var(--color-surface-950) 74%, transparent) 100%
    );
  }

  :global([data-theme='eink']) .app-ambient {
    display: none;
  }
</style>
