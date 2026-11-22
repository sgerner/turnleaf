// @vitest-environment jsdom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog', () => {
  let host: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let mounted: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    Element.prototype.animate ??= (() => {
      const animation = {
        onfinish: null as (() => void) | null,
        cancel: () => {},
        finish: () => {},
      };
      queueMicrotask(() => animation.onfinish?.());
      return animation as unknown as Animation;
    }) as typeof Element.prototype.animate;
    document.body.innerHTML = '';
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Delete item';
    host = document.createElement('div');
    document.body.append(trigger, host);
    trigger.focus();
  });

  afterEach(async () => {
    if (mounted) {
      await unmount(mounted);
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  it('renders an alertdialog with ARIA labelling and focuses Cancel first', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    mounted = mount(ConfirmDialog, {
      target: host,
      props: {
        title: 'Delete highlight?',
        description: 'This permanently deletes your highlight.',
        confirmLabel: 'Delete highlight',
        onConfirm,
        onCancel,
      },
    });
    await tick();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog?.getAttribute('aria-labelledby');
    const describedBy = dialog?.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent?.trim()).toBe('Delete highlight?');
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      'This permanently deletes your highlight.',
    );

    const buttons = Array.from(dialog!.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Cancel',
      'Delete highlight',
    ]);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('traps Tab navigation and restores focus to opener on Escape', async () => {
    const onCancel = vi.fn();
    mounted = mount(ConfirmDialog, {
      target: host,
      props: {
        title: 'Delete bookmark?',
        description: 'Remove custom bookmark?',
        confirmLabel: 'Delete bookmark',
        onConfirm: vi.fn(),
        onCancel,
      },
    });
    await tick();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const [cancelButton, confirmButton] = Array.from(dialog.querySelectorAll('button'));

    confirmButton!.focus();
    const forwardTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancelButton);

    const backwardTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(backwardTab);
    expect(backwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirmButton);

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();

    await unmount(mounted);
    mounted = null;
    await tick();
    expect(document.activeElement).toBe(trigger);
  });

  it('blocks duplicate submission and Escape dismissal while busy', async () => {
    let resolveConfirm: (() => void) | null = null;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const onCancel = vi.fn();
    mounted = mount(ConfirmDialog, {
      target: host,
      props: {
        title: 'Delete this server?',
        description: 'Removes the server connection.',
        confirmLabel: 'Delete now',
        busyLabel: 'Deleting...',
        onConfirm,
        onCancel,
      },
    });
    await tick();

    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const [, confirmButton] = Array.from(dialog.querySelectorAll('button'));

    confirmButton!.click();
    await tick();

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(confirmButton!.disabled).toBe(true);
    expect(confirmButton!.textContent?.trim()).toBe('Deleting...');

    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(onCancel).not.toHaveBeenCalled();

    resolveConfirm!();
    await tick();
  });
});
