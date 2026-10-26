import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, store, sxe, type Decision } from "../api";
import { Link, navigate } from "../App";
import { airLabel, EpisodeSheet, StatusPill, useEpisodeActions, type EpisodeRow } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Cover, Empty, ErrorBox, Menu, Modal, Spinner, SplitButton, useLoad, usePageTitle, useToast } from "../ui";
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
  const tabs: { id: ShowTab; label: string; hidden?: boolean }[] = [
    { id: "episodes", label: t("show.episodes") },
    { id: "movies", label: `${t("franchise.title")} (${s.movies.length})`, hidden: !s.movies.length && !linking },
    { id: "details", label: t("show.details") },
    { id: "history", label: t("show.history") },
  ];

  return (
    <section>
      {/* ---------------- header: what the show is, how complete it is, and its one main action */}
      <header className="series-hero card" style={h.banner ? { backgroundImage: `linear-gradient(180deg, color-mix(in srgb, var(--panel) 55%, transparent), var(--panel) 85%), url(${h.banner})` } : undefined}>
        <Cover src={h.cover} alt={h.title} size="lg" />
        <div className="stack hero-body">
          <div className="row between hero-title">
            <h1 className="clamp2 grow">{h.title}</h1>
            <Menu
              label={t("show.manage")}
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
          <div className="chips">
            <Chip tone={h.status === "continuing" ? "good" : "info"}>{h.status === "continuing" ? `● ${t("series.airing")}` : h.status === "ended" ? t("series.ended") : h.status}</Chip>
            {h.network && <Chip>{h.network}</Chip>}
            {h.year && <Chip>{h.year}</Chip>}
            {h.managed && (
              <Chip tone="accent">
                ★ {t("chip.managed")}
                {h.managed.dryRun ? ` · ${t("chip.dryRun")}` : ""}
              </Chip>
            )}
          </div>
          {h.nextEpisode && <p className="strong-line">⏱ {t("series.next", { label: sxe(h.nextEpisode.season, h.nextEpisode.episode), when: airLabel(h.nextEpisode.airUtc) })}</p>}
          <p>
            {t("series.have", { have: h.counts.have, aired: h.counts.aired })}
            {h.counts.missing ? <span className="warn-text"> · {t("series.missing", { n: h.counts.missing })}</span> : null}
            {!!h.language.have && h.language.withLang !== h.language.have && (
              <span className="warn-text"> · {t("series.langSome", { lang: h.language.lang.toUpperCase(), n: h.language.withLang, have: h.language.have })}</span>
            )}
            {!!h.language.have && h.language.withLang === h.language.have && <span className="muted"> · {t("series.langAll", { lang: h.language.lang.toUpperCase() })}</span>}
          </p>
          {h.overview && <Synopsis text={h.overview} />}
          <div className="row hero-actions">
            {!!missingAll.length && <SeasonSearch tvdbId={tvdbId} missing={missingAll} dryRun={dryRun} primary onDone={() => (void d.reload(), void act.reload())} />}
            <button className="small" onClick={() => setPanel("watch")} aria-haspopup="dialog">
              {t("profiles.watchAs")}: {h.profile.name} · {t(`mode.${h.profile.watchMode}` as I18nKey)}
            </button>
          </div>
        </div>
      </header>
      {!h.allowed && <p className="banner warn">{t("series.outsideRoot")}</p>}

      <div className="tabs" role="tablist" aria-label={h.title}>
        {tabs
          .filter((x) => !x.hidden)
          .map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
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
          <div className="row between episodes-toolbar">
            <span className="muted small">{t("show.epCount", { n: s.rows.filter((r) => !r.movie).length })}</span>
            <div className="row">
              <div className="seg" role="group" aria-label={t("ep.view")}>
                <button className={!grid ? "on" : ""} aria-pressed={!grid} onClick={() => (setGrid(false), store.set("episodeGrid", false))}>
                  {t("ep.list")}
                </button>
                <button className={grid ? "on" : ""} aria-pressed={grid} onClick={() => (setGrid(true), store.set("episodeGrid", true))}>
                  {t("ep.grid")}
                </button>
              </div>
              <button className="small" aria-pressed={selecting} onClick={() => (setSelecting(!selecting), setSel(new Set()))}>
                {selecting ? t("ep.selectDone") : t("ep.select")}
              </button>
            </div>
          </div>
          {!s.rows.length && <Empty icon="▤">{t("show.noEpisodes")}</Empty>}
      {seasons.map(([season, rows], i) => {
        const missing = rows.filter((r) => r.status === "missing" && !r.movie && r.special?.cls !== "junk");
        const nextId = rows.filter((r) => r.status === "unaired" && r.airUtc).sort((a, b) => a.airUtc! - b.airUtc!)[0]?.id;
        return (
          <details key={season} className="season card" open={i === 0}>
            <summary className="season-head">
              <strong>{season === 0 ? t("series.specials") : t("common.season", { n: season })}</strong>
              <span className="muted small">
                {rows.filter((r) => r.status === "have").length}/{rows.filter((r) => r.status !== "unaired").length}
              </span>
              {!!missing.length && <SeasonSearch tvdbId={tvdbId} missing={missing} dryRun={dryRun} onDone={() => (void d.reload(), void act.reload())} />}
              {selecting && (
                <button className="small ghost" onClick={(e) => (e.preventDefault(), setSel((x) => new Set([...x, ...rows.map((r) => r.id)])))}>
                  {t("shows.selectAll")}
                </button>
              )}
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
                {ordered(season === 0 ? rows.filter((r) => r.special?.cls !== "junk") : rows, nextId).main.map((r) => (
                  <li key={r.id} className={`ep-row${r.id === nextId ? " next" : ""}${sel.has(r.id) ? " selected" : ""}`}>
                    {selecting && <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={sxe(r.season, r.episode)} />}
                    <button className="ep-main" onClick={() => (selecting ? toggle(r.id) : setOpen(r.id))}>
                      <span className="ep-num">{r.episode}</span>
                      <span className="ep-text">
                        <span className="ep-title clamp2" title={r.title ?? undefined}>
                          {r.title ?? t("ep.tba")} {r.id === nextId && <Chip tone="accent">{t("ep.next")}</Chip>}
                          {r.movie && <Chip tone="info">🎬 {t("ep.movieChip")}</Chip>}
                          {r.file?.changed && <Chip tone="info" title={t("ep.changed")}>{t("ep.reencodedChip")}</Chip>}
                          {r.special && !r.movie && <Chip tone={r.special.cls === "junk" ? "info" : "accent"}>{t(`special.${r.special.type}` as I18nKey)}</Chip>}
                        </span>
                        <span className="ep-meta muted small">
                          {airLabel(r.airUtc)}
                          {season === 0 && r.runtime ? ` · ${t("ep.minutes", { n: r.runtime })}` : ""}
                          {r.file?.size ? ` · ${fmtSize(r.file.size)}` : ""}
                        </span>
                      </span>
                      <span className="ep-status">
                        <StatusPill e={r} lang={lang} />
                      </span>
                    </button>
                  </li>
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
                      <li key={r.id} className="ep-row">
                        <button className="ep-main" onClick={() => setOpen(r.id)}>
                          <span className="ep-num">{r.episode}</span>
                          <span className="ep-text">
                            <span className="ep-title clamp2" title={r.title ?? undefined}>
                              {r.title ?? t("ep.tba")} <Chip tone="info">{t(`special.${r.special!.type}` as I18nKey)}</Chip>
                            </span>
                            <span className="ep-meta muted small">
                              {airLabel(r.airUtc)}
                              {r.runtime ? ` · ${t("ep.minutes", { n: r.runtime })}` : ""}
                            </span>
                          </span>
                          <span className="ep-status">
                            <StatusPill e={r} lang={lang} />
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </details>
            )}
            {!grid && ordered(season === 0 ? rows.filter((r) => r.special?.cls !== "junk") : rows, nextId).later.length > 0 && (
              <details className="later">
                <summary className="muted small">{t("ep.upcoming", { n: ordered(season === 0 ? rows.filter((r) => r.special?.cls !== "junk") : rows, nextId).later.length })}</summary>
                <ul className="ep-list">
                  {ordered(season === 0 ? rows.filter((r) => r.special?.cls !== "junk") : rows, nextId).later.map((r) => (
                    <li key={r.id} className="ep-row">
                      <button className="ep-main" onClick={() => setOpen(r.id)}>
                        <span className="ep-num">{r.episode}</span>
                        <span className="ep-text">
                          <span className="ep-title clamp2">{r.title ?? t("ep.tba")}</span>
                          <span className="ep-meta muted small">{airLabel(r.airUtc)}</span>
                        </span>
                        <span className="ep-status">
                          <StatusPill e={r} lang={lang} />
                        </span>
                      </button>
                    </li>
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
function SeasonSearch({ tvdbId, missing, dryRun, onDone, primary = false }: { tvdbId: number; missing: EpisodeRow[]; dryRun: boolean; onDone: () => void; primary?: boolean }) {
  const list = missing.slice(0, 26);
  const a = useEpisodeActions({ tvdbId, episodes: list.map((r) => ({ id: r.id, label: sxe(r.season, r.episode) })), managedLive: false, dryRun, onDone });
  return (
    <span className="season-search" onClick={(e) => e.preventDefault()}>
      <SplitButton small primary={primary} label={`⚡ ${t("ep.findMissing", { n: list.length })}`} onClick={a.auto} disabled={a.autoBusy} items={[{ label: t("auto.chooseRelease"), onSelect: a.search }]} />
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
