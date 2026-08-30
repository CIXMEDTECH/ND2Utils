import { Info } from "@phosphor-icons/react";
import { t } from "../i18n";
import { useApp } from "../store";
import type { MsgKey } from "../i18n";
import { Glass } from "./Glass";

export function Guide({ title, body }: { title: MsgKey; body: MsgKey }) {
  const lang = useApp((s) => s.lang);
  return (
    <Glass as="aside" shape="chip" className="px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--text-dim)]">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-[var(--text)]">
        <Info size={14} weight="bold" className="text-[var(--accent)]" />
        {t(lang, title)}
      </div>
      {t(lang, body)}
    </Glass>
  );
}
