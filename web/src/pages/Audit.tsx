import { useState } from "react";
import { api, fmtSize, sxe } from "../api";
import { Link, navigate, query } from "../App";
import { QualityUpgradesPanel } from "../quality";
import { ShowLink, useEpisodeActions } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Confirm, Cover, dateTime, Empty, ErrorBox, Menu, Spinner, SplitButton, useLoad, usePageTitle, useToast, Why, ReleaseName } from "../ui";
import { ReleaseLine } from "./Queue";

type Tab = "gaps" | "language" | "specials" | "maintenance";
type Maint = "checks" | "upgrades" | "quality" | "duplicates" | "recycle";

/** Audit: three read-only reports, plus Maintenance (after-import checks, dual-audio and quality upgrades, recycle bin). */
export function Audit() {
  usePageTitle(t("audit.title"));
  const q = query().get("tab") ?? "gaps";
  const [tab, setTab] = useState<Tab>(["checks", "upgrades", "quality", "duplicates", "recycle", "maintenance"].includes(q) ? "maintenance" : ["language", "gaps", "specials"].includes(q) ? (q as Tab) : "gaps");
  const [maint, setMaint] = useState<Maint>(["upgrades", "quality", "duplicates", "recycle"].includes(q) ? (q as Maint) : "checks");
  const pick = (x: Tab, m: Maint = maint) => {
    setTab(x);
    setMaint(m);
    history.replaceState(null, "", `/audit?tab=${x === "maintenance" ? m : x}`);
  };
  return (
    <section>
      <h1>{t("audit.title")}</h1>
      <div className="tabs" role="tablist">
        {(["gaps", "language", "specials", "maintenance"] as Tab[]).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => pick(x)}>
            {t(`audit.tab.${x}` as I18nKey)}
          </button>
        ))}
      </div>
      <p className="muted small">{t(tab === "maintenance" && maint !== "recycle" ? "repair.notReadOnly" : "audit.readOnly")}</p>
      {tab === "maintenance" && (
        <div className="seg self-start" role="group" aria-label={t("audit.tab.maintenance")}>
          {(["checks", "upgrades", "quality", "duplicates", "recycle"] as Maint[]).map((m) => (
            <button key={m} className={maint === m ? "on" : ""} aria-pressed={maint === m} onClick={() => pick("maintenance", m)}>
              {t(`audit.tab.${m}` as I18nKey)}
            </button>
          ))}
        </div>
      )}
      {tab === "gaps" && <Gaps />}
      {tab === "language" && <Language />}
      {tab === "specials" && <Specials />}
      {tab === "maintenance" && maint === "checks" && <Checks />}
      {tab === "maintenance" && maint === "recycle" && (
        <div className="stack">
          <OwnBin />
          <Recycle />
        </div>
      )}
      {tab === "maintenance" && maint === "upgrades" && <Upgrades />}
      {tab === "maintenance" && maint === "quality" && <QualityUpgradesPanel />}
      {tab === "maintenance" && maint === "duplicates" && <Duplicates />}
    </section>
  );
}

/** "S1 · 1–12, 15" per season: a summary instead of a wall of episode links. */
function ranges(eps: { season: number; episode: number }[]) {
  const bySeason = new Map<number, number[]>();
  for (const e of eps) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e.episode]);
  return [...bySeason]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => {
      const nums = [...new Set(list)].sort((a, b) => a - b);
      const parts: string[] = [];
      for (let i = 0; i < nums.length; ) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        parts.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
        i = j + 1;
      }
      return { season, text: parts.join(", "), n: nums.length };
    });
}

interface GapSeries { seriesId: number; tvdbId: number; title: string; cover: string | null; status: string; missing: { id: number; season: number; episode: number; title: string | null; airUtc: number | null }[]; missingSeasons: { season: number; aired: number; monitored: boolean }[] }

