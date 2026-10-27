import { useEffect, useMemo, useState } from "react";
import { FixDetection, Peek, WatchIn } from "../filetools";
import { LibraryHead } from "./Shows";
import { RemoveNative } from "./Add";
import { api, fmtSize, type SearchResult } from "../api";
import { Link , navigate } from "../App";
import { t } from "../i18n";
import { Chip, Confirm, Cover, dateTime, Empty, ErrorBox, FlagChips, Menu, Modal, Skeleton, Spinner, SplitButton, thumbUrl, useLoad, usePageTitle, useToast, Why } from "../ui";
import { PosterCard } from "../posters";
import { ResultCard } from "./Search";
import { WatchAs, type WatchMode } from "../profiles";

interface MovieItem { id: number; tmdbId: number | null; title: string; year: number | null; cover: string | null; monitored: boolean; status: "have" | "missing" | "downloading" | "attention" | "unreleased"; releaseAt: number | null; allowed: boolean; verdict: { ok: boolean | null; why: string } | null; quality: string | null }

type Filter = "all" | "missing" | "problems";
/** Radarr's release dates are date-only (UTC midnight). */
const dateOnly = (ms: number) => new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
const STATUS_TONE = { have: "good", missing: "warn", downloading: "accent", attention: "warn", unreleased: "info" } as const;

