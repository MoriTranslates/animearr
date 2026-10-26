import { useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Chip, ErrorBox, Spinner, useLoad, useToast } from "./ui";

interface Entry {
  aid: number;
  name: string;
  type: string | null;
  episodes: number | null;
  firstAir: string | null;
  fetched: boolean;
  defaultMapping: string;
  override: { season: number; offset: number } | null;
  mapping: string[];
  have: number;
  missing: number;
  specialsHave: number;
  unplaced: number;
}
interface View { status: { configured: boolean; blockedUntil: number | null; today: number; dailyCap: number }; entries: Entry[] }

/** Show page: every AniDB entry of the show, in air order, and how it maps onto the TVDB/Plex numbering. */
export function AnidbEntries({ tvdbId, onChanged }: { tvdbId: number; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const d = useLoad(() => (open ? api<View>(`/series/${tvdbId}/anidb`) : Promise.resolve(null)), [open, tvdbId]);
  const [edit, setEdit] = useState<{ aid: number; season: number; offset: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      await d.reload();
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card pad stack" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <strong>{t("anidb.title")}</strong> <span className="muted small">{t("anidb.help")}</span>
      </summary>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {open && !d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && (
        <>
          <div className="row">
            <button className="small" disabled={busy || !d.data.status.configured || !!d.data.status.blockedUntil} onClick={() => void act(() => api(`/series/${tvdbId}/anidb/fetch`, { body: {} }), t("anidb.fetched"))}>
              {t("anidb.fetch")}
            </button>
            <span className="muted small">{d.data.status.blockedUntil ? t("anidb.blocked") : t("anidb.quota", { n: d.data.status.today, cap: d.data.status.dailyCap })}</span>
          </div>
          {!d.data.entries.length && <p className="muted small">{t("anidb.none")}</p>}
          <ul className="rename-list small">
            {d.data.entries.map((e) => (
              <li key={e.aid} className="stack">
                <span>
                  <strong>{e.name}</strong> · {e.type ?? "?"} · {e.episodes ?? "?"} {t("anidb.eps")} · {e.firstAir ?? "?"} ·{" "}
                  <a href={`https://anidb.net/anime/${e.aid}`} target="_blank" rel="noreferrer">
                    AniDB {e.aid} ↗
                  </a>{" "}
                  {!e.fetched && <Chip tone="info">{t("anidb.notFetched")}</Chip>}
                  {e.missing > 0 && <Chip tone="warn">{t("anidb.missing", { n: e.missing })}</Chip>}
                  {e.have > 0 && <Chip tone="good">{t("anidb.have", { n: e.have })}</Chip>}
                  {e.specialsHave > 0 && <Chip tone="info">{t("anidb.specials", { n: e.specialsHave })}</Chip>}
                  {e.unplaced > 0 && <Chip tone="warn">{t("anidb.unplaced", { n: e.unplaced })}</Chip>}
                </span>
                {e.mapping.map((m) => (
                  <span key={m} className="mono">
                    {m}
                  </span>
                ))}
                <span className="muted">
                  {e.override ? t("anidb.overridden", { season: e.override.season, offset: e.override.offset }) : t("anidb.default", { mapping: e.defaultMapping })}{" "}
                  <button className="small ghost" onClick={() => setEdit({ aid: e.aid, season: e.override?.season ?? 1, offset: e.override?.offset ?? 0 })}>
                    {t("anidb.change")}
                  </button>
                  {e.override && (
                    <button className="small ghost" disabled={busy} onClick={() => void act(() => api(`/series/${tvdbId}/anidb/override`, { method: "PUT", body: { aid: e.aid, season: null } }), t("anidb.reset"))}>
                      {t("anidb.resetBtn")}
                    </button>
                  )}
                </span>
                {edit?.aid === e.aid && (
                  <span className="row">
                    {t("anidb.season")}
                    <input type="number" min={0} max={99} value={edit.season} onChange={(x) => setEdit({ ...edit, season: Number(x.target.value) || 0 })} style={{ width: 60 }} aria-label={t("anidb.season")} />
                    {t("anidb.offset")}
                    <input type="number" min={-5000} max={5000} value={edit.offset} onChange={(x) => setEdit({ ...edit, offset: Number(x.target.value) || 0 })} style={{ width: 70 }} aria-label={t("anidb.offset")} />
                    <button className="small primary" disabled={busy} onClick={() => void act(() => api(`/series/${tvdbId}/anidb/override`, { method: "PUT", body: edit }), t("anidb.saved")).then(() => setEdit(null))}>
                      {t("common.save")}
                    </button>
                    <button className="small ghost" onClick={() => setEdit(null)}>
                      {t("common.cancel")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
