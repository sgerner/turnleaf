(function () {
  try {
    const raw = window.localStorage.getItem('turnleaf_boot_theme_v1');
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== 'object') return;
    const theme =
      typeof cached.theme === 'string' && /^[a-z]+$/.test(cached.theme) ? cached.theme : null;
    const mode = cached.mode === 'light' || cached.mode === 'dark' ? cached.mode : null;
    if (!theme || !mode) return;

    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.mode = mode;
    root.style.colorScheme = mode;

    const safeColor = (value) =>
      typeof value === 'string' && /^[#a-z0-9.%(),/\s+-]+$/i.test(value) ? value : '';

    const rootBgLight = safeColor(cached.rootBgLight);
    const rootBgDark = safeColor(cached.rootBgDark);
    const surfaceLight = safeColor(cached.surfaceLight);
    const surfaceDark = safeColor(cached.surfaceDark);

    if (rootBgLight) root.style.setProperty('--color-root-bg-light', rootBgLight);
    if (rootBgDark) root.style.setProperty('--color-root-bg-dark', rootBgDark);
    if (surfaceLight) root.style.setProperty('--color-surface-50', surfaceLight);
    if (surfaceDark) root.style.setProperty('--color-surface-950', surfaceDark);

    const activeBg = mode === 'light' ? rootBgLight : rootBgDark;
    if (activeBg) {
      root.style.backgroundColor = activeBg;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', activeBg);
    }
  } catch {
    // Fall back to default HTML attributes when storage is unavailable or malformed.
  }
})();
