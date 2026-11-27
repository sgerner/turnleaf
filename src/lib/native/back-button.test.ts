import { describe, expect, it, vi } from 'vitest';
import { createBackButtonStack, handleLibraryBack, handleOnboardingBack } from './back-button';

describe('Android Back handler stack', () => {
  it('dispatches handlers in LIFO order and exits only when unhandled', () => {
    const exitApp = vi.fn();
    const stack = createBackButtonStack({ exitApp });
    const events: string[] = [];

    stack.register(() => {
      events.push('library');
      return false;
    });
    let readerOpen = true;
    const removeReader = stack.register(() => {
      events.push('reader');
      if (!readerOpen) return false;
      readerOpen = false;
      return true;
    });

    expect(stack.dispatch()).toBe(true);
    expect(events).toEqual(['reader']);
    expect(exitApp).not.toHaveBeenCalled();

    removeReader();
    removeReader();
    expect(stack.dispatch()).toBe(false);
    expect(events).toEqual(['reader', 'library']);
    expect(exitApp).toHaveBeenCalledOnce();
  });

  it('consumes Back while onboarding is busy and cancels address editing when idle', () => {
    const onCancel = vi.fn();

    expect(handleOnboardingBack({ busy: true, onCancel })).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();

    expect(handleOnboardingBack({ busy: false, onCancel })).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();

    expect(handleOnboardingBack({ busy: false })).toBe(false);
  });

  it('closes library overlays in priority order and blocks dismiss while busy', () => {
    const closeConflict = vi.fn();
    const closeActionMenu = vi.fn();
    const closeReader = vi.fn();
    const cancelServerAddressEdit = vi.fn();
    const closeSettings = vi.fn();
    const closeFilters = vi.fn();
    const base = {
      hasConflict: false,
      acceptingRemoteProgress: false,
      hasActionMenu: false,
      hasOpenReader: false,
      editingServerAddress: false,
      savingServerAddress: false,
      settingsBusy: false,
      settingsVisible: false,
      filtersVisible: false,
      closeConflict,
      closeActionMenu,
      closeReader,
      cancelServerAddressEdit,
      closeSettings,
      closeFilters,
    };

    expect(handleLibraryBack({ ...base, hasConflict: true, acceptingRemoteProgress: true })).toBe(
      true,
    );
    expect(closeConflict).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, hasConflict: true, hasActionMenu: true })).toBe(true);
    expect(closeConflict).toHaveBeenCalledOnce();
    expect(closeActionMenu).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, hasActionMenu: true, settingsVisible: true })).toBe(true);
    expect(closeActionMenu).toHaveBeenCalledOnce();
    expect(closeSettings).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, hasOpenReader: true, filtersVisible: true })).toBe(true);
    expect(closeReader).toHaveBeenCalledOnce();
    expect(closeFilters).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({
        ...base,
        settingsVisible: true,
        editingServerAddress: true,
        savingServerAddress: true,
      }),
    ).toBe(true);
    expect(cancelServerAddressEdit).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({
        ...base,
        settingsVisible: true,
        editingServerAddress: true,
      }),
    ).toBe(true);
    expect(cancelServerAddressEdit).toHaveBeenCalledOnce();
    expect(closeSettings).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, settingsVisible: true, settingsBusy: true })).toBe(true);
    expect(closeSettings).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, settingsVisible: true, filtersVisible: true })).toBe(true);
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(closeFilters).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...base, filtersVisible: true })).toBe(true);
    expect(closeFilters).toHaveBeenCalledOnce();

    expect(handleLibraryBack(base)).toBe(false);
  });
});
