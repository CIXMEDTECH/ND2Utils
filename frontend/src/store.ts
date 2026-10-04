import { create } from "zustand";
import type { AccessUser, FileDetail, FileSummary, JobInfo, Lang, Theme } from "./lib/types";
import { readPref, writePref } from "./lib/storage";
import { listJobs, listWorkspace, logout as apiLogout, me, setUnauthorizedHandler } from "./lib/api";

function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
}

export interface AppState {
  lang: Lang;
  theme: Theme;
  /** false until /api/auth/me has answered. */
  authChecked: boolean;
  user: AccessUser | null;
  /** True when the server ended the session (code expired, disabled, …) rather than the user signing out. */
  sessionExpired: boolean;
  files: FileSummary[];
  folders: string[];
  /** Folder that uploads go into and that is highlighted in the tree. */
  currentFolder: string;
  selectedId: string | null;
  detail: FileDetail | null;
  jobs: JobInfo[];
  checked: Record<string, boolean>;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  checkAuth: () => Promise<void>;
  setUser: (user: AccessUser | null) => void;
  signOut: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  setCurrentFolder: (folder: string) => void;
  select: (id: string | null) => void;
  setDetail: (d: FileDetail | null) => void;
  toggleChecked: (id: string, value?: boolean) => void;
  checkAll: (value: boolean) => void;
}

const savedLang = (readPref("nd2utils.lang") as Lang | null) ?? "zh";
const savedTheme = (readPref("nd2utils.theme") as Theme | null) ?? "system";
applyTheme(savedTheme);

const emptyWorkspace = {
  files: [],
  folders: [],
  currentFolder: "",
  selectedId: null,
  detail: null,
  jobs: [],
  checked: {},
};

export const useApp = create<AppState>((set, get) => ({
  lang: savedLang === "en" ? "en" : "zh",
  theme: savedTheme,
  authChecked: false,
  user: null,
  sessionExpired: false,
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
    if (user?.id !== get().user?.id) set({ ...emptyWorkspace });
    set({ user, authChecked: true, sessionExpired: false });
  },
  signOut: async () => {
    try {
      await apiLogout();
    } finally {
      get().setUser(null);
    }
  },
  refreshFiles: async () => {
    const { files, folders } = await listWorkspace();
    const { selectedId, checked: currentChecked, currentFolder } = get();
    const still = files.some((f) => f.id === selectedId);
    const checked = Object.fromEntries(
      files.filter((f) => currentChecked[f.id]).map((f) => [f.id, true]),
    );
    set({
      files,
      folders,
      currentFolder: currentFolder && !folders.includes(currentFolder) ? "" : currentFolder,
      selectedId: still ? selectedId : files[0]?.id ?? null,
      checked,
    });
  },
  refreshJobs: async () => {
    set({ jobs: await listJobs() });
  },
  setCurrentFolder: (folder) => set({ currentFolder: folder }),
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
}));

setUnauthorizedHandler(() => {
  if (!useApp.getState().user) return;
  useApp.getState().setUser(null);
  useApp.setState({ sessionExpired: true });
});

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (useApp.getState().theme === "system") applyTheme("system");
});
