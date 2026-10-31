import { useEffect, useRef, useState, type ReactNode } from "react";
import { FixDetection, Peek, Verdicts, WatchIn } from "./filetools";
import { CaptionsOff } from "lucide-react";
import { api, fmtSize, sxe } from "./api";
import { Link, navigate } from "./App";
import { t, type I18nKey } from "./i18n";
import { Chip, Confirm, dateTime, Spinner, SplitButton, thumbUrl, useLoad, useToast, Why, ReleaseName } from "./ui";
import { showVars } from "./season";
import { languageList, languageName } from "./lang";
import { kindLabel } from "./pages/Activity";

export type EpisodeStatus = "have" | "missing" | "downloading" | "unaired" | "attention";

export interface FileInfo { id: number; path: string; name: string; size: number | null; quality: string | null; source: string | null; platform: string | null; group: string | null; sceneName: string | null; subs: string[]; audio: string[]; runTime: string | null; resolution: string | null; episodes: string[]; codec?: string | null; scanned?: boolean; lang?: { state: "ok" | "no" | "unknown"; why: string; code?: string }; changed?: { fromSize: number | null; toSize: number; codec: string | null; importedAt: string | null; changedAt: number; fromQuality: string | null } | null }
export interface EpisodeRow {
  missingWhy?: string | null; id: number; season: number; episode: number; absolute: number | null; title: string | null; airUtc: number | null; runtime: number | null; monitored: boolean; status: EpisodeStatus; progress: number | null; file: FileInfo | null; movie?: { movieId: number | null; title: string } | null; special?: { type: string; cls: string } | null; stage?: string | null; ahead?: number | null }

const TONE: Record<EpisodeStatus, "good" | "bad" | "warn" | "info" | "accent"> = { have: "good", missing: "bad", downloading: "accent", unaired: "info", attention: "warn" };
const ICON: Record<EpisodeStatus, string> = { have: "✓", missing: "!", downloading: "↓", unaired: "◷", attention: "⚠" };

export const resLabel = (r: string | null) => {
  const h = r ? Number(r.split("x")[1]) : NaN;
  return Number.isFinite(h) ? (h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : `${h}p`) : null;
};

/** Status pill: colour AND a word (never colour-only). "Have · 1080p WEB · EN subs", "Downloading 45%", ... */
/** The file's language verdict from the server (the same in the header, season tags and dots). */
export function langOf(f: Pick<FileInfo, "subs" | "audio" | "lang"> | null | undefined, lang: string): "ok" | "no" | "unknown" {
  if (!f) return "unknown";
  void lang;
  return f.lang?.state ?? "unknown";
}

