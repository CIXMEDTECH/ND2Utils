import { useNavigate, useLocation } from "react-router-dom";
import { CheckCircle, FolderSimplePlus, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { t } from "../i18n";
import { fromDataTransfer, fromFileList, type PendingUpload, useUploads } from "../lib/uploads";
import { useApp } from "../store";
import { UPLOAD_ACCEPT } from "../lib/format";

// React's input typings do not know the (widely supported) directory picker attributes.
const DIRECTORY_PICKER = { webkitdirectory: "", directory: "" } as Record<string, string>;

/** id of the hidden folder picker that belongs to a DropZone with `inputId`. */
export function folderInputId(inputId: string) {
  return `${inputId}-folder`;
}

export function DropZone({ inputId = "nd2-upload" }: { inputId?: string }) {
  const lang = useApp((s) => s.lang);
  const progress = useUploads((s) => s.progress);
  const error = useUploads((s) => s.error);
  const upload = useUploads((s) => s.upload);
  const nav = useNavigate();
  const location = useLocation();
  const [over, setOver] = useState(false);

  async function handle(items: PendingUpload[] | Promise<PendingUpload[]>) {
    if (progress) return;
    // Read the target now: the user may click another folder while uploads are running.
    const target = useApp.getState().currentFolder;
    const lastId = await upload(await items, target);
    if (lastId && location.pathname !== "/workspace") nav("/workspace");
  }

  return (
    <label
      htmlFor={inputId}
      aria-busy={Boolean(progress)}
      className={`drop-zone liquid-glass group relative flex cursor-pointer flex-col items-center justify-center overflow-hidden transition-[border-color,box-shadow] duration-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--focus)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--bg)] liquid-glass--dark liquid-glass--island min-h-[340px] text-[#eef1f2] md:min-h-[420px] ${over ? "border-[var(--accent)] shadow-[0_20px_70px_var(--accent-glow)]" : ""}`}
      onDragOver={(event) => {
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
        accept={UPLOAD_ACCEPT}
        multiple
        disabled={Boolean(progress)}
        className="sr-only"
        aria-label={t(lang, "chooseFiles")}
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

      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="stage-grid absolute inset-0 opacity-55" />
        <div className="drop-orbit drop-orbit-outer" />
        <div className="drop-orbit drop-orbit-inner" />
      </div>

      <div className="relative z-[1] flex max-w-md flex-col items-center px-6 text-center">
        <span className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl border border-current/15 bg-white/[0.07] text-[var(--accent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]">
          <UploadSimple size={26} weight="duotone" />
        </span>

        <p className="text-xl font-semibold tracking-[-0.02em]">
          {over ? t(lang, "dropActive") : t(lang, "drop")}
        </p>
        <p className="mt-2 max-w-[38ch] text-base leading-5 text-white/58">
          {t(lang, "dropHint")}
        </p>
        <button
          type="button"
          disabled={Boolean(progress)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            document.getElementById(folderInputId(inputId))?.click();
          }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-white/10"
        >
          <FolderSimplePlus size={15} weight="duotone" />
          {t(lang, "chooseFolder")}
        </button>

        {progress && (
          <div className="mt-5 w-full max-w-xs" role="status">
            <p className="font-mono text-xs text-[var(--accent)]">{progress.label}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ${progress.ratio == null ? "progress-indeterminate" : ""}`}
                style={progress.ratio == null ? undefined : { width: `${Math.max(progress.ratio * 100, 3)}%` }}
              />
            </div>
          </div>
        )}
        {!progress && error && (
          <p role="alert" className="mt-4 inline-flex items-start gap-1.5 text-left text-sm leading-5 text-[var(--danger)]">
            <WarningCircle size={15} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
        {!progress && !error && over && (
          <span className="mt-4 text-[var(--accent)]" aria-hidden>
            <CheckCircle size={18} weight="fill" />
          </span>
        )}
      </div>
    </label>
  );
}
