import { useCallback, useEffect, useRef, useState } from "react";
import { PhoneButton } from "./phone";
import { LostAtSea } from "./merry";
import { Wizard } from "./pages/Wizard";
import { FixHost } from "./fixes";
import { UpdateCheck } from "./updateCheck";
import { BellButton } from "./notify";
import { api, store, type Status, appPath, withBase } from "./api";
import { setLanguage, t, type I18nKey } from "./i18n";
import { Activity } from "./pages/Activity";
import { Add } from "./pages/Add";
import { Audit } from "./pages/Audit";
import { Calendar } from "./pages/Calendar";
import { FillIn } from "./pages/FillIn";
import { MoviePage, Movies } from "./pages/Movies";
import { Queue } from "./pages/Queue";
import { Home } from "./pages/Home";
import { Login, Setup } from "./pages/Login";
import { Managed } from "./pages/Managed";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Show } from "./pages/Show";
import { Shows } from "./pages/Shows";
import { ToastProvider, useToast } from "./ui";
import { applyFont, applyTextScale } from "./appearance";
import { applySeason, seasonOf } from "./season";
import { CalendarDays, Download, Ellipsis, History, House, LibraryBig, ListFilter, ListOrdered, ScanSearch, Search as SearchIcon, Settings as SettingsIcon, ShieldCheck, Sparkles } from "lucide-react";

/**
 * Navigation. Desktop: a sidebar grouped Watch · Get · Automate · Maintain, with the season card at the bottom and a
 * global search (Ctrl K) in the top bar. Phone: 5 tabs (Home · Calendar · Library · Search · More); More opens a sheet
 * with the rest, so nothing is unreachable.
 */
type Icon = typeof House;
interface NavItem { path: string; label: I18nKey; icon: Icon }
const GROUPS: { label: I18nKey; items: NavItem[] }[] = [
  { label: "nav.group.watch", items: [{ path: "/", label: "nav.home", icon: House }, { path: "/calendar", label: "nav.calendar", icon: CalendarDays }, { path: "/shows", label: "nav.library", icon: LibraryBig }] },
  { label: "nav.group.get", items: [{ path: "/find", label: "nav.find", icon: SearchIcon }, { path: "/queue", label: "nav.queue", icon: Download }] },
  { label: "nav.group.automate", items: [{ path: "/managed", label: "nav.managed", icon: Sparkles }, { path: "/fillin", label: "nav.fillin", icon: ListOrdered }] },
  { label: "nav.group.maintain", items: [{ path: "/audit", label: "nav.audit", icon: ShieldCheck }, { path: "/activity", label: "nav.activity", icon: History }, { path: "/settings", label: "nav.settings", icon: SettingsIcon }] },
];
const PHONE_TABS: NavItem[] = [
  { path: "/", label: "nav.home", icon: House },
  { path: "/calendar", label: "nav.calendar", icon: CalendarDays },
  { path: "/shows", label: "nav.library", icon: LibraryBig },
  { path: "/find", label: "nav.find", icon: SearchIcon },
];
const MORE: NavItem[] = [
  { path: "/queue", label: "nav.queue", icon: Download },
  { path: "/managed", label: "nav.managed", icon: Sparkles },
  { path: "/fillin", label: "nav.fillin", icon: ListOrdered },
  { path: "/audit", label: "nav.audit", icon: ShieldCheck },
  { path: "/activity", label: "nav.activity", icon: History },
  { path: "/search", label: "nav.deepSearch", icon: ListFilter },
  { path: "/search?tab=identify", label: "nav.identify", icon: ScanSearch },
  { path: "/settings", label: "nav.settings", icon: SettingsIcon },
];

const KNOWN = ["/", "/welcome", "/managed", "/shows", "/add", "/find", "/show", "/movies", "/movie", "/calendar", "/fillin", "/queue", "/audit", "/search", "/activity", "/settings"];

