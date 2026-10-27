import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ListFilter } from "lucide-react";
import { seasonOf } from "../season";
import { SeasonHeader } from "../seasonal";
import { api, store, sxe } from "../api";
import { navigate, Link } from "../App";
import { EpisodeSheet, StatusPill, type EpisodeStatus } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Cover, Empty, ErrorBox, Spinner, useLoad, usePageTitle } from "../ui";

interface EpEntry { episodeId: number; tvdbId: number; series: string; cover: string | null; season: number; episode: number; title: string | null; airUtc: number; status: EpisodeStatus; progress: number | null; stage?: string | null; ahead?: number | null; managed: boolean }
interface MovieEntry { movieId: number; title: string; year: number | null; cover: string | null; kind: "cinema" | "digital" | "physical"; at: number; status: string; monitored: boolean }
type Entry = ({ type: "episode" } & EpEntry & { at: number }) | ({ type: "movie" } & MovieEntry);
type View = "month" | "week" | "agenda";

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (ms: number, n: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const startOfWeek = (ms: number) => addDays(startOfDay(ms), -new Date(ms).getDay()); // Sunday first, like Sonarr
const isPhone = () => {
  try {
    return window.matchMedia("(max-width: 760px)").matches;
  } catch {
    return false;
  }
};
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** Radarr dates are date-only (UTC midnight): the local day with that calendar date. */
const utcDay = (ms: number) => {
  const u = new Date(ms);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime();
};
const dayOf = (e: Entry) => (e.type === "movie" ? utcDay(e.at) : startOfDay(e.at));
const keyOf = (e: Entry) => (e.type === "episode" ? `e${e.episodeId}` : `m${e.movieId}${e.kind}`);

function dayTitle(key: number) {
  const today = startOfDay(Date.now());
  if (key === today) return t("cal.today");
  if (key === addDays(today, 1)) return t("cal.tomorrow");
  if (key === addDays(today, -1)) return t("cal.yesterday");
  return new Date(key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** The range a view shows around an anchor date. */
function rangeOf(view: View, anchor: number, compact: boolean): [number, number] {
  // Home: from today (what aired days ago is in Activity), a week ahead; the list is capped below.
  if (compact) return [startOfDay(Date.now()), addDays(startOfDay(Date.now()), 7)];
  if (view === "week") {
    const s = startOfWeek(anchor);
    return [s, addDays(s, 7)];
  }
  if (view === "month") {
    const a = new Date(anchor);
    const s = startOfWeek(new Date(a.getFullYear(), a.getMonth(), 1).getTime());
    return [s, addDays(s, 42)];
  }
  const s = startOfDay(anchor);
  return [addDays(s, -7), addDays(s, 21)];
}

/** Sonarr-style calendar, cleaner: Month / Week / Agenda; episodes and anime movie releases; tap for details. */
export function Calendar({ compact = false }: { compact?: boolean }) {
  usePageTitle(t("cal.title"));
  const [managedOnly, setManagedOnly] = useState(() => store.get("calManagedOnly", false));
  const [view, setView] = useState<View>(() => {
    if (compact) return "agenda";
    const v = store.get<string>("calView", isPhone() ? "agenda" : "week");
    return v === "month" || v === "week" || v === "agenda" ? v : isPhone() ? "agenda" : "week";
  });
  const [anchor, setAnchor] = useState(() => Date.now());
  const [open, setOpen] = useState<number | null>(null);
  const [from, to] = rangeOf(view, anchor, compact);
  const d = useLoad(() => api<{ from: number; to: number; entries: EpEntry[]; movies?: MovieEntry[] }>(`/calendar?from=${from}&to=${to}${managedOnly ? "&managed=1" : ""}`), [managedOnly, from, to]);
  const status = useLoad(() => api<{ dryRun: boolean }>("/status"), []);
  const current = d.data && d.data.from === from && d.data.to === to ? d.data : null;
  const entries = useMemo<Entry[]>(
    () => [...(current?.entries ?? []).map((e) => ({ ...e, type: "episode" as const, at: e.airUtc })), ...(current?.movies ?? []).map((m) => ({ ...m, type: "movie" as const }))].sort((a, b) => a.at - b.at),
    [current],
  );
  const byDay = useMemo(() => {
    const map = new Map<number, Entry[]>();
    for (const e of entries) map.set(dayOf(e), [...(map.get(dayOf(e)) ?? []), e]);
    return map;
  }, [entries]);
  // Keep "downloading" moving.
  const busy = entries.some((e) => e.status === "downloading");
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void d.reload(), 15_000);
    return () => clearInterval(id);
  }, [busy, d.reload]);

  const pick = (v: View) => {
    setView(v);
    store.set("calView", v);
    if (v === "agenda") setAnchor(Date.now());
  };
  const step = (dir: -1 | 1) => setAnchor((a) => (view === "month" ? new Date(new Date(a).getFullYear(), new Date(a).getMonth() + dir, 1).getTime() : addDays(a, dir * 7)));
  const openEntry = (e: Entry) => (e.type === "episode" ? setOpen(e.episodeId) : navigate(`/movie/${e.movieId}`));
  const season = seasonOf(anchor);
  const title =
    view === "month"
      ? new Date(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : `${new Date(from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(addDays(to, -1)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <section>
      {!compact && (
        <SeasonHeader
          compact
          eyebrow={t("cal.title")}
          title={view === "agenda" ? t("cal.view.agenda") : title}
          sub={t("cal.headerSub", { season: t(`season.${season.key}` as I18nKey), year: season.year, week: season.week, weeks: season.weeks, n: entries.length })}
          right={
            <div className="cal-controls">
              <div className="seg seg-accent" role="group" aria-label={t("cal.view")}>
                {(["month", "week", "agenda"] as View[]).map((v) => (
                  <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => pick(v)}>
                    {t(`cal.view.${v}` as I18nKey)}
                  </button>
                ))}
              </div>
              {view !== "agenda" && (
                <span className="row cal-nav">
                  <button className="icon-btn" aria-label={t("cal.prev")} onClick={() => step(-1)}>
                    <ChevronLeft className="lucide" aria-hidden="true" />
                  </button>
                  <button className="small cal-today" onClick={() => setAnchor(Date.now())}>
                    {t("cal.today")}
                  </button>
                  <button className="icon-btn" aria-label={t("cal.next")} onClick={() => step(1)}>
                    <ChevronRight className="lucide" aria-hidden="true" />
                  </button>
                </span>
              )}
              <button
                className={`icon-btn${managedOnly ? " on" : ""}`}
                aria-pressed={managedOnly}
                aria-label={t("cal.managed")}
                title={t("cal.managed")}
                onClick={() => {
                  setManagedOnly(!managedOnly);
                  store.set("calManagedOnly", !managedOnly);
                }}
              >
                <ListFilter className="lucide" aria-hidden="true" />
              </button>
            </div>
          }
        />
      )}
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {!current && !d.error && <Spinner label={t("app.loading")} />}
      {current && view === "agenda" && <Agenda byDay={byDay} compact={compact} onOpen={openEntry} />}
      {current && view === "week" && <Week from={from} byDay={byDay} onOpen={openEntry} />}
      {current && view === "month" && <Month key={from} from={from} anchor={anchor} byDay={byDay} onOpen={openEntry} />}
      {open !== null && <EpisodeSheet episodeId={open} onClose={() => setOpen(null)} onChanged={() => void d.reload()} dryRun={status.data?.dryRun ?? true} />}
    </section>
  );
}

const GLYPH: Record<string, string> = { have: "✓", missing: "!", downloading: "↓", unaired: "◷", attention: "⚠", unreleased: "◷" };
const MOVIE_STATUS: Record<string, "good" | "bad" | "accent" | "info" | "warn"> = { have: "good", missing: "bad", downloading: "accent", attention: "warn", unreleased: "info" };

/** One entry: poster thumb, show (or movie), SxxEyy (or release kind), time, worded status. */
function EntryCard({ e, onOpen, dense = false }: { e: Entry; onOpen: (e: Entry) => void; dense?: boolean }) {
  return (
    <button className={`agenda-entry card${dense ? " dense" : ""}${e.type === "movie" ? " movie" : ""} st-${e.status}`} onClick={() => onOpen(e)}>
      <Cover src={e.cover} alt={e.type === "episode" ? e.series : e.title} size="sm" />
      <span className="agenda-text">
        <span className="strong clamp2">
          {e.type === "movie" && <span aria-hidden="true">🎬 </span>}
          {e.type === "episode" ? e.series : `${e.title}${e.year ? ` (${e.year})` : ""}`}
        </span>
        <span className="small">
          {e.type === "episode" ? (
            <>
              <span className="mono">{sxe(e.season, e.episode)}</span>
              {e.title && !dense ? ` · ${e.title}` : ""}
            </>
          ) : (
            t(`cal.movie.${e.kind}` as I18nKey)
          )}
        </span>
        {e.type === "episode" && <span className="muted small">{time(e.at)}</span>}
      </span>
      <span className="agenda-status">
        {e.type === "episode" ? <StatusPill e={{ status: e.status, progress: e.progress, file: null, stage: e.stage, ahead: e.ahead }} /> : <Chip tone={MOVIE_STATUS[e.status] ?? "info"}>{t(`movies.status.${e.status}` as I18nKey)}</Chip>}
      </span>
    </button>
  );
}

const entriesCount = (days: [number, Entry[]][]) => days.reduce((n, [, l]) => n + l.length, 0);

function Agenda({ byDay, compact, onOpen }: { byDay: Map<number, Entry[]>; compact: boolean; onOpen: (e: Entry) => void }) {
  const days = [...byDay].sort((a, b) => a[0] - b[0]);
  const scrolled = useRef(false);
  useEffect(() => {
    if (compact || scrolled.current || !days.length) return;
    scrolled.current = true;
    document.getElementById("cal-today")?.scrollIntoView({ block: "start" });
  }, [days.length, compact]);
  if (!days.length) return <Empty icon="▤">{t("cal.empty")}</Empty>;
  const today = startOfDay(Date.now());
  // Compact (Home): the first 8 entries, then "Full calendar".
  let left = compact ? 8 : Infinity;
  const shown = days.map(([k, list]) => {
    const take = list.slice(0, Math.max(0, left));
    left -= take.length;
    return [k, take] as [number, Entry[]];
  }).filter(([, l]) => l.length);
  const more = compact && entriesCount(days) > 8;
  return (
    <div className="agenda">
      {shown.map(([key, list]) => (
        <div key={key} className={`agenda-day${key === today ? " today" : ""}`} id={key === today ? "cal-today" : undefined}>
          <h2 className="agenda-date">{dayTitle(key)}</h2>
          <ul className="plain">
            {list.map((e) => (
              <li key={keyOf(e)}>
                <EntryCard e={e} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {more && (
        <Link to="/calendar" className="small">
          {t("cal.full", { n: entriesCount(days) - 8 })}
        </Link>
      )}
    </div>
  );
}

/** 7 columns on desktop; a horizontally swipeable day strip on phones (the strip scrolls, not the page). */
function Week({ from, byDay, onOpen }: { from: number; byDay: Map<number, Entry[]>; onOpen: (e: Entry) => void }) {
  const today = startOfDay(Date.now());
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On phones, start the strip at today.
    const el = strip.current?.querySelector<HTMLElement>(".week-day.today");
    if (strip.current) strip.current.scrollLeft = el ? el.offsetLeft - strip.current.offsetLeft : 0;
  }, [from]);
  const busiest = Math.max(0, ...Array.from({ length: 7 }, (_, i) => (byDay.get(addDays(from, i)) ?? []).length));
  return (
    <div className="week" ref={strip}>
      {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((day) => {
        const list = byDay.get(day) ?? [];
        return (
          <div key={day} className={`week-day${day === today ? " today" : ""}`} style={{ "--heat": Math.min(1, list.length / Math.max(4, busiest)) } as React.CSSProperties}>
            <h2 className="week-hd">
              <span className="eyebrow">{new Date(day).toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="week-kanji jp" lang="ja" aria-hidden="true">{"日月火水木金土"[new Date(day).getDay()]}</span>
              <span className="week-num">{new Date(day).getDate()}</span>
              <span className="muted small week-count">{list.length ? t("cal.eps", { n: list.length }) : ""}</span>
            </h2>
            <span className="week-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((list.length / Math.max(1, busiest)) * 100)}%` }} />
            </span>
            {!list.length && <p className="muted small">—</p>}
            <ul className="plain">
              {list.map((e) => (
                <li key={keyOf(e)}>
                  <EntryCard e={e} onOpen={onOpen} dense />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Month grid: entries in the cells on desktop; on phones dot counts, and tapping a day lists it below. */
function Month({ from, anchor, byDay, onOpen }: { from: number; anchor: number; byDay: Map<number, Entry[]>; onOpen: (e: Entry) => void }) {
  const today = startOfDay(Date.now());
  const month = new Date(anchor).getMonth();
  const [picked, setPicked] = useState<number | null>(null);
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const pickedList = picked !== null ? (byDay.get(picked) ?? []) : [];
  return (
    <div className="stack">
      <div className="month">
        {days.slice(0, 7).map((d) => (
          <div key={`h${d}`} className="month-head" aria-hidden="true">
            {new Date(d).toLocaleDateString(undefined, { weekday: "short" })}
          </div>
        ))}
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          const other = new Date(day).getMonth() !== month;
          return (
            <button
              key={day}
              className={`month-day${day === today ? " today" : ""}${other ? " other" : ""}${picked === day ? " picked" : ""}`}
              onClick={() => setPicked(picked === day ? null : day)}
              aria-pressed={picked === day}
              aria-current={day === today ? "date" : undefined}
              aria-label={`${new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}: ${t(list.length === 1 ? "cal.countOne" : "cal.count", { n: list.length })}`}
            >
              <span className="month-num">{new Date(day).getDate()}</span>
              <span className="month-items" aria-hidden="true">
                {list.slice(0, 3).map((e) => (
                  <span key={keyOf(e)} className={`month-item ${e.status}`}>
                    {GLYPH[e.status] ?? ""} {e.type === "movie" ? "🎬 " : ""}
                    {e.type === "episode" ? `${e.series} ${sxe(e.season, e.episode)}` : e.title}
                  </span>
                ))}
                {list.length > 3 && <span className="month-more muted small">+{list.length - 3}</span>}
              </span>
              {!!list.length && (
                <span className="month-dots" aria-hidden="true">
                  {list.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="agenda-day">
          <h2 className="agenda-date">{dayTitle(picked)}</h2>
          {!pickedList.length && <p className="muted small">{t("cal.empty")}</p>}
          <ul className="plain">
            {pickedList.map((e) => (
              <li key={keyOf(e)}>
                <EntryCard e={e} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
