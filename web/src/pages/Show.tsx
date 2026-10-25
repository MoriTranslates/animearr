import { useEffect, useMemo, useState } from "react";
import { api, fmtSize, store, sxe, type Decision } from "../api";
import { navigate } from "../App";
import { airLabel, EpisodeSheet, StatusPill, useEpisodeActions, type EpisodeRow } from "../episodes";
import { t } from "../i18n";
import { Chip, Cover, ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";
import { DecisionCard } from "./Activity";

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
  links: { anilist: string | null; anidb: string | null; tvdb: string };
  managed: { dryRun: boolean } | null;
  allowed: boolean;
}

interface ShowData {
  header: Header;
  rows: EpisodeRow[];
  anidb: { aid: number; season: number | "a" | null; offset: number; title: string | null }[];
  aliases: { id: number; title: string; season: number | null; source: string }[];
  rules: { id: number; grp: string | null; mode: string; season: number | null; offset: number }[];
  facts: { id: number; season: number | null; kind: string; lang: string; note: string }[];
}

export function Show({ tvdbId }: { tvdbId: number }) {
  const d = useLoad(() => api<ShowData>(`/series/${tvdbId}`), [tvdbId]);
  const act = useLoad(() => api<Decision[]>(`/activity?tvdbId=${tvdbId}`), [tvdbId]);
  const status = useLoad(() => api<{ dryRun: boolean }>("/status"), []);
  usePageTitle(d.data?.header.title ?? "…");
  const [open, setOpen] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [grid, setGrid] = useState(() => store.get("episodeGrid", false));

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
  const selected = (d.data?.rows ?? []).filter((r) => sel.has(r.id));
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

  return (
    <section>
      {/* ---------------- header */}
      <header className="series-hero card" style={h.banner ? { backgroundImage: `linear-gradient(180deg, color-mix(in srgb, var(--panel) 55%, transparent), var(--panel) 85%), url(${h.banner})` } : undefined}>
        <Cover src={h.cover} alt={h.title} size="lg" />
        <div className="stack hero-body">
          <h1 className="clamp2">{h.title}</h1>
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
          </p>
          {!!h.language.have && (
            <p className={h.language.withLang === h.language.have ? "good-text small" : "warn-text small"}>
              {h.language.withLang === h.language.have ? t("series.langAll", { lang: h.language.lang.toUpperCase() }) : t("series.langSome", { lang: h.language.lang.toUpperCase(), n: h.language.withLang, have: h.language.have })}
            </p>
          )}
          <div className="row small">
            {h.links.anilist && (
              <a href={h.links.anilist} target="_blank" rel="noreferrer">
                AniList ↗
              </a>
            )}
            {h.links.anidb && (
              <a href={h.links.anidb} target="_blank" rel="noreferrer">
                AniDB ↗
              </a>
            )}
            <a href={h.links.tvdb} target="_blank" rel="noreferrer">
              TVDB ↗
            </a>
          </div>
        </div>
      </header>
      {h.overview && (
        <details className="card pad synopsis-box">
          <summary>{t("series.synopsis")}</summary>
          <p className="muted">{h.overview}</p>
        </details>
      )}
      {!h.allowed && <p className="banner warn">{t("series.outsideRoot")}</p>}

      {/* ---------------- episodes */}
      <div className="row between episodes-toolbar">
        <h2>{t("show.episodes")}</h2>
        <div className="row">
          <div className="seg" role="group">
            <button className={!grid ? "on" : ""} onClick={() => (setGrid(false), store.set("episodeGrid", false))}>
              {t("ep.list")}
            </button>
            <button className={grid ? "on" : ""} onClick={() => (setGrid(true), store.set("episodeGrid", true))}>
              {t("ep.grid")}
            </button>
          </div>
          <button className="small" onClick={() => (setSelecting(!selecting), setSel(new Set()))}>
            {selecting ? t("ep.selectDone") : t("ep.select")}
          </button>
        </div>
      </div>
      {seasons.map(([season, rows], i) => {
        const missing = rows.filter((r) => r.status === "missing");
        const nextId = rows.filter((r) => r.status === "unaired" && r.airUtc).sort((a, b) => a.airUtc! - b.airUtc!)[0]?.id;
        return (
          <details key={season} className="season card" open={i === 0}>
            <summary className="season-head">
              <strong>{season === 0 ? t("series.specials") : t("common.season", { n: season })}</strong>
              <span className="muted small">
                {rows.filter((r) => r.status === "have").length}/{rows.filter((r) => r.status !== "unaired").length}
              </span>
              {!!missing.length && (
                <button className="small" onClick={(e) => (e.preventDefault(), navigate(`/search?tvdbId=${tvdbId}&eps=${missing.slice(0, 26).map((r) => r.id).join(",")}`))}>
                  {t("ep.searchMissing", { n: missing.length })}
                </button>
              )}
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
                {ordered(rows, nextId).main.map((r) => (
                  <li key={r.id} className={`ep-row${r.id === nextId ? " next" : ""}${sel.has(r.id) ? " selected" : ""}`}>
                    {selecting && <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={sxe(r.season, r.episode)} />}
                    <button className="ep-main" onClick={() => (selecting ? toggle(r.id) : setOpen(r.id))}>
                      <span className="ep-num">{r.episode}</span>
                      <span className="ep-text">
                        <span className="ep-title clamp2">
                          {r.title ?? t("ep.tba")} {r.id === nextId && <Chip tone="accent">{t("ep.next")}</Chip>}
                        </span>
                        <span className="ep-meta muted small">
                          {airLabel(r.airUtc)}
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
            {!grid && ordered(rows, nextId).later.length > 0 && (
              <details className="later">
                <summary className="muted small">{t("ep.upcoming", { n: ordered(rows, nextId).later.length })}</summary>
                <ul className="ep-list">
                  {ordered(rows, nextId).later.map((r) => (
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

      {/* ---------------- advanced (power-user settings) */}
      <Advanced s={s} tvdbId={tvdbId} path={h.path} onChanged={() => (void d.reload(), void act.reload())} />

      <h2 className="section-title">{t("nav.activity")}</h2>
      <div className="list">{(act.data ?? []).slice(0, 10).map((x) => <DecisionCard key={x.id} d={x} onUndone={act.reload} />)}</div>

      {selecting && !!sel.size && (
        <div className="bulkbar card">
          <span>{t("ep.selected", { n: sel.size })}</span>
          <div className="row">
            <button onClick={bulk.search}>⌕ {t("ep.search")}</button>
            <button onClick={bulk.regrab}>↻ {t("ep.regrab")}</button>
            <button className="danger" onClick={bulk.remove} disabled={!selected.some((r) => r.file)}>
              🗑 {t("ep.delete")}
            </button>
          </div>
        </div>
      )}
      {bulk.ui}
      {open !== null && <EpisodeSheet episodeId={open} onClose={() => setOpen(null)} onChanged={() => (void d.reload(), void act.reload())} managedLive={managedLive} dryRun={dryRun} lang={lang} />}
    </section>
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
