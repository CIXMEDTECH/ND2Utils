import { useCallback, useEffect, useState } from "react";
import {
  ArrowsClockwise,
  ArrowsLeftRight,
  FolderOpen,
  Check,
  Copy,
  Key,
  PencilSimple,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { t, type MsgKey } from "../i18n";
import { createCode, deleteCode, listCodes, regenerateCode, updateCode } from "../lib/api";
import { detailMessage, formatBytes, formatDateTime } from "../lib/format";
import type { AccessCode, CodeKind, CodeStatus } from "../lib/types";
import { useApp } from "../store";
import { Glass } from "./Glass";
import { ConfirmDialog } from "./Modal";
import { TransferDialog, type TransferSeed } from "./TransferDialog";

type ExpiryChoice = "never" | "1" | "7" | "30" | "90" | "custom";

const EXPIRY_OPTIONS: { value: ExpiryChoice; key: MsgKey }[] = [
  { value: "never", key: "expiryNever" },
  { value: "1", key: "expiry1d" },
  { value: "7", key: "expiry7d" },
  { value: "30", key: "expiry30d" },
  { value: "90", key: "expiry90d" },
  { value: "custom", key: "expiryCustom" },
];

const STATUS_KEY: Record<CodeStatus, MsgKey> = {
  active: "statusActive",
  expired: "statusExpired",
  disabled: "statusDisabled",
};

const fieldClass =
  "h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[12.5px] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none";

function toLocalInput(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ExpiryValue {
  choice: ExpiryChoice;
  custom: string;
}

function expirySeconds(value: ExpiryValue): number | null {
  if (value.choice === "never") return null;
  if (value.choice === "custom") return value.custom ? new Date(value.custom).getTime() / 1000 : null;
  return Date.now() / 1000 + Number(value.choice) * 86400;
}

function ExpiryField({ value, onChange }: { value: ExpiryValue; onChange: (value: ExpiryValue) => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <div className="grid gap-1.5">
      <select
        value={value.choice}
        onChange={(event) => {
          const choice = event.target.value as ExpiryChoice;
          onChange({ choice, custom: value.custom || toLocalInput(Date.now() / 1000 + 30 * 86400) });
        }}
        className={fieldClass}
      >
        {EXPIRY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(lang, option.key)}
          </option>
        ))}
      </select>
      {value.choice === "custom" && (
        <input
          type="datetime-local"
          value={value.custom}
          min={toLocalInput(Date.now() / 1000)}
          onChange={(event) => onChange({ ...value, custom: event.target.value })}
          className={fieldClass}
        />
      )}
    </div>
  );
}

