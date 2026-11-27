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

  it('does not skip lower handlers when a top handler unregisters another handler mid-dispatch', () => {
    const exitApp = vi.fn();
    const stack = createBackButtonStack({ exitApp });
    const events: string[] = [];

    stack.register(() => {
      events.push('base');
      return true;
    });
    const removeMiddle = stack.register(() => {
      events.push('middle');
      return true;
    });
    stack.register(() => {
      events.push('top');
      removeMiddle();
      return false;
    });

    expect(stack.dispatch()).toBe(true);
    expect(events).toEqual(['top', 'base']);
    expect(exitApp).not.toHaveBeenCalled();
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
    const actions = {
      closeConflict: vi.fn(),
      closeMenu: vi.fn(),
      closeReader: vi.fn(),
      cancelOpenProgress: vi.fn(),
      cancelServerAddressEdit: vi.fn(),
      cancelDeleteServer: vi.fn(),
      closeSettings: vi.fn(),
      hideFilters: vi.fn(),
    };
    const baseState = {
      hasConflict: false,
      acceptingRemoteProgress: false,
      hasActionMenu: false,
      hasOpenReader: false,
      resolvingOpenProgress: false,
      editingServerAddress: false,
      savingServerAddress: false,
      confirmDeleteServer: false,
      settingsBusy: false,
      retryingCredentialCleanup: false,
      settingsVisible: false,
      filtersVisible: false,
    };

    expect(
      handleLibraryBack(
        { ...baseState, hasConflict: true, acceptingRemoteProgress: true },
        actions,
      ),
    ).toBe(true);
    expect(actions.closeConflict).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({ ...baseState, hasConflict: true, hasActionMenu: true }, actions),
    ).toBe(true);
    expect(actions.closeConflict).toHaveBeenCalledOnce();
    expect(actions.closeMenu).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({ ...baseState, hasActionMenu: true, settingsVisible: true }, actions),
    ).toBe(true);
    expect(actions.closeMenu).toHaveBeenCalledOnce();
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({ ...baseState, hasOpenReader: true, filtersVisible: true }, actions),
    ).toBe(true);
    expect(actions.closeReader).toHaveBeenCalledOnce();
    expect(actions.hideFilters).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        { ...baseState, resolvingOpenProgress: true, filtersVisible: true },
        actions,
      ),
    ).toBe(true);
    expect(actions.cancelOpenProgress).toHaveBeenCalledOnce();
    expect(actions.hideFilters).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        {
          ...baseState,
          settingsVisible: true,
          editingServerAddress: true,
          savingServerAddress: true,
        },
        actions,
      ),
    ).toBe(true);
    expect(actions.cancelServerAddressEdit).not.toHaveBeenCalled();
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        {
          ...baseState,
          settingsVisible: true,
          editingServerAddress: true,
        },
        actions,
      ),
    ).toBe(true);
    expect(actions.cancelServerAddressEdit).toHaveBeenCalledOnce();
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        {
          ...baseState,
          settingsVisible: true,
          confirmDeleteServer: true,
          settingsBusy: true,
        },
        actions,
      ),
    ).toBe(true);
    expect(actions.cancelDeleteServer).not.toHaveBeenCalled();
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        {
          ...baseState,
          settingsVisible: true,
          confirmDeleteServer: true,
        },
        actions,
      ),
    ).toBe(true);
    expect(actions.cancelDeleteServer).toHaveBeenCalledOnce();
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({ ...baseState, settingsVisible: true, settingsBusy: true }, actions),
    ).toBe(true);
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        { ...baseState, settingsVisible: true, retryingCredentialCleanup: true },
        actions,
      ),
    ).toBe(true);
    expect(actions.closeSettings).not.toHaveBeenCalled();

    expect(
      handleLibraryBack({ ...baseState, settingsVisible: true, filtersVisible: true }, actions),
    ).toBe(true);
    expect(actions.closeSettings).toHaveBeenCalledOnce();
    expect(actions.hideFilters).not.toHaveBeenCalled();

    expect(
      handleLibraryBack(
        { ...baseState, retryingCredentialCleanup: true, filtersVisible: true },
        actions,
      ),
    ).toBe(true);
    expect(actions.hideFilters).not.toHaveBeenCalled();

    expect(handleLibraryBack({ ...baseState, filtersVisible: true }, actions)).toBe(true);
    expect(actions.hideFilters).toHaveBeenCalledOnce();

    expect(handleLibraryBack(baseState, actions)).toBe(false);
  });
});
