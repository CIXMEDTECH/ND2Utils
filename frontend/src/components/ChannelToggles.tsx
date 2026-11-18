import { Eye, EyeSlash, LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
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
  const channelLocked = useApp((s) => s.channelLocked);
  const toggleChannelLock = useApp((s) => s.toggleChannelLock);

  if (!channels.length) return null;

  const lockLabel = t(lang, channelLocked ? "channelsLocked" : "lockChannels");
  const lockHint = t(lang, "lockChannelsHint");

  if (variant === "list") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 pb-0.5">
          <span className="text-xs text-[var(--text-dim)]">{t(lang, "channelPreview")}</span>
          <button
            type="button"
            onClick={() => toggleChannelLock(channels, visible)}
            aria-pressed={channelLocked}
            title={lockHint}
            className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-all ${
              channelLocked
                ? "border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)] shadow-xs"
                : "border-[var(--line)] bg-[var(--bg)]/60 text-[var(--text-dim)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
            }`}
          >
            {channelLocked ? <LockSimple size={12} weight="fill" /> : <LockSimpleOpen size={12} />}
            <span>{lockLabel}</span>
          </button>
        </div>
        <div className="space-y-1">
          {channels.map((channel) => {
            const on = visible[channel.index] !== false;
            return (
              <button
                key={channel.index}
                type="button"
                onClick={() => onToggle(channel.index)}
                aria-pressed={on}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left font-mono text-xs transition-all ${
                  on
                    ? "border-[var(--line)] bg-[var(--bg)]/70 text-[var(--text)] shadow-2xs hover:border-[var(--line-strong)]"
                    : "border-transparent bg-transparent text-[var(--text-dim)] opacity-50 hover:bg-[var(--bg)]/40 hover:opacity-80"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-black/20"
                  style={{
                    background: rgbCss(channel.color),
                    boxShadow: on ? `0 0 8px ${rgbCss(channel.color, 0.55)}` : "none",
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {channel.name}
                  {channel.excitation_nm ? (
                    <span className="ml-1.5 text-2xs font-normal text-[var(--text-dim)]">
                      {channel.excitation_nm}/{channel.emission_nm}nm
                    </span>
                  ) : (
                    ""
                  )}
                </span>
                {on ? <Eye size={13} className="text-[var(--accent)]" /> : <EyeSlash size={13} />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t(lang, "channels")}>
      {channels.map((channel) => {
        const on = visible[channel.index] !== false;
        return (
          <button
            key={channel.index}
            type="button"
            onClick={() => onToggle(channel.index)}
            aria-pressed={on}
            title={t(lang, "channelPreview")}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-xs font-medium transition-all duration-150 ${
              on
                ? "bg-white/15 text-white shadow-2xs ring-1 ring-white/15"
                : "text-white/40 hover:bg-white/8 hover:text-white/75"
            }`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{
                background: rgbCss(channel.color, on ? 1 : 0.35),
                boxShadow: on ? `0 0 6px ${rgbCss(channel.color, 0.7)}` : "none",
              }}
            />
            {channel.name}
            {on ? <Eye size={11} /> : <EyeSlash size={11} />}
          </button>
        );
      })}
      <span className="mx-0.5 h-3.5 w-px bg-white/12" aria-hidden="true" />
      <button
        type="button"
        onClick={() => toggleChannelLock(channels, visible)}
        aria-pressed={channelLocked}
        title={lockHint}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-all duration-150 ${
          channelLocked
            ? "bg-sky-400/20 text-sky-300 ring-1 ring-sky-400/40"
            : "text-white/55 hover:bg-white/10 hover:text-white"
        }`}
      >
        {channelLocked ? <LockSimple size={12} weight="fill" /> : <LockSimpleOpen size={12} />}
        <span>{lockLabel}</span>
      </button>
    </div>
  );
}