export function StatusPill({ e, lang = "en" }: { e: Pick<EpisodeRow, "status" | "progress" | "file"> & { stage?: string | null; ahead?: number | null }; lang?: string }) {
  let label: string = t(`ep.status.${e.status}`);
  if (e.status === "downloading" && e.stage === "importing") label = `⇢ ${t("ep.importing")}`;
  else if (e.status === "downloading" && e.stage === "waiting") label = `⇢ ${e.ahead ? t("ep.waitingImportAhead", { n: e.ahead }) : t("ep.waitingImport")}`;
  else if (e.status === "downloading" && e.progress !== null) label += ` ${Math.round(e.progress * 100)}%`;
  // Healthy rows are quiet (a dot and muted words); a colour chip is kept for what needs you.
  const ls = e.file ? langOf(e.file, lang) : "ok";
  if (e.status === "have" && ls === "ok") {
    const q = e.file ? [resLabel(e.file.resolution), e.file.source].filter(Boolean).join(" ") : "";
    return (
      <span className="quiet-status">
        <span className="dot good" aria-hidden="true" />
        <span className="sr-only">{t("ep.status.have")}</span>
        {q || <span aria-hidden="true">{t("ep.status.have")}</span>}
        {e.file && !e.file.subs.includes(lang) && e.file.audio.includes(lang) ? ` · ${t("ep.audioLang", { lang: lang.toUpperCase() })}` : ""}
      </span>
    );
  }
  if (e.status === "unaired") {
    return (
      <span className="quiet-status">
        <span aria-hidden="true">◷</span> {label}
      </span>
    );
  }
  if (e.status === "have" && e.file && ls === "unknown")
    return (
      <span className="tag neutral" title={e.file.lang?.why ?? t("ep.status.have")}>
        <span aria-hidden="true">?</span> {e.file.lang?.code === "untagged" ? t("ep.subsUnknownLang") : t("ep.langUnknownShort", { lang: lang.toUpperCase() })}
      </span>
    );
  if (e.status === "have" && e.file) {
    const code = e.file.lang?.code;
    const L = lang.toUpperCase();
    const audio = e.file.audio.filter((a) => a !== "und").map((a) => a.toUpperCase()).join("/");
    return (
      <span className="tag warn" title={e.file.lang?.why ?? t("ep.status.have")}>
        <CaptionsOff className="lucide" aria-hidden="true" />
        {code === "dub-no-subs" ? t("ep.dubNoSubs", { audio: audio || "?" }) : code === "no-dub" ? t("ep.noDubShort", { lang: L }) : code === "forced-only" ? t("ep.forcedOnly", { lang: L }) : code === "dub-only" ? t("ep.dubOnlyShort") : t("ep.noSubsShort", { lang: L })}
      </span>
    );
  }
  return (
    <Chip tone={TONE[e.status]}>
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
export function ShowLink({ tvdbId, title, children, className = "", to }: { tvdbId: number | null; title: string; children: ReactNode; className?: string; to?: string }) {
  return (
    <Link to={to ?? `/show/${tvdbId}`} className={`card-link ${className}`}>
      {children}
      <span className="chevron" aria-hidden="true">
        ›
      </span>
      <span className="sr-only">{t("common.open2", { title })}</span>
    </Link>
  );
}

// ---------------------------------------------------------------- episode actions (shared by sheet, rows and bulk bar)

/** Opens the interactive (🔍) list for these episodes; when the search page is already open it runs there. */
export function openInteractive(tvdbId: number, ids: number[]) {
  navigate(`/search?tvdbId=${tvdbId}&eps=${ids.join(",")}`);
  window.dispatchEvent(new CustomEvent("animearr:interactive", { detail: { tvdbId, ids } }));
}

interface ActionProps { tvdbId: number; episodes: { id: number; label: string; release?: string | null; file?: string | null; fileEpisodes?: string[] }[]; managedLive: boolean; dryRun: boolean; onDone: () => void }

export function useEpisodeActions({ tvdbId, episodes, managedLive, dryRun, onDone }: ActionProps) {
  const toast = useToast();
  const [dialog, setDialog] = useState<"regrab" | "delete" | "searchAgain" | "autoMany" | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const interactive = () => openInteractive(tvdbId, ids);
  /** ⚡ Automatic search: grabs the best release, or says it needs a look (then 🔍 is one tap away). */
  const runAuto = async () => {
    setAutoBusy(true);
    try {
      const r = await api<{ results: { episodeIds: number[]; label: string; outcome: string; release?: string; why: string }[] }>("/autosearch", { body: { tvdbId, episodeIds: ids } });
      const look = r.results.filter((x) => x.outcome === "needs-look");
      const got = r.results.filter((x) => x.outcome === "grabbed" || x.outcome === "would-grab");
      const msg =
        r.results.length === 1
          ? `${r.results[0].label}: ${t(`auto.${r.results[0].outcome}` as I18nKey)}${r.results[0].release ? ` · ${r.results[0].release}` : ""} · ${r.results[0].why}`
          : t("auto.summary", { got: got.length, look: look.length, other: r.results.length - got.length - look.length });
      toast(msg, r.results.every((x) => x.outcome === "failed"), look.length ? { label: t("auto.openList"), run: () => openInteractive(tvdbId, look.flatMap((x) => x.episodeIds)) } : undefined, { kind: got.length ? "grab" : "success" });
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setAutoBusy(false);
    }
  };
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
      {dialog === "autoMany" && (
        <Confirm
          title={t("auto.manyTitle", { n: episodes.length })}
          confirmLabel={t("auto.button")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            await runAuto();
          }}
        >
          <p>{t("auto.manyBody")}</p>
          {dryRun && <p className="warn-text">{t("ep.regrabDry")}</p>}
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
    search: interactive,
    auto: () => (episodes.length > 26 ? toast(t("auto.tooMany"), true) : episodes.length > 1 ? setDialog("autoMany") : void runAuto()),
    autoBusy,
    regrab: () => setDialog("regrab"),
    remove: () => setDialog("delete"),
  };
}

// ---------------------------------------------------------------- the episode sheet (bottom sheet on phones, side panel on desktop)

const langName = (l: string | null) => (l ? languageName(l) : null);
const kindWord = (k: string) => kindLabel(k);
/**
 * Sonarr's quality label ("HDTV-1080p", also in the file name) against the source the release name says ("WEB"):
 * Sonarr sometimes guesses HDTV for a web release. The release name is the better witness; the label is noted.
 */
const sourceDiffers = (quality: string, source: string | null) => {
  if (!source) return false;
  const q = /hdtv|television/i.test(quality) ? "hdtv" : /web/i.test(quality) ? "web" : /blu/i.test(quality) ? "bluray" : /dvd/i.test(quality) ? "dvd" : null;
  return !!q && q !== source.toLowerCase().replace("-", "");
};
/** "[SubsPlease] Show - 01 (1080p)" → "SubsPlease"; "Show.S01E01.1080p.WEB-ToonsHub" → "ToonsHub". */
const groupOf = (release: string | null | undefined) => (release ? (/^\[([^\]]+)\]/.exec(release)?.[1] ?? /-([A-Za-z0-9]+)(?:\.\w{2,4})?$/.exec(release)?.[1] ?? null) : null);
/** "ToonsHub · WEB · 1080p" from a release name (the name itself is a detail). */
function releaseBits(release: string) {
  const res = /\b(2160|1080|720|480)p\b/i.exec(release)?.[1];
  const src = /\b(BD|Blu-?Ray|BDRip)\b/i.test(release) ? "Blu-ray" : /\bWEB(-?DL|Rip)?\b/i.test(release) ? "WEB" : /\bHDTV\b/i.test(release) ? "TV" : null;
  return [groupOf(release), src, res ? `${res}p` : null].filter(Boolean).join(" · ");
}
/**
 * The Subtitles fact in words, agreeing with the status badge: "English (full)", "English (signs only)", "None",
 * "No English (has Indonesian, Thai)", plus the other languages.
 */
function SubsLine({ d, lang }: { d: Detail; lang: string }) {
  const [open, setOpen] = useState(false);
  const L = languageName(lang);
  const code = d.file?.lang?.code;
  const own = d.own?.subs ?? [];
  const side = d.own?.sidecars ?? [];
  const tracks = own.length || side.length;
  const all = tracks ? [...own.map((x) => x.lang), ...side.map((x) => x.lang)] : (d.file?.subs ?? []);
  // Japanese first (the original), then the rest. A streaming release can carry 25+ languages: show two and a
  // "+N more" that opens the full list in place.
  const others = [...new Set(all.filter((x): x is string => !!x && x !== lang && x !== "und"))].sort((a, b) => Number(b === "ja") - Number(a === "ja"));
  const long = others.length > 3;
  const list = (
    <>
      {languageList(long && !open ? others.slice(0, 2) : others)}
      {long && (
        <>
          {" "}
          <button type="button" className="link small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("ep.subsLess") : t("ep.subsMore", { n: others.length - 2 })}
          </button>
        </>
      )}
    </>
  );
  const also = others.length ? (
    <>
      {" · "}
      {t("ep.subsAlso", { langs: "" })}
      {list}
    </>
  ) : null;
  if (code === "forced-only") return <>{t("ep.subsSigns", { lang: L })}{also}</>;
  if (code === "untagged") return <>{t("ep.subsUnlabelled")}</>;
  const full = tracks ? own.some((x) => x.lang === lang && !x.partial) || side.some((x) => x.lang === lang) : (d.file?.subs ?? []).includes(lang);
  if (full) return <>{t("ep.subsFull", { lang: L })}{also}</>;
  if (!all.length) return <>{t("ep.subsNone")}</>;
  // "No English (has Indonesian, Thai +12 more)": the list goes where {langs} sits.
  const [pre, post = ""] = t("ep.subsNoTarget", { lang: L, langs: "\u0000" }).split("\u0000");
  return <>{pre}{list}{post}</>;
}
/** "English", "Japanese + English", "1 track, language unknown". */
function trackAudio(d: Detail) {
  const a = d.own?.audio ?? [];
  if (!a.length) return d.file?.audio.map((x) => langName(x)).join(" + ") || t("ep.tracksNone");
  const known = a.filter((x) => x.lang && x.lang !== "und").map((x) => langName(x.lang));
  const unknown = a.length - known.length;
  return [...known, ...(unknown ? [t("ep.tracksUnknown", { n: unknown })] : [])].join(" + ");
}
/** "none", "English (signs only)", "1 track, language unknown (ASS)". */
function trackSubs(d: Detail) {
  const s = d.own?.subs ?? [];
  const side = d.own?.sidecars ?? [];
  if (!s.length && !side.length) return d.file?.subs.length ? d.file.subs.map((x) => langName(x)).join(", ") : t("ep.tracksNone");
  const parts = s.map((x) => (x.lang ? `${langName(x.lang)}${x.partial ? ` (${t("ep.signsOnly")})` : ""}` : `${t("ep.tracksUnknown", { n: 1 })} (${(x.codec ?? "?").toUpperCase()})`));
  for (const x of side) parts.push(`${x.lang ? langName(x.lang) : t("ep.tracksUnknown", { n: 1 })} (${t("ep.sidecar")})`);
  return parts.join(", ");
}

interface Detail extends EpisodeRow {
  art?: { cover: string | null; banner: string | null; color: string | null };
  own?: { audio: { index: number; codec: string | null; lang: string | null; title: string | null; default: boolean; channels: number | null }[]; subs: { index: number; codec: string | null; lang: string | null; title: string | null; default: boolean; partial: boolean }[]; sidecars: { file: string; lang: string | null }[] } | null;
  tvdbId: number;
  seriesTitle: string;
  grabs: { id: number; at: number; release: string; protocol: string; state: string; dry_run: number; why: string; error: string | null; progress: number | null }[];
  activity: { id: number; at: number; kind: string; why: string; summary?: string | null; resolved?: boolean }[];
  verify: { at: number; ok: boolean; why: string } | null;
  currentRelease: string | null;
}

export function EpisodeSheet({ episodeId, onClose, onChanged, managedLive = false, dryRun = true, lang = "en", focus }: { episodeId: number; onClose: () => void; onChanged?: () => void; managedLive?: boolean; dryRun?: boolean; lang?: string; focus?: "fix" }) {
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
  // The release group: the file's own, else the release it came from (never "—" next to a grab history that names it).
  const group = d?.file ? (d.file.group ?? groupOf(d.currentRelease) ?? groupOf(d.grabs.find((g) => g.state === "done")?.release)) : null;
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
      <div className="sheet card" role="dialog" aria-modal="true" aria-label={t("ep.details")} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sh-hero" style={showVars(d?.art?.color)}>
          {(d?.art?.banner || d?.art?.cover) && <span className="sh-art" style={{ backgroundImage: `url(${thumbUrl((d.art.banner ?? d.art.cover)!, d.art.banner ? "xl" : "md")})` }} aria-hidden="true" />}
          <div className="sheet-grip" aria-hidden="true" />
          <button className="icon sh-close" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
          <div className="sh-title">
            <span className="eyebrow show-eyebrow">
              {/* The show name opens the series (and closes the sheet, which may sit on that very page). */}
              {d && (
                <span onClick={onClose}>
                  <Link to={`/show/${d.tvdbId}`} className="sh-series">
                    {d.seriesTitle}
                  </Link>
                </span>
              )}
              {d ? " · " + [d.season === 0 ? t("series.specials") : t("common.season", { n: d.season }), t("ep.episodeN", { n: d.episode }), d.airUtc ? new Date(d.airUtc).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null].filter(Boolean).join(" · ") : ""}
            </span>
            <h2>{d ? (d.title ?? label) : ""}</h2>
          </div>
        </div>
        {err && <p className="error">{err}</p>}
        {!d && !err && <Spinner label={t("app.loading")} />}
        {d && (
          <div className="stack">
            <div className="row">
              <StatusPill e={d} lang={lang} />
              <span className="muted small">
                {/* A file before the listed date: streaming sites often release a week before the TV broadcast that TVDB lists. */}
                {d.airUtc && d.airUtc > Date.now() ? (d.file ? t("ep.outEarly", { when: dateTime(d.airUtc) }) : `${t("ep.airs")} ${dateTime(d.airUtc)}`) : `${t("ep.aired")} ${d.airUtc ? dateTime(d.airUtc) : "—"}`}
              </span>
            </div>
            {d.movie && (
              <p className="banner info">
                🎬 {t("ep.isMovie", { title: d.movie.title })} {d.movie.movieId ? <Link to={`/movie/${d.movie.movieId}`}>{t("ep.openMovie")} →</Link> : t("ep.addInRadarr")}
              </p>
            )}
            {!d.movie && (
            <div className="row sheet-actions">
              {!d.file ? (
                <SplitButton
                  up
                  label={`⚡ ${actions.autoBusy ? t("common.working") : t("auto.find")}`}
                  onClick={actions.auto}
                  disabled={actions.autoBusy}
                  items={[
                    { label: t("auto.chooseRelease"), onSelect: actions.search },
                    { label: t("ep.regrab"), onSelect: actions.regrab, hidden: d.status === "unaired" },
                  ]}
                />
              ) : (
                <SplitButton
                  up
                  primary={false}
                  label={t("auto.chooseRelease")}
                  onClick={actions.search}
                  items={[
                    { label: t("ep.regrab"), onSelect: actions.regrab },
                    { label: t("ep.delete"), onSelect: actions.remove, danger: true },
                  ]}
                />
              )}
            </div>
            )}
            {d.file ? (
              <dl className="facts">
                {/* The friendly facts first; the file path, codecs, tracks and release names are under Technical details. */}
                <div>
                  <dt>{t("ep.size")}</dt>
                  <dd>{d.file.size ? fmtSize(d.file.size) : "—"}</dd>
                </div>
                <div>
                  <dt>{t("ep.audio")}</dt>
                  <dd>{trackAudio(d)}</dd>
                </div>
                <div>
                  <dt>{t("ep.subtitles")}</dt>
                  <dd><SubsLine d={d} lang={lang} /></dd>
                </div>
                <div>
                  <dt>{t("ep.runtime")}</dt>
                  <dd>{d.file.runTime ?? (d.runtime ? t("ep.minutes", { n: d.runtime }) : "—")}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">{t("ep.noFile")}</p>
            )}
            {d.file && (
              <div className="file-tools stack">
                <div className="row">
                  <WatchIn path={d.file.path} title={d.seriesTitle} kind="episode" />
                  <Peek path={d.file.path} />
                </div>
                {d.file.lang && ((d.file.lang.state === "no" && ["no-subs", "wrong-subs", "forced-only"].includes(d.file.lang.code ?? "")) || d.file.lang.code === "untagged") && <Verdicts tvdbId={d.tvdbId} season={d.season} lang={lang} onFind={actions.search} onDone={() => (load(), onChanged?.())} />}
                <FixDetection
                  path={d.file.path}
                  tvdbId={d.tvdbId}
                  season={d.season}
                  group={group}
                  title={d.seriesTitle}
                  defaultOpen={focus === "fix" || d.file.lang?.code === "untagged" || d.file.lang?.code === "forced-only"}
                  focus={focus === "fix"}
                  onChanged={() => (load(), onChanged?.())}
                />
              </div>
            )}
            {!!d.grabs.length && (
              <>
                <h3>{t("ep.history")}</h3>
                <ul className="plain">
                  {d.grabs.map((g) => (
                    <li key={g.id} className="history-row">
                      <div className="row between">
                        <Chip tone={g.state === "done" ? "good" : g.state === "failed" ? "bad" : g.state === "needs-attention" ? "warn" : "info"}>{t(`grab.${g.state}` as I18nKey) || g.state}</Chip>
                        <span className="muted small">{dateTime(g.at)}</span>
                      </div>
                      <p className="small muted">{releaseBits(g.release) || t("ep.aVersion")}</p>
                      <Why summary={t("activity.detailsShort")} lines={[g.release, g.why, ...(g.error ? [g.error] : [])]} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(d.file || d.verify || !!d.activity.length) && (
            <details className="tech-details">
              <summary>{t("ep.technical")}</summary>
              <div className="stack">
                {d.file && (
                  <dl className="facts">
                    <div className="wide">
                      <dt>{t("ep.file")}</dt>
                      <dd className="mono small">{d.file.path}</dd>
                    </div>
                    <div>
                      <dt>{t("ep.source")}</dt>
                      <dd>
                        {[resLabel(d.file.resolution), d.file.source].filter(Boolean).join(" ") || "—"}
                        {/* Sonarr's quality label only when it disagrees with the file itself. */}
                        {d.file.quality && ((resLabel(d.file.resolution) && !d.file.quality.includes(String(resLabel(d.file.resolution)).replace(/p$/, ""))) || sourceDiffers(d.file.quality, d.file.source)) && <span className="warn-text small"> {t("ep.sonarrLabel", { label: d.file.quality })}</span>}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("ep.codec")}</dt>
                      <dd>{d.file.codec ? d.file.codec.toUpperCase() : "—"}</dd>
                    </div>
                    <div>
                      <dt>{t("ep.group")}</dt>
                      <dd>
                        {group ?? "—"}
                        {d.file.platform ? ` · ${d.file.platform}` : ""}
                      </dd>
                    </div>
                    {d.file.changed && (
                      <div className="wide">
                        <dt>{t("ep.changed")}</dt>
                        <dd>
                          {t("ep.lineage", {
                            source: [d.file.changed.fromQuality, group, d.file.changed.fromSize ? fmtSize(d.file.changed.fromSize) : null].filter(Boolean).join(" · "),
                            imported: d.file.changed.importedAt ? new Date(d.file.changed.importedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "?",
                            now: [(d.file.changed.codec ?? "").toUpperCase(), fmtSize(d.file.changed.toSize)].filter(Boolean).join(" · "),
                            changed: new Date(d.file.changed.changedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                          })}
                        </dd>
                      </div>
                    )}
                    {d.currentRelease && (
                      <div className="wide">
                        <dt>{t("ep.release")}</dt>
                        <dd className="small">
                          <ReleaseName name={d.currentRelease} />
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                {d.file?.lang && d.file.lang.state !== "ok" && <p className="muted small">{d.file.lang.why}</p>}
                {d.own && (
                  <>
                    <h4 className="small">{t("files.ownTracks")}</h4>
                    <ul className="plain small">
                      {d.own.audio.map((a) => (
                        <li key={`a${a.index}`}>
                          🔊 {a.lang ? languageName(a.lang) : t("fix.untagged")} <span className="muted">· {[a.codec?.toUpperCase(), a.channels ? `${a.channels}ch` : null, a.title, a.default ? t("files.default") : null].filter(Boolean).join(" · ")}</span>
                        </li>
                      ))}
                      {d.own.subs.map((x) => (
                        <li key={`s${x.index}`} className={x.partial ? "warn-text" : undefined}>
                          💬 {x.lang ? languageName(x.lang) : t("fix.untagged")}
                          {x.partial ? ` (${t("ep.signsOnly")})` : ""} <span className="muted">· {[x.codec?.toUpperCase(), x.title, x.default ? t("files.default") : null].filter(Boolean).join(" · ")}</span>
                        </li>
                      ))}
                      {d.own.sidecars.map((x) => (
                        <li key={x.file}>
                          📄 {x.lang ? languageName(x.lang) : t("fix.untagged")} <span className="muted mono">· {x.file}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {d.verify && (
                  <p className={d.verify.ok ? "good-text small" : "warn-text small"}>
                    {d.verify.ok ? "✓" : "✕"} {t("ep.verified")}: {d.verify.why}
                  </p>
                )}
                {!!d.activity.length && (
                  <>
                    <h4 className="small">{t("ep.activity")}</h4>
                    <ul className="plain">
                      {d.activity.map((a) => (
                        <li key={a.id} className="small">
                          <span className="muted">{dateTime(a.at)}</span> · <strong>{kindWord(a.kind)}</strong> {a.summary ?? a.why}
                          {a.resolved ? <span className="muted"> · {t("activity.resolved")}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </details>
            )}
            <div className="row">
              <span onClick={onClose}>
                <Link to={`/show/${d.tvdbId}`} className="small">
                  {t("ep.openSeries")} →
                </Link>
              </span>
              <Link to={`/activity`} className="small">
                {t("nav.activity")} →
              </Link>
            </div>
          </div>
        )}
        {actions.ui}
      </div>
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
