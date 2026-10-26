import { useEffect, useState } from "react";
import { FixButtons } from "../fixes";
import { api, type Decision } from "../api";
import { Link } from "../App";
import { t, type I18nKey } from "../i18n";
import { Chip, dateTime, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";

const KIND_TONE: Record<string, "good" | "bad" | "warn" | "info" | "accent"> = {
  "would-grab": "accent",
  grab: "good",
  import: "good",
  "verify-ok": "good",
  "verify-fail": "bad",
  fail: "bad",
  skip: "warn",
  search: "info",
};
const FILTERS: { key: string; label: I18nKey; kinds?: string }[] = [
  { key: "all", label: "activity.filter.all" },
  { key: "grabs", label: "activity.filter.grabs", kinds: "grab,import,verify-ok" },
  { key: "dry", label: "activity.filter.dry", kinds: "would-grab" },
  { key: "problems", label: "activity.filter.problems", kinds: "fail,verify-fail,skip" },
  { key: "changes", label: "activity.filter.changes", kinds: "managed,alias,rule,fact,sonarr,info" },
];

export function DecisionCard({ d, onUndone }: { d: Decision; onUndone?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const long = d.why.length > 160;
  return (
    <article className="card pad decision">
      <div className="row between">
        <div className="row">
          <Chip tone={KIND_TONE[d.kind] ?? "info"}>{d.kind}</Chip>
          {d.tvdbId ? (
            <Link to={`/show/${d.tvdbId}`} className="strong">
              {d.title}
            </Link>
          ) : (
            d.title && <strong>{d.title}</strong>
          )}
        </div>
        <time className="muted small">{dateTime(d.at)}</time>
      </div>
      <p className={`why-text ${open || !long ? "" : "clamp2"}`}>{d.why}</p>
      <FixButtons fixes={d.fixes} />
      <div className="row">
        {long && (
          <button className="linklike" onClick={() => setOpen(!open)}>
            {open ? t("common.less") : t("common.more")}
          </button>
        )}
        {d.undo && !d.undoneAt && (
          <button
            className="small"
            onClick={async () => {
              try {
                await api(`/activity/${d.id}/undo`, { body: {} });
                toast(t("common.undone"));
                onUndone?.();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("common.undo")}
          </button>
        )}
        {d.undoneAt && <Chip tone="info">{t("common.undone")}</Chip>}
      </div>
    </article>
  );
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
  const all = [...(list.data ?? []), ...extra];
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
      <p className="muted">{t("activity.intro")}</p>
      <div className="chips pickable" role="group">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip${filter === f.key ? " on" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {t(f.label)}
          </button>
        ))}
      </div>
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      {list.loading && !list.data && <Spinner label={t("app.loading")} />}
      {list.data && !all.length && <Empty>{t("activity.empty")}</Empty>}
      <div className="list">
        {all.map((d) => (
          <DecisionCard key={d.id} d={d} onUndone={list.reload} />
        ))}
      </div>
      {all.length >= 100 && <button onClick={more}>{t("common.loadMore")}</button>}
    </section>
  );
}
