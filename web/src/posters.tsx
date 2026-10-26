import { Check, Clock, Star, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { showVars } from "./season";
import { t } from "./i18n";
import { thumbUrl } from "./ui";

export type PosterStatus = "have" | "missing" | "downloading" | "unaired" | "attention" | null;

/** The status ring in a poster's corner: ✓ have, ! missing, progress % downloading, clock upcoming. Shape + words, not colour alone. */
export function StatusRing({ status, progress }: { status: PosterStatus; progress?: number | null }) {
  if (!status) return null;
  const label = t(`ep.status.${status}`);
  if (status === "downloading")
    return (
      <span className="st dl" style={{ "--p": Math.round((progress ?? 0) * 100) } as React.CSSProperties} title={label}>
        <span>{Math.round((progress ?? 0) * 100)}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  return (
    <span className={`st ${status}`} title={label}>
      {status === "have" ? <Check className="lucide" aria-hidden="true" /> : status === "missing" ? <b aria-hidden="true">!</b> : status === "attention" ? <TriangleAlert className="lucide" aria-hidden="true" /> : <Clock className="lucide" aria-hidden="true" />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A 2:3 poster with the title over a bottom gradient, a status ring, a ★ for managed shows, and a lift on hover. */
export function PosterCard({ title, cover, color, status, progress, managed, onClick, href, meta, width, className = "" }: { title: string; cover: string | null; color?: string | null; status?: PosterStatus; progress?: number | null; managed?: boolean; onClick?: () => void; href?: string; meta?: ReactNode; width?: number; className?: string }) {
  const inner = (
    <>
      <span className="pimg">
        {cover ? <img src={thumbUrl(cover, "md")} alt="" loading="lazy" decoding="async" width={200} height={300} /> : <span className="noimg">{title.slice(0, 1)}</span>}
        {managed && (
          <span className="star" title={t("chip.managed")}>
            <Star className="lucide" aria-hidden="true" />
          </span>
        )}
        <span className="stw">
          <StatusRing status={status ?? null} progress={progress} />
        </span>
        <span className="ov">{title}</span>
      </span>
      {meta && <span className="pmeta">{meta}</span>}
    </>
  );
  const style = { ...showVars(color), ...(width ? { "--pw": `${width}px` } : {}) } as React.CSSProperties;
  if (href)
    return (
      <a className={`pcard ${className}`} href={href} style={style} onClick={(e) => (e.preventDefault(), onClick?.())} aria-label={title}>
        {inner}
      </a>
    );
  return (
    <button type="button" className={`pcard ${className}`} style={style} onClick={onClick} aria-label={title}>
      {inner}
    </button>
  );
}

/** A circular progress ring (series completeness, downloads). */
export function Ring({ value, size = 52, label, children }: { value: number; size?: number; label: string; children?: ReactNode }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-bg" />
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} />
      </svg>
      <b>{children ?? `${Math.round(value * 100)}%`}</b>
    </span>
  );
}