/** Anime movies from Radarr, Sonarr-style poster grid. */
export function Movies() {
  usePageTitle(t("movies.title"));
  const d = useLoad(() => api<MovieItem[]>("/movies"), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const toast = useToast();
  const setWanted = async (ids: number[], wanted: boolean) => {
    try {
      await api("/movies/wanted", { body: { movieIds: ids, wanted } });
      toast(t(wanted ? "movies.nowWanted" : "movies.nowNotWanted", { n: ids.length }));
      setSel(new Set());
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (d.data ?? []).filter((m) => (filter === "all" || (filter === "missing" && m.status === "missing") || (filter === "problems" && m.verdict?.ok === false)) && (!ql || m.title.toLowerCase().includes(ql)));
  }, [d.data, filter, q]);
  return (
    <section>
      <LibraryHead current="movies" />
      <p className="muted">{t("movies.intro")}</p>
      <div className="filters card pad">
        <div className="chips pickable" role="group" aria-label={t("common.filter")}>
          {(["all", "missing", "problems"] as Filter[]).map((f) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(`movies.filter.${f}`)}
            </button>
          ))}
        </div>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("movies.searchPlaceholder")} aria-label={t("movies.searchPlaceholder")} />
      </div>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {d.loading && !d.data && <Skeleton kind="posters" />}
      {d.data && !d.data.length && <Empty>{t("movies.none")}</Empty>}
      {d.data && !!d.data.length && !shown.length && <Empty>{t("shows.empty")}</Empty>}
      {d.data && !!shown.length && (
        <div className="row between">
          <span className="muted small">{t("shows.count", { shown: shown.length, total: d.data.length })}</span>
          <button className={`small${selecting ? " on" : ""}`} aria-pressed={selecting} onClick={() => (setSelecting(!selecting), setSel(new Set()))}>
            {selecting ? t("ep.selectDone") : t("ep.select")}
          </button>
        </div>
      )}
      <div className="poster-grid lib-grid">
        {shown.map((m) => {
          const toggleSel = () =>
            setSel((x) => {
              const n = new Set(x);
              if (n.has(m.id)) n.delete(m.id);
              else n.add(m.id);
              return n;
            });
          return (
            <article key={m.id} className={`lib-card${sel.has(m.id) ? " selected" : ""}`}>
              {selecting && <input className="poster-check" type="checkbox" checked={sel.has(m.id)} onChange={toggleSel} aria-label={m.title} />}
              <PosterCard
                title={`${m.title}${m.year ? ` (${m.year})` : ""}`}
                cover={m.cover}
                status={m.status === "have" ? (m.verdict?.ok === false ? "attention" : null) : m.status === "unreleased" ? "unaired" : m.status}
                href={`/movie/${m.id}`}
                onClick={() => (selecting ? toggleSel() : navigate(`/movie/${m.id}`))}
                width={0}
                meta={
                  (m.verdict?.ok === false || !m.monitored || !m.allowed) && (
                    <span className="lib-flags">
                      {m.verdict?.ok === false && <span className="tag warn">{t("movies.notProfile")}</span>}
                      {!m.monitored && <span className="tag neutral">{t("movies.notWanted")}</span>}
                      {!m.allowed && <span className="tag warn">{t("chip.outsideRoot")}</span>}
                    </span>
                  )
                }
              />
            </article>
          );
        })}
      </div>
      {sel.size > 0 && (
        <div className="bulkbar card">
          <span>{t("movies.selected", { n: sel.size })}</span>
          <span className="row">
            <button className="small" onClick={() => setSel(new Set(shown.map((m) => m.id)))}>
              {t("movies.selectShown")}
            </button>
            <button className="primary small" onClick={() => void setWanted([...sel], true)}>
              {t("movies.want")}
            </button>
            <button className="small" onClick={() => void setWanted([...sel], false)}>
              {t("movies.dontWant")}
            </button>
            <button className="small ghost" onClick={() => setSel(new Set())}>
              {t("common.cancel")}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

interface MovieDetail {
  id: number;
  title: string;
  originalTitle: string | null;
  altTitles: string[];
  year: number | null;
  runtime: number | null;
  path: string;
  cover: string | null;
  monitored: boolean;
  allowed: boolean;
  file: { path: string | null; sceneName: string | null; releaseGroup: string | null; quality: string | null; audio: string[]; subs: string[]; resolution: string | null } | null;
  verdict: { ok: boolean | null; why: string } | null;
  active: { id: number; state: string; progress: number | null; release: string } | null;
  grabs: { id: number; at: number; release: string; state: string; error: string | null }[];
  released: boolean;
  dates: { inCinemas: number | null; digital: number | null; physical: number | null };
  series: { tvdbId: number; title: string; cover: string | null; source: string }[];
  prefs: { profile_id: string | null; watch_mode: WatchMode | null };
  profile: { name: string; watchMode: WatchMode; profileMode?: WatchMode };
  search: { state: string; nextAt: number; lastAt: number | null; attempts: number; why: string } | null;
  upgrade: { state: string; lastAt: number | null; why: string; release: string | null } | null;
}
interface MovieSearch { queries: string[]; found: number; matched: number; skipped: Record<string, number>; errors: string[]; tookMs: number; results: SearchResult[]; dryRun: boolean }

/** One movie: file and language check, search and grab (imported through Radarr). */
export function MoviePage({ id }: { id: number }) {
  const toast = useToast();
  const d = useLoad(() => api<MovieDetail>(`/movies/${id}`), [id]);
  usePageTitle(d.data?.title ?? t("movies.title"));
  const [res, setRes] = useState<MovieSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [grab, setGrab] = useState<SearchResult | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const auto = async () => {
    setAutoBusy(true);
    try {
      const r = await api<{ outcome: string; release?: string; why: string }>(`/movies/${id}/autosearch`, { body: { replace: !!d.data?.file } });
      toast(`${t(`auto.${r.outcome}` as never)}${r.release ? ` · ${r.release}` : ""} · ${r.why}`, r.outcome === "failed", r.outcome === "needs-look" ? { label: t("auto.openList"), run: () => void search() } : undefined);
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setAutoBusy(false);
    }
  };
  // "Interactive search" fix button: /movie/:id?search=1
  useEffect(() => {
    if (new URLSearchParams(location.search).get("search") === "1" && d.data && !res && !searching) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data, location.search]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const m = d.data;
  const rescan = async () => {
    try {
      const r = await api<{ files: number; probed: number }>(`/movies/${id}/scan`, { body: {} });
      toast(t("files.scanned", { files: r.files, probed: r.probed }));
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const toggleWanted = async () => {
    try {
      await api("/movies/wanted", { body: { movieIds: [id], wanted: !m.monitored } });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const search = async () => {
    setSearching(true);
    try {
      setRes(await api<MovieSearch>(`/movies/${id}/search`, { body: {} }));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSearching(false);
    }
  };
  return (
    <section className="stack">
      <header className="kv-hero">
        {m.cover && <span className="hero-blur" style={{ backgroundImage: `url(${thumbUrl(m.cover, "sm")})` }} aria-hidden="true" />}
        <div className="hero-in">
        <div className="hero-poster">
          <Cover src={m.cover} alt={m.title} size="lg" hero />
        </div>
        <div className="hero-info">
          <div className="hero-top">
            <span className="eyebrow show-eyebrow">
              <Link to="/movies" className="crumb-link">
                {t("lib.movies")}
              </Link>
              {m.year ? ` · ${m.year}` : ""}
              {m.runtime ? ` · ${t("movies.runtime", { min: m.runtime })}` : ""}
            </span>
            <Menu
              className="hero-menu"
              items={[
                { label: t("files.refreshScan"), onSelect: () => void rescan() },
                { label: m.monitored ? t("movies.unwantThis") : t("movies.wantThis"), onSelect: () => void toggleWanted() },
                { label: t("add.remove"), onSelect: () => setRemoving(true), hidden: id < 900_000_000, danger: true },
              ]}
            />
          </div>
          <h1 className="hero-title">{m.title}</h1>
          {m.originalTitle && m.originalTitle !== m.title && <p className="hero-jp jp">{m.originalTitle}</p>}
          {!!m.series.length && (
            <p className="small">
              {t("movies.partOf")}{" "}
              {m.series.map((s, i) => (
                <span key={s.tvdbId}>
                  {i > 0 && ", "}
                  <Link to={`/show/${s.tvdbId}`}>{s.title}</Link>
                </span>
              ))}
            </p>
          )}
          <p className="hero-facts">
            {[m.dates.digital ? t("movies.digital", { date: dateOnly(m.dates.digital) }) : null, m.dates.physical ? t("movies.physical", { date: dateOnly(m.dates.physical) }) : null].filter(Boolean).join(" · ")}
          </p>
          <div className="chips hero-chips">
            {!m.released && <Chip tone="info">{t("movies.status.unreleased")}</Chip>}
            {!m.allowed && <Chip tone="warn" title={m.path}>{t("chip.outsideRoot")}</Chip>}
            <button className="small" aria-pressed={m.monitored} onClick={() => void toggleWanted()} title={t("movies.wantedHelp")}>
              {m.monitored ? `★ ${t("movies.wanted")}` : `☆ ${t("movies.notWanted")}`}
            </button>
          </div>
          <div className="hero-actions">
            {m.allowed ? (
              <SplitButton
                label={`⚡ ${autoBusy ? t("common.working") : t("auto.find")}`}
                disabled={autoBusy}
                onClick={() => (m.file ? setConfirmAuto(true) : void auto())}
                items={[{ label: searching ? t("common.working") : t("auto.chooseRelease"), onSelect: () => void search(), disabled: searching }]}
              />
            ) : (
              <button disabled={searching} onClick={() => void search()}>
                {searching ? t("common.working") : t("auto.chooseRelease")}
              </button>
            )}
            <button className="glass-btn" onClick={() => setWatchOpen(true)} aria-haspopup="dialog">
              {t("profiles.watchAs")}: {m.profile.name}
            </button>
          </div>
        </div>
        </div>
      </header>
      <div className="card pad stack">
        <h2>{t("movies.file")}</h2>
        {m.file ? (
          <>
            <p className="mono small">{m.file.path}</p>
            <div className="chips">
              {m.file.quality && <Chip>{m.file.quality}</Chip>}
              {m.verdict && <Chip tone={m.verdict.ok === false ? "bad" : m.verdict.ok ? "good" : "info"}>{m.verdict.ok === false ? "✕ " : m.verdict.ok ? "✓ " : ""}{m.verdict.why}</Chip>}
            </div>
            <p className="small muted">{t("movies.tracks", { audio: m.file.audio.join(", ") || "?", subs: m.file.subs.join(", ") || "—" })}</p>
            {m.file.path && (
              <div className="file-tools stack">
                <div className="row">
                  <WatchIn path={m.file.path} title={m.title} kind="movie" />
                  <Peek path={m.file.path} />
                </div>
                <FixDetection path={m.file.path} group={m.file.releaseGroup} title={m.title} onChanged={() => void d.reload()} />
              </div>
            )}
          </>
        ) : (
          <p className="warn-text">{t("movies.noFile")}</p>
        )}
        {m.search && m.search.state !== "done" && (
          <p className="small muted">
            {t("movies.autoSearch", { state: t(`movies.search.${m.search.state}` as never), why: m.search.why })}
            {m.search.state !== "grabbed" && m.search.nextAt > Date.now() ? ` · ${t("movies.nextSearch", { when: dateTime(m.search.nextAt) })}` : ""}
          </p>
        )}
        {m.upgrade && <p className="small muted">{t("movies.upgrade", { why: m.upgrade.why })}</p>}
        {m.active && (
          <p className="small">
            {t("movies.active", { release: m.active.release, state: t(`grab.${m.active.state}` as never) })} · <Link to="/queue">{t("nav.queue")}</Link>
          </p>
        )}
      </div>
      {!m.allowed && <p className="banner warn">{t("movies.notAllowed", { path: m.path })}</p>}
      {res && (
        <div className="stack">
          <p className="muted small">{t("movies.searchSummary", { matched: res.matched, found: res.found, s: (res.tookMs / 1000).toFixed(1) })}</p>
          {!!Object.keys(res.skipped).length && <Why lines={Object.entries(res.skipped).map(([k, n]) => `${n} × ${k}`)} />}
          {!!res.errors.length && <Why lines={res.errors} />}
          {!res.results.length && <Empty>{t("movies.noResults")}</Empty>}
          <div className="list">
            {res.results.map((r) => (
              <ResultCard key={r.guid} r={r} onGrab={m.allowed ? () => setGrab(r) : undefined} />
            ))}
          </div>
        </div>
      )}
      {!!m.grabs.length && (
        <div className="card pad stack">
          <h2>{t("movies.history")}</h2>
          {m.grabs.map((g) => (
            <p key={g.id} className="small">
              <span className="mono">{g.release}</span> · {t(`grab.${g.state}` as never)} · {dateTime(g.at)}
              {g.error ? ` · ${g.error}` : ""}
            </p>
          ))}
        </div>
      )}
      {watchOpen && (
        <Modal title={t("profiles.watchAs")} onClose={() => setWatchOpen(false)}>
          <WatchAs tvdbId={m.id} endpoint={`/movies/${m.id}/prefs`} prefs={m.prefs} effective={m.profile} onChanged={() => void d.reload()} />
        </Modal>
      )}
      {removing && <RemoveNative movieId={id} title={m.title} asked onClose={() => setRemoving(false)} />}
      {confirmAuto && (
        <Confirm title={t("auto.button")} confirmLabel={t("auto.button")} onClose={() => setConfirmAuto(false)} onConfirm={async () => (setConfirmAuto(false), await auto())}>
          <p className="warn-text">⚠ {t("movies.replaceWarn", { file: m.file?.path ?? "" })}</p>
        </Confirm>
      )}
      {grab && res && (
        <Confirm
          title={t("search.grabTitle")}
          confirmLabel={t("search.grabConfirm")}
          onClose={() => setGrab(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>(`/movies/${id}/grab`, { body: { guid: grab.guid, confirm: true, replace: !!m.file } });
              toast(t("search.grabDone", { message: r.message }));
              setGrab(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p className="mono">{grab.title}</p>
          <FlagChips flags={grab.rank.flags} />
          <p className="small">{fmtSize(grab.size)} · {grab.indexer}</p>
          <p>{res.dryRun ? t("search.grabDry") : t("movies.grabLive", { client: grab.protocol === "usenet" ? "SABnzbd" : "qBittorrent" })}</p>
          {m.file && <p className="warn-text">⚠ {t("movies.replaceWarn", { file: m.file.path ?? "" })}</p>}
        </Confirm>
      )}
    </section>
  );
}
