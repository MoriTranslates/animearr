import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmtSize, sxe } from "./api";
import { Link, navigate } from "./App";
import { t, type I18nKey } from "./i18n";
import { Chip, Confirm, dateTime, Spinner, useLoad, useToast, Why } from "./ui";

export type EpisodeStatus = "have" | "missing" | "downloading" | "unaired" | "attention";

export interface FileInfo { id: number; path: string; name: string; size: number | null; quality: string | null; source: string | null; platform: string | null; group: string | null; sceneName: string | null; subs: string[]; audio: string[]; runTime: string | null; resolution: string | null; episodes: string[] }
export interface EpisodeRow { id: number; season: number; episode: number; absolute: number | null; title: string | null; airUtc: number | null; runtime: number | null; monitored: boolean; status: EpisodeStatus; progress: number | null; file: FileInfo | null }

const TONE: Record<EpisodeStatus, "good" | "bad" | "warn" | "info" | "accent"> = { have: "good", missing: "bad", downloading: "accent", unaired: "info", attention: "warn" };
const ICON: Record<EpisodeStatus, string> = { have: "✓", missing: "!", downloading: "↓", unaired: "◷", attention: "⚠" };

const resLabel = (r: string | null) => {
  const h = r ? Number(r.split("x")[1]) : NaN;
  return Number.isFinite(h) ? (h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : `${h}p`) : null;
};

/** Status pill: colour AND a word (never colour-only). "Have · 1080p WEB · EN subs", "Downloading 45%", ... */
export function StatusPill({ e, lang = "en" }: { e: Pick<EpisodeRow, "status" | "progress" | "file">; lang?: string }) {
  let label: string = t(`ep.status.${e.status}`);
  if (e.status === "downloading" && e.progress !== null) label += ` ${Math.round(e.progress * 100)}%`;
  if (e.status === "have" && e.file) {
    const parts = [[resLabel(e.file.resolution), e.file.source].filter(Boolean).join(" "), e.file.subs.includes(lang) ? t("ep.subs", { lang: lang.toUpperCase() }) : e.file.audio.includes(lang) ? t("ep.audioLang", { lang: lang.toUpperCase() }) : t("ep.noSubs", { lang: lang.toUpperCase() })].filter(Boolean);
    label = [label, ...parts].join(" · ");
  }
  return (
    <Chip tone={e.status === "have" && e.file && !e.file.subs.includes(lang) && !e.file.audio.includes(lang) ? "warn" : TONE[e.status]}>
      <span aria-hidden="true">{ICON[e.status]} </span>
      {label}
    </Chip>
  );
}

/** "Today 9:30 PM", "Tomorrow", "in 3 days", "Oct 18" (local time). */
export function airLabel(ms: number | null) {
  if (!ms) return "—";
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `${t("cal.today")} ${time}`;
  if (diff === 1) return `${t("cal.tomorrow")} ${time}`;
  if (diff === -1) return `${t("cal.yesterday")} ${time}`;
  if (diff > 1 && diff < 7) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diff, "day");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/** Whole-card link for a show (poster + title + chevron). Inner controls belong outside it. */
export function ShowLink({ tvdbId, title, children, className = "" }: { tvdbId: number; title: string; children: ReactNode; className?: string }) {
  return (
    <Link to={`/show/${tvdbId}`} className={`card-link ${className}`}>
      {children}
      <span className="chevron" aria-hidden="true">
        ›
      </span>
      <span className="sr-only">{t("common.open2", { title })}</span>
    </Link>
  );
}

// ---------------------------------------------------------------- episode actions (shared by sheet, rows and bulk bar)

interface ActionProps { tvdbId: number; episodes: { id: number; label: string; release?: string | null; file?: string | null; fileEpisodes?: string[] }[]; managedLive: boolean; dryRun: boolean; onDone: () => void }

