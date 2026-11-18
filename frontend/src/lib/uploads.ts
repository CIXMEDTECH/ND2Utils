import { create } from "zustand";
import { t } from "../i18n";
import { useApp } from "../store";
import { organizeByMagnification, uploadFile } from "./api";
import { readPref, writePref } from "./storage";
import { detailMessage, isSupportedName, joinPath } from "./format";

/** A file to upload plus its folder relative to the drop target ("" = directly into the target). */
export interface PendingUpload {
  file: File;
  dir: string;
}

interface UploadState {
  progress: { label: string; ratio: number | null } | null;
  error: string | null;
  clearError: () => void;
  /** Uploads into `target` (a workspace folder). Resolves to the id of the last uploaded file, if any. */
  upload: (items: PendingUpload[], target: string) => Promise<string | null>;
}

function isNd2(file: File) {
  return isSupportedName(file.name);
}

export function fromFileList(list: FileList | File[]): PendingUpload[] {
  // Folder pickers (webkitdirectory) report "Folder/sub/file.nd2" in webkitRelativePath.
  return [...list].map((file) => {
    const rel = file.webkitRelativePath || "";
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return { file, dir };
  });
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, dir: string, out: PendingUpload[]) {
  if (entry.isFile) {
    out.push({ file: await entryFile(entry as FileSystemFileEntry), dir });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const sub = joinPath(dir, entry.name);
  // readEntries returns results in batches until it returns an empty array.
  for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
    for (const child of batch) await walk(child, sub, out);
  }
}

/**
 * Collect dropped files and folders. Must be called synchronously inside the drop handler:
 * the entries are grabbed before the first await, after which the DataTransfer is emptied.
 */
export function fromDataTransfer(dt: DataTransfer): Promise<PendingUpload[]> {
  const entries = [...dt.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  const files = [...dt.files];
  return (async () => {
    if (!entries.length) return files.map((file) => ({ file, dir: "" }));
    const out: PendingUpload[] = [];
    for (const entry of entries) await walk(entry, "", out);
    return out;
  })();
}

const SORT_KEY = "nd2utils.sortAfterUpload";

/** "Sort by magnification after import" (remembered per browser). */
export function sortAfterUpload(): boolean {
  return readPref(SORT_KEY) === "1";
}

export function setSortAfterUpload(value: boolean) {
  writePref(SORT_KEY, value ? "1" : "0");
}

export const useUploads = create<UploadState>((set, get) => ({
  progress: null,
  error: null,
  clearError: () => set({ error: null }),
  upload: async (items, target) => {
    if (get().progress) return null;
    const lang = useApp.getState().lang;
    const files = items.filter((item) => isNd2(item.file));
    if (!files.length) {
      set({ error: t(lang, "notNd2") });
      return null;
    }
    set({ error: null });
    const startedAt = Date.now() / 1000 - 2;
    let lastId: string | null = null;
    let firstError: string | null = null;
    for (let i = 0; i < files.length; i += 1) {
      const { file, dir } = files[i];
      const label = `${t(lang, "uploading")} ${file.name}`;
      set({ progress: { label: `${label} (${i + 1}/${files.length})`, ratio: i / files.length } });
      try {
        let lastReport = 0;
        const rec = await uploadFile(file, joinPath(target, dir), (ratio) => {
          // Progress events fire many times per second; the bar does not need more than ~4.
          const now = performance.now();
          if (ratio < 1 && now - lastReport < 250) return;
          lastReport = now;
          set({
            progress: {
              label: `${label} · ${Math.round(ratio * 100)}% (${i + 1}/${files.length})`,
              ratio: (i + ratio) / files.length,
            },
          });
        });
        lastId = rec.id;
      } catch (err) {
        firstError ??= `${file.name}: ${detailMessage(err, lang)}`;
        if ((err as { status?: number }).status === 401) break;
      }
    }
    try {
      set({ progress: { label: t(lang, "indexing"), ratio: null } });
      const app = useApp.getState();
      if (lastId && sortAfterUpload()) {
        await organizeByMagnification({ folder: target, recursive: true, apply: true, since: startedAt, unknown_label: t(lang, "unknownMag") }).catch(
          () => undefined,
        );
      }
      await app.refreshFiles();
      if (lastId) {
        app.select(lastId);
        app.reveal(useApp.getState().files.find((f) => f.id === lastId)?.folder ?? target);
      }
    } catch (err) {
      firstError ??= detailMessage(err, lang);
    } finally {
      set({ progress: null, error: firstError });
    }
    return lastId;
  },
}));
