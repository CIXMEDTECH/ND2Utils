// Browsers can refuse site storage (blocked cookies/site data, some private modes) and then
// throw on access. Preferences are optional, so never let that take the whole app down.

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore: the preference just won't persist
  }
}
