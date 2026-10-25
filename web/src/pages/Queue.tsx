import { useEffect, useState } from "react";
import { api, fmtSize } from "../api";
import { query } from "../App";
import { ShowLink } from "../episodes";
import { t, type I18nKey } from "../i18n";
import { Chip, Confirm, dateTime, Empty, ErrorBox, Spinner, useLoad, usePageTitle, useToast, Why } from "../ui";

interface Item {
  id: number;
  at: number;
  tvdbId: number;
  movieId?: number | null;
  series: string;
  episodes: string[];
  release: string;
  protocol: string;
  client: string | null;
  state: string;
  dryRun: boolean;
  why: string;
  error: string | null;
  progress: number | null;
  attempt: number;
  live?: { state: string; progress: number; etaSec?: number | null; speed?: number | null; sizeBytes?: number | null; clientStatus?: string; seeders?: number | null; message?: string } | null;
}

const STATE_TONE: Record<string, "good" | "bad" | "warn" | "info" | "accent"> = { done: "good", failed: "bad", "needs-attention": "warn", downloading: "accent", importing: "accent", sending: "info", "dry-run": "info" };
const ICON: Record<string, string> = { done: "✓", failed: "✕", "needs-attention": "⚠", downloading: "↓", importing: "⇢", sending: "…", "dry-run": "◌" };

const eta = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function StateChip({ state }: { state: string }) {
  return (
    <Chip tone={STATE_TONE[state] ?? "info"}>
      <span aria-hidden="true">{ICON[state] ?? ""} </span>
      {t(`grab.${state}` as I18nKey)}
    </Chip>
  );
}

/** Sonarr-style queue: what's downloading now, with live progress, plus the grab history. */
export function Queue() {
  usePageTitle(t("queue.title"));
  const [tab, setTab] = useState<"queue" | "history">(query().get("tab") === "history" ? "history" : "queue");
  return (
    <section>
      <h1>{t("queue.title")}</h1>
      <p className="muted">{t("queue.intro")}</p>
      <div className="tabs" role="tablist">
        {(["queue", "history"] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => (setTab(x), history.replaceState(null, "", `/queue?tab=${x}`))}>
            {t(`queue.tab.${x}`)}
          </button>
        ))}
      </div>
      {tab === "queue" ? (
        <>
          <Downloading />
          <SonarrProblems />
        </>
      ) : (
        <History />
      )}
    </section>
  );
}

