import { ArrowRight, CaptionsOff, ChevronRight, CircleAlert, Download, FileX, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, store, sxe, type Status } from "../api";
import { Link, navigate } from "../App";
import { EpisodeSheet, type EpisodeStatus } from "../episodes";
import { t } from "../i18n";
import { PosterCard } from "../posters";
import { Pill, SeasonHeader } from "../seasonal";
import { seasonOf, showVars } from "../season";
import { Cover, Empty, ErrorBox, Skeleton, thumbUrl, useLoad, usePageTitle } from "../ui";

interface CalEntry { episodeId: number; tvdbId: number; series: string; cover: string | null; color?: string | null; season: number; episode: number; title: string | null; airUtc: number; status: EpisodeStatus; progress: number | null; managed: boolean }
interface HomeData {
  airingShows: number;
  airingToday: CalEntry[];
  needs: { missing: { n: number; sample: string | null }; failed: { n: number; sample: string | null }; noLang: { n: number; series: number; lang: string } };
  downloading: { id: number; tvdbId: number; movieId: number | null; title: string; cover: string | null; color: string | null; label: string; release: string; protocol: string; client: string | null; clientName?: string; state: string; progress: number }[];
  justArrived: { tvdbId: number; title: string; cover: string | null; color: string | null; label: string; at: number }[];
  importsThisWeek: number;
  readyToBinge: { tvdbId: number; title: string; season: number; episodes: number; cover: string | null; color: string | null; finishedAt: number }[];
  thisWeek: CalEntry[];
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short" });

/** Home: what airs today, what needs you, what's downloading, what just arrived, what's ready to binge, this week. */
export function Home({ status }: { status: Status; onChanged: () => void }) {
  usePageTitle(t("home.title"));
  const d = useLoad(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return api<HomeData>(`/home?from=${midnight}${store.get("calManagedOnly", false) ? "&managed=1" : ""}`);
  }, []);
  const [open, setOpen] = useState<number | null>(null);
  // Downloads and today's statuses move on by themselves.
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && void d.reload(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const c = status.connected!;
  const steps = [
    { done: (c.sabnzbd || c.qbittorrent) && (c.prowlarr || c.sonarr), label: t("home.step.connect"), to: "/settings?tab=clients" },
    { done: !!status.allowedRoots?.length, label: t("home.step.root"), to: "/settings?tab=safety" },
    { done: (status.librarySeries ?? 0) > 0, label: t("home.step.add"), to: "/find" },
    { done: (status.managed ?? 0) > 0, label: t("home.step.manage"), to: "/shows" },
  ];
  const s = seasonOf();
  const h = d.data;
  const needN = h ? h.needs.missing.n + h.needs.failed.n : 0;
  const first = h?.airingToday.find((e) => e.cover);

  return (
    <section className="home">
      {steps.some((x) => !x.done) && (
        <div className="card pad stack">
          <h2>{t("home.start")}</h2>
          <ol className="checklist">
            {steps.map((x) => (
              <li key={x.label} className={x.done ? "done" : ""}>
                <span aria-hidden="true">{x.done ? "✓" : "○"}</span> {x.done ? x.label : <Link to={x.to}>{x.label}</Link>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <SeasonHeader
        sub={t("home.seasonSub", { week: s.week, weeks: s.weeks, shows: h?.airingShows ?? status.airingShows ?? 0, today: h?.airingToday.length ?? 0 })}
        right={
          h && (
            <>
              <Pill onClick={() => navigate("/calendar")}>
                <i className="d" aria-hidden="true" /> {t("home.pill.today", { n: h.airingToday.length })}
              </Pill>
              {!!h.downloading.length && (
                <Pill onClick={() => navigate("/queue")}>
                  <Download className="lucide" aria-hidden="true" /> {t("home.pill.downloading", { n: h.downloading.length })}
                </Pill>
              )}
              {needN > 0 && (
                <Pill tone="bad" onClick={() => navigate(h.needs.failed.n ? "/queue" : "/audit?tab=gaps")}>
                  <TriangleAlert className="lucide" aria-hidden="true" /> {t("home.pill.need", { n: needN })}
                </Pill>
              )}
            </>
          )
        }
      />
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {!h && !d.error && <Skeleton kind="home" />}
      {h && (
        <div className="home-grid">
          <div className="home-main stack">
            {/* ---------- needs you */}
            <section className="card side-card needs-phone" aria-label={t("home.needsYou")}>
              <div className="sec-hd">
                <h2>{t("home.needsYou")}</h2>
                <Link to="/audit" className="sec-link muted-link">
                  {t("nav.audit")} <ChevronRight className="lucide" aria-hidden="true" />
                </Link>
              </div>
              {needN === 0 && !h.needs.noLang.n ? (
                <p className="muted small">{t("home.allGood")}</p>
              ) : (
                <div className="needs">
                  <NeedRow icon={<CircleAlert className="lucide" />} tone="bad" n={h.needs.missing.n} label={t("home.need.missing")} sample={h.needs.missing.sample} to="/audit?tab=gaps" />
                  <NeedRow icon={<FileX className="lucide" />} tone="warn" n={h.needs.failed.n} label={t("home.need.failed")} sample={h.needs.failed.sample} to="/queue" />
                  <NeedRow icon={<CaptionsOff className="lucide" />} tone="info" n={h.needs.noLang.n} label={t("home.need.noLang", { lang: h.needs.noLang.lang.toUpperCase() })} sample={t("home.need.noLangSample")} to="/audit?tab=language" />
                </div>
              )}
            </section>

            {/* ---------- airing today: a poster shelf over the first show's blurred art */}
            <section className="shelf" style={showVars(first?.color)} aria-labelledby="airing-today">
              {first?.cover && <span className="shelf-art" style={{ backgroundImage: `url(${thumbUrl(first.cover, "sm")})` }} aria-hidden="true" />}
              <div className="sec-hd">
                <h2 className="eyebrow strong-eyebrow" id="airing-today">
                  {t("home.airingToday")}
                </h2>
                <span className="muted small">{new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
                <Link to="/calendar" className="sec-link">
                  {t("home.fullCalendar")} <ArrowRight className="lucide" aria-hidden="true" />
                </Link>
              </div>
              {h.airingToday.length ? (
                <div className="posters hscroll">
                  {h.airingToday.map((e) => (
                    <PosterCard
                      key={e.episodeId}
                      title={e.series}
                      cover={e.cover}
                      color={e.color}
                      managed={e.managed}
                      status={e.status}
                      progress={e.progress}
                      onClick={() => setOpen(e.episodeId)}
                      meta={
                        <>
                          <b>{countdown(e.airUtc) ?? time(e.airUtc)}</b>
                          <span className="tnum">{sxe(e.season, e.episode)}</span>
                        </>
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">{t("home.nothingToday")}</p>
              )}
            </section>

            {/* ---------- just arrived */}
            {!!h.justArrived.length && (
              <section aria-labelledby="just-arrived">
                <div className="sec-hd">
                  <h2 id="just-arrived">{t("home.justArrived")}</h2>
                  <span className="muted small">{t("home.importsWeek", { n: h.importsThisWeek })}</span>
                  <Link to="/activity" className="sec-link">
                    {t("nav.activity")} <ArrowRight className="lucide" aria-hidden="true" />
                  </Link>
                </div>
                <div className="posters hscroll">
                  {h.justArrived.map((x) => (
                    <PosterCard
                      key={`${x.tvdbId}${x.label}`}
                      title={x.title}
                      cover={x.cover}
                      color={x.color}
                      href={`/show/${x.tvdbId}`}
                      onClick={() => navigate(`/show/${x.tvdbId}`)}
                      className={Date.now() - x.at < 86_400_000 ? "fresh" : ""}
                      meta={
                        <span className="meta-stack">
                          <b className="tnum">{x.label}</b>
                          <span>{weekday(x.at)}</span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {/* ---------- ready to binge */}
            {!!h.readyToBinge.length && (
              <section aria-labelledby="binge">
                <div className="sec-hd">
                  <h2 id="binge">{t("home.binge")}</h2>
                  <span className="muted small">{t("home.bingeSub", { lang: h.needs.noLang.lang.toUpperCase() })}</span>
                </div>
                <div className="binge-grid">
                  {h.readyToBinge.map((b) => (
                    <Link key={`${b.tvdbId}-${b.season}`} to={`/show/${b.tvdbId}`} className="binge" style={showVars(b.color)}>
                      <span className="binge-art" style={b.cover ? { backgroundImage: `url(${thumbUrl(b.cover, "md")})` } : undefined} aria-hidden="true" />
                      <span className="binge-text" style={showVars(b.color)}>
                        <b className="clamp2">{b.title}</b>
                        <span className="muted small">{t("home.bingeSeason", { season: b.season, n: b.episodes })}</span>
                        <span className="binge-pill">{t("home.bingePill", { n: b.episodes })}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          <aside className="home-side stack">
            {/* ---------- needs you */}
            <section className="card side-card needs-desk" aria-labelledby="needs-you">
              <div className="sec-hd">
                <h2 id="needs-you">{t("home.needsYou")}</h2>
                <Link to="/audit" className="sec-link muted-link">
                  {t("nav.audit")} <ChevronRight className="lucide" aria-hidden="true" />
                </Link>
              </div>
              {needN === 0 && !h.needs.noLang.n ? (
                <p className="muted small">{t("home.allGood")}</p>
              ) : (
                <div className="needs">
                  <NeedRow icon={<CircleAlert className="lucide" />} tone="bad" n={h.needs.missing.n} label={t("home.need.missing")} sample={h.needs.missing.sample} to="/audit?tab=gaps" />
                  <NeedRow icon={<FileX className="lucide" />} tone="warn" n={h.needs.failed.n} label={t("home.need.failed")} sample={h.needs.failed.sample} to="/queue" />
                  <NeedRow icon={<CaptionsOff className="lucide" />} tone="info" n={h.needs.noLang.n} label={t("home.need.noLang", { lang: h.needs.noLang.lang.toUpperCase() })} sample={t("home.need.noLangSample")} to="/audit?tab=language" />
                </div>
              )}
            </section>

            {/* ---------- downloading */}
            {!!h.downloading.length && (
              <section className="card side-card" aria-labelledby="downloading">
                <div className="sec-hd">
                  <h2 id="downloading">{t("home.downloading")}</h2>
                  <Link to="/queue" className="sec-link">
                    {t("nav.queue")} <ArrowRight className="lucide" aria-hidden="true" />
                  </Link>
                </div>
                {h.downloading.map((g) => (
                  <Link key={g.id} to={g.movieId ? `/movie/${g.movieId}` : `/show/${g.tvdbId}`} className="dlrow">
                    <span className="pring" style={{ ...showVars(g.color), "--p": Math.round(g.progress * 100) } as React.CSSProperties} aria-hidden="true">
                      {g.cover ? <img src={thumbUrl(g.cover, "sm")} alt="" /> : <span />}
                    </span>
                    <span className="grow dl-text">
                      <b className="clamp1">
                        {g.title}
                        {g.label ? ` · ${g.label}` : ""}
                      </b>
                      <span className="muted small clamp1">
                        {g.state === "importing" ? t("ep.importing") : `${g.protocol === "usenet" ? t("chip.usenet") : t("chip.torrent")}${g.clientName ? ` · ${g.clientName}` : ""}`}
                      </span>
                    </span>
                    <span className="pc tnum">{Math.round(g.progress * 100)}%</span>
                  </Link>
                ))}
              </section>
            )}

            {/* ---------- this week */}
            <section className="card side-card" aria-labelledby="this-week">
              <div className="sec-hd">
                <h2 id="this-week">{t("home.thisWeek")}</h2>
                <Link to="/calendar" className="sec-link">
                  {t("nav.calendar")} <ArrowRight className="lucide" aria-hidden="true" />
                </Link>
              </div>
              {!h.thisWeek.length && <Empty>{t("cal.empty")}</Empty>}
              <div className="this-week-scroll">
                <ThisWeek list={h.thisWeek} onOpen={setOpen} />
              </div>
            </section>
          </aside>
        </div>
      )}
      {open !== null && <EpisodeSheet episodeId={open} onClose={() => setOpen(null)} onChanged={() => void d.reload()} dryRun={status.dryRun ?? true} />}
    </section>
  );
}

function NeedRow({ icon, tone, n, label, sample, to }: { icon: React.ReactNode; tone: "bad" | "warn" | "info"; n: number; label: string; sample: string | null; to: string }) {
  if (!n) return null;
  return (
    <Link to={to} className={`need ${tone}`}>
      <span className="need-ic" aria-hidden="true">
        {icon}
      </span>
      <span className="need-n tnum">{n.toLocaleString()}</span>
      <span className="need-l">
        {label}
        {sample && <small className="clamp1">{sample}</small>}
      </span>
      <ChevronRight className="lucide need-chev" aria-hidden="true" />
    </Link>
  );
}

function ThisWeek({ list, onOpen }: { list: CalEntry[]; onOpen: (id: number) => void }) {
  const days = new Map<string, CalEntry[]>();
  for (const e of list) {
    const k = new Date(e.airUtc).toDateString();
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  const tomorrow = new Date(Date.now() + 86_400_000).toDateString();
  return (
    <div className="agenda-mini">
      {[...days].map(([k, es]) => (
        <div key={k}>
          <h3 className="ag-day">
            {k === tomorrow ? `${t("cal.tomorrow")} · ` : ""}
            {new Date(es[0].airUtc).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
          </h3>
          {es.map((e) => (
            <button key={e.episodeId} className="ag" onClick={() => onOpen(e.episodeId)}>
              <Cover src={e.cover} alt={e.series} size="sm" />
              <span className="ag-t">
                <b className="clamp1">{e.series}</b>
                <small className="clamp1">
                  {sxe(e.season, e.episode)}
                  {e.title ? ` · ${e.title}` : ""}
                </small>
              </span>
              <span className="muted small tnum">{time(e.airUtc)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "ON AIR" for 30 minutes after the air time, "in 2 h 10 m" before it; otherwise null (the time is shown). */
function countdown(airUtc: number, now = Date.now()) {
  const d = airUtc - now;
  if (d <= 0 && d > -30 * 60_000) return t("home.onAir");
  if (d > 0 && d < 12 * 3_600_000) {
    const h = Math.floor(d / 3_600_000);
    const m = Math.round((d % 3_600_000) / 60_000);
    return h ? t("home.inHM", { h, m }) : t("home.inM", { m });
  }
  return null;
}
