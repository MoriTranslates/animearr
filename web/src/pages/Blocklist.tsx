import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { Chip, Confirm, dateTime, Empty, ErrorBox, Spinner, useLoad, useToast, ReleaseName } from "../ui";

interface Entry { id: number; release: string; tvdbId: number | null; movieId: number | null; title: string; reason: string; at: number; protocol: string | null; indexer: string | null }
interface Data { items: Entry[]; total: number; shows: { tvdbId: number | null; movieId: number | null; title: string; count: number }[] }

/** Releases AnimeArr won't pick again, with why and where they came from; remove one, many, or a whole show's. */
export function Blocklist() {
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<number[] | null>(null);
  const d = useLoad(() => api<Data>(`/blocklist${filter}`), [filter]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const { items, total, shows } = d.data;
  const all = items.length > 0 && items.every((x) => picked.includes(x.id));
  async function remove(ids: number[]) {
    try {
      const r = await api<{ removed: number }>("/blocklist/remove", { body: { ids } });
      toast(t("blocklist.removed", { n: r.removed }));
      setPicked((p) => p.filter((x) => !ids.includes(x)));
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  return (
    <div className="stack">
      <p className="muted small">{t("blocklist.intro")}</p>
      <div className="row between">
        <select aria-label={t("blocklist.show")} value={filter} onChange={(e) => (setFilter(e.target.value), setPicked([]))}>
          <option value="">{t("blocklist.allShows")}</option>
          {shows.map((s) => (
            <option key={`${s.tvdbId}-${s.movieId}`} value={s.movieId ? `?movieId=${s.movieId}` : `?tvdbId=${s.tvdbId}`}>
              {s.title} ({s.count})
            </option>
          ))}
        </select>
        <span className="row">
          <label className="check small">
            <input type="checkbox" checked={all} onChange={() => setPicked(all ? [] : items.map((x) => x.id))} /> {t("blocklist.selectAll")}
          </label>
          <button className="danger small" disabled={!picked.length} onClick={() => setConfirm(picked)}>
            {t("blocklist.removeSelected", { n: picked.length })}
          </button>
        </span>
      </div>
      {!items.length && <Empty icon="⊘">{t("blocklist.empty")}</Empty>}
      <div className="list">
        {items.map((x) => (
          <article key={x.id} className="card pad stack">
            <div className="row between">
              <label className="check">
                <input type="checkbox" aria-label={t("blocklist.select", { name: x.release })} checked={picked.includes(x.id)} onChange={() => setPicked((p) => (p.includes(x.id) ? p.filter((i) => i !== x.id) : [...p, x.id]))} />
                <span className="strong">{x.title || t("blocklist.show")}</span>
              </label>
              <button className="small" onClick={() => setConfirm([x.id])}>
                {t("blocklist.remove")}
              </button>
            </div>
            <ReleaseName name={x.release} className="small" />
            <p className="warn-text small">{x.reason}</p>
            <p className="muted small row">
              <span>{dateTime(x.at)}</span>
              {x.protocol && <Chip tone="info">{x.protocol}</Chip>}
              {x.indexer && <span>{x.indexer}</span>}
            </p>
          </article>
        ))}
      </div>
      <p className="muted small">{t("blocklist.total", { shown: items.length, total })}</p>
      {confirm && (
        <Confirm title={t("blocklist.confirmTitle")} confirmLabel={t("blocklist.remove")} onClose={() => setConfirm(null)} onConfirm={() => remove(confirm)}>
          <p>{t("blocklist.confirmBody", { n: confirm.length })}</p>
        </Confirm>
      )}
    </div>
  );
}
