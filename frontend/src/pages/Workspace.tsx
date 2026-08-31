import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, File as FileIcon, MagnifyingGlass, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChannelToggles } from "../components/ChannelToggles";
import { DropZone } from "../components/DropZone";
import { ExportPanel } from "../components/ExportPanel";
import { Glass } from "../components/Glass";
import { Shell } from "../components/Shell";
import { ZoomStage } from "../components/ZoomStage";
import { t } from "../i18n";
import { deleteFile, fetchPlane, getFile } from "../lib/api";
import { axisSize, detailMessage, formatBytes, formatUm, rgbCss } from "../lib/format";
import { autoscaleLimits, createPreviewLayers, drawPreview, unpackPlane } from "../lib/plane";
import type { LutSetting, PackedPlane } from "../lib/types";
import { useApp } from "../store";

type WorkspaceTab = "identify" | "metadata" | "export";

interface LocalPreview {
  fileId: string;
  dimensions: Pick<PackedPlane, "width" | "height">;
  layers: ReturnType<typeof createPreviewLayers>;
}

const WORKSPACE_TABS: { key: WorkspaceTab; label: WorkspaceTab }[] = [
  { key: "identify", label: "identify" },
  { key: "metadata", label: "metadata" },
  { key: "export", label: "export" },
];