function KindToggle({ value, onChange }: { value: CodeKind; onChange: (kind: CodeKind) => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--bg)] p-1">
      {(["temporary", "permanent"] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={value === kind}
          onClick={() => onChange(kind)}
          className={`h-7 rounded-md text-[11.5px] transition-colors ${value === kind ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
        >
          {t(lang, kind === "permanent" ? "kindPermanent" : "kindTemporary")}
        </button>
      ))}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--accent)] hover:bg-[var(--accent-soft)]"
      aria-label={label}
      title={label}
    >
      {done ? <Check size={14} weight="bold" /> : <Copy size={14} />}
    </button>
  );
}

function StatusBadge({ status }: { status: CodeStatus }) {
  const lang = useApp((s) => s.lang);
  const tone =
    status === "active"
      ? "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-[var(--ok)]"
      : "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]";
  return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${tone}`}>{t(lang, STATUS_KEY[status])}</span>;
}

function CodeRow({
  code,
  onChanged,
  onFiles,
}: {
  code: AccessCode;
  onChanged: () => Promise<void>;
  onFiles: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const reduce = useReducedMotion();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(code.label);
  const [kind, setKind] = useState<CodeKind>(code.kind);
  const [expiry, setExpiry] = useState<ExpiryValue>({ choice: "never", custom: "" });
  const [confirm, setConfirm] = useState<"delete" | "regenerate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setLabel(code.label);
    setKind(code.kind);
    setExpiry(code.expires_at ? { choice: "custom", custom: toLocalInput(code.expires_at) } : { choice: "never", custom: "" });
    setError(null);
    setEditing(true);
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setError(detailMessage(err, lang));
      return false;
    }
  }

  return (
    <li className="border-t border-[var(--line)] py-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[13px] font-semibold">{code.label || "—"}</span>
        <StatusBadge status={code.status} />
        <span className="rounded-full bg-[var(--bg)] px-2 py-0.5 text-[10.5px] text-[var(--text-dim)]">
          {t(lang, code.kind === "permanent" ? "kindPermanent" : "kindTemporary")}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <code className="select-all font-mono text-[13px] tracking-[0.08em] text-[var(--text)]">{code.code}</code>
        <CopyButton text={code.code} label={t(lang, "copyCode")} />
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
        <dt>{t(lang, "expiresAt")}</dt>
        <dd className="font-mono tabular-nums text-[var(--text)]">
          {code.expires_at ? formatDateTime(code.expires_at, lang) : t(lang, "expiresNever")}
        </dd>
        <dt>{t(lang, "lastLogin")}</dt>
        <dd className="font-mono tabular-nums">{code.last_login_at ? formatDateTime(code.last_login_at, lang) : t(lang, "neverLoggedIn")}</dd>
        <dt>{t(lang, "usage")}</dt>
        <dd className="font-mono tabular-nums">
          {code.usage.files} {t(lang, "nFiles")} · {formatBytes(code.usage.bytes, lang)}
        </dd>
      </dl>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {[
          { key: "edit", label: t(lang, "edit"), icon: <PencilSimple size={13} />, onClick: () => (editing ? setEditing(false) : startEdit()) },
          {
            key: "toggle",
            label: t(lang, code.disabled ? "enable" : "disable"),
            icon: code.disabled ? <Play size={13} /> : <Pause size={13} />,
            onClick: () => void run(() => updateCode(code.id, { disabled: !code.disabled })),
          },
          { key: "regen", label: t(lang, "regenerate"), icon: <ArrowsClockwise size={13} />, onClick: () => setConfirm("regenerate") },
          { key: "files", label: t(lang, "manageFiles"), icon: <FolderOpen size={13} />, onClick: onFiles },
        ].map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={action.onClick}
            aria-expanded={action.key === "edit" ? editing : undefined}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-[var(--text-dim)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
          >
            {action.icon}
            {action.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setConfirm("delete")}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_9%,transparent)]"
        >
          <Trash size={13} />
          {t(lang, "deleteCode")}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {editing && (
          <motion.form
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduce ? undefined : { opacity: 0, height: 0 }}
            className="overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                updateCode(code.id, { label, kind, expires_at: expirySeconds(expiry) }),
              ).then((ok) => ok && setEditing(false));
            }}
          >
            <div className="mt-2 grid gap-2.5 rounded-xl bg-[var(--bg)]/60 p-3 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] text-[var(--text-dim)] sm:col-span-2">
                {t(lang, "codeLabel")}
                <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} className={fieldClass} />
              </label>
              <div className="grid gap-1 text-[11px] text-[var(--text-dim)]">
                {t(lang, "codeKind")}
                <KindToggle value={kind} onChange={setKind} />
              </div>
              <div className="grid gap-1 text-[11px] text-[var(--text-dim)]">
                {t(lang, "codeExpiry")}
                <ExpiryField value={expiry} onChange={setExpiry} />
              </div>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <button type="button" onClick={() => setEditing(false)} className="h-8 rounded-lg px-3 text-[12px] text-[var(--text-dim)] hover:bg-[var(--bg)]">
                  {t(lang, "cancel")}
                </button>
                <button type="submit" className="h-8 rounded-lg bg-[var(--accent)] px-4 text-[12px] font-semibold text-white">
                  {t(lang, "save")}
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={t(lang, confirm === "delete" ? "deleteCode" : "regenerate")}
        body={
          <>
            <span className="mb-1 block font-mono text-[11px] text-[var(--text)]">
              {code.label ? `${code.label} · ` : ""}
              {code.code}
            </span>
            {t(lang, confirm === "delete" ? "deleteCodeHint" : "regenerateHint")}
          </>
        }
        confirmLabel={t(lang, confirm === "delete" ? "deleteCode" : "regenerate")}
        onConfirm={async () => {
          await (confirm === "delete" ? deleteCode(code.id) : regenerateCode(code.id));
          await onChanged();
        }}
        onClose={() => setConfirm(null)}
      />
    </li>
  );
}

