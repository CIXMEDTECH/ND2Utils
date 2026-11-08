import { t, type MsgKey } from "../i18n";
import type { FileSummary, Lang } from "./types";

const SLIDE_SUFFIXES = [".ome.tif", ".ome.tiff", ".tif", ".tiff"];

/** OME-TIFF / TIFF file names (opened in the whole-slide viewer). */
export function isSlideName(name: string): boolean {
  const lower = name.toLowerCase();
  return SLIDE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Leica LIF projects: imported as a folder with one workspace file per image. */
export function isLifName(name: string): boolean {
  return name.toLowerCase().endsWith(".lif");
}

export function isSupportedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".nd2") || isSlideName(name) || isLifName(name);
}

export function isSlide(file: Pick<FileSummary, "format" | "name" | "cropped"> | null | undefined): boolean {
  if (!file || file.cropped) return false;
  return file.format ? file.format === "ome-tiff" || file.format === "tiff" : isSlideName(file.name);
}

/** "a.ome.tiff" -> ".ome.tiff", "b.nd2" -> ".nd2" */
export function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  const slide = SLIDE_SUFFIXES.find((suffix) => lower.endsWith(suffix) && suffix.startsWith(".ome"));
  if (slide) return name.slice(name.length - slide.length);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export const UPLOAD_ACCEPT = ".nd2,.tif,.tiff,.lif";

export function formatBytes(n: number, lang: Lang = "en"): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const num = v >= 10 ? v.toFixed(0) : v.toFixed(1);
  return lang === "zh" ? `${num} ${units[i]}` : `${num} ${units[i]}`;
}

export function formatUm(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 100) return `${n.toFixed(0)} µm`;
  if (Math.abs(n) >= 10) return `${n.toFixed(1)} µm`;
  return `${n.toFixed(3)} µm`;
}

export function axisSize(axes: { name: string; size: number }[], name: string): number {
  const aliases: Record<string, string[]> = {
    T: ["T", "Time"],
    Z: ["Z"],
    C: ["C"],
    P: ["P", "XY", "M", "Position"],
    X: ["X"],
    Y: ["Y"],
  };
  const opts = aliases[name] ?? [name];
  for (const ax of axes) {
    if (opts.includes(ax.name)) return ax.size;
  }
  return 1;
}

export function rgbCss(color: number[] | undefined, a = 1): string {
  const [r = 220, g = 220, b = 220] = color ?? [];
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function detailMessage(err: unknown, lang: Lang = "en"): string {
  const record = err && typeof err === "object" ? err as Record<string, unknown> : null;
  const code = typeof record?.code === "string" ? record.code : undefined;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const keyByCode: Record<string, MsgKey> = {
    not_nd2: "errorNotNd2",
    not_tiff: "errorNotNd2",
    not_lif: "errorNotNd2",
    unsupported: "errorNotNd2",
    slide_error: "errorNotNd2",
    not_slide: "slideNotSlide",
    parse_failed: "errorNotNd2",
    nd2_error: "errorNotNd2",
    too_large: "errorTooLarge",
    network: "errorNetwork",
    not_found: "errorNotFound",
    missing: "errorNotFound",
    not_ready: "errorNotReady",
    no_axis: "errorNoAxis",
    no_z: "errorNoAxis",
    unauthorized: "errorUnauthorized",
    forbidden: "errorForbidden",
    bad_path: "errorBadPath",
    exists: "errorExists",
    empty: "errorEmpty",
    bad_expiry: "errorBadExpiry",
    invalid_code: "loginInvalid",
    code_expired: "loginExpired",
    code_disabled: "loginDisabled",
    rate_limited: "loginRateLimited",
  };
  const normalized = code ?? (message === "network" || message.includes("Failed to fetch") ? "network" : "");
  if (normalized && keyByCode[normalized]) return t(lang, keyByCode[normalized]);
  if (lang === "en" && message) return message;
  return t(lang, "errorGeneric");
}

export function formatDateTime(seconds: number | null | undefined, lang: Lang): string {
  if (!seconds) return "–";
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

/** "a/b/c" -> "c"; "" -> "" */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "a/b/c" -> "a/b"; "a" -> "" */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap((p) => p.split("/")).filter(Boolean).join("/");
}
