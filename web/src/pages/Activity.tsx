import { useEffect, useMemo, useState } from "react";
import { FixButtons } from "../fixes";
import { api, type Decision } from "../api";
import { Link } from "../App";
import { t, type I18nKey } from "../i18n";
import { Chip, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";

type Tone = "good" | "bad" | "warn" | "info" | "accent";
const KIND_TONE: Record<string, Tone> = {
  "would-grab": "accent",
  grab: "good",
  import: "good",
  "verify-ok": "good",
  "verify-fail": "bad",
  fail: "bad",
  skip: "warn",
  search: "info",
};
const KIND_ICON: Record<string, string> = { grab: "↓", "would-grab": "◌", import: "✓", "verify-ok": "✓", "verify-fail": "✕", fail: "✕", skip: "↷", search: "⌕", info: "•", managed: "★", alias: "✎", rule: "✎", fact: "✎", sonarr: "⇄", sync: "↻", plex: "▶" };
const KNOWN = ["grab", "would-grab", "import", "verify-ok", "verify-fail", "fail", "skip", "search", "info", "managed", "alias", "rule", "fact", "sonarr", "sync", "plex"];
/** Human words for the decision kinds (never the raw enum). */
export const kindLabel = (kind: string) => (KNOWN.includes(kind) ? t(`activity.kind.${kind}` as I18nKey) : kind);
const isPlex = (d: Decision) => (d.kind === "info" || d.kind === "fail") && /^Plex: asked/.test(d.why);
const kindOf = (d: Decision) => (isPlex(d) ? "plex" : d.kind);
const PROBLEM = new Set(["fail", "verify-fail", "skip"]);

const FILTERS: { key: string; label: I18nKey; kinds?: string }[] = [
  { key: "all", label: "activity.filter.all" },
  { key: "grabs", label: "activity.filter.grabs", kinds: "grab,import,verify-ok" },
  { key: "dry", label: "activity.filter.dry", kinds: "would-grab" },
  { key: "problems", label: "activity.filter.problems", kinds: "fail,verify-fail,skip" },
  { key: "changes", label: "activity.filter.changes", kinds: "managed,alias,rule,fact,sonarr,info" },
];

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayKey = (ms: number) => new Date(new Date(ms).getFullYear(), new Date(ms).getMonth(), new Date(ms).getDate()).getTime();
function dayTitle(key: number) {
  const today = dayKey(Date.now());
  if (key === today) return t("cal.today");
  if (key === today - 86_400_000) return t("cal.yesterday");
  return new Date(key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** One decision, on its own (show/movie pages, sheets, Home). */
export function DecisionCard({ d, onUndone }: { d: Decision; onUndone?: () => void }) {
  return <EventCard ev={{ key: `d${d.id}`, at: d.at, items: [d] }} onUndone={onUndone} showDate />;
}

interface Ev { key: string; at: number; items: Decision[] }

/**
 * One event: a grab and everything that followed it (download, checks, import, Plex) is ONE card with a stage track,
 * not five log lines. The newest problem (or the newest step) is the sentence; the rest is under "Steps".
 */
function EventCard({ ev, onUndone, showDate = false }: { ev: Ev; onUndone?: () => void; showDate?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const steps = [...ev.items].sort((a, b) => a.at - b.at || a.id - b.id);
  const lead = [...ev.items].sort((a, b) => b.at - a.at || b.id - a.id).find((x) => PROBLEM.has(x.kind) && !x.undoneAt) ?? ev.items.find((x) => kindOf(x) !== "plex") ?? ev.items[0];
  const k = kindOf(lead);
  const release = ev.items.find((x) => x.release)?.release ?? null;
  const fixes = ev.items.find((x) => x.fixes?.length)?.fixes;
  const undoable = ev.items.filter((x) => x.undo && !x.undoneAt);
  const track = steps.length > 1 ? [...new Map(steps.map((x) => [kindOf(x), x])).values()] : [];
  const long = lead.why.length > 160;
  return (
    <article className={`card event${PROBLEM.has(lead.kind) ? " problem" : ""}`}>
      <span className={`event-icon ${KIND_TONE[k] ?? "info"}`} aria-hidden="true">
        {KIND_ICON[k] ?? "•"}
      </span>
      <div className="event-body">
        <div className="event-head">
          <span className="event-kind">{kindLabel(k)}</span>
          {lead.tvdbId ? (
            <Link to={`/show/${lead.tvdbId}`} className="strong clamp1">
              {lead.title || t("activity.show")}
            </Link>
          ) : (
            lead.title && <strong className="clamp1">{lead.title}</strong>
          )}
          <time className="muted small event-time" dateTime={new Date(ev.at).toISOString()}>
            {showDate ? new Date(ev.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : time(ev.at)}
          </time>
        </div>
        <button className={`event-why why-text${open || !long ? "" : " clamp2"}`} onClick={() => long && setOpen(!open)} aria-expanded={long ? open : undefined} disabled={!long}>
          {lead.why}
        </button>
        {!!track.length && (
          <ol className="stage-track" aria-label={t("activity.steps")}>
            {track.map((x) => (
              <li key={x.id} className={PROBLEM.has(x.kind) ? "bad" : KIND_TONE[kindOf(x)] === "good" || kindOf(x) === "plex" ? "good" : ""}>
                {kindLabel(kindOf(x))}
              </li>
            ))}
          </ol>
        )}
        {release && <span className="mono muted small clamp1 event-release" title={release}>{release}</span>}
        <FixButtons fixes={fixes} />
        {(steps.length > 1 || undoable.length > 0 || ev.items.some((x) => x.undoneAt)) && (
          <div className="row">
            {steps.length > 1 && (
              <button className="linklike small" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? t("activity.hideSteps") : t("activity.showSteps", { n: steps.length })}
              </button>
            )}
            {undoable.map((x) => (
              <button
                key={x.id}
                className="small"
                onClick={async () => {
                  try {
                    await api(`/activity/${x.id}/undo`, { body: {} });
                    toast(t("common.undone"));
                    onUndone?.();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {t("common.undo")}
                {undoable.length > 1 ? `: ${kindLabel(kindOf(x))}` : ""}
              </button>
            ))}
            {ev.items.some((x) => x.undoneAt) && <Chip tone="info">{t("common.undone")}</Chip>}
          </div>
        )}
        {open && steps.length > 1 && (
          <ol className="event-steps small">
            {steps.map((x) => (
              <li key={x.id}>
                <span className="muted">{time(x.at)}</span> <strong>{kindLabel(kindOf(x))}</strong> <span className="why-text">{x.why}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  );
}

/**
 * Builds the events: decisions of one grab are one event (grabId); a Plex scan right after an import joins that
 * import; two identical "imported" lines for the same episodes become one.
 */
export function groupEvents(list: Decision[]): Ev[] {
  const sorted = [...list].sort((a, b) => b.at - a.at || b.id - a.id);
  const out: Ev[] = [];
  const plex: Decision[] = [];
  const byGrab = new Map<number, Ev>();
  for (const d of sorted) {
    const grabId = (d.detail as { grabId?: number } | undefined)?.grabId;
    if (grabId) {
      const ev = byGrab.get(grabId);
      if (ev) {
        ev.items.push(d);
        continue;
      }
      const n = { key: `g${grabId}`, at: d.at, items: [d] };
      byGrab.set(grabId, n);
      out.push(n);
      continue;
    }
    if (isPlex(d)) {
      plex.push(d);
      continue;
    }
    if (d.kind === "import" || (d.kind === "info" && /^Imported/.test(d.why))) {
      const same = out.find((e) => e.items.some((x) => (x.kind === "import" || /^Imported/.test(x.why)) && x.tvdbId === d.tvdbId && JSON.stringify(x.episodeIds) === JSON.stringify(d.episodeIds) && Math.abs(x.at - d.at) < 300_000));
      if (same) {
        same.items.push(d);
        continue;
      }
    }
    out.push({ key: `d${d.id}`, at: d.at, items: [d] });
  }
  // Plex scans join the import they follow (within 3 minutes); the rest stay on their own.
  for (const d of plex) {
    const near = out.find((e) => e.items.some((x) => x.kind === "import" && d.at >= x.at - 5_000 && d.at - x.at < 180_000));
    if (near) near.items.push(d);
    else out.push({ key: `d${d.id}`, at: d.at, items: [d] });
  }
  return out.sort((a, b) => b.at - a.at);
}

export function Activity() {
  usePageTitle(t("activity.title"));
  const [filter, setFilter] = useState("all");
  const [extra, setExtra] = useState<Decision[]>([]);
  const kinds = FILTERS.find((f) => f.key === filter)?.kinds;
  const list = useLoad(() => {
    setExtra([]);
    return api<Decision[]>(`/activity${kinds ? `?kinds=${kinds}` : ""}`);
  }, [filter]);
  const all = useMemo(() => [...(list.data ?? []), ...extra], [list.data, extra]);
  const days = useMemo(() => {
    const map = new Map<number, Ev[]>();
    for (const ev of groupEvents(all)) map.set(dayKey(ev.at), [...(map.get(dayKey(ev.at)) ?? []), ev]);
    return [...map];
  }, [all]);
  // Refresh while the page is open, so grabs and imports move on by themselves.
  useEffect(() => {
    const id = setInterval(() => void list.reload(), 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function more() {
    const last = all[all.length - 1];
    if (!last) return;
    const next = await api<Decision[]>(`/activity?before=${last.id}${kinds ? `&kinds=${kinds}` : ""}`);
    setExtra((x) => [...x, ...next]);
  }
  return (
    <section>
      <h1>{t("activity.title")}</h1>
      <p className="muted small">{t("activity.intro")}</p>
      <div className="chips pickable" role="group" aria-label={t("common.filter")}>
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip${filter === f.key ? " on" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {t(f.label)}
          </button>
        ))}
      </div>
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      {list.loading && !list.data && <Spinner label={t("app.loading")} />}
      {list.data && !all.length && <Empty icon="≡">{filter === "problems" ? t("activity.noProblems") : t("activity.empty")}</Empty>}
      {days.map(([day, evs]) => (
        <div key={day} className="day-group">
          <h2 className="agenda-date">{dayTitle(day)}</h2>
          <div className="list">
            {evs.map((ev) => (
              <EventCard key={ev.key} ev={ev} onUndone={list.reload} />
            ))}
          </div>
        </div>
      ))}
      {all.length >= 100 && <button onClick={more}>{t("common.loadMore")}</button>}
    </section>
  );
}
