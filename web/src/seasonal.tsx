import type { ReactNode } from "react";
import { t, type I18nKey } from "./i18n";
import { seasonOf, type SeasonKey } from "./season";

/** A few seasonal shapes scattered over the header (static; decorative only). */
const SHAPES: Record<SeasonKey, string> = {
  // momiji (maple leaf)
  fall: "M12 2l1.6 4.2 3.4-2-1 4.1 4.4-.6-3 3.3 3.6 2.4-4.5.6.9 4.4-3.8-2.4L12 22l-1.6-4.1-3.8 2.4.9-4.4-4.5-.6 3.6-2.4-3-3.3 4.4.6-1-4.1 3.4 2z",
  // sakura petal
  spring: "M12 3c3 2.5 5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 2-6.5 5-9zm0 5.5l-1.2 2.2h2.4z",
  // ramune bubble
  summer: "M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16zm-3 4a2.2 2.2 0 1 1 0 4.4A2.2 2.2 0 0 1 9 8z",
  // snowflake
  winter: "M11 2h2v5.3l3.2-1.9 1 1.7L14 9l3.2 1.9-1 1.7L13 10.7V13h-2v-2.3l-3.2 1.9-1-1.7L10 9 6.8 7.1l1-1.7L11 7.3z",
};
const SPOTS = [
  { left: "62%", top: "8%", size: 22, rot: 12, o: 0.7 },
  { left: "78%", top: "52%", size: 14, rot: -30, o: 0.45 },
  { left: "88%", top: "14%", size: 26, rot: 40, o: 0.55 },
  { left: "47%", top: "62%", size: 12, rot: 70, o: 0.35 },
  { left: "95%", top: "70%", size: 16, rot: -10, o: 0.5 },
];

export function Leaves({ season }: { season: SeasonKey }) {
  return (
    <span className="leaves" aria-hidden="true">
      {SPOTS.map((p, i) => (
        <svg key={i} viewBox="0 0 24 24" style={{ left: p.left, top: p.top, width: p.size, height: p.size, transform: `rotate(${p.rot}deg)`, opacity: p.o }}>
          <path d={SHAPES[season]} />
        </svg>
      ))}
    </span>
  );
}

/** The seasonal page header: 秋 + "Fall 2026 season", a line of context, and pills or controls on the right. */
export function SeasonHeader({ title, eyebrow, sub, right, children, compact = false }: { title?: ReactNode; eyebrow?: ReactNode; sub?: ReactNode; right?: ReactNode; children?: ReactNode; compact?: boolean }) {
  const s = seasonOf();
  const now = new Date();
  return (
    <header className={`season-hd${compact ? " compact" : ""}`}>
      <Leaves season={s.key} />
      <span className="kanji" aria-hidden="true">
        {s.kanji}
      </span>
      <div className="season-hd-text">
        <span className="eyebrow accent">{eyebrow ?? now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
        <h1 className="season-ttl">{title ?? t("season.title", { season: t(`season.${s.key}` as I18nKey), year: s.year })}</h1>
        {sub && <p className="muted season-sub">{sub}</p>}
        {children}
      </div>
      {right && <div className="season-right">{right}</div>}
    </header>
  );
}

/** A small rounded pill (header summaries). */
export function Pill({ children, onClick, tone }: { children: ReactNode; onClick?: () => void; tone?: "warn" | "bad" | "info" }) {
  return onClick ? (
    <button className={`pill${tone ? ` ${tone}` : ""}`} onClick={onClick}>
      {children}
    </button>
  ) : (
    <span className={`pill${tone ? ` ${tone}` : ""}`}>{children}</span>
  );
}
