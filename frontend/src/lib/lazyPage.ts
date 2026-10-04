import { lazy, type ComponentType } from "react";

const RELOAD_KEY = "nd2utils.chunk-reload";
const RELOAD_WINDOW_MS = 30_000;

/**
 * After a redeploy, a tab (or a cached index.html) may still reference bundles that no longer
 * exist. Reload once to pick up the new build instead of rendering nothing; if that already
 * happened moments ago, give up and let the error boundary explain.
 */
export function reloadForNewBuild(): boolean {
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function lazyPage<T extends ComponentType<object>>(load: () => Promise<T>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (err) {
      if (reloadForNewBuild()) return new Promise<never>(() => undefined);
      throw err;
    }
  });
}

// Vite fires this when a preloaded dependency of a dynamic import fails to load.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});
