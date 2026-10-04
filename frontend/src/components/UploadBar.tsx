import { useState } from "react";
import { FolderSimplePlus, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { t } from "../i18n";
import { fromDataTransfer, fromFileList, type PendingUpload, useUploads } from "../lib/uploads";
import { useApp } from "../store";
import { folderInputId } from "./DropZone";

// React's input typings do not know the (widely supported) directory picker attributes.
const DIRECTORY_PICKER = { webkitdirectory: "", directory: "" } as Record<string, string>;

/**
 * Compact upload controls for the workspace sidebar. The hidden inputs keep the ids the
 * context menu uses for "upload here" (`inputId` and `folderInputId(inputId)`).
 */
export function UploadBar({ inputId }: { inputId: string }) {
  const lang = useApp((s) => s.lang);
  const currentFolder = useApp((s) => s.currentFolder);
  const progress = useUploads((s) => s.progress);
  const error = useUploads((s) => s.error);
  const clearError = useUploads((s) => s.clearError);
  const upload = useUploads((s) => s.upload);
  const [over, setOver] = useState(false);

  async function handle(items: PendingUpload[] | Promise<PendingUpload[]>) {
    if (progress) return;
    // Read the target now: the user may click another folder while uploads are running.
    const target = useApp.getState().currentFolder;
    await upload(await items, target);
  }

  const button =
    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40";

  return (
    <div
      className={`rounded-xl border border-dashed p-2 transition-colors ${over ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)]"}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        void handle(fromDataTransfer(event.dataTransfer));
      }}
    >
      <input
        id={inputId}
        type="file"
        accept=".nd2"
        multiple
        disabled={Boolean(progress)}
        className="sr-only"
        tabIndex={-1}
        aria-label={t(lang, "uploadFiles")}
        onChange={(event) => {
          if (event.target.files) void handle(fromFileList(event.target.files));
          event.target.value = "";
        }}
      />
      <input
        id={folderInputId(inputId)}
        type="file"
        multiple
        {...DIRECTORY_PICKER}
        disabled={Boolean(progress)}
        className="sr-only"
        tabIndex={-1}
        aria-label={t(lang, "chooseFolder")}
        onChange={(event) => {
          if (event.target.files) void handle(fromFileList(event.target.files));
          event.target.value = "";
        }}
      />
      <div className="flex gap-1.5">
        <button type="button" disabled={Boolean(progress)} onClick={() => document.getElementById(inputId)?.click()} className={button}>
          <UploadSimple size={14} /> {t(lang, "uploadFiles")}
        </button>
        <button
          type="button"
          disabled={Boolean(progress)}
          onClick={() => document.getElementById(folderInputId(inputId))?.click()}
          className={button}
        >
          <FolderSimplePlus size={14} /> {t(lang, "chooseFolder")}
        </button>
      </div>
      <p className="mt-1.5 truncate px-0.5 text-[10.5px] text-[var(--text-dim)]" title={`/${currentFolder}`}>
        {over ? t(lang, "dropActive") : `${t(lang, "dropShort")} · ${t(lang, "uploadTarget")} /${currentFolder}`}
      </p>
      {progress && (
        <div className="mt-1.5" role="status">
          <p className="truncate font-mono text-[10px] text-[var(--accent)]">{progress.label}</p>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className={`h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ${progress.ratio == null ? "progress-indeterminate w-1/3" : ""}`}
              style={progress.ratio == null ? undefined : { width: `${Math.max(progress.ratio * 100, 3)}%` }}
            />
          </div>
        </div>
      )}
      {!progress && error && (
        <p role="alert" className="mt-1.5 flex items-start gap-1 text-[11px] leading-4 text-[var(--danger)]">
          <WarningCircle size={13} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 rounded p-0.5 hover:bg-[var(--bg)]" aria-label={t(lang, "close")}>
            <X size={11} />
          </button>
        </p>
      )}
    </div>
  );
}