export function AdminCodes() {
  const lang = useApp((s) => s.lang);
  const reduce = useReducedMotion();
  const [codes, setCodes] = useState<AccessCode[] | null>(null);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<CodeKind>("temporary");
  const [expiry, setExpiry] = useState<ExpiryValue>({ choice: "30", custom: "" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AccessCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferSeed, setTransferSeed] = useState<TransferSeed | null>(null);

  const load = useCallback(async () => {
    const res = await listCodes();
    setCodes(res.codes);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const rec = await createCode({ label: label.trim(), kind, expires_at: expirySeconds(expiry) });
      setCreated(rec);
      setLabel("");
      await load();
    } catch (err) {
      setError(detailMessage(err, lang));
    } finally {
      setBusy(false);
    }
  }

  const admin = codes?.find((c) => c.role === "admin");
  const users = codes?.filter((c) => c.role !== "admin") ?? [];

  return (
    <Glass as="section" shape="card" className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <Key size={18} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)]">{t(lang, "adminEyebrow")}</p>
          <h2 className="mt-1 text-[14px] font-semibold">{t(lang, "adminTitle")}</h2>
          <p className="mt-2 text-[12px] leading-5 text-[var(--text-dim)]">{t(lang, "adminIntro")}</p>
          <button
            type="button"
            onClick={() => setTransferSeed({ fileIds: [], folders: [] })}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <ArrowsLeftRight size={14} />
            {t(lang, "transferFiles")}
          </button>

          {admin && (
            <div className="mt-4 rounded-xl bg-[var(--bg)]/60 p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-dim)]">
                <ShieldCheck size={14} weight="fill" className="text-[var(--accent)]" />
                {t(lang, "adminSelf")}
              </p>
              <div className="mt-1 flex items-center gap-1">
                <code className="select-all font-mono text-[13px] tracking-[0.08em]">{admin.code}</code>
                <CopyButton text={admin.code} label={t(lang, "copyCode")} />
              </div>
            </div>
          )}

          <form onSubmit={(event) => void create(event)} className="mt-5 grid gap-2.5 sm:grid-cols-2">
            <p className="text-[12.5px] font-semibold sm:col-span-2">{t(lang, "newCode")}</p>
            <label className="grid gap-1 text-[11px] text-[var(--text-dim)] sm:col-span-2">
              {t(lang, "codeLabel")}
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={80}
                placeholder={t(lang, "codeLabelPlaceholder")}
                className={fieldClass}
              />
            </label>
            <div className="grid gap-1 text-[11px] text-[var(--text-dim)]">
              {t(lang, "codeKind")}
              <KindToggle value={kind} onChange={setKind} />
            </div>
            <div className="grid gap-1 text-[11px] text-[var(--text-dim)]">
              {t(lang, "codeExpiry")}
              <ExpiryField value={expiry} onChange={setExpiry} />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-40 sm:col-span-2 sm:justify-self-start"
            >
              <Plus size={14} weight="bold" />
              {t(lang, "createCode")}
            </button>
          </form>

          <AnimatePresence>
            {created && (
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--ok)_35%,var(--line))] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] p-3"
              >
                <p className="text-[12px] text-[var(--text-dim)]">{t(lang, "codeCreated")}</p>
                <div className="mt-1 flex items-center gap-1">
                  <code className="select-all font-mono text-[15px] font-semibold tracking-[0.1em]">{created.code}</code>
                  <CopyButton text={created.code} label={t(lang, "copyCode")} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}

          <div className="mt-6">
            {codes === null ? (
              <div className="grid gap-2" aria-hidden>
                <span className="h-16 animate-pulse rounded-xl bg-[var(--bg)]/50" />
                <span className="h-16 animate-pulse rounded-xl bg-[var(--bg)]/50" />
              </div>
            ) : users.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--line)] py-6 text-center text-[12px] text-[var(--text-dim)]">{t(lang, "noCodes")}</p>
            ) : (
              <ul>
                {users.map((code) => (
                  <CodeRow
                    key={code.id}
                    code={code}
                    onChanged={load}
                    onFiles={() => setTransferSeed({ source: code.id, fileIds: [], folders: [] })}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <TransferDialog
        open={Boolean(transferSeed)}
        seed={transferSeed}
        onClose={() => setTransferSeed(null)}
        onDone={() => {
          void load();
          // The admin's own workspace may have changed too.
          void useApp.getState().refreshFiles().catch(() => undefined);
        }}
      />
    </Glass>
  );
}