export function useEpisodeActions({ tvdbId, episodes, managedLive, dryRun, onDone }: ActionProps) {
  const toast = useToast();
  const [dialog, setDialog] = useState<"regrab" | "delete" | "searchAgain" | null>(null);
  // The episodes a delete actually emptied (kept here: the caller clears its selection right after).
  const [afterIds, setAfterIds] = useState<number[]>([]);
  const ids = episodes.map((e) => e.id);
  const files = [...new Map(episodes.filter((e) => e.file).map((e) => [e.file!, e.fileEpisodes ?? [e.label]])).entries()];
  const one = episodes.length === 1 ? episodes[0] : null;
  const ui = (
    <>
      {dialog === "regrab" && (
        <Confirm
          title={t("ep.regrabTitle", { label: one ? one.label : t("ep.selected", { n: episodes.length }) })}
          confirmLabel={t("ep.regrab")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ results: { outcome: string }[] }>("/episodes/regrab", { body: { tvdbId, episodeIds: ids, confirm: true } });
              toast(r.results.map((x) => x.outcome).join(" · "));
              setDialog(null);
              onDone();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{one?.release ? t("ep.regrabBody", { release: one.release }) : one?.file ? t("ep.regrabUnknown") : t("ep.regrabBodyNoFile")}</p>
          {dryRun && <p className="warn-text">{t("ep.regrabDry")}</p>}
        </Confirm>
      )}
      {dialog === "delete" && (
        <Confirm
          danger
          title={t("ep.deleteTitle")}
          confirmLabel={t("ep.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ deleted: unknown[]; skipped: { why: string }[]; affected: number[]; askSearch: boolean }>("/episodes/delete", { body: { tvdbId, episodeIds: ids, confirm: true } });
              toast(t("ep.deleted", { n: r.deleted.length }) + (r.skipped.length ? ` · ${r.skipped.map((x) => x.why).join("; ")}` : ""), r.deleted.length === 0);
              setAfterIds(r.affected);
              setDialog(r.askSearch ? "searchAgain" : null);
              onDone();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{files.length === 1 ? t("ep.deleteBody", { file: files[0][0] }) : t("ep.deleteMany", { n: files.length })}</p>
          <RecycleNote />
          <ul className="plain small">
            {files.map(([file, eps]) => (
              <li key={file}>
                <span className="mono">{file}</span>
                {eps.length > 1 && <span className="warn-text"> · {t("ep.multiFile", { eps: eps.join(" + ") })}</span>}
              </li>
            ))}
          </ul>
        </Confirm>
      )}
      {dialog === "searchAgain" && managedLive && (
        <Confirm
          title={t("ep.searchAgainTitle")}
          confirmLabel={t("ep.search")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api("/episodes/search-soon", { body: { tvdbId, episodeIds: afterIds.length ? afterIds : ids } });
              toast(t("ep.queued"));
              setDialog(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("ep.searchAgainBody")}</p>
        </Confirm>
      )}
    </>
  );
  return {
    ui,
    open: dialog !== null,
    search: () => navigate(`/search?tvdbId=${tvdbId}&eps=${ids.join(",")}`),
    regrab: () => setDialog("regrab"),
    remove: () => setDialog("delete"),
  };
}

// ---------------------------------------------------------------- the episode sheet (bottom sheet on phones, side panel on desktop)

interface Detail extends EpisodeRow {
  tvdbId: number;
  seriesTitle: string;
  grabs: { id: number; at: number; release: string; protocol: string; state: string; dry_run: number; why: string; error: string | null; progress: number | null }[];
  activity: { id: number; at: number; kind: string; why: string }[];
  verify: { at: number; ok: boolean; why: string } | null;
  currentRelease: string | null;
}

export function EpisodeSheet({ episodeId, onClose, onChanged, managedLive = false, dryRun = true, lang = "en" }: { episodeId: number; onClose: () => void; onChanged?: () => void; managedLive?: boolean; dryRun?: boolean; lang?: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const dialogOpen = useRef(false);
  const load = () =>
    void api<Detail>(`/episodes/${episodeId}`)
      .then((x) => (setD(x), setErr(null)))
      .catch((e) => setErr((e as Error).message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [episodeId]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen.current) return; // the confirm dialog handles its own Escape/Tab
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], summary, input")];
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => (window.removeEventListener("keydown", onKey), prev?.focus());
  }, []);
  // While this episode downloads (and loads fine), refresh every few seconds.
  useEffect(() => {
    if (d?.status !== "downloading" || err) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.status, err]);
  const label = d ? sxe(d.season, d.episode) : "";
  const actions = useEpisodeActions({
    tvdbId: d?.tvdbId ?? 0,
    episodes: d ? [{ id: d.id, label, release: d.currentRelease, file: d.file?.name ?? null, fileEpisodes: d.file?.episodes }] : [],
    managedLive,
    dryRun,
    onDone: () => (load(), onChanged?.()),
  });
  dialogOpen.current = actions.open;
  return (
    <div className="sheet-back" onClick={onClose}>
      <aside className="sheet card" role="dialog" aria-modal="true" aria-label={t("ep.details")} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="card-head">
          <div>
            <p className="muted small">{d?.seriesTitle}</p>
            <h2>
              {label} {d?.title && <span className="muted">· {d.title}</span>}
            </h2>
          </div>
          <button className="icon" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {err && <p className="error">{err}</p>}
        {!d && !err && <Spinner label={t("app.loading")} />}
        {d && (
          <div className="stack">
            <div className="row">
              <StatusPill e={d} lang={lang} />
              <span className="muted small">
                {d.airUtc && d.airUtc > Date.now() ? t("ep.airs") : t("ep.aired")} {d.airUtc ? dateTime(d.airUtc) : "—"}
              </span>
            </div>
            <div className="row sheet-actions">
              <button className="primary" onClick={actions.search}>
                ⌕ {t("ep.search")}
              </button>
              {(d.file || d.status !== "unaired") && <button onClick={actions.regrab}>↻ {t("ep.regrab")}</button>}
              {d.file && (
                <button className="danger" onClick={actions.remove}>
                  🗑 {t("ep.delete")}
                </button>
              )}
            </div>
            {d.file ? (
              <dl className="facts">
                <div className="wide">
                  <dt>{t("ep.file")}</dt>
                  <dd className="mono small">{d.file.path}</dd>
                </div>
                <div>
                  <dt>{t("ep.size")}</dt>
                  <dd>{d.file.size ? fmtSize(d.file.size) : "—"}</dd>
                </div>
                <div>
                  <dt>{t("ep.quality")}</dt>
                  <dd>
                    {[resLabel(d.file.resolution), d.file.source].filter(Boolean).join(" ") || "—"} <span className="muted small">{t("ep.sonarrLabel", { label: d.file.quality ?? "?" })}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t("ep.group")}</dt>
                  <dd>{d.file.group ?? "—"}{d.file.platform ? ` · ${d.file.platform}` : ""}</dd>
                </div>
                <div>
                  <dt>{t("ep.subtitles")}</dt>
                  <dd>{d.file.subs.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>{t("ep.audio")}</dt>
                  <dd>{d.file.audio.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>{t("ep.runtime")}</dt>
                  <dd>{d.file.runTime ?? (d.runtime ? t("ep.minutes", { n: d.runtime }) : "—")}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">{t("ep.noFile")}</p>
            )}
            {d.verify && (
              <p className={d.verify.ok ? "good-text small" : "warn-text small"}>
                {d.verify.ok ? "✓" : "✕"} {t("ep.verified")}: {d.verify.why}
              </p>
            )}
            <h3>{t("ep.history")}</h3>
            {!d.grabs.length && <p className="muted small">{t("ep.noHistory")}</p>}
            <ul className="plain">
              {d.grabs.map((g) => (
                <li key={g.id} className="history-row">
                  <div className="row between">
                    <Chip tone={g.state === "done" ? "good" : g.state === "failed" ? "bad" : g.state === "needs-attention" ? "warn" : "info"}>{t(`grab.${g.state}` as I18nKey) || g.state}</Chip>
                    <span className="muted small">{dateTime(g.at)}</span>
                  </div>
                  <p className="mono small">{g.release}</p>
                  <Why lines={[g.why, ...(g.error ? [g.error] : [])]} />
                </li>
              ))}
            </ul>
            <h3>{t("ep.activity")}</h3>
            <ul className="plain">
              {d.activity.map((a) => (
                <li key={a.id} className="small">
                  <span className="muted">{dateTime(a.at)}</span> · <Chip>{a.kind}</Chip> {a.why}
                </li>
              ))}
            </ul>
            <Link to={`/activity`} className="small">
              {t("nav.activity")} →
            </Link>
          </div>
        )}
        {actions.ui}
      </aside>
    </div>
  );
}

/** Where a deleted file goes: Sonarr's recycle bin (and for how long), or nowhere. */
function RecycleNote() {
  const r = useLoad(() => api<{ configured: boolean; path: string; cleanupDays: number; error?: string }>("/recycle/setting"), []);
  if (!r.data || r.data.error) return <p className="small muted">{t("recycle.maybe")}</p>;
  return r.data.configured ? (
    <p className="small">{r.data.cleanupDays ? t("recycle.goesTo", { path: r.data.path, days: r.data.cleanupDays }) : t("recycle.goesToForever", { path: r.data.path })}</p>
  ) : (
    <p className="small warn-text">⚠ {t("recycle.none")}</p>
  );
}
