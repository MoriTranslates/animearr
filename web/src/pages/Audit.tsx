import { useState } from "react";
import { api, fmtSize, sxe } from "../api";
import { navigate, query } from "../App";
import { ShowLink } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Cover, dateTime, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast, Why } from "../ui";

type Tab = "language" | "gaps" | "specials" | "checks" | "recycle";

export function Audit() {
  usePageTitle(t("audit.title"));
  const initial = (query().get("tab") as Tab) || "gaps";
  const [tab, setTab] = useState<Tab>(["language", "gaps", "specials", "checks", "recycle"].includes(initial) ? initial : "gaps");
  const pick = (x: Tab) => {
    setTab(x);
    history.replaceState(null, "", `/audit?tab=${x}`);
  };
  return (
    <section>
      <h1>{t("audit.title")}</h1>
      <p className="muted small">{t(tab === "checks" ? "repair.notReadOnly" : "audit.readOnly")}</p>
      <div className="tabs" role="tablist">
        {(["gaps", "language", "specials", "checks", "recycle"] as Tab[]).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => pick(x)}>
            {t(`audit.tab.${x}`)}
          </button>
        ))}
      </div>
      {tab === "gaps" && <Gaps />}
      {tab === "language" && <Language />}
      {tab === "specials" && <Specials />}
      {tab === "checks" && <Checks />}
      {tab === "recycle" && <Recycle />}
    </section>
  );
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
      {!d.data.series.length && <Empty>{t("audit.gaps.empty")}</Empty>}
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
                <div className="chips">
                  {s.missing.slice(0, 24).map((e) => (
                    <button key={e.id} className="chip link" title={e.title ?? ""} onClick={() => navigate(`/search?tvdbId=${s.tvdbId}&eps=${e.id}`)}>
                      {sxe(e.season, e.episode)}
                    </button>
                  ))}
                  {s.missing.length > 24 && <span className="muted small">+{s.missing.length - 24}</span>}
                </div>
              )}
              <button className="small self-start" onClick={() => navigate(`/search?tvdbId=${s.tvdbId}&eps=${s.missing.slice(0, 26).map((e) => e.id).join(",")}`)} disabled={!s.missing.length}>
                {t("audit.gaps.deep")}
              </button>
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
      {!d.data.series.length && !d.data.movies.length && <Empty>{t("audit.lang.empty")}</Empty>}
      <div className="list">
        {d.data.series.map((g) => (
          <article key={`${g.tvdbId}-${g.season}`} className="card show-card">
            <div className="show-body">
              <ShowLink tvdbId={g.tvdbId} title={g.title} className="show-card-head">
                <Cover src={g.cover} alt={g.title} size="sm" />
                <span className="stack">
                  <span className="strong clamp2">{g.title}</span>
                  <Chip tone="info">
                    {t("common.season", { n: g.season })} · {t("audit.lang.files", { n: g.files.length })}
                  </Chip>
                </span>
              </ShowLink>
              <p className="small muted">{g.files[0].reason}</p>
              <Why summary={t("common.more")} lines={g.files.map((f) => `${f.name}${f.group ? ` [${f.group}]` : ""}: ${f.reason}`)} />
              <button
                className="small self-start"
                onClick={async () => {
                  try {
                    await api("/facts", { body: { tvdbId: g.tvdbId, season: g.season, kind: "burned_in", lang } });
                    toast(t("audit.lang.marked", { season: g.season }));
                    await d.reload();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {t("audit.lang.markBurned", { lang })}
              </button>
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

interface SpecialSeries { tvdbId: number; title: string; cover: string | null; items: { id: number; episode: number; title: string | null; runtime: number | null; hasFile: boolean; cls: "movie" | "real" | "junk" | "unknown"; why: string; radarr: { inRadarr: boolean; title?: string } | null }[] }

function Specials() {
  const [junk, setJunk] = useState(false);
  const d = useLoad(() => api<{ series: SpecialSeries[]; totals: Record<string, number> }>("/audit/specials"), []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const tone = { movie: "accent", real: "good", junk: "info", unknown: "warn" } as const;
  return (
    <div className="stack">
      <p className="muted">{t("audit.specials.intro")}</p>
      <p>
        <strong>{t("audit.specials.totals", { movie: d.data.totals.movie, inRadarr: d.data.totals.movieInRadarr, real: d.data.totals.real, junk: d.data.totals.junk, unknown: d.data.totals.unknown })}</strong>
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
                    <li key={i.id} className="special-row">
                      <span className="mono">S00E{String(i.episode).padStart(2, "0")}</span>
                      <Chip tone={tone[i.cls]}>{t(`audit.specials.${i.cls}`)}</Chip>
                      <span className="clamp2">{i.title ?? "—"}</span>
                      {i.hasFile && <Chip tone="good">✓</Chip>}
                      {i.radarr && <Chip tone={i.radarr.inRadarr ? "good" : "warn"}>{i.radarr.inRadarr ? t("audit.specials.inRadarr", { title: i.radarr.title }) : t("audit.specials.notInRadarr")}</Chip>}
                      <Why lines={[i.why]} />
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
      {!d.data.checks.length && <Empty>{t("repair.empty")}</Empty>}
      <div className="list">
        {d.data.checks.map((c) => (
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
            <p className="mono small">{c.release}</p>
            <p className="small">{c.why}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

interface RecycleItem { path: string; series: string | null; tvdbId: number | null; size: number; deletedAt: number; purgeAt: number | null }

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
