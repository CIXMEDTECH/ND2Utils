import { useState } from "react";
import { Eye, EyeSlash, LockSimple, LockSimpleOpen, SlidersHorizontal } from "@phosphor-icons/react";
import { t } from "../i18n";
import { rgbCss } from "../lib/format";
import type { ChannelDisplay } from "../lib/slide";
import type { SlideInfo } from "../lib/types";
import { useApp } from "../store";

const SWATCHES = [
  [40, 110, 255],
  [0, 255, 0],
  [255, 0, 0],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 140, 0],
  [255, 255, 255],
];

function hex(color: number[]): string {
  return `#${color.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(value: string): number[] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Upper end of the range sliders: the data range of the slide's pixel type. */
export function rangeTop(info: SlideInfo, index: number): number {
  const suggested = info.channels[index]?.suggested_max;
  if (suggested && suggested > 1) return suggested;
  return info.dtype === "uint8" ? 255 : info.dtype === "uint16" ? 65535 : 1;
}

/**
 * Channel list for the slide viewer: a click on a row shows / hides the channel (like the
 * workspace); color, black / white point and gamma sit behind each row's adjust button.
 */
export function SlideChannels({
  info,
  display,
  onChange,
  onAuto,
}: {
  info: SlideInfo;
  display: ChannelDisplay[];
  onChange: (next: ChannelDisplay[]) => void;
  onAuto: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const channelLocked = useApp((s) => s.channelLocked);
  const toggleChannelLock = useApp((s) => s.toggleChannelLock);
  const updateLockedChannels = useApp((s) => s.updateLockedChannels);
  const [open, setOpen] = useState<number | null>(null);
  const float = info.dtype.startsWith("float");

  function applyDisplay(next: ChannelDisplay[]) {
    onChange(next);
    if (channelLocked) {
      updateLockedChannels(
        info.channels,
        next.map((d) => d.visible),
      );
    }
  }

  function patch(index: number, change: Partial<ChannelDisplay>) {
    applyDisplay(display.map((d, i) => (i === index ? { ...d, ...change } : d)));
  }

  const headerButton = "rounded-lg px-2 py-1 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]";

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1 flex flex-wrap items-center gap-0.5">
        <button type="button" className={headerButton} onClick={() => applyDisplay(display.map((d) => ({ ...d, visible: true })))}>
          {t(lang, "showAll")}
        </button>
        <button type="button" className={headerButton} onClick={() => applyDisplay(display.map((d) => ({ ...d, visible: false })))}>
          {t(lang, "hideAll")}
        </button>
        <button
          type="button"
          onClick={() =>
            toggleChannelLock(
              info.channels,
              display.map((d) => d.visible),
            )
          }
          aria-pressed={channelLocked}
          title={t(lang, "lockChannelsHint")}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
            channelLocked ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-dim)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
          }`}
        >
          {channelLocked ? <LockSimple size={12} weight="fill" /> : <LockSimpleOpen size={12} />}
          {t(lang, channelLocked ? "channelsLocked" : "lockChannels")}
        </button>
        <button type="button" className={`${headerButton} ml-auto`} onClick={onAuto}>
          {t(lang, "auto")}
        </button>
      </div>

      {display.map((d, i) => {
        const channel = info.channels[i];
        const name = channel?.name ?? `C${i + 1}`;
        const top = rangeTop(info, i);
        const step = float ? top / 1000 : 1;
        const expanded = open === i;
        return (
          <div key={i} className={`rounded-lg transition-colors ${expanded ? "bg-[var(--bg)]" : ""}`}>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => patch(i, { visible: !d.visible })}
                aria-pressed={d.visible}
                className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left font-mono text-[11.5px] transition-opacity hover:bg-[var(--bg)] ${d.visible ? "opacity-100" : "opacity-40"}`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: rgbCss(d.color) }} />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
                {d.visible ? <Eye size={13} /> : <EyeSlash size={13} />}
              </button>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : i)}
                aria-expanded={expanded}
                aria-label={`${t(lang, "displayRange")}: ${name}`}
                title={t(lang, "displayRange")}
                className={`ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg)] ${expanded ? "text-[var(--accent)]" : "text-[var(--text-dim)]"}`}
              >
                <SlidersHorizontal size={13} />
              </button>
            </div>

            {expanded && (
              <div className="overflow-hidden">
                <div className="grid gap-2 px-2 pb-2.5 pt-1 text-[10.5px] text-[var(--text-dim)]">
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t(lang, "channelColor")}>
                    {SWATCHES.map((color) => (
                      <button
                        key={color.join()}
                        type="button"
                        onClick={() => patch(i, { color })}
                        aria-label={hex(color)}
                        className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-[var(--bg)] transition-transform hover:scale-110 ${d.color.join() === color.join() ? "ring-2 ring-[var(--text)]" : "ring-1 ring-[var(--line-strong)]"}`}
                        style={{ background: rgbCss(color) }}
                      />
                    ))}
                    <label className="relative ml-auto h-4 w-4 cursor-pointer overflow-hidden rounded-full ring-1 ring-[var(--line-strong)]" title={t(lang, "channelColor")} style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}>
                      <input
                        type="color"
                        value={hex(d.color)}
                        onChange={(event) => patch(i, { color: fromHex(event.target.value) })}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        aria-label={`${t(lang, "channelColor")} ${name}`}
                      />
                    </label>
                  </div>
                  <label className="grid gap-0.5">
                    <span className="flex justify-between">
                      {t(lang, "min")}
                      <span className="font-mono tabular-nums text-[var(--text)]">{float ? d.min.toPrecision(3) : Math.round(d.min)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={top}
                      step={step}
                      value={d.min}
                      onChange={(event) => patch(i, { min: Math.min(Number(event.target.value), d.max - step) })}
                      className="w-full"
                    />
                  </label>
                  <label className="grid gap-0.5">
                    <span className="flex justify-between">
                      {t(lang, "max")}
                      <span className="font-mono tabular-nums text-[var(--text)]">{float ? d.max.toPrecision(3) : Math.round(d.max)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={top}
                      step={step}
                      value={d.max}
                      onChange={(event) => patch(i, { max: Math.max(Number(event.target.value), d.min + step) })}
                      className="w-full"
                    />
                  </label>
                  <label className="grid gap-0.5">
                    <span className="flex justify-between">
                      γ<span className="font-mono tabular-nums text-[var(--text)]">{d.gamma.toFixed(2)}</span>
                    </span>
                    <input
                      type="range"
                      min={0.3}
                      max={3}
                      step={0.05}
                      value={d.gamma}
                      onChange={(event) => patch(i, { gamma: Number(event.target.value) })}
                      className="w-full"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => applyDisplay(display.map((x, j) => ({ ...x, visible: j === i })))}
                    className="justify-self-start rounded-md px-1.5 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  >
                    {t(lang, "solo")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <p className="pt-1 text-[11px] leading-4 text-[var(--text-dim)]">{t(lang, "slideChannelHint")}</p>
    </div>
  );
}