export function Workspace() {
  const lang = useApp((s) => s.lang);
  const files = useApp((s) => s.files);
  const selectedId = useApp((s) => s.selectedId);
  const detail = useApp((s) => s.detail);
  const checked = useApp((s) => s.checked);
  const select = useApp((s) => s.select);
  const setDetail = useApp((s) => s.setDetail);
  const refreshFiles = useApp((s) => s.refreshFiles);
  const toggleChecked = useApp((s) => s.toggleChecked);
  const checkAll = useApp((s) => s.checkAll);
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<WorkspaceTab>("identify");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const [composite, setComposite] = useState(true);
  const [scaleBar, setScaleBar] = useState(true);
  const [visible, setVisible] = useState<boolean[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void refreshFiles().catch((err) => setError(detailMessage(err, lang)));
  }, [lang, refreshFiles]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    void getFile(selectedId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err) => {
        if (!cancelled) setError(detailMessage(err, lang));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, selectedId, setDetail]);

  useEffect(() => {
    setPendingDelete(null);
  }, [selectedId]);

  const previewFileId = useRef<string | null>(null);
  useEffect(() => {
    if (previewFileId.current === selectedId) return;
    previewFileId.current = selectedId;
    const file = files.find((item) => item.id === selectedId);
    setVisible(file?.channels.map(() => true) ?? []);
    setComposite(true);
    setScaleBar(true);
  }, [files, selectedId]);

  const selected = files.find((file) => file.id === selectedId) ?? null;
  const channelVisible = useMemo(
    () => selected?.channels.map((_, index) => visible[index] ?? true) ?? [],
    [selected, visible],
  );
  const previewReady = Boolean(selected && localPreview?.fileId === selected.id);

  useEffect(() => {
    if (!selected) {
      setLocalPreview(null);
      setLoadingPreview(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const file = selected;
    setLoadingPreview(true);
    void fetchPlane(file.id, 0, 0, 0, controller.signal)
      .then((buffer) => {
        if (cancelled) return;
        const packed = unpackPlane(buffer);
        const luts: LutSetting[] = packed.channels.map((channel, index) => {
          const [min, autoMax] = autoscaleLimits(channel.data);
          const metadata = file.channels[index];
          const fileMax = metadata?.lut_max;
          return {
            min,
            max: fileMax ? Math.min(autoMax, fileMax) : autoMax,
            gamma: metadata?.lut_gamma || 1,
            visible: true,
            color: metadata?.color ?? channel.color,
          };
        });
        const layers = createPreviewLayers(packed, luts);
        if (!cancelled) {
          setLocalPreview({
            fileId: file.id,
            dimensions: { width: packed.width, height: packed.height },
            layers,
          });
        }
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(detailMessage(err, lang));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lang, selected?.id]);

  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !selected || localPreview?.fileId !== selected.id) return;
    drawPreview(canvas, localPreview.dimensions, localPreview.layers, {
      composite,
      scaleBar,
      visible: channelVisible,
      umPerPixel: Number(selected.voxel_um?.[0] || 0),
    });
  }, [channelVisible, composite, localPreview, scaleBar, selected]);
  const selectedIds = files.filter((file) => checked[file.id]).map((file) => file.id);
  const exportIds = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
  const allChecked = files.length > 0 && files.every((file) => checked[file.id]);

  const metaBlob = useMemo(() => {
    if (!detail) return "";
    return JSON.stringify(
      {
        name: detail.name,
        version: detail.version,
        shape: detail.shape,
        channels: detail.channels,
        voxel_um: detail.voxel_um,
        objective: detail.objective,
        instrument: detail.instrument,
        software: detail.software,
        text_info: detail.text_info,
        groups: detail.groups,
        events: detail.events,
      },
      null,
      2,
    );
  }, [detail]);

  const filteredText = useMemo(() => {
    if (!detail) return [];
    const rows = Object.entries(detail.text_info || {}).map(([k, v]) => ({ k, v }));
    if (Object.keys(detail.groups ?? {}).length) {
      rows.push({ k: "groups", v: JSON.stringify(detail.groups, null, 2) });
    }
    const query = q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => row.k.toLowerCase().includes(query) || row.v.toLowerCase().includes(query));
  }, [detail, q]);

  function toggleChannel(index: number) {
    setVisible((prev) => {
      const count = selected?.channels.length ?? prev.length;
      const next = Array.from({ length: count }, (_, i) => prev[i] ?? true);
      next[index] = !next[index];
      return next;
    });
  }

  async function confirmDelete() {
    if (!selected) return;
    try {
      setError(null);
      await deleteFile(selected.id);
      setPendingDelete(null);
      await refreshFiles();
    } catch (err) {
      setError(detailMessage(err, lang));
    }
  }

  return (
    <Shell dense>
      <div className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:grid-cols-[272px_minmax(0,1fr)_352px]">
        <Glass as="aside" shape="panel" className="min-h-0 border-b lg:border-b-0">
          <div className="flex items-center justify-between px-4 py-3 text-[12px] text-[var(--text-dim)]">
            <span className="inline-flex items-center gap-2">
              {t(lang, "files")}
              <span className="font-mono text-[10px]">{files.length}</span>
            </span>
            {files.length > 0 && (
              <button
                type="button"
                onClick={() => checkAll(!allChecked)}
                className="rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
              >
                {t(lang, allChecked ? "clearSelection" : "selectAll")}
              </button>
            )}
          </div>
          <div className="px-3 pb-3">
            <DropZone compact inputId="workspace-nd2-upload" />
          </div>

          <AnimatePresence>
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mx-3 mb-2 overflow-hidden text-[12px] leading-5 text-[var(--danger)]"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          <motion.ul layout className="max-h-[calc(100dvh-15rem)] overflow-auto">
            {files.length === 0 && (
              <li className="mx-3 rounded-xl border border-dashed border-[var(--line)] px-4 py-8 text-center text-[13px] leading-5 text-[var(--text-dim)]">
                <FileIcon size={22} weight="duotone" className="mx-auto mb-3 text-[var(--accent)]" />
                {t(lang, "emptyFiles")}
              </li>
            )}
            <AnimatePresence initial={false}>
              {files.map((file) => {
                const active = selectedId === file.id;
                return (
                  <motion.li
                    layout
                    key={file.id}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? undefined : { opacity: 0, x: -12 }}
                    className="relative border-t border-[var(--line)]"
                  >
                    {active && (
                      <motion.span
                        layoutId="selected-file"
                        className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-[var(--accent)]"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                    <div className={`flex items-start gap-2 px-3 py-3 transition-colors ${active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg)]"}`}>
                      <label className="mt-0.5 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-black/5">
                        <input
                          type="checkbox"
                          checked={Boolean(checked[file.id])}
                          aria-label={`${t(lang, "selectFile")} ${file.name}`}
                          onChange={(event) => toggleChecked(file.id, event.target.checked)}
                        />
                      </label>
                      <button type="button" onClick={() => select(file.id)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[13px] font-semibold tracking-[-0.01em]">{file.name}</span>
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {file.channels?.map((channel) => (
                            <span
                              key={channel.index}
                              className="rounded-md px-1.5 py-0.5 font-mono text-[9px] font-medium text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
                              style={{ background: rgbCss(channel.color) }}
                            >
                              {channel.name}
                            </span>
                          ))}
                        </span>
                        <span className="mt-1.5 block font-mono text-[10px] text-[var(--text-dim)]">
                          {file.width ?? "–"}×{file.height ?? "–"} · {formatBytes(file.size_bytes, lang)}
                        </span>
                      </button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>
        </Glass>

        <main className="min-h-[430px] bg-[var(--well)]">
          <ZoomStage
            src={null}
            alt={t(lang, "previewAlt")}
            mediaReady={previewReady}
            mediaLoading={loadingPreview}
            media={
              <canvas
                ref={previewCanvasRef}
                role="img"
                aria-label={t(lang, "previewAlt")}
                className="block max-h-none max-w-none"
              />
            }
          >
            <Glass tone="dark" shape="chip" className="absolute left-3 top-3 flex gap-1 overflow-visible p-1">
              {([
                ["overlay", composite, () => setComposite(true)],
                ["split", !composite, () => setComposite(false)],
                ["scaleBar", scaleBar, () => setScaleBar((value) => !value)],
              ] as const).map(([key, active, action]) => (
                <button
                  key={key}
                  type="button"
                  onClick={action}
                  aria-pressed={active}
                  className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] transition-all duration-200 ${active ? "bg-white text-black shadow-sm" : "text-white/65 hover:bg-white/10 hover:text-white"}`}
                >
                  {t(lang, key)}
                </button>
              ))}
            </Glass>
            {selected && selected.channels.length > 0 && (
              <Glass tone="dark" shape="chip" className="absolute bottom-3 left-3 max-w-[min(100%-1.5rem,32rem)] overflow-visible p-1">
                <ChannelToggles channels={selected.channels} visible={channelVisible} onToggle={toggleChannel} />
              </Glass>
            )}
          </ZoomStage>
        </main>

        <Glass as="aside" shape="panel" className="flex min-h-0 flex-col border-t lg:border-l lg:border-t-0">
          <div className="flex gap-1 border-b border-[var(--line)] p-2 text-[12px]" role="tablist">
            {WORKSPACE_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`relative flex-1 rounded-lg px-2 py-2 transition-colors ${tab === key ? "text-[var(--bg)]" : "text-[var(--text-dim)] hover:text-[var(--text)]"}`}
              >
                {tab === key && (
                  <motion.span
                    layoutId="workspace-tab"
                    className="absolute inset-0 rounded-lg bg-[var(--text)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative z-[1]">{t(lang, label)}</span>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selected && (
              <div className="flex min-h-44 flex-col items-center justify-center text-center text-[13px] leading-5 text-[var(--text-dim)]">
                <FileIcon size={24} weight="duotone" className="mb-3 text-[var(--accent)]" />
                <p className="max-w-[27ch]">{t(lang, "noneSelected")}</p>
              </div>
            )}

            {selected && (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  initial={reduce ? false : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? undefined : { opacity: 0, x: -6 }}
                  transition={{ duration: 0.2 }}
                >
                  {tab === "identify" && (
                    <>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
                        <dt className="text-[var(--text-dim)]">{t(lang, "version")}</dt>
                        <dd className="font-mono tabular-nums">{selected.version?.join(".") ?? "–"}</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "dtype")}</dt>
                        <dd className="font-mono tabular-nums">
                          {selected.dtype ?? "–"} {selected.bits_significant ? `(${selected.bits_significant}-bit)` : ""}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "shape")}</dt>
                        <dd className="break-words font-mono tabular-nums">
                          {selected.axes?.map((axis) => `${axis.name}${axis.size}`).join(" ") || selected.shape.join("×")}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "channels")}</dt>
                        <dd>
                          <ChannelToggles
                            variant="list"
                            channels={selected.channels}
                            visible={channelVisible}
                            onToggle={toggleChannel}
                          />
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "objective")}</dt>
                        <dd>
                          {selected.objective ?? "–"}
                          {selected.na ? ` · NA ${selected.na}` : ""}
                        </dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "voxel")}</dt>
                        <dd className="font-mono tabular-nums">{formatUm(selected.voxel_um?.[0])}/px</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "instrument")}</dt>
                        <dd>{selected.instrument ?? "–"}</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "software")}</dt>
                        <dd>{selected.software ?? "–"}</dd>
                        <dt className="text-[var(--text-dim)]">{t(lang, "acquired")}</dt>
                        <dd className="font-mono text-[11px] tabular-nums">{selected.acquired ?? "–"}</dd>
                      </dl>

                      <div className="mt-7 flex flex-wrap gap-2">
                        <button type="button" onClick={() => nav(`/advanced/${selected.id}`)} className="primary-action min-h-9 px-4 text-[12px]">
                          {t(lang, "openAdvanced")}
                        </button>
                        {pendingDelete !== selected.id && (
                          <button
                            type="button"
                            onClick={() => setPendingDelete(selected.id)}
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_9%,transparent)]"
                          >
                            <Trash size={14} /> {t(lang, "delete")}
                          </button>
                        )}
                      </div>

                      <AnimatePresence>
                        {pendingDelete === selected.id && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, height: 0 }}
                            animate={{ opacity: 1, y: 0, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="mt-4 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--danger)_28%,var(--line))] bg-[color-mix(in_srgb,var(--danger)_6%,var(--bg))] p-3"
                          >
                            <p className="text-[12px] leading-5 text-[var(--text-dim)]">{t(lang, "deleteHint")}</p>
                            <div className="mt-3 flex gap-2">
                              <button type="button" onClick={() => void confirmDelete()} className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--danger)] px-3 text-[11px] font-medium text-white">
                                <Check size={13} /> {t(lang, "confirmDelete")}
                              </button>
                              <button type="button" onClick={() => setPendingDelete(null)} className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-[11px] text-[var(--text-dim)] hover:bg-[var(--bg)]">
                                <X size={13} /> {t(lang, "cancel")}
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}

                  {tab === "metadata" && (
                    <div className="flex flex-col gap-3">
                      {loadingDetail && <p className="text-[12px] text-[var(--text-dim)]">{t(lang, "loadingFile")}</p>}
                      {!loadingDetail && detail && (
                        <>
                          <label className="relative block">
                            <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" />
                            <input
                              value={q}
                              onChange={(event) => setQ(event.target.value)}
                              placeholder={t(lang, "searchMeta")}
                              className="h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] pl-9 pr-3 text-[13px] transition-colors focus:border-[var(--accent)]"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={async () => {
                              await navigator.clipboard.writeText(metaBlob);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1200);
                            }}
                            className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                          >
                            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                            {copied ? t(lang, "copied") : t(lang, "copyJson")}
                          </button>

                          {filteredText.map((row) => (
                            <section key={row.k}>
                              <h3 className="text-[12px] font-semibold text-[var(--text-dim)]">{row.k}</h3>
                              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-2.5 font-mono text-[10px] leading-relaxed">
                                {row.v}
                              </pre>
                            </section>
                          ))}
                          {detail.events?.length ? (
                            <section>
                              <h3 className="text-[12px] font-semibold text-[var(--text-dim)]">{t(lang, "events")}</h3>
                              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-2.5 font-mono text-[10px] leading-relaxed">
                                {JSON.stringify(detail.events, null, 2)}
                              </pre>
                            </section>
                          ) : null}
                          {filteredText.length === 0 && !detail.events?.length && (
                            <p className="py-6 text-center text-[12px] text-[var(--text-dim)]">
                              {t(lang, q ? "noSearchResults" : "noMetadata")}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {tab === "export" && <ExportPanel fileIds={exportIds} />}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {selected && (
            <p className="border-t border-[var(--line)] px-4 py-2.5 font-mono text-[10px] text-[var(--text-dim)] tabular-nums">
              T{axisSize(selected.axes, "T")} · Z{axisSize(selected.axes, "Z")} · C{axisSize(selected.axes, "C")} · P{axisSize(selected.axes, "P")}
            </p>
          )}
        </Glass>
      </div>
    </Shell>
  );
}
