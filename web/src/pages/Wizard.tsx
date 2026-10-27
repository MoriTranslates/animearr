import { ArrowLeft, ArrowRight, Check, Folder, FolderOpen } from "lucide-react";
import { PhonePanel } from "../phone";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings as S, type Status } from "../api";
import { Link, navigate } from "../App";
import { Cutover } from "../cutover";
import { fromEntry, type CatalogEntry } from "../connectionsEdit";
import { DownloadClients, Indexers, Migration, type SaveNow } from "../connections";
import { t, type I18nKey } from "../i18n";
import { SeasonHeader } from "../seasonal";
import { Settings, type SettingsTab } from "./Settings";
import { ErrorBox, Spinner, useLoad, usePageTitle, useToast } from "../ui";

/**
 * First-run setup: two paths chosen on the welcome screen. Every step can be skipped and comes back later from
 * Settings; progress is saved, so it can be resumed. Re-run from Settings → System, without wiping anything.
 */
type Path = "new" | "migrate";
interface WizardState { done: boolean; path: Path | null; step: string; completed: string[] }
interface Step { id: string; title: I18nKey; intro: I18nKey; body: ReactNode }

/** The settings + a "save just this change" helper, for the embedded connection cards. */
function useSettingsSaver(onSaved: () => void) {
  const toast = useToast();
  const d = useLoad(() => api<S>("/settings"), []);
  const saveNow: SaveNow = async (fn) => {
    try {
      const next = await api<S>("/settings", { method: "PUT", body: fn(structuredClone(d.data!)) });
      d.setData(next);
      toast(t("common.saved"));
      onSaved();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  return { s: d.data, saveNow, reload: d.reload, error: d.error };
}

export function Wizard({ status, onChanged }: { status: Status; onChanged: () => void | Promise<void> }) {
  usePageTitle(t("wiz.title"));
  const toast = useToast();
  const st = useLoad(() => api<WizardState>("/wizard"), []);
  const [w, setW] = useState<WizardState | null>(null);
  useEffect(() => {
    if (st.data) setW(st.data);
  }, [st.data]);
  const saver = useSettingsSaver(onChanged);
  const save = async (patch: Partial<WizardState>) => {
    const next = { ...w!, ...patch };
    setW(next);
    try {
      await api("/wizard", { method: "PUT", body: next });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (st.error) return <ErrorBox error={st.error} retry={st.reload} />;
  if (!w || !saver.s) return <Spinner label={t("app.loading")} />;
  const s = saver.s;
  const section = (only: SettingsTab) => <Settings status={status} onSaved={() => (onChanged(), void saver.reload())} only={only} />;

  if (!w.path || w.step === "welcome")
    return (
      <section className="wizard">
        <SeasonHeader eyebrow={t("wiz.eyebrow")} title={t("wiz.welcome")} sub={t("wiz.welcomeSub")} />
        <div className="wiz-paths">
          <button className="wiz-path card" onClick={() => void save({ path: "new", step: "account" })}>
            <span className="wiz-path-icon" aria-hidden="true">
              ✦
            </span>
            <b>{t("wiz.pathNew")}</b>
            <span className="muted small">{t("wiz.pathNewHelp")}</span>
          </button>
          <button className="wiz-path card" onClick={() => void save({ path: "migrate", step: "connect" })}>
            <span className="wiz-path-icon" aria-hidden="true">
              ⇄
            </span>
            <b>{t("wiz.pathMigrate")}</b>
            <span className="muted small">{t("wiz.pathMigrateHelp")}</span>
          </button>
        </div>
        <p className="muted small">
          {t("wiz.skipAll")}{" "}
          <button className="linklike" onClick={() => void save({ done: true }).then(async () => (await onChanged(), navigate("/settings")))}>
            {t("wiz.skipLink")}
          </button>
        </p>
      </section>
    );

  const steps: Step[] =
    w.path === "new"
      ? [
          { id: "account", title: "wiz.s.account", intro: "wiz.i.account", body: <AccountStep status={status} /> },
          { id: "folders", title: "wiz.s.folders", intro: "wiz.i.folders", body: <FoldersStep s={s} saveNow={saver.saveNow} /> },
          { id: "clients", title: "wiz.s.clients", intro: "wiz.i.clients", body: <ClientsStep s={s} saveNow={saver.saveNow} /> },
          { id: "indexers", title: "wiz.s.indexers", intro: "wiz.i.indexers", body: <IndexersStep s={s} saveNow={saver.saveNow} /> },
          { id: "prefs", title: "wiz.s.prefs", intro: "wiz.i.prefs", body: section("profile") },
          { id: "media", title: "wiz.s.media", intro: "wiz.i.media", body: section("mediaservers") },
          { id: "metadata", title: "wiz.s.metadata", intro: "wiz.i.metadata", body: section("metadata") },
          { id: "notify", title: "wiz.s.notify", intro: "wiz.i.notify", body: section("notifications") },
          { id: "done", title: "wiz.s.done", intro: "wiz.i.done", body: <DoneStep path="new" /> },
        ]
      : [
          { id: "connect", title: "wiz.s.connect", intro: "wiz.i.connect", body: <Migration s={s} saveNow={saver.saveNow} /> },
          { id: "preview", title: "wiz.s.preview", intro: "wiz.i.preview", body: <PreviewStep onApplied={() => (onChanged(), void saver.reload())} /> },
          { id: "review", title: "wiz.s.review", intro: "wiz.i.review", body: <ReviewStep status={status} /> },
          { id: "clients", title: "wiz.s.clients", intro: "wiz.i.clientsMigrate", body: <ClientsStep s={s} saveNow={saver.saveNow} /> },
          { id: "takeover", title: "wiz.s.takeover", intro: "wiz.i.takeover", body: <Cutover /> },
          { id: "done", title: "wiz.s.done", intro: "wiz.i.done", body: <DoneStep path="migrate" /> },
        ];
  const idx = Math.max(0, steps.findIndex((x) => x.id === w.step));
  const step = steps[idx];
  const go = (i: number) => void save({ step: steps[Math.max(0, Math.min(steps.length - 1, i))].id, completed: [...new Set([...w.completed, step.id])] });

  return (
    <section className="wizard">
      <SeasonHeader compact eyebrow={t(w.path === "new" ? "wiz.pathNew" : "wiz.pathMigrate")} title={t(step.title)} sub={t("wiz.stepOf", { n: idx + 1, total: steps.length })}>
        <div className="wiz-progress" role="progressbar" aria-valuenow={idx + 1} aria-valuemin={1} aria-valuemax={steps.length} aria-label={t("wiz.progress")}>
          <i style={{ width: `${Math.round(((idx + 1) / steps.length) * 100)}%` }} />
        </div>
      </SeasonHeader>
      <ol className="wiz-steps" aria-label={t("wiz.progress")}>
        {steps.map((x, i) => (
          <li key={x.id} className={`${i === idx ? "on" : ""}${w.completed.includes(x.id) ? " done" : ""}`}>
            <button className="linklike" onClick={() => go(i)} aria-current={i === idx ? "step" : undefined}>
              {w.completed.includes(x.id) && <Check className="lucide" aria-hidden="true" />}
              {t(x.title)}
            </button>
          </li>
        ))}
      </ol>
      <p className="wiz-intro">{t(step.intro)}</p>
      <div className="wiz-body">{step.body}</div>
      <div className="wiz-nav sticky-actions row between">
        <button onClick={() => (idx === 0 ? void save({ step: "welcome" }) : go(idx - 1))}>
          <ArrowLeft className="lucide" aria-hidden="true" /> {t("wiz.back")}
        </button>
        <span className="row">
          {step.id !== "done" && (
            <button className="ghost" onClick={() => go(idx + 1)}>
              {t("wiz.skip")}
            </button>
          )}
          {step.id === "done" ? (
            <button className="primary" onClick={() => void save({ done: true, completed: steps.map((x) => x.id) }).then(async () => (await onChanged(), navigate("/")))}>
              {t("wiz.finish")}
            </button>
          ) : (
            <button className="primary" onClick={() => go(idx + 1)}>
              {t("wiz.next")} <ArrowRight className="lucide" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

function AccountStep({ status }: { status: Status }) {
  return (
    <div className="card pad stack">
      <p>{status.defaultPassword ? t("wiz.account.default") : t("wiz.account.ok")}</p>
      <p className="muted small">{status.bypassLocal ? t("wiz.account.bypassOn") : t("wiz.account.bypassOff")}</p>
      <Link to="/settings?tab=security" className="button small self-start">
        {t("wiz.account.open")}
      </Link>
    </div>
  );
}

/** Folder browser over the container's mounts: pick the series and movie library folders. */
function FoldersStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const [p, setP] = useState("/");
  const d = useLoad(() => api<{ path: string; parent: string | null; writable: boolean; dirs: { name: string; path: string; writable: boolean }[] }>(`/fs/folders?path=${encodeURIComponent(p)}`), [p]);
  const roots = s.allowedRoots;
  const add = (r: string) => void saveNow((x) => ({ ...x, allowedRoots: [...new Set([...x.allowedRoots, r])] }));
  const remove = (r: string) => void saveNow((x) => ({ ...x, allowedRoots: x.allowedRoots.filter((y) => y !== r) }));
  return (
    <div className="stack">
      <p className="banner slim small">{t("wiz.folders.docker")}</p>
      <div className="card pad stack">
        <h3>{t("wiz.folders.chosen")}</h3>
        {!roots.length && <p className="muted small">{t("wiz.folders.none")}</p>}
        <ul className="plain">
          {roots.map((r) => (
            <li key={r} className="row between">
              <span className="mono">{r}</span>
              <button className="small ghost" onClick={() => remove(r)}>
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="card pad stack folder-browser">
        <div className="row between">
          <span className="mono">{d.data?.path ?? p}</span>
          {d.data && (
            <button className="small primary" disabled={!d.data.writable || roots.includes(d.data.path)} onClick={() => add(d.data!.path)}>
              {d.data.writable ? t("wiz.folders.use") : t("wiz.folders.readOnly")}
            </button>
          )}
        </div>
        {d.error && <p className="warn-text small">{d.error}</p>}
        <ul className="plain folder-list">
          {d.data?.parent && (
            <li>
              <button className="linklike" onClick={() => setP(d.data!.parent!)}>
                <FolderOpen className="lucide" aria-hidden="true" /> ..
              </button>
            </li>
          )}
          {d.data?.dirs.map((x) => (
            <li key={x.path}>
              <button className="linklike" onClick={() => setP(x.path)}>
                <Folder className="lucide" aria-hidden="true" /> {x.name}
              </button>
              {!x.writable && <span className="muted small"> · {t("wiz.folders.readOnly")}</span>}
            </li>
          ))}
        </ul>
        <p className="muted small">{t("wiz.folders.what")}</p>
      </div>
    </div>
  );
}

/** Download clients, with "create the animearr category" for SABnzbd/qBittorrent. */
function ClientsStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const toast = useToast();
  const create = async (client: "sabnzbd" | "qbittorrent") => {
    try {
      const r = await api<{ category: string; existed?: boolean }>("/wizard/category", { body: { client } });
      toast(t(r.existed ? "wiz.cat.existed" : "wiz.cat.created", { cat: r.category }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <DownloadClients s={s} saveNow={saveNow} />
      <div className="row">
        {s.sabnzbd.url && <button onClick={() => void create("sabnzbd")}>{t("wiz.cat.sab", { cat: s.sabnzbd.category })}</button>}
        {s.qbittorrent.url && <button onClick={() => void create("qbittorrent")}>{t("wiz.cat.qbit", { cat: s.qbittorrent.category })}</button>}
      </div>
    </div>
  );
}

/** Indexers, with the starter picks for anime (AnimeTosho, Nyaa, SubsPlease) in one click. */
function IndexersStep({ s, saveNow }: { s: S; saveNow: SaveNow }) {
  const toast = useToast();
  const [key, setKey] = useState(0);
  const starter = async () => {
    try {
      const cat = await api<{ entries: CatalogEntry[] }>("/catalog/indexers");
      const have = new Set(((await api<{ indexers: { catalogId: string | null }[] }>("/indexers")).indexers ?? []).map((x) => x.catalogId));
      let n = 0;
      for (const e of cat.entries.filter((x) => x.recommended && !x.needsKey && !have.has(x.id))) {
        await api("/indexers", { body: fromEntry(e) });
        n++;
      }
      toast(t("wiz.starterAdded", { n }));
      setKey((k) => k + 1);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <div className="card pad row between">
        <span>
          <b>{t("wiz.starter")}</b>
          <br />
          <span className="muted small">{t("wiz.starterHelp")}</span>
        </span>
        <button className="primary" onClick={() => void starter()}>
          {t("wiz.starterAdd")}
        </button>
      </div>
      <Indexers key={key} s={s} saveNow={saveNow} />
    </div>
  );
}

interface Preview { sonarr?: { animeSeries: number; roots: string[]; clients: { name: string; type: string; enabled: boolean; protocol: string; host: string | null; port: number | null; ssl?: boolean; urlBase?: string; category: string | null }[]; indexers: { name: string; type: string; protocol: string; viaProwlarr: boolean }[]; plex: boolean; tags: string[] }; radarr?: { animeMovies: number; roots: string[] } }

/** What Sonarr/Radarr have, with a checkbox per piece to take over. */
function PreviewStep({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const d = useLoad(() => api<Preview>("/wizard/arr-preview"), []);
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [useClients, setUseClients] = useState(true);
  useEffect(() => {
    if (d.data) setRoots(new Set([...(d.data.sonarr?.roots ?? []), ...(d.data.radarr?.roots ?? [])].filter((r) => /anime/i.test(r))));
  }, [d.data]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const so = d.data.sonarr;
  const url = (c: { host: string | null; port: number | null; ssl?: boolean; urlBase?: string }) => (c.host ? `${c.ssl ? "https" : "http"}://${c.host}${c.port ? `:${c.port}` : ""}${c.urlBase ?? ""}` : "");
  const sab = so?.clients.find((c) => /sabnzbd/i.test(c.type) && c.enabled);
  const qb = so?.clients.find((c) => /qbittorrent/i.test(c.type) && c.enabled);
  return (
    <div className="stack">
      {!so && !d.data.radarr && <p className="warn-text">{t("wiz.preview.none")}</p>}
      {so && (
        <div className="card pad stack">
          <h3>Sonarr</h3>
          <p>{t("wiz.preview.series", { n: so.animeSeries })}</p>
          <h4 className="eyebrow">{t("wiz.preview.roots")}</h4>
          {[...so.roots, ...(d.data.radarr?.roots ?? [])].map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={roots.has(r)} onChange={(e) => setRoots((x) => (e.target.checked ? new Set([...x, r]) : new Set([...x].filter((y) => y !== r))))} /> <span className="mono">{r}</span>
            </label>
          ))}
          <h4 className="eyebrow">{t("wiz.preview.clients")}</h4>
          <ul className="plain small">
            {so.clients.map((c) => (
              <li key={c.name}>
                {c.name} · {c.type} · {c.protocol} {url(c) && <span className="mono muted">{url(c)}</span>} {c.enabled ? "" : `· ${t("clients.disabled")}`}
              </li>
            ))}
          </ul>
          {(sab || qb) && (
            <label className="check">
              <input type="checkbox" checked={useClients} onChange={(e) => setUseClients(e.target.checked)} /> {t("wiz.preview.useClients")}
            </label>
          )}
          <h4 className="eyebrow">{t("wiz.preview.indexers")}</h4>
          <ul className="plain small">
            {so.indexers.map((i) => (
              <li key={i.name}>
                {i.name} · {i.protocol} {i.viaProwlarr ? `· ${t("conn.viaProwlarr")}` : ""}
              </li>
            ))}
          </ul>
          {so.indexers.some((i) => i.viaProwlarr) && <p className="muted small">{t("wiz.preview.prowlarrHint")}</p>}
          <p className="small">{so.plex ? t("wiz.preview.plexYes") : t("wiz.preview.plexNo")}</p>
        </div>
      )}
      {d.data.radarr && (
        <div className="card pad">
          <h3>Radarr</h3>
          <p>{t("wiz.preview.movies", { n: d.data.radarr.animeMovies })}</p>
        </div>
      )}
      <button
        className="primary self-start"
        onClick={async () => {
          try {
            await api("/wizard/arr-apply", { body: { roots: [...roots], sab: useClients && sab ? { url: url(sab), category: "animearr" } : null, qbit: useClients && qb ? { url: url(qb), category: "animearr" } : null } });
            toast(t("wiz.preview.applied"));
            onApplied();
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      >
        {t("wiz.preview.apply")}
      </button>
    </div>
  );
}

function ReviewStep({ status }: { status: Status }) {
  const toast = useToast();
  return (
    <div className="stack">
      <div className="card pad stack">
        <h3>{t("wiz.review.naming")}</h3>
        <p className="muted small">{t("wiz.review.namingHelp")}</p>
        <button
          className="self-start"
          onClick={async () => {
            try {
              await api("/media/import-defaults", { body: {} });
              toast(t("common.saved"));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          {t("wiz.review.copyNaming")}
        </button>
      </div>
      <div className="card pad stack">
        <h3>{t("wiz.review.shows", { n: status.librarySeries ?? 0 })}</h3>
        <p className="muted small">{t("wiz.review.showsHelp")}</p>
        <Link to="/shows" className="button small self-start">
          {t("wiz.review.openLibrary")}
        </Link>
      </div>
      <div className="card pad stack">
        <h3>{t("wiz.review.movies")}</h3>
        <p className="muted small">{t("wiz.review.moviesHelp")}</p>
      </div>
    </div>
  );
}

function DoneStep({ path }: { path: Path }) {
  const o = useLoad(() => api<{ clients: { name: string; configured: boolean; ok: boolean | null }[]; indexers: { name: string }[]; mediaServers: { configured: boolean }[] }>("/connections"), []);
  const toast = useToast();
  return (
    <div className="stack">
      {o.data && (
        <ul className="plain card pad stack">
          <li>
            {t("wiz.done.clients")}: {o.data.clients.filter((c) => c.configured).map((c) => c.name).join(", ") || "—"}
          </li>
          <li>
            {t("wiz.done.indexers")}: {o.data.indexers.length}
          </li>
          <li>
            {t("wiz.done.media")}: {o.data.mediaServers.some((m) => m.configured) ? "Plex" : "—"}
          </li>
        </ul>
      )}
      <div className="row">
        <Link to="/find" className="button primary">
          {t("wiz.done.addShow")}
        </Link>
        {path === "new" && (
          <button
            onClick={async () => {
              try {
                await api("/files/scan", { body: {} });
                toast(t("wiz.done.scanning"));
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            {t("wiz.done.haveFiles")}
          </button>
        )}
      </div>
      <div className="card pad stack">
        <h3>{t("phone.settingsTitle")}</h3>
        <PhonePanel />
      </div>
      <p className="muted small">{t("wiz.done.later")}</p>
    </div>
  );
}