function Gaps() {
  const d = useLoad(() => api<{ series: GapSeries[]; episodes: number; seasons: number }>("/audit/gaps"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="stack">
      <p className="muted">{t("audit.gaps.intro")}</p>
      <p>
        <strong>{t("audit.gaps.total", { episodes: d.data.episodes, seasons: d.data.seasons })}</strong>
      </p>
      {!d.data.series.length && <Empty icon="✓" title={t("audit.allGood")}>{t("audit.gaps.empty")}</Empty>}
      <div className="list">
        {d.data.series.map((s) => (
          <article key={s.tvdbId} className="card show-card">
            <div className="show-body">
              <ShowLink tvdbId={s.tvdbId} title={s.title} className="show-card-head">
                <Cover src={s.cover} alt={s.title} size="sm" />
                <span className="strong clamp2">{s.title}</span>
              </ShowLink>
              {!!s.missingSeasons.length && (
                <div className="chips">
                  {s.missingSeasons.map((m) => (
                    <Chip key={m.season} tone="warn">
                      {t("audit.gaps.missingSeason", { n: m.season, aired: m.aired })}
                    </Chip>
                  ))}
                </div>
              )}
              {!!s.missing.length && (
                <ul className="plain small gap-ranges">
                  {ranges(s.missing).map((r) => (
                    <li key={r.season}>
                      <span className="mono">{r.season === 0 ? t("series.specials") : `S${r.season}`}</span> · {t("audit.gaps.range", { eps: r.text, n: r.n })}
                    </li>
                  ))}
                </ul>
              )}
              {!!s.missing.length && <GapSearch tvdbId={s.tvdbId} missing={s.missing} onDone={() => void d.reload()} />}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

interface LangGroup { seriesId: number; tvdbId: number; title: string; cover: string | null; season: number; files: { id: number; name: string; group: string | null; audio: string[]; subs: string[]; reason: string }[] }

function Language() {
  const toast = useToast();
  const [sidecars, setSidecars] = useState(false);
  const d = useLoad(() => api<{ profile: string[]; checkedFiles: number; series: LangGroup[]; confirmed: { tvdbId: number; title: string; season: number; files: number }[]; movies: { movieId: number; title: string; cover: string | null; group: string | null; reason: string }[] }>(`/audit/language${sidecars ? "?sidecars=1" : ""}`), [sidecars]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const lang = d.data.profile[0] ?? "en";
  return (
    <div className="stack">
      <p className="muted">{t("audit.lang.intro", { langs: d.data.profile.join(", ") })}</p>
      <label className="check">
        <input type="checkbox" checked={sidecars} onChange={(e) => setSidecars(e.target.checked)} /> {t("audit.lang.sidecars")}
      </label>
      <p className="muted small">{t("audit.lang.checked", { n: d.data.checkedFiles })}</p>
      {!d.data.series.length && !d.data.movies.length && <Empty icon="✓" title={t("audit.allGood")}>{t("audit.lang.empty")}</Empty>}
      <div className="list">
        {d.data.series.map((g) => (
          <article key={`${g.tvdbId}-${g.season}`} className="card show-card">
            <div className="show-body">
              <div className="row between no-wrap">
                <ShowLink tvdbId={g.tvdbId} title={g.title} className="show-card-head">
                  <Cover src={g.cover} alt={g.title} size="sm" />
                  <span className="stack">
                    <span className="strong clamp2">{g.title}</span>
                    <span className="muted small">
                      {t("common.season", { n: g.season })} · {t("audit.lang.files", { n: g.files.length })}
                    </span>
                  </span>
                </ShowLink>
                <Menu
                  label={`${g.title}: ${t("common.moreActions")}`}
                  items={[
                    {
                      label: t("audit.lang.markBurned", { lang }),
                      onSelect: async () => {
                        try {
                          await api("/facts", { body: { tvdbId: g.tvdbId, season: g.season, kind: "burned_in", lang } });
                          toast(t("audit.lang.marked", { season: g.season }));
                          await d.reload();
                        } catch (e) {
                          toast((e as Error).message, true);
                        }
                      },
                    },
                  ]}
                />
              </div>
              <p className="small muted">{g.files[0].reason}</p>
              {g.files.length > 1 && <Why summary={t("audit.lang.allFiles", { n: g.files.length })} lines={g.files.map((f) => `${f.name}${f.group ? ` [${f.group}]` : ""}: ${f.reason}`)} />}
            </div>
          </article>
        ))}
      </div>
      {!!d.data.movies.length && (
        <>
          <h2 className="section-title">{t("audit.lang.movies")}</h2>
          <div className="list">
            {d.data.movies.map((m) => (
              <article key={m.movieId} className="card show-card">
                <Cover src={m.cover} alt={m.title} size="sm" />
                <div className="show-body">
                  <strong>{m.title}</strong>
                  <p className="small muted">{m.reason}</p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {!!d.data.confirmed.length && (
        <>
          <h2 className="section-title">{t("audit.lang.confirmed")}</h2>
          <div className="chips">
            {d.data.confirmed.map((c) => (
              <Chip key={`${c.tvdbId}-${c.season}`} tone="info">
                {c.title} · {t("common.season", { n: c.season })}
              </Chip>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SpecialSeries { tvdbId: number; title: string; cover: string | null; items: { id: number; episode: number; title: string | null; runtime: number | null; hasFile: boolean; cls: "movie" | "real" | "junk" | "unknown" | "creditless"; why: string; radarr: { inRadarr: boolean; title?: string; movieId?: number } | null }[] }

function Specials() {
  const [junk, setJunk] = useState(false);
  const d = useLoad(() => api<{ series: SpecialSeries[]; totals: Record<string, number> }>("/audit/specials"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const tone = { movie: "accent", real: "good", junk: "info", unknown: "warn", creditless: "good" } as const;
  return (
    <div className="stack">
      <p className="muted">{t("audit.specials.intro")}</p>
      <p>
        <strong>{t("audit.specials.totals", { movie: d.data.totals.movie, inRadarr: d.data.totals.movieInRadarr, real: d.data.totals.real, junk: d.data.totals.junk, unknown: d.data.totals.unknown, creditless: d.data.totals.creditless ?? 0 })}</strong>
      </p>
      <label className="check">
        <input type="checkbox" checked={junk} onChange={(e) => setJunk(e.target.checked)} /> {t("audit.specials.showJunk")}
      </label>
      <div className="list">
        {d.data.series
          .map((s) => ({ ...s, items: s.items.filter((i) => junk || i.cls !== "junk") }))
          .filter((s) => s.items.length)
          .map((s) => (
            <article key={s.tvdbId} className="card show-card">
              <div className="show-body">
                <ShowLink tvdbId={s.tvdbId} title={s.title} className="show-card-head">
                  <Cover src={s.cover} alt={s.title} size="sm" />
                  <span className="strong clamp2">{s.title}</span>
                </ShowLink>
                <ul className="plain">
                  {s.items.map((i) => (
                    <li key={i.id}>
                      <details className="special-item">
                        <summary className="special-row">
                          <span className={`dot ${tone[i.cls] === "accent" ? "info" : tone[i.cls]}`} aria-hidden="true" />
                          <span className="mono">S00E{String(i.episode).padStart(2, "0")}</span>
                          <span className="muted small">{t(`audit.specials.${i.cls}`)}</span>
                          <span className="clamp1 grow">{i.title ?? "—"}</span>
                          {i.hasFile && <span className="quiet-status"><span className="dot good" aria-hidden="true" />{t("ep.status.have")}</span>}
                        </summary>
                        <div className="stack small special-detail">
                          <p className="muted">{i.why}</p>
                          {i.radarr && <span className={i.radarr.inRadarr ? "good-text" : "warn-text"}>{i.radarr.inRadarr ? t("audit.specials.inRadarr", { title: i.radarr.title }) : t("audit.specials.notInRadarr")}</span>}
                          {i.radarr?.movieId && <Link to={`/movie/${i.radarr.movieId}`}>{t("ep.openMovie")} →</Link>}
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
      </div>
    </div>
  );
}

interface Check { history_id: number; tvdb_id: number; episode_id: number; release: string; ok: number; action: string; why: string; at: number; title: string | null; label: string | null }

const CHECK_TONE: Record<string, "good" | "accent" | "info" | "warn" | "bad"> = { none: "good", skipped: "info", unchecked: "info", suspected: "info", "would-repair": "warn", capped: "warn", "gave-up": "bad", error: "bad", repaired: "accent" };

/** After-import checks: every file that landed in the allowed root folders, checked against its show's profile. */
function Checks() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const d = useLoad(() => api<{ mode: string; checks: Check[] }>("/repair/recent"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ done: boolean; reason?: string; checked?: number; bad?: number }>("/repair/run", { body: {} });
      if (r.done) toast(t("repair.ran", { n: r.checked ?? 0, bad: r.bad ?? 0 }));
      else toast(t(`repair.notRun.${r.reason ?? "error"}` as I18nKey), r.reason !== "running");
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p className="muted">{t("repair.intro", { mode: t(`repair.mode.${d.data.mode}` as I18nKey) })}</p>
      <button className="small self-start" disabled={busy || d.data.mode === "off"} onClick={() => void run()}>
        {busy ? t("common.working") : t("repair.runNow")}
      </button>
      {!d.data.checks.length && <Empty icon="✓">{t("repair.empty")}</Empty>}
      {d.data.checks.some((c) => c.action === "skipped" || c.action === "unchecked") && (
        <label className="check small">
          <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> {t("repair.showSkipped", { n: d.data.checks.filter((c) => c.action === "skipped" || c.action === "unchecked").length })}
        </label>
      )}
      <div className="list">
        {d.data.checks.filter((c) => showSkipped || (c.action !== "skipped" && c.action !== "unchecked")).map((c) => (
          <article key={c.history_id} className="card pad stack">
            <div className="row between">
              <Chip tone={CHECK_TONE[c.action] ?? "info"}>
                {c.action === "none" ? "✓ " : c.action === "repaired" ? "↻ " : c.ok ? "" : "✕ "}
                {t(`repair.action.${c.action}` as I18nKey)}
              </Chip>
              <span className="muted small">{dateTime(c.at)}</span>
            </div>
            {c.title && (
              <ShowLink tvdbId={c.tvdb_id} title={c.title}>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <strong className="clamp2">{c.title}</strong>
                  {c.label && <span className="muted small">{c.label}</span>}
                </span>
              </ShowLink>
            )}
            <ReleaseLine release={c.release} />
            <p className="small">{c.why}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

interface RecycleItem { path: string; series: string | null; tvdbId: number | null; size: number; deletedAt: number; purgeAt: number | null }

/** AnimeArr's own recycling bin: replaced files, kept N days, purged daily; "Empty bin now". */
function OwnBin() {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const d = useLoad(() => api<{ path: string; days: number; error: string | null; files: number; bytes: number; nextPurge: number | null; oldest: number | null }>("/recycle/animearr"), []);
  if (!d.data) return null;
  const b = d.data;
  return (
    <div className="card pad stack">
      <h3>{t("bin.title")}</h3>
      {b.error ? (
        <p className="warn-text small">{b.error}</p>
      ) : (
        <>
          <p className="small">
            {t("bin.summary", { path: b.path, n: b.files, size: fmtSize(b.bytes) })} · {b.days ? t("bin.keeps", { days: b.days }) : t("bin.forever")}
          </p>
          {b.nextPurge && <p className="muted small">{t("bin.next", { when: dateTime(b.nextPurge) })}</p>}
          <div className="row">
            <button type="button" className="small danger" disabled={!b.files} onClick={() => setAsk(true)}>
              {t("bin.empty")}
            </button>
          </div>
        </>
      )}
      {ask && (
        <Confirm
          danger
          title={t("bin.emptyTitle")}
          confirmLabel={t("bin.empty")}
          onClose={() => setAsk(false)}
          onConfirm={async () => {
            try {
              const r = await api<{ deleted: number; bytes: number }>("/recycle/animearr/empty", { body: { confirm: true } });
              toast(t("bin.emptied", { n: r.deleted, size: fmtSize(r.bytes) }));
              setAsk(false);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("bin.emptyBody", { n: b.files, size: fmtSize(b.bytes) })}</p>
        </Confirm>
      )}
    </div>
  );
}

/** Sonarr's recycle bin, anime shows only (read-only: restore by moving the file back). */
function Recycle() {
  const [fresh, setFresh] = useState(0);
  const d = useLoad(() => api<{ configured: boolean; path: string; cleanupDays: number; reachable: boolean; items: RecycleItem[]; totalCount: number; totalBytes: number; truncated: boolean; error?: string }>(`/recycle${fresh ? "?fresh=1" : ""}`), [fresh]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const r = d.data;
  if (r.error) return <ErrorBox error={r.error} retry={d.reload} />;
  const refresh = (
    <button className="small self-start" onClick={() => setFresh((x) => x + 1)}>
      {t("recycle.refresh")}
    </button>
  );
  if (!r.configured)
    return (
      <div className="stack">
        <p className="warn-text">⚠ {t("recycle.none")}</p>
        {refresh}
      </div>
    );
  return (
    <div className="stack">
      <p className="muted">{r.cleanupDays ? t("recycle.intro", { path: r.path, days: r.cleanupDays }) : t("recycle.introForever", { path: r.path })}</p>
      {!r.reachable && <p className="muted small">{t("recycle.unreachable")}</p>}
      {r.reachable && !r.items.length && <Empty>{t("recycle.empty")}</Empty>}
      {refresh}
      {r.reachable && !!r.items.length && <p className="small">{t("recycle.total", { n: r.totalCount, size: fmtSize(r.totalBytes) })}{r.truncated ? ` ${t("recycle.truncated", { n: r.items.length })}` : ""}</p>}
      <div className="list">
        {r.items.map((i) => (
          <article key={i.path} className="card pad stack">
            {i.tvdbId && i.series ? (
              <ShowLink tvdbId={i.tvdbId} title={i.series}>
                <strong className="clamp2">{i.series}</strong>
              </ShowLink>
            ) : null}
            <p className="mono small">{i.path}</p>
            <p className="muted small">
              {t("recycle.item", { size: fmtSize(i.size), when: dateTime(i.deletedAt) })}
              {i.purgeAt ? ` · ${t("recycle.purge", { when: dateTime(i.purgeAt) })}` : ""}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}

interface Upgrade { episodeId: number; tvdbId: number; title: string; label: string; audio: string[]; dub: string[]; state: string; lastAt: number | null; why: string; release: string | null }
const UPGRADE_TONE: Record<string, "good" | "accent" | "info" | "warn"> = { waiting: "info", found: "accent", grabbed: "good", upgraded: "good" };

/** Sub-only placeholders in dual-mode shows, waiting for a dual-audio release. */
function Upgrades() {
  const d = useLoad(() => api<{ mode: string; items: Upgrade[]; movies: { movieId: number; title: string; audio: string[]; dub: string[]; state: string; lastAt: number | null; why: string; release: string | null }[] }>("/upgrades"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="stack">
      <p className="muted">{t("dual.intro", { mode: t(d.data.mode === "auto" ? "dual.auto" : (`repair.mode.${d.data.mode}` as I18nKey)) })}</p>
      {d.data.mode === "off" && <p className="warn-text">{t("dual.offNote")}</p>}
      {!d.data.items.length && !d.data.movies.length && <Empty>{t("dual.empty")}</Empty>}
      <div className="list" hidden={!d.data.movies.length}>
        {d.data.movies.map((u) => (
          <article key={`m${u.movieId}`} className="card pad stack">
            <Link to={`/movie/${u.movieId}`} className="card-link">
              <strong className="clamp2">🎬 {u.title}</strong>
            </Link>
            <div className="row">
              <Chip tone={UPGRADE_TONE[u.state] ?? "info"}>{t(`dual.state.${u.state}` as I18nKey)}</Chip>
              <span className="muted small">{t("dual.audioNow", { audio: u.audio.join("/"), dub: u.dub.join("/") })}</span>
            </div>
            {u.release && <p className="small"><ReleaseName name={u.release} /></p>}
            <p className="small">{u.why}</p>
          </article>
        ))}
      </div>
      <div className="list">
        {d.data.items.map((u) => (
          <article key={u.episodeId} className="card pad stack">
            <ShowLink tvdbId={u.tvdbId} title={u.title}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <strong className="clamp2">{u.title}</strong>
                <span className="muted small">{u.label}</span>
              </span>
            </ShowLink>
            <div className="row">
              <Chip tone={UPGRADE_TONE[u.state] ?? "info"}>{t(`dual.state.${u.state}` as I18nKey)}</Chip>
              <span className="muted small">{t("dual.audioNow", { audio: u.audio.join("/"), dub: u.dub.join("/") })}</span>
            </div>
            {u.release && <p className="small"><ReleaseName name={u.release} /></p>}
            <p className="small">
              {u.why}
              {u.lastAt ? ` · ${dateTime(u.lastAt)}` : ""}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}

interface Dup { tvdbId: number; title: string; managed: boolean; sonarr: boolean; sonarrUrl: string; otherTvdbId: number; otherTitle: string; mine: string; there: string; mineFiles: { files: number; total: number }; thereFiles: { files: number; total: number }; blocking: boolean }

/** Shows TVDB lists twice (found from catalog ids): which episodes overlap, file counts, and how to retire the copy. */
function Duplicates() {
  const toast = useToast();
  const d = useLoad(() => api<{ items: Dup[] }>("/audit/duplicates"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const stop = async (x: Dup) => {
    try {
      await api("/managed", { body: { tvdbIds: [x.tvdbId], on: false } });
      toast(t("dup.stopped", { title: x.title }));
      d.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  return (
    <div className="stack">
      <p className="muted">{t("dup.intro")}</p>
      {!d.data.items.length && <Empty>{t("dup.empty")}</Empty>}
      <div className="list">
        {d.data.items.map((x) => (
          <article key={`${x.tvdbId}|${x.otherTvdbId}`} className="card pad stack">
            <div className="row">
              <ShowLink tvdbId={x.tvdbId} title={x.title}>
                <strong className="clamp2">{x.title}</strong>
              </ShowLink>
              <span className="muted">≈</span>
              <ShowLink tvdbId={x.otherTvdbId} title={x.otherTitle}>
                <strong className="clamp2">{x.otherTitle}</strong>
              </ShowLink>
            </div>
            <p className="small">{t("dup.overlap", { mine: x.mine, there: x.there, other: x.otherTitle })}</p>
            <div className="row">
              <Chip tone={x.blocking ? "good" : "warn"}>{t(x.blocking ? "dup.blocking" : "dup.notBlocking")}</Chip>
              <span className="muted small">{t("dup.files", { a: x.mineFiles.files, b: x.mineFiles.total, c: x.thereFiles.files, d: x.thereFiles.total })}</span>
            </div>
            {x.managed && (
              <div className="row">
                <button className="small" onClick={() => void stop(x)}>{t("dup.stop")}</button>
              </div>
            )}
            {x.sonarr && (
              <p className="muted small">
                {t("dup.sonarrHow", { title: x.title })} {x.sonarrUrl && <a href={x.sonarrUrl} target="_blank" rel="noreferrer">{t("dup.openSonarr")}</a>}
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/** "Find missing (n)" for a show on the Gaps list; the caret picks releases (or opens the show). */
function GapSearch({ tvdbId, missing, onDone }: { tvdbId: number; missing: { id: number; season: number; episode: number }[]; onDone: () => void }) {
  const list = missing.slice(0, 26);
  const a = useEpisodeActions({ tvdbId, episodes: list.map((e) => ({ id: e.id, label: sxe(e.season, e.episode) })), managedLive: false, dryRun: false, onDone });
  return (
    <div className="row">
      <SplitButton small primary={false} label={`⚡ ${t("ep.findMissing", { n: list.length })}`} onClick={a.auto} disabled={a.autoBusy} items={[{ label: t("auto.chooseRelease"), onSelect: a.search }, { label: t("audit.openShow"), onSelect: () => navigate(`/show/${tvdbId}`) }]} />
      {a.ui}
    </div>
  );
}
