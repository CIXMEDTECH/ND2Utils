import { t, type MsgKey } from "../i18n";
import type { Lang } from "./types";

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
    parse_failed: "errorNotNd2",
    nd2_error: "errorNotNd2",
    too_large: "errorTooLarge",
    network: "errorNetwork",
    not_found: "errorNotFound",
    missing: "errorNotFound",
    not_ready: "errorNotReady",
    no_axis: "errorNoAxis",
    no_z: "errorNoAxis",
  };
  const normalized = code ?? (message === "network" || message.includes("Failed to fetch") ? "network" : "");
  if (normalized && keyByCode[normalized]) return t(lang, keyByCode[normalized]);
  if (lang === "en" && message) return message;
  return t(lang, "errorGeneric");
}