function Downloading() {
  const toast = useToast();
  const d = useLoad(() => api<{ items: Item[] }>("/queue"), []);
  const [remove, setRemove] = useState<Item | null>(null);
  const [opts, setOpts] = useState({ blocklist: true, searchNext: true });
  useEffect(() => {
    const id = setInterval(() => void d.reload(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  return (
    <div className="list">
      {!d.data.items.length && <Empty>{t("queue.empty")}</Empty>}
      {d.data.items.map((g) => {
        const pct = Math.round((g.live?.progress ?? g.progress ?? 0) * 100);
        return (
          <article key={g.id} className="card pad stack">
            <ShowLink tvdbId={g.tvdbId} title={g.series} to={g.movieId ? `/movie/${g.movieId}` : undefined}>
              <span className="stack">
                <span className="strong clamp2">{g.series}</span>
                <span className="mono small">{g.episodes.join(", ")}</span>
              </span>
            </ShowLink>
            <p className="mono small muted">{g.release}</p>
            <div className="row">
              <StateChip state={g.state} />
              <Chip>{g.protocol === "usenet" ? t("chip.usenet") : t("chip.torrent")}</Chip>
              {g.live?.sizeBytes ? <span className="muted small">{fmtSize(g.live.sizeBytes)}</span> : null}
              {g.attempt > 1 && <span className="muted small">#{g.attempt}</span>}
            </div>
            {g.state === "downloading" && (
              <>
                <div className="progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${pct}%` }} />
                </div>
                <p className="small">{g.live?.etaSec ? t("queue.progress", { pct, eta: eta(g.live.etaSec), speed: fmtSize(g.live.speed ?? 0) }) : t("queue.progressNoEta", { pct })}</p>
              </>
            )}
            <Why lines={[g.why, ...(g.error ? [g.error] : []), ...(g.live?.message ? [g.live.message] : [])]} />
            <div className="row">
              {g.state === "needs-attention" && (
                <button
                  className="small"
                  onClick={async () => {
                    try {
                      await api(`/grabs/${g.id}/retry`, { body: {} });
                      toast(t("managed.retried"));
                      await d.reload();
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  {t("managed.retryImport")}
                </button>
              )}
              {(g.state === "downloading" || g.state === "needs-attention") && (
                <button className="small danger" onClick={() => setRemove(g)}>
                  {t("queue.remove")}
                </button>
              )}
            </div>
          </article>
        );
      })}
      {remove && (
        <Confirm
          danger
          title={t("queue.removeTitle")}
          confirmLabel={t("queue.remove")}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`/queue/${remove.id}/remove`, { body: { ...opts, confirm: true } });
              toast(t("queue.removed"));
              setRemove(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("queue.removeBody", { release: remove.release, client: remove.client === "qbittorrent" ? "qBittorrent" : "SABnzbd" })}</p>
          <label className="check">
            <input type="checkbox" checked={opts.blocklist} onChange={(e) => setOpts({ ...opts, blocklist: e.target.checked })} /> {t("queue.blocklist")}
          </label>
          <label className="check">
            <input type="checkbox" checked={opts.searchNext} onChange={(e) => setOpts({ ...opts, searchNext: e.target.checked })} /> {t("queue.searchNext")}
          </label>
        </Confirm>
      )}
    </div>
  );
}

function History() {
  const [state, setState] = useState("");
  const [extra, setExtra] = useState<Item[]>([]);
  const d = useLoad(() => {
    setExtra([]);
    return api<Item[]>(`/history${state ? `?state=${state}` : ""}`);
  }, [state]);
  const all = [...(d.data ?? []), ...extra];
  const filters: [string, I18nKey][] = [
    ["", "queue.filter.all"],
    ["done", "queue.filter.done"],
    ["failed", "queue.filter.failed"],
    ["dry-run", "queue.filter.dry"],
  ];
  return (
    <div className="stack">
      <div className="chips pickable" role="group">
        {filters.map(([k, label]) => (
          <button key={k} className={`chip${state === k ? " on" : ""}`} aria-pressed={state === k} onClick={() => setState(k)}>
            {t(label)}
          </button>
        ))}
      </div>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {d.data && !all.length && <Empty>{t("queue.historyEmpty")}</Empty>}
      <div className="list">
        {all.map((g) => (
          <article key={g.id} className="card pad stack">
            <div className="row between">
              <ShowLink tvdbId={g.tvdbId} title={g.series} to={g.movieId ? `/movie/${g.movieId}` : undefined}>
                <span className="strong clamp2">
                  {g.series} <span className="mono small">{g.episodes.join(", ")}</span>
                </span>
              </ShowLink>
            </div>
            <div className="row">
              <StateChip state={g.state} />
              <span className="muted small">{dateTime(g.at)}</span>
            </div>
            <p className="mono small muted">{g.release}</p>
            <Why lines={[g.why, ...(g.error ? [g.error] : [])]} />
          </article>
        ))}
      </div>
      {all.length >= 50 && (
        <button
          onClick={async () => {
            const next = await api<Item[]>(`/history?before=${all[all.length - 1].id}${state ? `&state=${state}` : ""}`);
            setExtra((x) => [...x, ...next]);
          }}
        >
          {t("common.loadMore")}
        </button>
      )}
    </div>
  );
}

interface Problem { id: number; downloadId: string | null; series: string; tvdbId: number | null; episodes: string[]; release: string; client: string | null; protocol: string | null; problem: string; messages: string[]; added: string | null }
const PROBLEM_TONE: Record<string, "bad" | "warn" | "info"> = { failed: "bad", "sonarr-handling": "info", "import-blocked": "warn", warning: "warn", stalled: "info" };

/** Sonarr's own queue: only the items that need a look (report; removal only when you ask). */
function SonarrProblems() {
  const toast = useToast();
  const d = useLoad(() => api<{ items: Problem[] }>("/queue/sonarr"), []);
  const [remove, setRemove] = useState<Problem | null>(null);
  const [blocklist, setBlocklist] = useState(true);
  useEffect(() => {
    const id = setInterval(() => void d.reload(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!d.error && (!d.data || !d.data.items.length)) return null;
  return (
    <div className="stack" style={{ marginTop: "var(--space-6, 24px)" }}>
      <h2>{t("queue.sonarr.title")}</h2>
      {d.error ? <ErrorBox error={d.error} retry={d.reload} /> : <p className="muted small">{t("queue.sonarr.intro")}</p>}
      <div className="list">
        {(d.data?.items ?? []).map((p) => (
          <article key={p.id} className="card pad stack">
            <span className="stack">
              <span className="strong clamp2">{p.series}</span>
              {!!p.episodes.length && <span className="mono small">{p.episodes.join(", ")}</span>}
            </span>
            <p className="mono small muted">{p.release}</p>
            <div className="row">
              <Chip tone={PROBLEM_TONE[p.problem] ?? "info"}>
                <span aria-hidden="true">⚠ </span>
                {t(`queue.sonarr.${p.problem}` as I18nKey)}
              </Chip>
              {p.client && <span className="muted small">{p.client}</span>}
            </div>
            {!!p.messages.length && <Why lines={p.messages} />}
            {p.problem !== "sonarr-handling" && (
              <div className="row">
                <button className="small danger" onClick={() => (setBlocklist(true), setRemove(p))}>
                  {t("queue.remove")}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {remove && (
        <Confirm
          danger
          title={t("queue.removeTitle")}
          confirmLabel={t("queue.remove")}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            try {
              await api(`/queue/sonarr/${remove.id}/remove`, { body: { blocklist, confirm: true, downloadId: remove.downloadId } });
              toast(t("queue.removed"));
              setRemove(null);
              await d.reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("queue.sonarr.removeBody", { release: remove.release })}</p>
          <label className="check">
            <input type="checkbox" checked={blocklist} onChange={(e) => setBlocklist(e.target.checked)} /> {t("queue.sonarr.blocklist")}
          </label>
        </Confirm>
      )}
    </div>
  );
}
