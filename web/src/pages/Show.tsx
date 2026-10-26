import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, store, sxe, type Decision } from "../api";
import { Link, navigate } from "../App";
import { airLabel, EpisodeSheet, resLabel, StatusPill, useEpisodeActions, type EpisodeRow } from "../episodes";
import { CaptionsOff, Check, Download, LayoutGrid, List, ListChecks } from "lucide-react";
import { Ring } from "../posters";
import { showVars } from "../season";
import { t, type I18nKey } from "../i18n";
import { Chip, Cover, Empty, ErrorBox, Menu, Modal, Spinner, SplitButton, thumbUrl, useLoad, usePageTitle, useToast } from "../ui";
import { DecisionCard } from "./Activity";
import { WatchAs, type WatchMode } from "../profiles";
import { ScopeEditor } from "../scope";
import { ManualImport, RenamePreview } from "../media";
import { RemoveNative } from "./Add";
import { AnidbEntries } from "../anidb";
import { query } from "../App";

interface Header {
  seriesId: number;
  tvdbId: number;
  title: string;
  year: number | null;
  status: string;
  network: string | null;
  overview: string | null;
  genres: string[];
  path: string;
  cover: string | null;
  banner: string | null;
  color?: string | null;
  catalog?: { titleNative: string | null; kind: string | null; from: number | null; to: number | null } | null;
  nextEpisode: { id: number; season: number; episode: number; title: string | null; airUtc: number | null } | null;
  counts: { have: number; aired: number; missing: number; downloading: number; total: number };
  language: { lang: string; withLang: number; have: number };
  links: { anilist: string | null; anidb: string | null; tvdb: string | null };
  native?: boolean;
  profile: { id: string; name: string; watchMode: WatchMode; profileMode: WatchMode; source: string; original: string[] };
  managed: { dryRun: boolean } | null;
  allowed: boolean;
}

interface ShowData {
  header: Header;
  prefs: { profile_id: string | null; watch_mode: WatchMode | null };
  rows: EpisodeRow[];
  anidb: { aid: number; season: number | "a" | null; offset: number; title: string | null }[];
  aliases: { id: number; title: string; season: number | null; source: string }[];
  rules: { id: number; grp: string | null; mode: string; season: number | null; offset: number }[];
  facts: { id: number; season: number | null; kind: string; lang: string; note: string }[];
  movies: FranchiseMovie[];
}

type ShowTab = "episodes" | "movies" | "details" | "history";

interface FranchiseMovie { movieId: number | null; tmdbId: number | null; title: string; year: number | null; cover: string | null; inRadarr: boolean; hasFile: boolean; s0Episode: number | null; source: "anime-lists" | "title" | "manual" }