export function navigate(to: string) {
  history.pushState(null, "", withBase(to));
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function Link({ to, children, className, current, style, title }: { to: string; children: React.ReactNode; className?: string; current?: boolean; style?: React.CSSProperties; title?: string }) {
  return (
    <a href={withBase(to)} className={className} style={style} title={title} aria-current={current ? "page" : undefined} onClick={(e) => (e.preventDefault(), navigate(to))}>
      {children}
    </a>
  );
}

export const query = () => new URLSearchParams(location.search);

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  // The browser chrome (address bar, PWA title bar) follows the theme; the root color-scheme comes from the CSS.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f6fa" : "#0b0d14");
  applySeason(theme === "light" ? "light" : "dark");
  // The Merry palette (Appearance): caramel wood, sea blue, sail white, instead of the season's accent.
  document.documentElement.dataset.palette = store.get<string>("palette", "season") === "merry" ? "merry" : "season";
  applyFont(store.get<string>("font", "inter"));
  // The device's own text size; without one, the saved default (applied when the status arrives).
  const ts = store.get<string | null>("textScale", null);
  if (ts) applyTextScale(ts);
  // Manga speech-bubble toasts are the default; "standard" is the opt-out (Settings → Appearance).
  document.documentElement.dataset.toasts = store.get<string>("toastStyle", "bubble") === "standard" ? "standard" : "bubble";
}

