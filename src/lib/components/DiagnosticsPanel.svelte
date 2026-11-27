<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { Directory, Filesystem, type Encoding } from '@capacitor/filesystem';
  import {
    clearDiagnostics,
    exportDiagnostics,
    getDiagnosticCount,
    subscribeDiagnostics,
  } from '../diagnostics/log';

  const UTF8 = 'utf8' as Encoding;

  let {
    kavitaVersion = null,
    compact = false,
  }: {
    kavitaVersion?: string | null | undefined;
    compact?: boolean | undefined;
  } = $props();

  let diagnosticCount = $state(getDiagnosticCount());
  let diagnosticsVisible = $state(false);
  let diagnosticsOutput = $state('');
  let diagnosticsMessage = $state('');
  let exporting = $state(false);
  let diagnosticsField = $state<HTMLTextAreaElement | null>(null);

  function platformName(): string {
    return Capacitor.getPlatform?.() ?? (Capacitor.isNativePlatform() ? 'native' : 'web');
  }

  function diagnosticsText(): string {
    return exportDiagnostics({
      appVersion: __APP_VERSION__,
      platform: platformName(),
      kavitaVersion,
    });
  }

  $effect(() =>
    subscribeDiagnostics((count) => {
      diagnosticCount = count;
      if (diagnosticsVisible) {
        diagnosticsOutput = diagnosticsText();
      }
    }),
  );

  $effect(() => {
    if (diagnosticsVisible) {
      diagnosticsOutput = exportDiagnostics({
        appVersion: __APP_VERSION__,
        platform: platformName(),
        kavitaVersion,
      });
    }
  });

  async function copyDiagnostics(): Promise<void> {
    diagnosticsMessage = '';
    diagnosticsOutput = diagnosticsText();
    try {
      const text = diagnosticsOutput;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        let copied = false;
        try {
          field.select();
          copied = document.execCommand('copy');
        } finally {
          field.remove();
        }
        if (!copied) throw new Error('Clipboard unavailable');
      }
      diagnosticsMessage = 'Diagnostics copied. Review them before sharing.';
    } catch {
      diagnosticsVisible = true;
      diagnosticsMessage =
        'Copy is unavailable here. Open the log below to select and copy it, or download it.';
    }
  }

  async function downloadDiagnostics(): Promise<void> {
    if (exporting) return;
    diagnosticsMessage = '';
    diagnosticsOutput = diagnosticsText();
    exporting = true;
    try {
      if (Capacitor.isNativePlatform()) {
        const filename = `turnleaf-diagnostics-${Date.now()}.txt`;
        await Filesystem.writeFile({
          path: filename,
          data: diagnosticsOutput,
          directory: Directory.Documents,
          encoding: UTF8,
        });
        diagnosticsMessage = `Saved to Documents as ${filename}. Review it before sharing.`;
      } else {
        const file = new Blob([diagnosticsOutput], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'turnleaf-diagnostics.txt';
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        diagnosticsVisible = true;
        diagnosticsMessage =
          'Review the log before sharing. If the file did not download, select and copy it below.';
      }
    } catch {
      diagnosticsVisible = true;
      diagnosticsMessage =
        'Download is unavailable here. Select all text below to copy the log manually.';
    } finally {
      exporting = false;
    }
  }

  function showDiagnostics(): void {
    diagnosticsOutput = diagnosticsText();
    diagnosticsVisible = !diagnosticsVisible;
  }

  function selectDiagnostics(): void {
    diagnosticsField?.focus();
    diagnosticsField?.select();
  }

  async function clearDiagnosticLog(): Promise<void> {
    await clearDiagnostics();
    diagnosticsOutput = diagnosticsText();
    diagnosticsMessage = 'Diagnostics cleared.';
  }
</script>

{#if compact}
  <div class="rounded-xl border border-surface-500/25 p-3 text-left">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <p class="text-xs font-medium uppercase tracking-wider text-surface-800-200">
        Diagnostics ({diagnosticCount})
      </p>
      <p class="text-xs text-surface-700-300">
        Excludes server address, auth key, and book titles.
      </p>
    </div>
    <div class="mt-2 flex flex-wrap gap-2">
      <button
        class="btn btn-sm preset-tonal-surface !text-sm"
        type="button"
        onclick={() => void copyDiagnostics()}
      >
        Copy diagnostics
      </button>
      <button
        class="btn btn-sm preset-tonal-surface !text-sm"
        type="button"
        disabled={exporting}
        onclick={() => void downloadDiagnostics()}
      >
        Download log
      </button>
      <button
        class="btn btn-sm preset-tonal-surface !text-sm"
        type="button"
        onclick={showDiagnostics}
      >
        {diagnosticsVisible ? 'Hide diagnostics' : 'View diagnostics'}
      </button>
      <button
        class="btn btn-sm preset-tonal-surface !text-sm"
        type="button"
        onclick={() => void clearDiagnosticLog()}
      >
        Clear diagnostics
      </button>
    </div>
    {#if diagnosticsVisible}
      <div class="mt-3 grid gap-2">
        <p class="text-xs text-surface-700-300">
          If copy or download is unavailable, select all text below, then copy it manually.
        </p>
        <textarea
          bind:this={diagnosticsField}
          class="input min-h-36 w-full font-mono text-xs"
          readonly
          rows="7"
          bind:value={diagnosticsOutput}
          aria-label="Turnleaf diagnostics log"
          onclick={selectDiagnostics}></textarea>
        <button
          class="btn btn-sm preset-tonal-surface justify-self-start !text-sm"
          type="button"
          onclick={selectDiagnostics}
        >
          Select all text
        </button>
      </div>
    {/if}
    {#if diagnosticsMessage}
      <p class="mt-2 text-xs text-surface-800-200" role="status">{diagnosticsMessage}</p>
    {/if}
  </div>
{:else}
  <section class="mt-7" aria-labelledby="library-settings-diagnostics-title">
    <h3 id="library-settings-diagnostics-title" class="text-lg font-medium">Diagnostics</h3>
    <p class="mt-1 text-sm text-surface-700-300">
      Copy or download recent startup, connection, and book download details. The log includes API
      routes, HTTP statuses, and failure categories, and stays in app-private storage until you
      clear it. Review it before sharing.
    </p>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <button class="btn preset-tonal-surface" type="button" onclick={() => void copyDiagnostics()}>
        Copy diagnostics
      </button>
      <button
        class="btn preset-tonal-surface"
        type="button"
        disabled={exporting}
        onclick={() => void downloadDiagnostics()}
      >
        Download log
      </button>
    </div>
    <button class="btn preset-tonal-surface mt-2 w-full" type="button" onclick={showDiagnostics}>
      {diagnosticsVisible ? 'Hide diagnostics' : 'View diagnostics'}
    </button>
    {#if diagnosticsVisible}
      <div class="mt-3 grid gap-2">
        <p class="text-sm text-surface-700-300">
          If copy or download is unavailable, select all text below, then copy it manually.
        </p>
        <textarea
          bind:this={diagnosticsField}
          class="input min-h-48 w-full font-mono text-xs"
          readonly
          rows="10"
          bind:value={diagnosticsOutput}
          aria-label="Turnleaf diagnostics log"
          onclick={selectDiagnostics}></textarea>
        <button class="btn preset-tonal-surface" type="button" onclick={selectDiagnostics}>
          Select all text
        </button>
      </div>
    {/if}
    <button
      class="btn preset-tonal-surface mt-2 w-full"
      type="button"
      onclick={() => void clearDiagnosticLog()}
    >
      Clear diagnostics
    </button>
    {#if diagnosticsMessage}
      <p class="mt-2 text-sm text-surface-700-300" role="status">{diagnosticsMessage}</p>
    {/if}
  </section>
{/if}
