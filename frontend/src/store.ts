import { create } from "zustand";
import type { AccessUser, FileDetail, FileSummary, JobInfo, Lang, TextSize, Theme } from "./lib/types";
import { readPref, writePref } from "./lib/storage";
import { listJobs, listWorkspace, logout as apiLogout, me, setUnauthorizedHandler } from "./lib/api";
import { configure as configureCache, signedOut as clearCache } from "./lib/previewCache";

function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function applyTextSize(size: TextSize) {
  if (size === "normal") delete document.documentElement.dataset.textSize;
  else document.documentElement.dataset.textSize = size;
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
}

export interface LockedChannelsState {
  byIndex: boolean[];
  byName: Record<string, boolean>;
}

export interface AppState {
  lang: Lang;
  theme: Theme;
  /** Interface text size (scales the rem-based type scale). */
  textSize: TextSize;
  /** false until /api/auth/me has answered. */
  authChecked: boolean;
  user: AccessUser | null;
  /** True when the server ended the session (code expired, disabled, …) rather than the user signing out. */
  sessionExpired: boolean;
  files: FileSummary[];
  folders: string[];
  /** Folder that uploads go into and that is highlighted in the tree. */
  currentFolder: string;
  /**
   * Ask the file tree to expand the path to a folder (new folder, upload target …).
   * Only explicit requests open folders, so a folder the user collapsed stays collapsed.
   */
  revealRequest: { path: string; seq: number } | null;
  selectedId: string | null;
  detail: FileDetail | null;
  jobs: JobInfo[];
  checked: Record<string, boolean>;
  /** When enabled, channel visibility is preserved when switching between images. */
  channelLocked: boolean;
  lockedChannels: LockedChannelsState;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  setTextSize: (size: TextSize) => void;
  checkAuth: () => Promise<void>;
  setUser: (user: AccessUser | null) => void;
  signOut: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  setCurrentFolder: (folder: string) => void;
  reveal: (folder: string) => void;
  select: (id: string | null) => void;
  setDetail: (d: FileDetail | null) => void;
  toggleChecked: (id: string, value?: boolean) => void;
  checkAll: (value: boolean) => void;
  toggleChannelLock: (channels?: { name: string }[], currentVisible?: boolean[]) => void;
  updateLockedChannels: (channels: { name: string }[], visible: boolean[]) => void;
  resolveVisibleChannels: (channels: { name: string }[]) => boolean[];
}

const savedLang = (readPref("nd2utils.lang") as Lang | null) ?? "zh";
const savedTheme = (readPref("nd2utils.theme") as Theme | null) ?? "system";
const savedTextSize: TextSize = (() => {
  const raw = readPref("nd2utils.textSize");
  return raw === "large" || raw === "xlarge" ? raw : "normal";
})();
const savedChannelLocked = readPref("nd2utils.channelLocked") === "1";
const savedLockedChannels: LockedChannelsState = (() => {
  try {
    const raw = readPref("nd2utils.lockedChannels");
    if (!raw) return { byIndex: [], byName: {} };
    const parsed = JSON.parse(raw) as Partial<LockedChannelsState>;
    return {
      byIndex: Array.isArray(parsed.byIndex) ? parsed.byIndex.map(Boolean) : [],
      byName: parsed.byName && typeof parsed.byName === "object" ? parsed.byName : {},
    };
  } catch {
    return { byIndex: [], byName: {} };
  }
})();
applyTheme(savedTheme);
applyTextSize(savedTextSize);

const emptyWorkspace = {
  files: [],
  folders: [],
  currentFolder: "",
  revealRequest: null,
  selectedId: null,
  detail: null,
  jobs: [],
  checked: {},
};