export function App() {
  const [path, setPath] = useState(appPath());
  const [, setSearch] = useState(location.search);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dismissed for a day, then it comes back while the default password is still in use.
  const [moreOpen, setMoreOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => Date.now() - store.get("dismissDefaultPw", 0) < 86_400_000);

  // A fresh install (nothing connected at all, setup not finished) opens the setup wizard.
  useEffect(() => {
    if (status?.loggedIn && status.freshInstall && appPath() === "/") navigate("/welcome");
  }, [status?.loggedIn, status?.freshInstall]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api<Status>("/status");
      setLanguage(s.uiLanguage ?? "en");
      if (store.get<string | null>("textScale", null) === null) {
        applyTextScale(s.textScale ?? "md");
        (window as unknown as { __textScaleDefault?: string }).__textScaleDefault = s.textScale ?? "md";
      }
      setStatus(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    applyTheme(store.get("theme", "dark"));
    void refreshStatus();
    const onPop = () => {
      setPath(appPath());
      setSearch(location.search);
      setMoreOpen(false);
      document.getElementById("main")?.focus();
    };
    const onAuth = () => void refreshStatus();
    window.addEventListener("popstate", onPop);
    window.addEventListener("animearr:auth", onAuth);
    window.addEventListener("animearr:changed", onAuth);
    // Keeps the Queue badge and banners current.
    const poll = setInterval(() => document.visibilityState === "visible" && void refreshStatus(), 60_000);
    return () => {
      clearInterval(poll);
      window.removeEventListener("animearr:changed", onAuth);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("animearr:auth", onAuth);
    };
  }, [refreshStatus]);

  if (error && !status)
    return (
      <div className="center-msg">
        <p>{t("app.unreachable", { error })}</p>
        <button onClick={() => void refreshStatus()}>{t("app.retry")}</button>
      </div>
    );
  if (!status) return <div className="center-msg">{t("app.loading")}</div>;
  if (status.setupRequired) return <Setup onDone={refreshStatus} />;
  if (!status.loggedIn) return <Login onDone={refreshStatus} />;


  const section = "/" + (path.split("/")[1] ?? "");
  const active = (p: string) =>
    p === "/"
      ? path === "/"
      : section === p.split("?")[0] ||
        (p === "/shows" && ["/show", "/movies", "/movie"].includes(section)) ||
        (p === "/find" && (section === "/add" || section === "/search")) ||
        (p === "/managed" && section === "/fillin");
  const moreActive = !PHONE_TABS.some((x) => active(x.path));
  const q = status.queue ?? { active: 0, attention: 0 };
  const badge = q.attention ? <span className="nav-badge warn" aria-label={t("nav.queueBadge", { n: q.attention })}>{q.attention}</span> : q.active ? <span className="nav-badge">{q.active}</span> : null;

  const season = seasonOf();
  const navLink = (n: NavItem) => (
    <Link key={n.path} to={n.path} className={`nav-link${active(n.path) ? " active" : ""}`} current={active(n.path)}>
      <n.icon aria-hidden="true" className="lucide" />
      <span className="nav-label">{t(n.label)}</span>
      {n.path === "/queue" && badge}
    </Link>
  );

  return (
    <ToastProvider>
      <div className="app">
        <a className="skip" href="#main">
          {t("app.skip")}
        </a>
        <aside className="sidebar" aria-label={t("nav.main")}>
          <Brand listen />
          <nav className="side-nav" aria-label={t("nav.main")}>
            {GROUPS.map((g) => (
              <div key={g.label} className="nav-group" role="group" aria-labelledby={`grp-${g.label}`}>
                <span className="eyebrow nav-grp" id={`grp-${g.label}`}>
                  {t(g.label)}
                </span>
                {g.items.map(navLink)}
              </div>
            ))}
          </nav>
          <Link to="/calendar" className="season-card">
            <span className="kanji" aria-hidden="true">
              {season.kanji}
            </span>
            <span className="season-name">
              {t(`season.${season.key}` as I18nKey)} {season.year}
            </span>
            <span className="muted small">{t("season.cardSub", { week: season.week, weeks: season.weeks, n: status.airingShows ?? 0 })}</span>
            <span className="season-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((season.week / season.weeks) * 100)}%` }} />
            </span>
          </Link>
        </aside>
        <div className="shell">
          <header className="topbar">
            <span className="phone-only">
              <Brand />
            </span>
            <GlobalSearch />
            <span className="topbar-end">
              {status.dryRun && (
                <Link to="/settings?tab=safety" className="mode-chip dry">
                  {t("chip.dryRun")}
                </Link>
              )}
              <PhoneButton />
              <BellButton />
            </span>
            <FixHost />
            <UpdateCheck />
          </header>
          <main id="main" tabIndex={-1}>
            {status.defaultPassword && !dismissed && (
              <div className="banner warn row between" role="alert">
                <span>
                  {t("security.defaultBanner")} · <Link to="/settings?tab=security">{t("security.defaultBannerLink")}</Link>
                </span>
                <button className="small ghost" onClick={() => (setDismissed(true), store.set("dismissDefaultPw", Date.now()))}>
                  {t("security.dismiss")}
                </button>
              </div>
            )}
            {status.warnings?.map((w) => (
              <p key={w} className="banner warn" role="alert">
                {w}
              </p>
            ))}
            <DryRunBanner status={status} />
            {status.grabsPaused && (
              <p className="banner warn" role="status">
                {t("dl.banner", { why: status.grabsPaused.why })}
                {status.grabsPaused.diskRule && status.grabsPaused.disk ? ` ${t("dl.bannerDisk", { label: status.grabsPaused.disk.label, free: status.grabsPaused.disk.freeGb, ours: status.grabsPaused.disk.animearrGb, other: status.grabsPaused.disk.otherGb })}${status.grabsPaused.disk.shareFreeGb !== null ? ` ${t("dl.bannerArray", { free: status.grabsPaused.disk.shareFreeGb })}` : ""}` : ""}{" "}
                <Link to="/settings?tab=downloads">{t("dl.bannerLink")}</Link>
              </p>
            )}
            {path === "/" && <Home status={status} onChanged={refreshStatus} />}
            {section === "/welcome" && <Wizard status={status} onChanged={refreshStatus} />}
            {section === "/managed" && <Managed status={status} />}
            {section === "/shows" && <Shows status={status} />}
            {(section === "/add" || section === "/find") && <Add />}
            {section === "/show" && <Show key={path} tvdbId={Number(path.split("/")[2])} />}
            {section === "/movies" && <Movies />}
            {section === "/movie" && <MoviePage key={path} id={Number(path.split("/")[2])} />}
            {section === "/calendar" && <Calendar />}
            {section === "/fillin" && <FillIn />}
            {section === "/queue" && <Queue />}
            {section === "/audit" && <Audit />}
            {section === "/search" && <Search />}
            {section === "/activity" && <Activity />}
            {section === "/settings" && <Settings status={status} onSaved={refreshStatus} />}
            {!KNOWN.includes(section) && <LostAtSea />}
          </main>
          <footer className="foot">
            {t("app.footer", { version: status.version })} ·{" "}
            <a href="https://ko-fi.com/moritranslates" target="_blank" rel="noreferrer">
              {t("app.support")}
            </a>
          </footer>
        </div>
        <nav className="tabbar" aria-label={t("nav.main")}>
          {PHONE_TABS.map((n) => (
            <Link key={n.path} to={n.path} className={active(n.path) ? "active" : ""} current={active(n.path)}>
              <span className="tab-pill" aria-hidden="true">
                <n.icon className="lucide" />
              </span>
              {t(n.label)}
            </Link>
          ))}
          <button type="button" className={`tab-more${moreActive || moreOpen ? " active" : ""}`} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>
            <span className="tab-pill" aria-hidden="true">
              <Ellipsis className="lucide" />
            </span>
            {t("nav.more")}
            {badge}
          </button>
        </nav>
        {moreOpen && <MoreSheet active={active} badge={badge} version={status.version} onClose={() => setMoreOpen(false)} />}
      </div>
    </ToastProvider>
  );
}

