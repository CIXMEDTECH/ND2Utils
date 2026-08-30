import { create } from "zustand";
import type { FileDetail, FileSummary, JobInfo, Lang, Theme } from "./lib/types";
import { listFiles, listJobs } from "./lib/api";

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
  files: FileSummary[];
  selectedId: string | null;
  detail: FileDetail | null;
  jobs: JobInfo[];
  checked: Record<string, boolean>;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  refreshFiles: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  select: (id: string | null) => void;
  setDetail: (d: FileDetail | null) => void;
  toggleChecked: (id: string, value?: boolean) => void;
  checkAll: (value: boolean) => void;
}

const savedLang = (localStorage.getItem("nd2utils.lang") as Lang | null) ?? "zh";
const savedTheme = (localStorage.getItem("nd2utils.theme") as Theme | null) ?? "system";
applyTheme(savedTheme);

export const useApp = create<AppState>((set, get) => ({
  lang: savedLang === "en" ? "en" : "zh",
  theme: savedTheme,
  files: [],
  selectedId: null,
  detail: null,
  jobs: [],
  checked: {},
  setLang: (lang) => {
    localStorage.setItem("nd2utils.lang", lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    set({ lang });
  },
  setTheme: (theme) => {
    localStorage.setItem("nd2utils.theme", theme);
    applyTheme(theme);
    set({ theme });
  },
  refreshFiles: async () => {
    const files = await listFiles();
    const selectedId = get().selectedId;
    const still = files.some((f) => f.id === selectedId);
    const currentChecked = get().checked;
    const checked = Object.fromEntries(
      files.filter((f) => currentChecked[f.id]).map((f) => [f.id, true]),
    );
    set({
      files,
      selectedId: still ? selectedId : files[0]?.id ?? null,
      checked,
    });
  },
  refreshJobs: async () => {
    set({ jobs: await listJobs() });
  },
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

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (useApp.getState().theme === "system") applyTheme("system");
});