export function Show({ tvdbId }: { tvdbId: number }) {
  const d = useLoad(() => api<ShowData>(`/series/${tvdbId}`), [tvdbId]);
  const act = useLoad(() => api<Decision[]>(`/activity?tvdbId=${tvdbId}`), [tvdbId]);
  const status = useLoad(() => api<{ dryRun: boolean }>("/status"), []);
  usePageTitle(d.data?.header.title ?? "…");
  const [open, setOpen] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [grid, setGrid] = useState(() => store.get("episodeGrid", false));
  const [tab, setTabState] = useState<ShowTab>(() => (["movies", "details", "history"].includes(query().get("tab") ?? "") ? (query().get("tab") as ShowTab) : "episodes"));
  const [panel, setPanel] = useState<null | "scope" | "rename" | "import" | "watch" | "remove">(() => (query().get("rename") === "1" ? "rename" : null));
  const [linking, setLinking] = useState(false);
  const toast = useToast();

  // Poll while something is downloading so status moves on by itself.
  const downloading = d.data?.rows.some((r) => r.status === "downloading");
  useEffect(() => {
    if (!downloading) return;
    const id = setInterval(() => void d.reload(), 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading]);

  const h = d.data?.header;
  const dryRun = status.data?.dryRun ?? true;
  const managedLive = !!h?.managed && !h.managed.dryRun && !dryRun;
  const lang = h?.language.lang ?? "en";
  const seasons = useMemo(() => {
    const map = new Map<number, EpisodeRow[]>();
    for (const r of d.data?.rows ?? []) map.set(r.season, [...(map.get(r.season) ?? []), r]);
    // Newest season first; specials last.
    return [...map].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0]));
  }, [d.data]);
  const selected = (d.data?.rows ?? []).filter((r) => sel.has(r.id) && !r.movie);
  const bulk = useEpisodeActions({
    tvdbId,
    episodes: selected.map((r) => ({ id: r.id, label: sxe(r.season, r.episode), release: r.file?.sceneName ?? null, file: r.file?.name ?? null, fileEpisodes: r.file?.episodes })),
    managedLive,
    dryRun,
    onDone: () => (setSel(new Set()), setSelecting(false), void d.reload(), void act.reload()),
  });

  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data || !h) return <Spinner label={t("app.loading")} />;
  const s = d.data;
  const toggle = (id: number) =>
    setSel((x) => {
      const n = new Set(x);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const missingAll = (d.data?.rows ?? []).filter((r) => r.status === "missing" && !r.movie && r.special?.cls !== "junk");
  const links = [
    { label: "AniList ↗", href: h.links.anilist },
    { label: "AniDB ↗", href: h.links.anidb },
    { label: "TVDB ↗", href: h.links.tvdb },
  ].filter((l) => !!l.href);
  const setTab = (x: ShowTab) => {
    setTabState(x);
    const u = new URL(location.href);
    if (x === "episodes") u.searchParams.delete("tab");
    else u.searchParams.set("tab", x);
    history.replaceState(null, "", u.pathname + u.search);
  };
  const refreshScan = async () => {
    try {
      const r = await api<{ files: number; probed: number; removed: number }>(`/series/${tvdbId}/scan`, { body: {} });
      toast(t("files.scanned", { files: r.files, probed: r.probed }));
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const tabs: { id: ShowTab; label: string; n?: number; hidden?: boolean }[] = [
    { id: "episodes", label: t("show.episodes"), n: s.rows.filter((r) => !r.movie && r.season > 0).length },
    { id: "movies", label: t("franchise.title"), n: s.movies.length, hidden: !s.movies.length && !linking },
    { id: "details", label: t("show.details") },
    { id: "history", label: t("show.history") },
  ];

  return (
    <section>
      {/* ---------------- header: what the show is, how complete it is, and its one main action */}
      <header className="kv-hero" style={showVars(h.color)}>
        {h.banner && <span className="hero-bgart" style={{ backgroundImage: `url(${thumbUrl(h.banner, "xl")})` }} aria-hidden="true" />}
        {h.cover && <span className="hero-blur" style={{ backgroundImage: `url(${thumbUrl(h.cover, "sm")})` }} aria-hidden="true" />}
        <div className="hero-in">
          <div className="hero-poster">
            <Cover src={h.cover} alt={h.title} size="lg" hero />
          </div>
          <div className="hero-info">
            <div className="hero-top">
              <span className="eyebrow show-eyebrow">{[h.catalog?.kind ? t(`catalog.kind.${h.catalog.kind}` as I18nKey) : null, h.network, h.catalog?.from ? `${h.catalog.from}${h.catalog.to && h.catalog.to !== h.catalog.from ? ` – ${h.catalog.to}` : h.status === "continuing" ? " –" : ""}` : h.year].filter(Boolean).join(" · ")}</span>
              <Menu
                label={t("show.manage")}
                className="hero-menu"
                items={[
                  { label: t("scope.menu"), onSelect: () => setPanel("scope"), hidden: !h.managed },
                  { label: t("rename.menu"), onSelect: () => setPanel("rename"), hidden: !h.allowed },
                  { label: t("import.menu"), onSelect: () => setPanel("import"), hidden: !h.allowed },
                  { label: t("files.refreshScan"), onSelect: () => void refreshScan() },
                  { label: t("franchise.linkMenu"), onSelect: () => (setLinking(true), setTab("movies")) },
                  ...links.map((l) => ({ label: l.label, onSelect: () => window.open(l.href!, "_blank", "noopener,noreferrer") })),
                  { label: t("add.remove"), onSelect: () => setPanel("remove"), hidden: !h.native, danger: true },
                ]}
              />
            </div>
            <h1 className="hero-title">{h.title}</h1>
            {h.catalog?.titleNative && <p className="hero-jp jp" lang="ja">{h.catalog.titleNative}</p>}
            <p className="hero-facts">
              <span>
                <i className={`dot ${h.status === "continuing" ? "good" : "off"}`} aria-hidden="true" />
                {h.status === "continuing" ? t("series.continuing") : h.status === "ended" ? t("series.ended") : h.status}
              </span>
              {h.network && <span>{h.network}</span>}
              <span>{t("show.seasonsEps", { s: seasons.filter(([n]) => n > 0).length, e: s.rows.filter((r) => r.season > 0).length })}</span>
              {!!h.genres?.length && <span className="hide-phone">{h.genres.slice(0, 3).join(", ")}</span>}
              {h.managed && (
                <span className="managed-flag">
                  ★ {t("chip.managed")}
                  {h.managed.dryRun ? ` · ${t("chip.dryRun")}` : ""}
                </span>
              )}
            </p>
            {h.nextEpisode && <p className="hero-next">⏱ {t("series.next", { label: sxe(h.nextEpisode.season, h.nextEpisode.episode), when: airLabel(h.nextEpisode.airUtc) })}</p>}
            {h.overview && <Synopsis text={h.overview} />}
            <div className="hero-actions">
              <span className="ring-wrap hide-phone">
                <Ring value={h.counts.aired ? h.counts.have / h.counts.aired : 0} label={t("series.have", { have: h.counts.have, aired: h.counts.aired })} />
                <span className="ringlbl">
                  <b className="tnum">
                    {h.counts.have} / {h.counts.aired}
                  </b>
                  {t("show.inLibraryLang", { n: h.language.withLang, lang: h.language.lang.toUpperCase() })}
                </span>
              </span>
              {missingAll.length ? (
                <SeasonSearch tvdbId={tvdbId} missing={missingAll} dryRun={dryRun} primary big onDone={() => (void d.reload(), void act.reload())} />
              ) : (
                <SplitButton label={`⚡ ${t("show.searchReleases")}`} onClick={() => navigate(`/search?tvdbId=${tvdbId}`)} items={[{ label: t("files.refreshScan"), onSelect: () => void refreshScan() }]} />
              )}
              <button className="glass-btn" onClick={() => setPanel("watch")} aria-haspopup="dialog">
                {t("profiles.watchAs")}: {t(`mode.${h.profile.watchMode}` as I18nKey)} · {h.profile.name}
              </button>
            </div>
          </div>
        </div>
      </header>
      {!h.allowed && <p className="banner warn">{t("series.outsideRoot")}</p>}

      <div className="show-tabs" style={showVars(h.color)}>
        <div className="tabs" role="tablist" aria-label={h.title}>
          {tabs
            .filter((x) => !x.hidden)
            .map((x) => (
              <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>
                {x.label}
                {x.n !== undefined && <small className="tab-n">{x.n}</small>}
              </button>
            ))}
        </div>
        {tab === "episodes" && (
          <div className="row tab-tools">
            <div className="seg icon-seg" role="group" aria-label={t("ep.view")}>
              <button className={!grid ? "on" : ""} aria-pressed={!grid} aria-label={t("ep.list")} title={t("ep.list")} onClick={() => (setGrid(false), store.set("episodeGrid", false))}>
                <List className="lucide" aria-hidden="true" />
              </button>
              <button className={grid ? "on" : ""} aria-pressed={grid} aria-label={t("ep.grid")} title={t("ep.grid")} onClick={() => (setGrid(true), store.set("episodeGrid", true))}>
                <LayoutGrid className="lucide" aria-hidden="true" />
              </button>
            </div>
            <button className={`icon-btn${selecting ? " on" : ""}`} aria-pressed={selecting} aria-label={selecting ? t("ep.selectDone") : t("ep.select")} title={selecting ? t("ep.selectDone") : t("ep.select")} onClick={() => (setSelecting(!selecting), setSel(new Set()))}>
              <ListChecks className="lucide" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {tab === "movies" && !s.movies.length && !linking && <Empty>{t("franchise.none")}</Empty>}
      {tab === "movies" && <FranchiseMovies tvdbId={tvdbId} movies={s.movies} adding={linking} setAdding={setLinking} onChanged={() => void d.reload()} />}
      {tab === "details" && (
        <>
          {h.native && <p className="muted small">{t("add.nativeNote")}</p>}
          <Franchise tvdbId={tvdbId} />
          <AnidbEntries tvdbId={tvdbId} onChanged={() => void d.reload()} />
          <Advanced s={s} tvdbId={tvdbId} path={h.path} onChanged={() => (void d.reload(), void act.reload())} />
        </>
      )}
      {tab === "history" && (
        <div className="list">
          {act.data && !act.data.length && <Empty icon="≡">{t("show.noHistory")}</Empty>}
          {(act.data ?? []).slice(0, 50).map((x) => (
            <DecisionCard key={x.id} d={x} onUndone={act.reload} />
          ))}
        </div>
      )}

      {/* ---------------- episodes (what you open the page for) */}
      {tab === "episodes" && (
        <>
          {!s.rows.length && <Empty icon="▤">{t("show.noEpisodes")}</Empty>}
      {seasons.map(([season, rows], i) => {
        const missing = rows.filter((r) => r.status === "missing" && !r.movie && r.special?.cls !== "junk");
        const nextId = rows.filter((r) => r.status === "unaired" && r.airUtc).sort((a, b) => a.airUtc! - b.airUtc!)[0]?.id;
        const aired = rows.filter((r) => r.status !== "unaired");
        const have = rows.filter((r) => r.status === "have");
        const noLang = have.filter((r) => r.file && !r.file.subs.includes(lang) && !r.file.audio.includes(lang));
        const dl = rows.filter((r) => r.status === "downloading");
        const attention = rows.filter((r) => r.status === "attention");
        const quiet = !missing.length && !noLang.length && !dl.length && !attention.length && have.length === aired.length;
        const unmonitored = rows.length > 0 && rows.every((r) => !r.monitored) && !h.managed;
        const years = [...new Set(rows.filter((r) => r.airUtc).map((r) => new Date(r.airUtc!).getFullYear()))].sort();
        const firstOpen = seasons.findIndex(([n, rs]) => n > 0 && rs.some((r) => r.status !== "have" || (r.file && !r.file.subs.includes(lang) && !r.file.audio.includes(lang))));
        const ordered_ = ordered(season === 0 ? rows.filter((r) => r.special?.cls !== "junk") : rows, nextId);
        return (
          <details key={season} className="season card" open={selecting || i === (firstOpen < 0 ? 0 : firstOpen)}>
            <summary className="season-head">
              <span className="season-chev" aria-hidden="true" />
              <h3 className="season-name-h">{season === 0 ? t("series.specials") : t("common.season", { n: season })}</h3>
              {!!years.length && <span className="muted small tnum hide-phone">{years.length > 1 ? `${years[0]} – ${years[years.length - 1]}` : years[0]}</span>}
              <span className="season-prog hide-phone" aria-hidden="true">
                <i style={{ width: `${aired.length ? Math.round((have.length / aired.length) * 100) : 0}%` }} />
              </span>
              <span className="muted small tnum">
                {have.length} / {aired.length}
              </span>
              {quiet && aired.length > 0 && (
                <span className="tag good">
                  <Check className="lucide" aria-hidden="true" /> {t("show.allQuiet")}
                </span>
              )}
              {unmonitored && <span className="tag neutral">{t("show.notMonitored")}</span>}
              {!!noLang.length && (
                <span className="tag warn">
                  <CaptionsOff className="lucide" aria-hidden="true" /> {t("show.noLangCount", { n: noLang.length, lang: lang.toUpperCase() })}
                </span>
              )}
              {!!dl.length && (
                <span className="tag info">
                  <Download className="lucide" aria-hidden="true" /> {t("show.dlCount", { n: dl.length })}
                </span>
              )}
              {!!attention.length && <span className="tag bad">{t("show.attentionCount", { n: attention.length })}</span>}
              <span className="season-right">
                {!!missing.length && <SeasonSearch tvdbId={tvdbId} missing={missing} dryRun={dryRun} onDone={() => (void d.reload(), void act.reload())} />}
                {selecting && (
                  <button className="small ghost" onClick={(e) => (e.preventDefault(), setSel((x) => new Set([...x, ...rows.map((r) => r.id)])))}>
                    {t("shows.selectAll")}
                  </button>
                )}
              </span>
            </summary>
            {grid ? (
              <div className="ep-grid">
                {[...rows].reverse().map((r) => (
                  <button key={r.id} className={`ep-cell ${r.status}${sel.has(r.id) ? " selected" : ""}`} onClick={() => (selecting ? toggle(r.id) : setOpen(r.id))} aria-pressed={selecting ? sel.has(r.id) : undefined} title={`${sxe(r.season, r.episode)} ${r.title ?? ""} · ${t(`ep.status.${r.status}`)}`}>
                    {r.episode}
                    <span className="sr-only"> {t(`ep.status.${r.status}`)}</span>
                  </button>
                ))}
                <p className="legend small muted">
                  ✓ {t("ep.status.have")} · ! {t("ep.status.missing")} · ↓ {t("ep.status.downloading")} · ◷ {t("ep.status.unaired")} · ⚠ {t("ep.status.attention")}
                </p>
              </div>
            ) : (
              <ul className="ep-list">
                {ordered_.main.map((r) => (
                  <EpRow key={r.id} r={r} lang={lang} next={r.id === nextId} selecting={selecting} selected={sel.has(r.id)} onToggle={() => toggle(r.id)} onOpen={() => setOpen(r.id)} />
                ))}
              </ul>
            )}
            {!grid && season === 0 && rows.some((r) => r.special?.cls === "junk") && (
              <details className="later">
                <summary className="muted small">{t("special.minor", { n: rows.filter((r) => r.special?.cls === "junk").length })}</summary>
                <ul className="ep-list">
                  {rows
                    .filter((r) => r.special?.cls === "junk")
                    .map((r) => (
                      <EpRow key={r.id} r={r} lang={lang} selecting={false} selected={false} onToggle={() => undefined} onOpen={() => setOpen(r.id)} />
                    ))}
                </ul>
              </details>
            )}
            {!grid && ordered_.later.length > 0 && (
              <details className="later">
                <summary className="muted small">{t("ep.upcoming", { n: ordered_.later.length })}</summary>
                <ul className="ep-list">
                  {ordered_.later.map((r) => (
                    <EpRow key={r.id} r={r} lang={lang} selecting={false} selected={false} onToggle={() => undefined} onOpen={() => setOpen(r.id)} />
                  ))}
                </ul>
              </details>
            )}
          </details>
        );
      })}
        </>
      )}

      {selecting && !!sel.size && (
        <div className="bulkbar card">
          <span>{t("ep.selected", { n: sel.size })}</span>
          <SplitButton
            up
            label={`⚡ ${t("auto.button")}`}
            onClick={bulk.auto}
            disabled={bulk.autoBusy}
            items={[
              { label: t("auto.chooseRelease"), onSelect: bulk.search },
              { label: t("ep.regrab"), onSelect: bulk.regrab },
              { label: t("ep.delete"), onSelect: bulk.remove, danger: true, disabled: !selected.some((r) => r.file) },
            ]}
          />
        </div>
      )}
      {bulk.ui}
      {open !== null && <EpisodeSheet episodeId={open} onClose={() => setOpen(null)} onChanged={() => (void d.reload(), void act.reload())} managedLive={managedLive} dryRun={dryRun} lang={lang} />}

      {/* ---------------- the ⋯ tools, each in its own dialog */}
      {panel === "scope" && (
        <Modal title={t("scope.title")} onClose={() => setPanel(null)}>
          <p className="muted small">{t("scope.titleHelp")}</p>
          <ScopeEditor tvdbIds={[tvdbId]} onSaved={() => (setPanel(null), void d.reload())} />
        </Modal>
      )}
      {panel === "rename" && h.allowed && (
        <Modal title={t("rename.title")} onClose={() => setPanel(null)}>
          <RenamePreview tvdbId={tvdbId} initiallyOpen onDone={() => void d.reload()} />
        </Modal>
      )}
      {panel === "import" && (
        <Modal title={t("import.title")} onClose={() => setPanel(null)}>
          <ManualImport tvdbId={tvdbId} initiallyOpen onDone={() => void d.reload()} />
        </Modal>
      )}
      {panel === "watch" && (
        <Modal title={t("profiles.watchAs")} onClose={() => setPanel(null)}>
          <WatchAs tvdbId={tvdbId} prefs={d.data.prefs} effective={h.profile} onChanged={() => void d.reload()} />
        </Modal>
      )}
      {panel === "remove" && <RemoveNative tvdbId={tvdbId} title={h.title} asked onClose={() => setPanel(null)} />}
    </section>
  );
}

/** The synopsis inside the hero: three lines, "More" for the rest. */
function Synopsis({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <p className="muted synopsis">
      <span className={open || !long ? "" : "clamp3"}>{text}</span>
      {long && (
        <button className="linklike small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("common.less") : t("common.more")}
        </button>
      )}
    </p>
  );
}

/**
 * One episode row: a status dot in the number column, title + date · group, then quality and size as columns on
 * desktop; a chip only when something needs you (no subs, downloading, missing, attention).
 */
function EpRow({ r, lang, next = false, selecting, selected, onToggle, onOpen }: { r: EpisodeRow; lang: string; next?: boolean; selecting: boolean; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  const noLang = r.status === "have" && !!r.file && !r.file.subs.includes(lang) && !r.file.audio.includes(lang);
  const dot = r.status === "have" ? (noLang ? "warn" : "good") : r.status === "downloading" ? "info" : r.status === "missing" ? "bad" : r.status === "attention" ? "warn" : "off";
  const quality = r.file ? [r.file.source, r.file.resolution ? resLabel(r.file.resolution) : null].filter(Boolean).join(" ") : "";
  return (
    <li className={`ep-row${next ? " next" : ""}${selected ? " selected" : ""}`}>
      {selecting && <input type="checkbox" checked={selected} onChange={onToggle} aria-label={sxe(r.season, r.episode)} />}
      <button className="ep-main" onClick={() => (selecting ? onToggle() : onOpen())}>
        <span className="ep-num tnum">
          <i className={`dot ${dot}`} aria-hidden="true" />
          {r.episode}
        </span>
        <span className="ep-text">
          <span className="ep-title clamp1" title={r.title ?? undefined}>
            {r.title ?? t("ep.tba")}
            {r.movie && <span className="tag info inline">{t("ep.movieChip")}</span>}
            {r.file?.changed && <span className="tag neutral inline" title={t("ep.changed")}>{t("ep.reencodedChip")}</span>}
            {r.special && !r.movie && <span className="tag neutral inline">{t(`special.${r.special.type}` as I18nKey)}</span>}
          </span>
          <span className="ep-meta muted small">
            {airLabel(r.airUtc)}
            {r.file?.group ? ` · ${r.file.group}` : ""}
            {r.season === 0 && r.runtime ? ` · ${t("ep.minutes", { n: r.runtime })}` : ""}
            <span className="phone-meta">
              {quality ? ` · ${quality}` : ""}
              {r.file?.size ? ` · ${fmtSize(r.file.size)}` : ""}
            </span>
          </span>
        </span>
        <span className="ep-q muted small">{quality}</span>
        <span className="ep-sz muted small tnum">{r.file?.size ? fmtSize(r.file.size) : ""}</span>
        <span className="ep-status">
          {next ? <span className="tag next">{t("ep.next")}</span> : null}
          {r.status === "have" && !noLang ? <span className="sr-only">{t("ep.status.have")}</span> : !next || r.status !== "unaired" ? <StatusPill e={r} lang={lang} /> : null}
        </span>
      </button>
    </li>
  );
}

/** Season rows: the next unaired episode first, then aired ones newest first; later unaired ones go under "Upcoming". */
function ordered(rows: EpisodeRow[], nextId: number | undefined) {
  const aired = rows.filter((r) => r.status !== "unaired" || r.file);
  const next = rows.find((r) => r.id === nextId);
  const later = rows.filter((r) => r.status === "unaired" && !r.file && r.id !== nextId).sort((a, b) => a.episode - b.episode);
  return { main: [...(next ? [next] : []), ...aired], later };
}

function Advanced({ s, tvdbId, path, onChanged }: { s: ShowData; tvdbId: number; path: string; onChanged: () => void }) {
  const toast = useToast();
  const [alias, setAlias] = useState({ title: "", season: "" });
  const [rule, setRule] = useState({ mode: "season", season: "", offset: "0", group: "" });
  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t("common.saved"));
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <details className="card pad advanced">
      <summary>{t("series.advanced")}</summary>
      <div className="two-col">
        <div className="stack">
          <h3>{t("series.path")}</h3>
          <p className="mono small muted">{path}</p>
          <h3>{t("show.anidb")}</h3>
          {!s.anidb.length && <p className="muted">{t("show.noAnidb")}</p>}
          <ul className="plain small">
            {s.anidb.map((a) => (
              <li key={a.aid}>
                <a href={`https://anidb.net/anime/${a.aid}`} target="_blank" rel="noreferrer">
                  {a.aid}
                </a>{" "}
                {a.title} → {a.season === "a" ? "absolute" : a.season === null ? "—" : `S${a.season}`}
                {a.offset ? ` (+${a.offset})` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className="stack">
          <h3>{t("show.aliases")}</h3>
          <ul className="plain">
            {s.aliases.map((a) => (
              <li key={a.id} className="row between">
                <span>
                  {a.title}
                  {a.season !== null ? ` (S${a.season})` : ""} <Chip>{a.source}</Chip>
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/aliases/${a.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void call(() => api("/aliases", { body: { tvdbId, title: alias.title, season: alias.season ? Number(alias.season) : null } })).then(() => setAlias({ title: "", season: "" }));
            }}
          >
            <input className="grow" value={alias.title} onChange={(e) => setAlias({ ...alias, title: e.target.value })} placeholder={t("show.aliasAdd")} aria-label={t("show.aliasAdd")} />
            <input className="narrow" inputMode="numeric" value={alias.season} onChange={(e) => setAlias({ ...alias, season: e.target.value })} placeholder={t("show.aliasSeason")} aria-label={t("show.aliasSeason")} />
            <button>{t("common.add")}</button>
          </form>
        </div>
        <div className="stack">
          <h3>{t("show.rules")}</h3>
          <ul className="plain">
            {s.rules.map((r) => (
              <li key={r.id} className="row between">
                <span>
                  {r.grp ? `${r.grp}: ` : ""}
                  {r.mode}
                  {r.season !== null ? ` S${r.season}` : ""}
                  {r.offset ? ` offset ${r.offset}` : ""}
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/rules/${r.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void call(() => api("/rules", { body: { tvdbId, mode: rule.mode, season: rule.season ? Number(rule.season) : null, offset: Number(rule.offset) || 0, group: rule.group } }));
            }}
          >
            <label>
              {t("show.ruleMode")}
              <select value={rule.mode} onChange={(e) => setRule({ ...rule, mode: e.target.value })}>
                <option value="absolute">{t("show.ruleMode.absolute")}</option>
                <option value="season">{t("show.ruleMode.season")}</option>
                <option value="offset">{t("show.ruleMode.offset")}</option>
              </select>
            </label>
            {rule.mode !== "absolute" && (
              <label>
                {t("show.aliasSeason")}
                <input inputMode="numeric" value={rule.season} onChange={(e) => setRule({ ...rule, season: e.target.value })} />
              </label>
            )}
            {rule.mode === "offset" && (
              <label>
                {t("show.ruleOffset")}
                <input inputMode="numeric" value={rule.offset} onChange={(e) => setRule({ ...rule, offset: e.target.value })} />
              </label>
            )}
            <label>
              {t("show.ruleGroup")}
              <input value={rule.group} onChange={(e) => setRule({ ...rule, group: e.target.value })} />
            </label>
            <button className="self-start">{t("common.add")}</button>
          </form>
        </div>
        <div className="stack">
          <h3>{t("show.facts")}</h3>
          {!s.facts.length && <p className="muted">{t("common.none")}</p>}
          <ul className="plain">
            {s.facts.map((f) => (
              <li key={f.id} className="row between">
                <span>
                  {f.season !== null ? `S${f.season}: ` : ""}
                  {f.kind === "burned_in" ? `burned-in ${f.lang}` : f.kind} {f.note && <span className="muted small">({f.note})</span>}
                </span>
                <button className="small ghost" onClick={() => call(() => api(`/facts/${f.id}`, { method: "DELETE" }))}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

/** The franchise's movies (Radarr keeps the files; AnimeArr shows them with their show). Links can be corrected. */
function FranchiseMovies({ tvdbId, movies, adding, setAdding, onChanged }: { tvdbId: number; movies: FranchiseMovie[]; adding: boolean; setAdding: (v: boolean) => void; onChanged: () => void }) {
  const toast = useToast();
  const all = useLoad(() => (adding ? api<{ id: number; title: string; year: number | null }[]>("/movies") : Promise.resolve([])), [adding]);
  const link = async (movieId: number, on: boolean) => {
    try {
      await api("/franchise/link", { method: "PUT", body: { tvdbId, movieId, on } });
      toast(t("common.saved"));
      setAdding(false);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <div className="row end">
        <button className="small ghost" onClick={() => setAdding(!adding)}>
          {adding ? t("common.cancel") : `+ ${t("franchise.link")}`}
        </button>
      </div>
      {adding && (
        <select
          defaultValue=""
          aria-label={t("franchise.link")}
          onChange={(e) => e.target.value && void link(Number(e.target.value), true)}
        >
          <option value="">{t("franchise.pick")}</option>
          {(all.data ?? [])
            .filter((m) => !movies.some((x) => x.movieId === m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.year ? ` (${m.year})` : ""}
              </option>
            ))}
        </select>
      )}
      {!movies.length && !adding && <Empty>{t("franchise.none")}</Empty>}
      {!!movies.length && (
        <div className="poster-grid small-posters">
          {movies.map((m) => (
            <article key={`${m.movieId ?? "t"}${m.tmdbId}`} className="poster-card">
              {m.movieId ? (
                <Link to={`/movie/${m.movieId}`} className="poster-link card-link">
                  <Cover src={m.cover} alt={m.title} size="lg" />
                  <span className="poster-title clamp2">
                    {m.title}
                    {m.year ? ` (${m.year})` : ""}
                  </span>
                </Link>
              ) : (
                <div className="poster-link">
                  <Cover src={null} alt={m.title} size="lg" />
                  <span className="poster-title clamp2">{m.title}</span>
                </div>
              )}
              <div className="poster-body row between">
                <div className="chips">
                  {!m.inRadarr ? <Chip tone="warn">{t("franchise.notInRadarr")}</Chip> : m.hasFile ? <span className="quiet-status"><span className="dot good" aria-hidden="true" />{t("ep.status.have")}</span> : <Chip tone="bad">! {t("ep.status.missing")}</Chip>}
                  {m.s0Episode !== null && <Chip>{t("franchise.s0", { n: m.s0Episode })}</Chip>}
                </div>
                {m.movieId && (
                  <Menu
                    label={`${m.title}: ${t("common.moreActions")}`}
                    items={[{ label: t("franchise.unlink"), danger: true, onSelect: () => window.confirm(t("franchise.unlinkConfirm", { title: m.title })) && void link(m.movieId!, false) }]}
                  />
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Find missing (n)" for a season or the whole show: finds automatically (asks once; prefers a season pack); the caret picks a release. */
function SeasonSearch({ tvdbId, missing, dryRun, onDone, primary = false, big = false }: { tvdbId: number; missing: EpisodeRow[]; dryRun: boolean; onDone: () => void; primary?: boolean; big?: boolean }) {
  const list = missing.slice(0, 26);
  const a = useEpisodeActions({ tvdbId, episodes: list.map((r) => ({ id: r.id, label: sxe(r.season, r.episode) })), managedLive: false, dryRun, onDone });
  return (
    <span className="season-search" onClick={(e) => e.preventDefault()}>
      <SplitButton small={!big} primary={primary} label={`⚡ ${t("ep.findMissing", { n: list.length })}`} onClick={a.auto} disabled={a.autoBusy} items={[{ label: t("auto.chooseRelease"), onSelect: a.search }]} />
      {a.ui}
    </span>
  );
}

interface CatalogEntry { anilistId: number; kind: string | null; title: string; titleRomaji: string | null; titleNative: string | null; status: string | null; year: number | null; episodes: number | null; cover: string | null; tvdbSeason: string | null; nextEpisode: number | null; nextAt: number | null; country: string | null }

/** The show's AniList entries (seasons/cours) and the rest of its franchise, from AnimeArr's own catalog. */
function Franchise({ tvdbId }: { tvdbId: number }) {
  const d = useLoad(() => api<{ franchise: { id: number; title: string } | null; entries: CatalogEntry[]; related: CatalogEntry[] }>(`/series/${tvdbId}/catalog`), [tvdbId]);
  if (!d.data || (!d.data.entries.length && !d.data.related.length)) return null;
  const row = (e: CatalogEntry) => (
    <li key={e.anilistId} className="franchise-entry">
      <Cover src={e.cover} alt={e.title} size="sm" />
      <span className="stack grow">
        <a href={`https://anilist.co/anime/${e.anilistId}`} target="_blank" rel="noreferrer" className="strong clamp2">
          {e.title}
        </a>
        {e.titleNative && <span className="muted small">{e.titleRomaji && e.titleRomaji !== e.title ? `${e.titleRomaji} · ` : ""}{e.titleNative}</span>}
        <span className="chips">
          {e.kind && <Chip>{t(`catalog.kind.${e.kind}` as I18nKey)}</Chip>}
          {e.year && <Chip>{e.year}</Chip>}
          {e.episodes ? <Chip>{t("catalog.eps", { n: e.episodes })}</Chip> : null}
          {e.status && <Chip tone={e.status === "RELEASING" ? "good" : "info"}>{t(`catalog.status.${e.status}` as I18nKey)}</Chip>}
          {e.tvdbSeason && <Chip>{e.tvdbSeason === "a" ? t("catalog.absolute") : e.tvdbSeason === "0" ? t("series.specials") : t("common.season", { n: Number(e.tvdbSeason) })}</Chip>}
          {e.country === "CN" && <Chip>{t("catalog.donghua")}</Chip>}
        </span>
      </span>
    </li>
  );
  return (
    <details className="card pad stack" open>
      <summary>
        <strong className="clamp1">{t("catalog.title", { name: d.data.franchise?.title ?? d.data.entries[0]?.title ?? d.data.related[0]?.title ?? "" })}</strong> <span className="muted small">{t(d.data.entries.length + d.data.related.length === 1 ? "catalog.countOne" : "catalog.count", { n: d.data.entries.length + d.data.related.length })}</span>
      </summary>
      <ul className="plain stack">{d.data.entries.map(row)}</ul>
      {!!d.data.related.length && (
        <>
          <h3>{t("catalog.related")}</h3>
          <ul className="plain stack">{d.data.related.map(row)}</ul>
        </>
      )}
    </details>
  );
}