const fileKeys = new WeakMap<FileSummary, string>();
const fileKey = (file: FileSummary): string => {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = JSON.stringify(file);
    fileKeys.set(file, key);
  }
  return key;
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `next`, reusing the objects of `prev` for files whose content did not change. */
function shareFiles(prev: FileSummary[], next: FileSummary[]): FileSummary[] {
  const byId = new Map(prev.map((f) => [f.id, f]));
  let changed = prev.length !== next.length;
  const out = next.map((file, i) => {
    const old = byId.get(file.id);
    if (old && fileKey(old) === fileKey(file)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return file;
  });
  return changed ? out : prev;
}

export const useApp = create<AppState>((set, get) => ({
  lang: savedLang === "en" ? "en" : "zh",
  theme: savedTheme,
  textSize: savedTextSize,
  authChecked: false,
  user: null,
  sessionExpired: false,
  channelLocked: savedChannelLocked,
  lockedChannels: savedLockedChannels,
  ...emptyWorkspace,
  setLang: (lang) => {
    writePref("nd2utils.lang", lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    set({ lang });
  },
  setTheme: (theme) => {
    writePref("nd2utils.theme", theme);
    applyTheme(theme);
    set({ theme });
  },
  setTextSize: (textSize) => {
    writePref("nd2utils.textSize", textSize);
    applyTextSize(textSize);
    set({ textSize });
  },
  checkAuth: async () => {
    try {
      const res = await me();
      get().setUser(res.user);
    } finally {
      set({ authChecked: true });
    }
  },
  setUser: (user) => {
    // A different code means a different workspace: never show the previous one's data.
    if (user?.id !== get().user?.id) {
      set({ ...emptyWorkspace });
      void configureCache(user?.id ?? null, true);
    }
    set({ user, authChecked: true, sessionExpired: false });
  },
  signOut: async () => {
    try {
      await apiLogout();
    } finally {
      get().setUser(null);
      // Shared lab computers: no previews of this workspace stay behind.
      await clearCache();
    }
  },
  refreshFiles: async () => {
    const fresh = await listWorkspace();
    const prev = get();
    // Keep the objects of unchanged files (and the arrays when nothing changed at all), so a
    // poll during an import re-renders only what actually changed.
    const files = shareFiles(prev.files, fresh.files);
    const folders = sameList(prev.folders, fresh.folders) ? prev.folders : fresh.folders;
    const { selectedId, checked: currentChecked, currentFolder } = prev;
    const still = files.some((f) => f.id === selectedId);
    const checkedIds = files.filter((f) => currentChecked[f.id]).map((f) => f.id);
    const checkedSame = checkedIds.length === Object.values(currentChecked).filter(Boolean).length;
    const nextFolder = currentFolder && !folders.includes(currentFolder) ? "" : currentFolder;
    const nextSelected = still ? selectedId : files[0]?.id ?? null;
    if (files === prev.files && folders === prev.folders && checkedSame && nextFolder === currentFolder && nextSelected === selectedId) {
      return;
    }
    set({
      files,
      folders,
      currentFolder: nextFolder,
      selectedId: nextSelected,
      checked: checkedSame ? currentChecked : Object.fromEntries(checkedIds.map((id) => [id, true])),
    });
  },
  refreshJobs: async () => {
    set({ jobs: await listJobs() });
  },
  setCurrentFolder: (folder) => set({ currentFolder: folder }),
  reveal: (folder) => set({ revealRequest: { path: folder, seq: (get().revealRequest?.seq ?? 0) + 1 } }),
  select: (id) => set({ selectedId: id, detail: id === get().selectedId ? get().detail : null }),
  setDetail: (d) => set({ detail: d }),
  toggleChecked: (id, value) => {
    const cur = get().checked;
    const next = { ...cur, [id]: value ?? !cur[id] };
    set({ checked: next });
  },
  checkAll: (value) => {
    const checked: Record<string, boolean> = {};
    for (const f of get().files) checked[f.id] = value;
    set({ checked });
  },
  toggleChannelLock: (channels, currentVisible) => {
    const nextLocked = !get().channelLocked;
    writePref("nd2utils.channelLocked", nextLocked ? "1" : "0");
    if (nextLocked && channels && currentVisible) {
      const byIndex = channels.map((_, i) => currentVisible[i] ?? true);
      const byName: Record<string, boolean> = { ...get().lockedChannels.byName };
      channels.forEach((ch, i) => {
        if (ch.name) byName[ch.name] = currentVisible[i] ?? true;
      });
      const lockedChannels = { byIndex, byName };
      writePref("nd2utils.lockedChannels", JSON.stringify(lockedChannels));
      set({ channelLocked: true, lockedChannels });
    } else {
      set({ channelLocked: nextLocked });
    }
  },
  updateLockedChannels: (channels, visible) => {
    const byIndex = channels.map((_, i) => visible[i] ?? true);
    const byName: Record<string, boolean> = { ...get().lockedChannels.byName };
    channels.forEach((ch, i) => {
      if (ch.name) byName[ch.name] = visible[i] ?? true;
    });
    const lockedChannels = { byIndex, byName };
    writePref("nd2utils.lockedChannels", JSON.stringify(lockedChannels));
    set({ lockedChannels });
  },
  resolveVisibleChannels: (channels) => {
    if (!get().channelLocked) {
      return channels.map(() => true);
    }
    const { byIndex, byName } = get().lockedChannels;
    if (byIndex.length === 0 && Object.keys(byName).length === 0) {
      return channels.map(() => true);
    }
    return channels.map((ch, i) => {
      if (i < byIndex.length) return byIndex[i];
      if (ch.name && ch.name in byName) return byName[ch.name];
      return true;
    });
  },
}));

setUnauthorizedHandler(() => {
  if (!useApp.getState().user) return;
  useApp.getState().setUser(null);
  useApp.setState({ sessionExpired: true });
});

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (useApp.getState().theme === "system") applyTheme("system");
});
