import { useEffect, useState } from "react";
import { applyFont } from "../appearance";
import { api, fmtSize, store, type PathMapping, type Settings as S, type Status } from "../api";
import { applyTheme, query } from "../App";
import { t, type I18nKey } from "../i18n";
import { Cutover } from "../cutover";
import { DownloadClients, Indexers, MediaServers, Migration, SectionIntro, type SaveNow } from "../connections";
import { NotifyCard } from "../notify";
import { DownloadRules } from "../downloads";
import { MediaManagement } from "../media";
import { ProfilesEditor } from "../profiles";
import { ScopeFields } from "../scope";
import { Chip, Confirm, ErrorBox, ListInput, NumberInput, relTime, SecretInput, Spinner, Toggle, useLoad, usePageTitle, useToast } from "../ui";

type Tab = "indexers" | "clients" | "mediaservers" | "notifications" | "migration" | "profile" | "media" | "paths" | "metadata" | "downloads" | "safety" | "appearance" | "security" | "system";

/** Settings, grouped like Sonarr's: a left sub-nav on desktop, a list on phones. */
const SECTIONS: { label: I18nKey; tabs: { id: Tab; icon: string }[] }[] = [
  { label: "settings.group.connect", tabs: [{ id: "indexers", icon: "⌕" }, { id: "clients", icon: "↓" }, { id: "mediaservers", icon: "▶" }, { id: "notifications", icon: "🔔" }, { id: "migration", icon: "⇄" }] },
  { label: "settings.group.library", tabs: [{ id: "profile", icon: "◐" }, { id: "media", icon: "▦" }, { id: "paths", icon: "⤳" }, { id: "metadata", icon: "ⓘ" }] },
  { label: "settings.group.automation", tabs: [{ id: "safety", icon: "★" }, { id: "downloads", icon: "⛁" }] },
  { label: "settings.group.general", tabs: [{ id: "appearance", icon: "◑" }, { id: "security", icon: "🔒" }, { id: "system", icon: "⚙" }] },
];
const TABS = SECTIONS.flatMap((x) => x.tabs.map((y) => y.id));
/** Old links (?tab=connections, ?tab=cutover) still land in the right place. */
const ALIAS: Record<string, Tab> = { connections: "indexers", cutover: "migration", plex: "mediaservers" };
/** Tabs whose fields save with the page's Save button (the connection tabs save in their own dialogs). */
const FORM_TABS: Tab[] = ["notifications", "media", "downloads", "safety", "paths", "metadata"];

export type SettingsTab = Tab;

