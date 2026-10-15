import { Eye, EyeSlash, Target } from "@phosphor-icons/react";
import { t } from "../i18n";
import { rgbCss } from "../lib/format";
import type { ChannelDisplay } from "../lib/slide";
import type { SlideInfo } from "../lib/types";
import { useApp } from "../store";

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
  const float = info.dtype.startsWith("float");

  function patch(index: number, change: Partial<ChannelDisplay>) {
    onChange(display.map((d, i) => (i === index ? { ...d, ...change } : d)));
  }

  const headerButton =
    "rounded-lg px-2 py-1 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-0.5">
        <button type="button" className={headerButton} onClick={() => onChange(display.map((d) => ({ ...d, visible: true })))}>
          {t(lang, "showAll")}
        </button>
        <button type="button" className={headerButton} onClick={() => onChange(display.map((d) => ({ ...d, visible: false })))}>
          {t(lang, "hideAll")}
        </button>
        <button type="button" className={`${headerButton} ml-auto`} onClick={onAuto}>
          {t(lang, "auto")}
        </button>
      </div>

      {display.map((d, i) => {
        const channel = info.channels[i];
        const top = rangeTop(info, i);
        const step = float ? top / 1000 : 1;
        return (
          <div
            key={i}
            className={`liquid-glass liquid-glass--chip p-2.5 transition-opacity duration-200 ${d.visible ? "" : "opacity-55"}`}
          >
            <div className="flex items-center gap-2 text-[12px]">
              <label
                className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-[var(--line-strong)]"
                style={{ background: rgbCss(d.color) }}
                title={t(lang, "channelColor")}
              >
                <input
                  type="color"
                  value={hex(d.color)}
                  onChange={(event) => patch(i, { color: fromHex(event.target.value) })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label={`${t(lang, "channelColor")} ${channel?.name ?? i + 1}`}
                />
              </label>
              <span className="min-w-0 flex-1 truncate font-mono" title={channel?.name}>
                {channel?.name ?? `C${i + 1}`}
              </span>
              <button
                type="button"
                title={t(lang, "solo")}
                aria-label={`${t(lang, "solo")}: ${channel?.name ?? i + 1}`}
                onClick={() => onChange(display.map((x, j) => ({ ...x, visible: j === i })))}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
              >
                <Target size={13} />
              </button>
              <button
                type="button"
                aria-pressed={d.visible}
                aria-label={channel?.name ?? `C${i + 1}`}
                onClick={() => patch(i, { visible: !d.visible })}
                className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg)] ${d.visible ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`}
              >
                {d.visible ? <Eye size={14} /> : <EyeSlash size={14} />}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[10.5px] text-[var(--text-dim)]">
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
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    patch(i, { min: Math.min(v, d.max - step) });
                  }}
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
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    patch(i, { max: Math.max(v, d.min + step) });
                  }}
                  className="w-full"
                />
              </label>
              <label className="col-span-2 grid gap-0.5">
                <span className="flex justify-between">
                  γ
                  <span className="font-mono tabular-nums text-[var(--text)]">{d.gamma.toFixed(2)}</span>
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
