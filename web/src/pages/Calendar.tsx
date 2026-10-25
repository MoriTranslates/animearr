import { useEffect, useMemo, useRef, useState } from "react";
import { api, store, sxe } from "../api";
import { EpisodeSheet, StatusPill, type EpisodeStatus } from "../episodes";
import { t } from "../i18n";
import { Cover, Empty, ErrorBox, Spinner, useLoad, usePageTitle } from "../ui";

interface Entry { episodeId: number; tvdbId: number; series: string; cover: string | null; season: number; episode: number; title: string | null; airUtc: number; status: EpisodeStatus; progress: number | null; managed: boolean }

const DAY = 86_400_000;
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function dayTitle(key: number) {
  const today = dayKey(Date.now());
  if (key === today) return t("cal.today");
  if (key === today + DAY) return t("cal.tomorrow");
  if (key === today - DAY) return t("cal.yesterday");
  return new Date(key).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Vertical agenda calendar (Sonarr-style): days down the page, today highlighted, tap an entry for its sheet. */
export function Calendar({ compact = false }: { compact?: boolean }) {
  usePageTitle(t("cal.title"));
  const [managedOnly, setManagedOnly] = useState(() => store.get("calManagedOnly", false));
  const [open, setOpen] = useState<number | null>(null);
  const from = compact ? Date.now() - 2 * DAY : Date.now() - 7 * DAY;
  const to = compact ? Date.now() + 3 * DAY : Date.now() + 14 * DAY;
  const d = useLoad(() => api<{ entries: Entry[] }>(`/calendar?from=${from}&to=${to}${managedOnly ? "&managed=1" : ""}`), [managedOnly, compact]);
  const status = useLoad(() => api<{ dryRun: boolean }>("/status"), []);
  const days = useMemo(() => {
    const map = new Map<number, Entry[]>();
    for (const e of d.data?.entries ?? []) map.set(dayKey(e.airUtc), [...(map.get(dayKey(e.airUtc)) ?? []), e]);
    return [...map].sort((a, b) => a[0] - b[0]);
  }, [d.data]);
  // Keep "downloading" moving.
  const busy = d.data?.entries.some((e) => e.status === "downloading");
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void d.reload(), 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const scrolled = useRef(false);
  useEffect(() => {
    // Scroll today into view once on the full page (not again on every refresh).
    if (compact || !d.data || scrolled.current) return;
    scrolled.current = true;
    document.getElementById("cal-today")?.scrollIntoView({ block: "start" });
  }, [d.data, compact]);

  return (
    <section>
      {!compact && (
        <>
          <h1>{t("cal.title")}</h1>
          <p className="muted">{t("cal.intro")}</p>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={managedOnly}
          onChange={(e) => {
            setManagedOnly(e.target.checked);
            store.set("calManagedOnly", e.target.checked);
          }}
        />
        {t("cal.managed")}
      </label>
      {d.error && <ErrorBox error={d.error} retry={d.reload} />}
      {!d.data && !d.error && <Spinner label={t("app.loading")} />}
      {d.data && !days.length && <Empty>{t("cal.empty")}</Empty>}
      <div className="agenda">
        {days.map(([key, entries]) => (
          <div key={key} className={`agenda-day${key === dayKey(Date.now()) ? " today" : ""}`} id={key === dayKey(Date.now()) ? "cal-today" : undefined}>
            <h2 className="agenda-date">{dayTitle(key)}</h2>
            <ul className="plain">
              {entries.map((e) => (
                <li key={e.episodeId}>
                  <button className="agenda-entry card" onClick={() => setOpen(e.episodeId)}>
                    <Cover src={e.cover} alt={e.series} size="sm" />
                    <span className="agenda-text">
                      <span className="strong clamp2">{e.series}</span>
                      <span className="small">
                        <span className="mono">{sxe(e.season, e.episode)}</span>
                        {e.title ? ` · ${e.title}` : ""}
                      </span>
                      <span className="muted small">{new Date(e.airUtc).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                    </span>
                    <span className="agenda-status">
                      <StatusPill e={{ status: e.status, progress: e.progress, file: null }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {open !== null && <EpisodeSheet episodeId={open} onClose={() => setOpen(null)} onChanged={() => void d.reload()} dryRun={status.data?.dryRun ?? true} />}
    </section>
  );
}