/** `only`: one section without the Settings frame (the setup wizard embeds them). */
export function Settings({ status, onSaved, only }: { status: Status; onSaved: () => void; only?: Tab }) {
  usePageTitle(only ? t("wiz.title") : t("settings.title"));
  const toast = useToast();
  const q = query().get("tab") ?? "";
  const initial = (ALIAS[q] ?? q) as Tab;
  const [tab, setTabState] = useState<Tab | null>(only ?? (TABS.includes(initial) ? initial : null));
  const loaded = useLoad(() => api<S>("/settings"), []);
  const [s, setS] = useState<S | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  useEffect(() => {
    if (only) return;
    const onPop = () => {
      const x = query().get("tab") ?? "";
      const t2 = (ALIAS[x] ?? x) as Tab;
      // Leaving a tab with the browser's Back drops its unsaved edits (they'd otherwise ride along with a later save).
      setDirty((d) => {
        if (d && loaded.data) setS(loaded.data);
        return false;
      });
      setTabState(TABS.includes(t2) ? t2 : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setTab = (x: Tab | null) => {
    if (dirty && !window.confirm(t("settings.unsavedLeave"))) return;
    if (dirty && loaded.data) (setS(loaded.data), setDirty(false));
    setTabState(x);
    history.pushState(null, "", x ? `/settings?tab=${x}` : "/settings");
    window.scrollTo(0, 0);
  };
  const upd = (fn: (x: S) => S) => {
    setS((x) => (x ? fn(structuredClone(x)) : x));
    setDirty(true);
  };
  async function save() {
    if (!s) return;
    try {
      const next = await api<S>("/settings", { method: "PUT", body: s });
      setS(next);
      setDirty(false);
      toast(t("common.saved"));
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  /** Connection dialogs save straight away (only their own change, on top of what's saved). */
  const saveNow: SaveNow = async (fn) => {
    try {
      const base = loaded.data ?? s!;
      const next = await api<S>("/settings", { method: "PUT", body: fn(structuredClone(base)) });
      loaded.setData(next);
      if (!dirty) setS(next);
      toast(t("common.saved"));
      onSaved();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  if (loaded.error) return <ErrorBox error={loaded.error} retry={loaded.reload} />;
  if (!s) return <Spinner label={t("app.loading")} />;
  const cur = s;
  function body(x: Tab) {
    const s = cur;
    return (
      <>
          {x === "indexers" && <Indexers s={s} saveNow={saveNow} />}
          {x === "clients" && <DownloadClients s={s} saveNow={saveNow} />}
          {x === "mediaservers" && <MediaServers s={s} saveNow={saveNow} plexForm={(draft, set) => <PlexCard s={draft} upd={set} bare />} />}
          {x === "notifications" && (
            <>
              <SectionIntro icon="🔔" text={t("conn.intro.notifications")} />
              <NotifyCard s={s} upd={upd} />
            </>
          )}
          {x === "migration" && (
            <Migration s={s} saveNow={saveNow}>
              <Cutover />
            </Migration>
          )}
          {x === "profile" && <ProfilesEditor />}
          {x === "media" && <MediaManagement s={s} upd={upd} />}
          {x === "downloads" && <DownloadRules s={s} upd={upd} />}
          {x === "safety" && <Safety s={s} upd={upd} />}
          {x === "paths" && <Paths s={s} upd={upd} />}
          {x === "metadata" && <Metadata s={s} upd={upd} />}
          {x === "appearance" && <Appearance />}
          {x === "system" && <System status={status} />}
          {x === "security" && <Security s={s} status={status} onChanged={onSaved} />}
          {FORM_TABS.includes(x) && (
            <div className="sticky-actions row">
              <button className="primary" disabled={!dirty} onClick={save}>
                {t("common.save")}
              </button>
              {dirty && (
                <>
                  <span className="muted small">{t("settings.unsaved")}</span>
                  <button className="ghost small" onClick={() => (loaded.data && setS(loaded.data), setDirty(false))}>
                    {t("settings.discard")}
                  </button>
                </>
              )}
            </div>
          )}
      </>
    );
  }

  const nav = (
    <nav className="settings-nav" aria-label={t("settings.title")}>
      {SECTIONS.map((g) => (
        <div key={g.label} className="settings-group">
          <h2 className="eyebrow">{t(g.label)}</h2>
          <ul className="plain">
            {g.tabs.map((x) => (
              <li key={x.id}>
                <a
                  href={`/settings?tab=${x.id}`}
                  className={tab === x.id ? "active" : ""}
                  aria-current={tab === x.id ? "page" : undefined}
                  onClick={(e) => (e.preventDefault(), setTab(x.id))}
                >
                  <span aria-hidden="true" className="more-icon">
                    {x.icon}
                  </span>
                  <span className="grow">{t(`settings.tab.${x.id}` as I18nKey)}</span>
                  <span className="chevron" aria-hidden="true">
                    ›
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
  if (only) return <div className="settings-only stack">{body(only)}</div>;
  return (
    <section className={`settings${tab ? " has-tab" : ""}`}>
      <div className="row between settings-title">
        {tab ? (
          <button className="linklike settings-back" onClick={() => setTab(null)}>
            ‹ {t("settings.title")}
          </button>
        ) : null}
        <h1>{tab ? t(`settings.tab.${tab}` as I18nKey) : t("settings.title")}</h1>
      </div>
      <div className="settings-layout">
        {nav}
        <div className="settings-body stack">
          {!tab && <p className="muted small settings-pick">{t("settings.pick")}</p>}
          {tab && body(tab)}
        </div>
      </div>
    </section>
  );
}

/** Appearance (this device): theme, and how messages pop up. */
function Appearance() {
  const [theme, setTheme] = useState(store.get("theme", "dark"));
  const [toastStyle, setToastStyle] = useState(store.get("toastStyle", "bubble"));
  const [font, setFont] = useState(store.get("font", "inter"));
  const [exclaim, setExclaim] = useState(store.get("exclaim", "sometimes"));
  const [palette, setPalette] = useState(store.get("palette", "season"));
  const toast = useToast();
  return (
    <div className="stack">
      <SectionIntro icon="◑" text={t("appearance.intro")} />
      <div className="card pad form">
        <label>
          {t("settings.system.theme")}
          <select
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value);
              store.set("theme", e.target.value);
              applyTheme(e.target.value);
            }}
          >
            <option value="dark">{t("settings.system.dark")}</option>
            <option value="light">{t("settings.system.light")}</option>
          </select>
        </label>
        <label>
          {t("appearance.toasts")}
          <select
            value={toastStyle}
            onChange={(e) => {
              setToastStyle(e.target.value);
              store.set("toastStyle", e.target.value);
              applyTheme(store.get("theme", "dark"));
            }}
          >
            <option value="bubble">{t("appearance.toasts.bubble")}</option>
            <option value="standard">{t("appearance.toasts.standard")}</option>
          </select>
          <span className="muted small">{t("appearance.toastsHelp")}</span>
        </label>
        <label>
          {t("appearance.palette")}
          <select
            value={palette}
            onChange={(e) => {
              setPalette(e.target.value);
              store.set("palette", e.target.value);
              applyTheme(store.get("theme", "dark"));
            }}
          >
            <option value="season">{t("appearance.palette.season")}</option>
            <option value="merry">{t("appearance.palette.merry")}</option>
          </select>
          <span className="muted small">{t("appearance.paletteHelp")}</span>
        </label>
        <label>
          {t("appearance.font")}
          <select
            value={font}
            onChange={(e) => {
              setFont(e.target.value);
              store.set("font", e.target.value);
              applyFont(e.target.value);
            }}
          >
            <option value="inter">{t("appearance.font.inter")}</option>
            <option value="system">{t("appearance.font.system")}</option>
            <option value="comic">{t("appearance.font.comic")}</option>
          </select>
          <span className="muted small">{t("appearance.fontHelp")}</span>
        </label>
        <label>
          {t("appearance.exclaim")}
          <select
            value={exclaim}
            onChange={(e) => {
              setExclaim(e.target.value);
              store.set("exclaim", e.target.value);
            }}
          >
            <option value="off">{t("appearance.exclaim.off")}</option>
            <option value="sometimes">{t("appearance.exclaim.sometimes")}</option>
            <option value="always">{t("appearance.exclaim.always")}</option>
          </select>
          <span className="muted small">{t("appearance.exclaimHelp")}</span>
        </label>
        <button className="small self-start" onClick={() => toast(t("appearance.preview"), false, undefined, { kind: "grab", burst: "always" })}>
          {t("appearance.try")}
        </button>
      </div>
    </div>
  );
}

type Upd = (fn: (x: S) => S) => void;

/** Per-show dry-run overrides (managed shows). */
function ShowDryRuns() {
  const toast = useToast();
  const d = useLoad(() => api<{ shows: { tvdbId: number; title: string; dryRun: boolean }[] }>("/managed"), []);
  if (!d.data?.shows.length) return null;
  const set = async (tvdbId: number, dryRun: boolean) => {
    try {
      await api(`/managed/${tvdbId}`, { method: "PUT", body: { dryRun } });
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const on = d.data.shows.filter((x) => x.dryRun);
  return (
    <div className="stack">
      <p className="small">{on.length ? t("dry.showsOn", { n: on.length }) : t("dry.showsNone")}</p>
      <ul className="plain stack">
        {d.data.shows.map((x) => (
          <li key={x.tvdbId}>
            <Toggle checked={x.dryRun} onChange={(v) => void set(x.tvdbId, v)} label={x.title} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Safety({ s, upd }: { s: S; upd: Upd }) {
  const roots = useLoad(() => api<{ roots: { path: string; freeSpace?: number; app?: "sonarr" | "radarr" }[]; suggested: string | null }>("/sonarr/rootfolders"), []);
  const m = s.managed;
  const setM = (fn: (x: S["managed"]) => S["managed"]) => upd((x) => ({ ...x, managed: fn(x.managed) }));
  return (
    <div className="stack">
      <details className="card pad stack" open={m.dryRun}>
        <summary>
          <strong>{t("dry.section")}</strong> <span className="muted small">{t("dry.sectionHelp")}</span>
        </summary>
        <Toggle checked={m.dryRun} onChange={(v) => setM((x) => ({ ...x, dryRun: v }))} label={t("settings.safety.dryRun")} help={t("settings.safety.dryRunHelp")} />
        <ShowDryRuns />
      </details>
      <div className="card pad stack">
        <h2>{t("settings.safety.roots")}</h2>
        <p className="muted small">{t("settings.safety.rootsHelp")}</p>
        {roots.error && <p className="warn-text">{roots.error}</p>}
        <div className="stack">
          {(roots.data?.roots ?? []).map((r) => (
            <label key={r.path} className="check">
              <input
                type="checkbox"
                checked={s.allowedRoots.includes(r.path)}
                onChange={(e) => upd((x) => ({ ...x, allowedRoots: e.target.checked ? [...x.allowedRoots, r.path] : x.allowedRoots.filter((y) => y !== r.path) }))}
              />
              <span className="mono">{r.path}</span>
              {r.app === "radarr" && <Chip>{t("settings.safety.radarrRoot")}</Chip>}
              {roots.data?.suggested === r.path && <Chip tone="accent">{t("settings.safety.suggested")}</Chip>}
            </label>
          ))}
        </div>
      </div>
      <div className="card pad stack">
        <h2>{t("scope.defaults")}</h2>
        <p className="muted small">{t("scope.defaultsHelp")}</p>
        <h3>{t("scope.forEnded")}</h3>
        <ScopeFields value={s.scope.ended} onChange={(v) => upd((x) => ({ ...x, scope: { ...x.scope, ended: v } }))} />
        <h3>{t("scope.forContinuing")}</h3>
        <ScopeFields value={s.scope.continuing} onChange={(v) => upd((x) => ({ ...x, scope: { ...x.scope, continuing: v } }))} />
      </div>
      <Backlog s={s} upd={upd} />
      <MovieSearch s={s} upd={upd} />
      <div className="card pad stack">
        <h2>{t("dual.title")}</h2>
        <p className="muted small">{t("dual.help")}</p>
        <div className="form">
          <label>
            {t("repair.mode")}
            <select value={s.dualUpgrade.mode} onChange={(e) => upd((x) => ({ ...x, dualUpgrade: { ...x.dualUpgrade, mode: e.target.value as "off" | "log" | "auto" } }))}>
              <option value="off">{t("repair.mode.off")}</option>
              <option value="log">{t("repair.mode.log")}</option>
              <option value="auto">{t("dual.auto")}</option>
            </select>
          </label>
          <label>
            {t("backlog.perHour")}
            <NumberInput value={s.dualUpgrade.perHour} min={1} max={24} onChange={(v) => upd((x) => ({ ...x, dualUpgrade: { ...x.dualUpgrade, perHour: v } }))} label={t("backlog.perHour")} />
          </label>
          <label>
            {t("dual.recheckDays")}
            <NumberInput value={s.dualUpgrade.recheckDays} min={1} max={60} onChange={(v) => upd((x) => ({ ...x, dualUpgrade: { ...x.dualUpgrade, recheckDays: v } }))} label={t("dual.recheckDays")} />
          </label>
          <label>
            {t("dual.maxAgeDays")}
            <NumberInput value={s.dualUpgrade.maxAgeDays} min={7} max={3650} onChange={(v) => upd((x) => ({ ...x, dualUpgrade: { ...x.dualUpgrade, maxAgeDays: v } }))} label={t("dual.maxAgeDays")} />
          </label>
        </div>
      </div>
      <div className="card pad stack">
        <h2>{t("qh.title")}</h2>
        <p className="muted small">{t("qh.help")}</p>
        <div className="form">
          <label>
            {t("qh.stallHours")}
            <NumberInput value={s.queueHealth.stallHours} min={1} max={72} onChange={(v) => upd((x) => ({ ...x, queueHealth: { ...x.queueHealth, stallHours: v } }))} label={t("qh.stallHours")} />
          </label>
          <label>
            {t("qh.metadataMin")}
            <NumberInput value={s.queueHealth.metadataMin} min={10} max={1440} onChange={(v) => upd((x) => ({ ...x, queueHealth: { ...x.queueHealth, metadataMin: v } }))} label={t("qh.metadataMin")} />
          </label>
        </div>
        <Toggle checked={s.queueHealth.removeFailed} onChange={(v) => upd((x) => ({ ...x, queueHealth: { ...x.queueHealth, removeFailed: v } }))} label={t("qh.removeFailed")} help={t("qh.removeFailedHelp")} />
      </div>
      <div className="card pad stack">
        <Toggle checked={s.extraction.enabled} onChange={(v) => upd((x) => ({ ...x, extraction: { enabled: v } }))} label={t("extract.enabled")} help={t("extract.help")} />
      </div>
      <div className="card pad stack">
        <h2>{t("repair.title")}</h2>
        <p className="muted small">{t("repair.help")}</p>
        <div className="form">
          <label>
            {t("repair.mode")}
            <select value={s.repair.mode} onChange={(e) => upd((x) => ({ ...x, repair: { ...x.repair, mode: e.target.value as "off" | "log" | "auto" } }))}>
              <option value="off">{t("repair.mode.off")}</option>
              <option value="log">{t("repair.mode.log")}</option>
              <option value="auto">{t("repair.mode.auto")}</option>
            </select>
          </label>
          <label>
            {t("repair.maxPerDay")}
            <NumberInput value={s.repair.maxPerDay} min={1} max={100} onChange={(v) => upd((x) => ({ ...x, repair: { ...x.repair, maxPerDay: v } }))} label={t("repair.maxPerDay")} />
          </label>
        </div>
      </div>
      <div className="card pad form">
        <label>
          {t("settings.safety.delay")}
          <NumberInput value={m.searchDelayMin} min={0} max={1440} onChange={(v) => setM((x) => ({ ...x, searchDelayMin: v }))} label={t("settings.safety.delay")} />
        </label>
        <label>
          {t("settings.safety.backoff")}
          <ListInput value={m.backoffMin} onChange={(v) => setM((x) => ({ ...x, backoffMin: v.map(Number).filter((n) => n > 0) }))} label={t("settings.safety.backoff")} />
        </label>
        <label>
          {t("settings.safety.attempts")}
          <NumberInput value={m.maxAttempts} min={1} max={100} onChange={(v) => setM((x) => ({ ...x, maxAttempts: v }))} label={t("settings.safety.attempts")} />
        </label>
        <label>
          {t("settings.safety.rss")}
          <NumberInput value={m.rssMin} min={0} max={1440} onChange={(v) => setM((x) => ({ ...x, rssMin: v }))} label={t("settings.safety.rss")} />
        </label>
        <label>
          {t("settings.safety.confidence")}
          <NumberInput value={m.minConfidence} min={50} max={100} onChange={(v) => setM((x) => ({ ...x, minConfidence: v }))} label={t("settings.safety.confidence")} />
        </label>
      </div>
    </div>
  );
}

/** Automatic movie search (release watching + missing movies): off by default, confirmed, rate-limited. */
function MovieSearch({ s, upd }: { s: S; upd: Upd }) {
  const sum = useLoad(() => api<{ wanted: number; released: number; states: Record<string, number> }>("/movies-search"), []);
  const [confirm, setConfirm] = useState(false);
  const m = s.movieSearch;
  const setM = (fn: (x: S["movieSearch"]) => S["movieSearch"]) => upd((x) => ({ ...x, movieSearch: fn(x.movieSearch) }));
  return (
    <div className="card pad stack">
      <h2>{t("msearch.title")}</h2>
      <p className="muted small">{t("msearch.help")}</p>
      <Toggle checked={m.enabled} onChange={(v) => (v ? setConfirm(true) : setM((x) => ({ ...x, enabled: false })))} label={t("msearch.enabled")} help={t("msearch.enabledHelp")} />
      {confirm && (
        <Confirm title={t("msearch.confirmTitle")} confirmLabel={t("backlog.confirmOk")} onClose={() => setConfirm(false)} onConfirm={() => (setM((x) => ({ ...x, enabled: true })), setConfirm(false))}>
          <p>{sum.data ? t("msearch.confirmBody", { released: sum.data.released, wanted: sum.data.wanted, perHour: m.perHour }) : t("app.loading")}</p>
          <p className="muted small">{t("backlog.confirmSave")}</p>
        </Confirm>
      )}
      {sum.data && <p className="small">{t("msearch.summary", { wanted: sum.data.wanted, released: sum.data.released })}</p>}
      <div className="form">
        <label>
          {t("msearch.delay")}
          <NumberInput value={m.delayHours} min={0} max={168} onChange={(v) => setM((x) => ({ ...x, delayHours: v }))} label={t("msearch.delay")} />
        </label>
        <label>
          {t("backlog.perHour")}
          <NumberInput value={m.perHour} min={1} max={12} onChange={(v) => setM((x) => ({ ...x, perHour: v }))} label={t("backlog.perHour")} />
        </label>
        <label>
          {t("backlog.retryDays")}
          <NumberInput value={m.retryDays} min={1} max={60} onChange={(v) => setM((x) => ({ ...x, retryDays: v }))} label={t("backlog.retryDays")} />
        </label>
      </div>
    </div>
  );
}

/** Missing-episode search: off by default, rate-limited, with what it would do. */
function Backlog({ s, upd }: { s: S; upd: Upd }) {
  const sum = useLoad(() => api<{ missing: number; missingLive: number; liveShows: number; states: Record<string, number>; searchedLastHour: number }>("/backlog"), []);
  const [confirm, setConfirm] = useState(false);
  const b = s.backlog;
  const setB = (fn: (x: S["backlog"]) => S["backlog"]) => upd((x) => ({ ...x, backlog: fn(x.backlog) }));
  const st = sum.data?.states ?? {};
  return (
    <div className="card pad stack">
      <h2>{t("backlog.title")}</h2>
      <p className="muted small">{t("backlog.help")}</p>
      <Toggle checked={b.enabled} onChange={(v) => (v ? setConfirm(true) : setB((x) => ({ ...x, enabled: false })))} label={t("backlog.enabled")} help={t("backlog.enabledHelp")} />
      {confirm && (
        <Confirm title={t("backlog.confirmTitle")} confirmLabel={t("backlog.confirmOk")} onClose={() => setConfirm(false)} onConfirm={() => (setB((x) => ({ ...x, enabled: true })), setConfirm(false))}>
          <p>{t("backlog.confirmBody", { live: sum.data?.liveShows ?? 0, missing: sum.data?.missingLive ?? 0, perHour: b.perHour })}</p>
          <p className="muted small">{t("backlog.confirmSave")}</p>
        </Confirm>
      )}
      {sum.data && (
        <p className="small">
          {t("backlog.summary", { missing: sum.data.missing, queued: st.backlog ?? 0, wouldGrab: st["would-grab"] ?? 0, grabbed: st.grabbed ?? 0, hour: sum.data.searchedLastHour })}
        </p>
      )}
      <div className="form">
        <label>
          {t("backlog.perHour")}
          <NumberInput value={b.perHour} min={1} max={24} onChange={(v) => setB((x) => ({ ...x, perHour: v }))} label={t("backlog.perHour")} />
        </label>
        <label>
          {t("backlog.retryDays")}
          <NumberInput value={b.retryDays} min={1} max={60} onChange={(v) => setB((x) => ({ ...x, retryDays: v }))} label={t("backlog.retryDays")} />
        </label>
      </div>
    </div>
  );
}

function MappingList({ value, onChange, title, help }: { value: PathMapping[]; onChange: (v: PathMapping[]) => void; title: string; help: string }) {
  return (
    <div className="card pad stack">
      <h2>{title}</h2>
      <p className="muted small">{help}</p>
      {value.map((m, i) => (
        <div key={i} className="row">
          <input className="grow" value={m.from} placeholder={t("settings.paths.from")} aria-label={t("settings.paths.from")} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span aria-hidden="true">→</span>
          <input className="grow" value={m.to} placeholder={t("settings.paths.to")} aria-label={t("settings.paths.to")} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <button className="small ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            {t("common.delete")}
          </button>
        </div>
      ))}
      <button className="small self-start" onClick={() => onChange([...value, { from: "", to: "" }])}>
        {t("common.add")}
      </button>
    </div>
  );
}

/** Plex: partial scans after AnimeArr's own imports and renames (token stored encrypted; read-only otherwise). */
function PlexCard({ s, upd, bare = false }: { s: S; upd: Upd; bare?: boolean }) {
  const toast = useToast();
  const p = s.plex;
  const set = (patch: Partial<S["plex"]>) => upd((x) => ({ ...x, plex: { ...x.plex, ...patch } }));
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className={bare ? "stack" : "card pad stack"}>
      <div className="row between">
        {!bare && <h2>Plex</h2>}
        <button
          className="small"
          onClick={async () => {
            try {
              const r = await api<{ version: string; name: string; sections: { title: string; locations: string[] }[] }>("/test/plex", { body: { url: p.url, apiKey: p.token } });
              setRes({ ok: true, text: t("plex.testOk", { name: r.name, version: r.version, libs: r.sections.map((x) => `${x.title} (${x.locations.join(", ")})`).join("; ") }) });
            } catch (e) {
              setRes({ ok: false, text: (e as Error).message });
              toast((e as Error).message, true);
            }
          }}
        >
          {bare ? t("plex.testLibraries") : t("common.test")}
        </button>
      </div>
      <p className="muted small">{t("plex.help")}</p>
      <div className="form">
        <label>
          {t("settings.url")}
          <input value={p.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://192.168.1.10:32400" />
        </label>
        <label className="field">
          {t("plex.token")}
          <SecretInput value={p.token} onChange={(v) => set({ token: v })} label={t("plex.token")} />
        </label>
        <Toggle checked={p.enabled} onChange={(v) => set({ enabled: v })} label={t("plex.enabled")} />
      </div>
      <MappingList value={p.pathMappings} onChange={(v) => set({ pathMappings: v })} title={t("plex.paths")} help={t("plex.pathsHelp")} />
      {res && <p className={`small ${res.ok ? "good-text" : "warn-text"}`}>{res.text}</p>}
    </div>
  );
}

function Paths({ s, upd }: { s: S; upd: Upd }) {
  return (
    <div className="stack">
      <MappingList value={s.localPathMappings} onChange={(v) => upd((x) => ({ ...x, localPathMappings: v }))} title={t("settings.paths.local")} help={t("settings.paths.localHelp")} />
      <MappingList value={s.remotePathMappings} onChange={(v) => upd((x) => ({ ...x, remotePathMappings: v }))} title={t("settings.paths.remote")} help={t("settings.paths.remoteHelp")} />
    </div>
  );
}

interface SystemInfo {
  version: string;
  jobs: { name: string; state: string; detail: string; finishedAt: number | null }[];
  metadata: { anidb: { count: number }; animeLists: { count: number } };
  aliasKeys: number;
  db: { corrupt: boolean; detail: string };
  backups: { name: string; kind: string; size: number; at: number }[];
  backupDir: string;
  memoryMb: number;
}

/** Own metadata: what the catalog knows, optional provider keys. */
function Metadata({ s, upd }: { s: S; upd: Upd }) {
  const toast = useToast();
  const d = useLoad(() => api<{ entries: number; franchises: number; episodes: number; withTitles: number; withoutTvdb: number; donghua: number; providers: Record<string, boolean>; pending: Record<string, boolean>; lastJob: { state: string; detail: string } | null }>("/catalog"), []);
  const m = s.metadata;
  const setM = (fn: (x: S["metadata"]) => S["metadata"]) => upd((x) => ({ ...x, metadata: fn(x.metadata) }));
  return (
    <div className="stack">
      <div className="card pad stack">
        <h2>{t("meta.title")}</h2>
        <p className="muted small">{t("meta.help")}</p>
        {d.data && (
          <>
            <p className="small">{t("meta.counts", { entries: d.data.entries, franchises: d.data.franchises, episodes: d.data.episodes, titles: d.data.withTitles, noTvdb: d.data.withoutTvdb, donghua: d.data.donghua })}</p>
            {d.data.lastJob && <p className="small muted">{d.data.lastJob.detail}</p>}
            <div className="chips">
              {Object.entries(d.data.providers).map(([k, on]) => (
                <span key={k} className={`chip ${on ? "good" : "info"}`}>
                  {on ? "✓" : "○"} {t(`meta.provider.${k}` as I18nKey)}
                </span>
              ))}
              {Object.entries(d.data.pending).map(([k, on]) => (
                <span key={k} className="chip info">
                  {on ? t("meta.savedNotUsed", { name: t(`meta.provider.${k}` as I18nKey) }) : `○ ${t(`meta.provider.${k}` as I18nKey)}`}
                </span>
              ))}
            </div>
          </>
        )}
        <button
          className="small self-start"
          onClick={async () => {
            try {
              const r = await api<{ started: boolean }>("/catalog/refresh", { body: {} });
              toast(r.started ? t("meta.refreshing") : t("meta.alreadyRunning"));
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          ↻ {t("meta.refresh")}
        </button>
      </div>
      <div className="card pad form">
        <h2>{t("meta.providers")}</h2>
        <label>
          {t("meta.tmdb")}
          <span className="row">
            <SecretInput value={m.tmdbKey} onChange={(v) => setM((x) => ({ ...x, tmdbKey: v.trim() }))} label={t("meta.tmdb")} />
            <button
              type="button"
              className="small"
              onClick={async () => {
                try {
                  const r = await api<{ kind: string }>("/test/tmdb", { body: { key: m.tmdbKey } });
                  toast(t("meta.tmdbOk", { kind: r.kind === "token" ? "Read Access Token" : "API key" }));
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              {t("meta.tmdbTest")}
            </button>
          </span>
          <span className="muted small">{t("meta.tmdbHelp")}</span>
        </label>
        <label>
          {t("meta.anidb")}
          <input value={m.anidbClient} onChange={(e) => setM((x) => ({ ...x, anidbClient: e.target.value }))} placeholder="animearr" />
          <span className="muted small">{t("meta.anidbHelp")}</span>
        </label>
        <label>
          {t("meta.anidbVer")}
          <NumberInput value={m.anidbClientVer} min={1} max={99} onChange={(v) => setM((x) => ({ ...x, anidbClientVer: v }))} label={t("meta.anidbVer")} />
        </label>
        <label>
          {t("meta.tvdb")}
          <SecretInput value={m.tvdbKey} onChange={(v) => setM((x) => ({ ...x, tvdbKey: v }))} label={t("meta.tvdb")} />
          <span className="muted small">{t("meta.tvdbHelp")}</span>
        </label>
      </div>
    </div>
  );
}

/** AnimeArr's own file records: what was scanned, problems found, scan now. */
function LibraryFiles() {
  const toast = useToast();
  const d = useLoad(() => api<{ roots: string[]; byRoot: { root: string; n: number; bytes: number }[]; total: number; probed: number; errors: number; errorSamples: { path: string; error: string }[]; forcedOnlyEnglish: number; forcedSamples: string[]; lastScan: { state: string; detail: string } | null; progress: { phase: string; done: number; total: number; running: boolean } }>("/files/summary"), []);
  useEffect(() => {
    if (!d.data?.progress.running) return;
    const id = setInterval(() => void d.reload(), 5000);
    return () => clearInterval(id);
  }, [d.data?.progress.running, d.reload]);
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return null;
  const x = d.data;
  return (
    <div className="card pad stack">
      <h2>{t("files.title")}</h2>
      <p className="muted small">{t("files.help")}</p>
      {x.lastScan && <p className="small muted">{t("files.last", { detail: x.lastScan.detail })}</p>}
      <p className="small">{t("files.counts", { total: x.total, probed: x.probed, errors: x.errors })}</p>
      {x.progress.running && <p className="small">{x.progress.phase === "walking" ? t("files.walking") : t("files.probing", { done: x.progress.done, total: x.progress.total })}</p>}
      <ul className="plain small">
        {x.roots.map((r) => {
          const b = x.byRoot.find((y) => y.root === r);
          return (
            <li key={r}>
              <span className="mono">{r}</span> · {b ? `${b.n} · ${fmtSize(b.bytes ?? 0)}` : t("files.notScanned")}
            </li>
          );
        })}
      </ul>
      {x.forcedOnlyEnglish > 0 && (
        <details>
          <summary className="warn-text small">{t("files.forcedOnly", { n: x.forcedOnlyEnglish })}</summary>
          <ul className="plain small mono">{x.forcedSamples.map((p) => <li key={p}>{p}</li>)}</ul>
        </details>
      )}
      {x.errors > 0 && (
        <details>
          <summary className="small">{t("files.errors", { n: x.errors })}</summary>
          <ul className="plain small">{x.errorSamples.map((e) => <li key={e.path}><span className="mono">{e.path}</span> · {e.error}</li>)}</ul>
        </details>
      )}
      <div className="row">
        <button
          className="small"
          disabled={x.progress.running}
          onClick={async () => {
            try {
              await api("/files/scan", { body: {} });
              toast(t("files.started"));
              setTimeout(() => void d.reload(), 1500);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          {t("files.scanNow")}
        </button>
      </div>
    </div>
  );
}

function System({ status }: { status: Status }) {
  const toast = useToast();
  const d = useLoad(() => api<SystemInfo>("/system"), []);
  const [restore, setRestore] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  if (!d.data) return <Spinner label={t("app.loading")} />;
  const x = d.data;
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      await d.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      {x.db.corrupt && <p className="banner warn">{t("settings.system.dbCorrupt", { detail: x.db.detail })}</p>}
      <LibraryFiles />
      <div className="card pad stack">
        <h2>{t("support.title")}</h2>
        <p className="small">{t("support.body")}</p>
        <p>
          <a className="button-link" href="https://ko-fi.com/moritranslates" target="_blank" rel="noreferrer">
            {t("app.support")}
          </a>
        </p>
      </div>
      <div className="card pad stack">
        <h2>{t("settings.system.jobs")}</h2>
        <ul className="plain">
          {x.jobs.map((j) => (
            <li key={j.name}>
              <Chip tone={j.state === "error" ? "bad" : j.state === "running" ? "warn" : "good"}>{j.name}</Chip> <span className="small">{j.detail}</span> {j.finishedAt && <span className="muted small">· {relTime(j.finishedAt)}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="card pad stack">
        <h2>{t("settings.system.metadata")}</h2>
        <p className="small">
          AniDB {x.metadata.anidb.count} · Anime-Lists {x.metadata.animeLists.count} · {x.aliasKeys} alias keys · {x.memoryMb} MB
        </p>
        <button className="small self-start" onClick={() => act(() => api("/system/metadata", { body: {} }), t("common.saved"))}>
          {t("settings.system.refreshMeta")}
        </button>
      </div>
      <div className="card pad stack">
        <h2>{t("settings.system.backups")}</h2>
        <p className="muted small">{t("settings.system.backupHelp", { dir: x.backupDir })}</p>
        <button className="small self-start" onClick={() => act(() => api("/system/backup", { body: {} }), t("common.saved"))}>
          {t("settings.system.backupNow")}
        </button>
        <ul className="plain">
          {x.backups.map((b) => (
            <li key={b.name} className="row between">
              <span className="small">
                <Chip>{b.kind}</Chip> {new Date(b.at).toLocaleString()} · {Math.round(b.size / 1024)} KB
              </span>
              <button className="small ghost" onClick={() => setRestore(b.name)}>
                {t("settings.system.restore")}
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">{t("settings.system.rebuildHelp")}</p>
        <button className="small self-start" onClick={() => act(() => api("/system/cache/reset", { body: {} }), t("common.saved"))}>
          {t("settings.system.rebuildCache")}
        </button>
      </div>
      <div className="card pad stack">
        <p className="muted small">
          AnimeArr v{x.version} · {status.via}
        </p>
        <button
          className="self-start"
          onClick={async () => {
            await api("/wizard", { method: "PUT", body: { done: false, step: "welcome", path: null } });
            location.href = "/welcome";
          }}
        >
          {t("wiz.runAgain")}
        </button>
        <button
          className="self-start"
          onClick={async () => {
            await api("/auth/logout", { body: {} });
            location.href = "/";
          }}
        >
          {t("settings.system.logout")}
        </button>
      </div>
      {restore && (
        <Confirm
          danger
          title={t("settings.system.restore")}
          confirmLabel={t("settings.system.restore")}
          onClose={() => setRestore(null)}
          onConfirm={async () => {
            try {
              const r = await api<{ message: string }>("/system/restore", { body: { name: restore, password: pw } });
              toast(r.message);
              setRestore(null);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <p>{t("settings.system.restoreConfirm", { name: restore })}</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label={t("login.password")} autoComplete="current-password" />
        </Confirm>
      )}
    </div>
  );
}


function Security({ s, status, onChanged }: { s: S; status: Status; onChanged: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [user, setUser] = useState(s.auth.username);
  const [bypass, setBypass] = useState(status.bypassLocal ?? s.auth.bypassLocal);
  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return toast(t("security.mismatch"), true);
    try {
      await api("/auth/account", { method: "PUT", body: { currentPassword: cur, username: user, password: pw } });
      setCur("");
      setPw("");
      setPw2("");
      toast(t("security.changed"));
      onChanged();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }
  async function setMode(on: boolean) {
    try {
      await api("/auth/mode", { method: "PUT", body: { bypassLocal: on } });
      setBypass(on);
      toast(on ? t("security.bypassOn") : t("security.bypassOff"));
      onChanged();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }
  return (
    <div className="stack">
      <form className="card pad stack" onSubmit={change}>
        <h2>{t("security.password")}</h2>
        <div className="form">
          <label>
            {t("security.username")}
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
          </label>
          <label>
            {t("security.current")}
            <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          </label>
          <label>
            {t("security.new")}
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <label>
            {t("security.confirm")}
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
        </div>
        <button className="primary self-start">{t("common.save")}</button>
      </form>
      <div className="card pad stack">
        <label className="check">
          <input type="checkbox" checked={bypass} onChange={(e) => void setMode(e.target.checked)} /> {t("security.bypass")}
        </label>
        <p className="muted small">{t("security.bypassHelp")}</p>
      </div>
    </div>
  );
}
