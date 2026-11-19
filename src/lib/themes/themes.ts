const themeStyles = {
  catppuccin: () => import('@skeletonlabs/skeleton/themes/catppuccin'),
  cerberus: () => import('@skeletonlabs/skeleton/themes/cerberus'),
  concord: () => import('@skeletonlabs/skeleton/themes/concord'),
  crimson: () => import('@skeletonlabs/skeleton/themes/crimson'),
  eink: () => import('./eink.css'),
  fennec: null,
  hamlindigo: () => import('@skeletonlabs/skeleton/themes/hamlindigo'),
  legacy: () => import('@skeletonlabs/skeleton/themes/legacy'),
  mint: () => import('@skeletonlabs/skeleton/themes/mint'),
  modern: () => import('@skeletonlabs/skeleton/themes/modern'),
  mona: () => import('@skeletonlabs/skeleton/themes/mona'),
  nosh: () => import('@skeletonlabs/skeleton/themes/nosh'),
  nouveau: () => import('@skeletonlabs/skeleton/themes/nouveau'),
  pine: () => import('@skeletonlabs/skeleton/themes/pine'),
  reign: () => import('@skeletonlabs/skeleton/themes/reign'),
  rocket: () => import('@skeletonlabs/skeleton/themes/rocket'),
  rose: () => import('@skeletonlabs/skeleton/themes/rose'),
  sahara: () => import('@skeletonlabs/skeleton/themes/sahara'),
  seafoam: () => import('@skeletonlabs/skeleton/themes/seafoam'),
  terminus: () => import('@skeletonlabs/skeleton/themes/terminus'),
  vintage: () => import('@skeletonlabs/skeleton/themes/vintage'),
  vox: () => import('@skeletonlabs/skeleton/themes/vox'),
  wintry: () => import('@skeletonlabs/skeleton/themes/wintry'),
} as const;

export type SkeletonTheme = keyof typeof themeStyles;
export const skeletonThemes = Object.keys(themeStyles) as SkeletonTheme[];

export async function loadTheme(theme: string): Promise<boolean> {
  if (!Object.hasOwn(themeStyles, theme)) return false;
  await themeStyles[theme as SkeletonTheme]?.();
  return true;
}
