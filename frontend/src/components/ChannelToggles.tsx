import { Eye, EyeSlash } from "@phosphor-icons/react";
import { t } from "../i18n";
import { rgbCss } from "../lib/format";
import { useApp } from "../store";

type ChannelChip = {
  index: number;
  name: string;
  color: number[];
  excitation_nm?: number | null;
  emission_nm?: number | null;
};

export function ChannelToggles({
  channels,
  visible,
  onToggle,
  variant = "overlay",
}: {
  channels: ChannelChip[];
  visible: boolean[];
  onToggle: (index: number) => void;
  variant?: "overlay" | "list";
}) {
  const lang = useApp((s) => s.lang);
  if (!channels.length) return null;

  if (variant === "list") {
    return (
      <div className="space-y-1">
        {channels.map((channel) => {
          const on = visible[channel.index] !== false;
          return (
            <button
              key={channel.index}
              type="button"
              onClick={() => onToggle(channel.index)}
              aria-pressed={on}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left font-mono text-[11px] transition-opacity hover:bg-[var(--bg)] ${on ? "opacity-100" : "opacity-40"}`}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: rgbCss(channel.color) }} />
              <span className="min-w-0 flex-1 truncate">
                {channel.name}
                {channel.excitation_nm ? ` · ${channel.excitation_nm}/${channel.emission_nm} nm` : ""}
              </span>
              {on ? <Eye size={13} /> : <EyeSlash size={13} />}
            </button>
          );
        })}
        <p className="pt-1 text-[11px] leading-4 text-[var(--text-dim)]">{t(lang, "channelPreview")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t(lang, "channels")}>
      {channels.map((channel) => {
        const on = visible[channel.index] !== false;
        return (
          <button
            key={channel.index}
            type="button"
            onClick={() => onToggle(channel.index)}
            aria-pressed={on}
            title={t(lang, "channelPreview")}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[10px] font-medium transition-all duration-200 ${
              on ? "bg-white/16 text-white" : "text-white/40 hover:bg-white/10 hover:text-white/75"
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: rgbCss(channel.color, on ? 1 : 0.35) }} />
            {channel.name}
            {on ? <Eye size={11} /> : <EyeSlash size={11} />}
          </button>
        );
      })}
    </div>
  );
}