/** The logo mark. Tap it 7 times (or type the Konami code) for Comic mode. */
function Brand({ listen = false }: { listen?: boolean }) {
  const toast = useToast();
  const taps = useRef<number[]>([]);
  useEffect(() => {
    if (!listen) return;
    const seq = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    let i = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      i = e.key === seq[i] ? i + 1 : e.key === seq[0] ? 1 : 0;
      if (i === seq.length) (i = 0), toggleComic(toast);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast, listen]);
  return (
    <Link to="/" className="brand">
      <span
        className="mark"
        aria-hidden="true"
        onClick={(e) => {
          const now = Date.now();
          taps.current = [...taps.current.filter((x) => now - x < 2500), now];
          if (taps.current.length >= 7) {
            e.preventDefault();
            e.stopPropagation();
            taps.current = [];
            toggleComic(toast);
          }
        }}
      >
        <b>A</b>
      </span>
      <span className="brand-name">{t("app.name")}</span>
    </Link>
  );
}

function toggleComic(toast: ReturnType<typeof useToast>) {
  const on = store.get<string>("font", "inter") !== "comic";
  store.set("font", on ? "comic" : "inter");
  applyFont(on ? "comic" : "inter");
  toast(on ? t("comic.on") : t("comic.off"), false, undefined, on ? { burst: "always" } : undefined);
}

/** Global search in the top bar: Ctrl K or "/" focuses it; it opens Search with what you typed. */
function GlobalSearch() {
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
      if (document.querySelector("[aria-modal='true']")) return;
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      className="global-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/find${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        setQ("");
        ref.current?.blur();
      }}
    >
      <SearchIcon aria-hidden="true" className="lucide" />
      <input ref={ref} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("find.global")} aria-label={t("find.title")} />
      <kbd aria-hidden="true" className={q.trim() ? "kbd-enter" : undefined}>{q.trim() ? t("find.pressEnter") : "Ctrl K"}</kbd>
    </form>
  );
}

/** A slim banner, only while something is in dry-run (nothing at all otherwise). */
function DryRunBanner({ status }: { status: Status }) {
  const shows = status.dryRunShows ?? [];
  if (!status.dryRun && !shows.length) return null;
  return (
    <p className="banner slim">
      {status.dryRun ? t("dry.global") : t("dry.shows", { n: shows.length })} · <Link to="/settings?tab=safety">{t("dry.manage")}</Link>
    </p>
  );
}

/** Phone "More": everything that isn't one of the four tabs. */
function MoreSheet({ active, badge, version, onClose }: { active: (p: string) => boolean; badge: React.ReactNode; version: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close.current();
      // Focus stays inside the sheet (like the other dialogs).
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet card more-sheet" role="dialog" aria-modal="true" aria-label={t("nav.more")} ref={ref} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <ul className="more-list">
          {MORE.map((n) => (
            <li key={n.path}>
              <Link to={n.path} className={active(n.path) && !n.path.includes("?") ? "active" : ""}>
                <n.icon aria-hidden="true" className="lucide more-icon" />
                <span className="grow">{t(n.label)}</span>
                {n.path === "/queue" && badge}
              </Link>
            </li>
          ))}
        </ul>
        <p className="muted small">
          {t("app.footer", { version })} ·{" "}
          <a href="https://ko-fi.com/moritranslates" target="_blank" rel="noreferrer">
            {t("app.support")}
          </a>
        </p>
      </div>
    </div>
  );
}
