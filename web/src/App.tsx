import { useCallback, useEffect, useRef, useState } from "react";
import { FixHost } from "./fixes";
import { BellButton } from "./notify";
import { api, store, type Status } from "./api";
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
import { ToastProvider } from "./ui";

/**
 * Navigation. Desktop: one row, grouped (Watch · Get · Automate · Maintain · Settings). Phone: 5 tabs
 * (Home · Calendar · Library · Search · More); More opens a sheet with the rest, so nothing is unreachable.
 */
interface NavItem { path: string; label: I18nKey; icon: string }
const GROUPS: { label: I18nKey; items: NavItem[] }[] = [
  { label: "nav.group.watch", items: [{ path: "/", label: "nav.home", icon: "⌂" }, { path: "/calendar", label: "nav.calendar", icon: "▤" }, { path: "/shows", label: "nav.library", icon: "▦" }] },
  { label: "nav.group.get", items: [{ path: "/find", label: "nav.find", icon: "⌕" }, { path: "/queue", label: "nav.queue", icon: "↓" }] },
  { label: "nav.group.automate", items: [{ path: "/managed", label: "nav.managed", icon: "★" }] },
  { label: "nav.group.maintain", items: [{ path: "/audit", label: "nav.audit", icon: "✓" }, { path: "/activity", label: "nav.activity", icon: "≡" }] },
  { label: "nav.settings", items: [{ path: "/settings", label: "nav.settings", icon: "⚙" }] },
];
const PHONE_TABS: NavItem[] = [
  { path: "/", label: "nav.home", icon: "⌂" },
  { path: "/calendar", label: "nav.calendar", icon: "▤" },
  { path: "/shows", label: "nav.library", icon: "▦" },
  { path: "/find", label: "nav.find", icon: "⌕" },
];
const MORE: NavItem[] = [
  { path: "/queue", label: "nav.queue", icon: "↓" },
  { path: "/managed", label: "nav.managed", icon: "★" },
  { path: "/fillin", label: "nav.fillin", icon: "⇣" },
  { path: "/audit", label: "nav.audit", icon: "✓" },
  { path: "/activity", label: "nav.activity", icon: "≡" },
  { path: "/search", label: "nav.deepSearch", icon: "⌕" },
  { path: "/search?tab=identify", label: "nav.identify", icon: "?" },
  { path: "/settings", label: "nav.settings", icon: "⚙" },
];

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function Link({ to, children, className, current }: { to: string; children: React.ReactNode; className?: string; current?: boolean }) {
  return (
    <a href={to} className={className} aria-current={current ? "page" : undefined} onClick={(e) => (e.preventDefault(), navigate(to))}>
      {children}
    </a>
  );
}

export const query = () => new URLSearchParams(location.search);

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  // Manga speech-bubble toasts are the default; "standard" is the opt-out (Settings → Appearance).
  document.documentElement.dataset.toasts = store.get<string>("toastStyle", "bubble") === "standard" ? "standard" : "bubble";
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [, setSearch] = useState(location.search);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dismissed for a day, then it comes back while the default password is still in use.
  const [moreOpen, setMoreOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => Date.now() - store.get("dismissDefaultPw", 0) < 86_400_000);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api<Status>("/status");
      setLanguage(s.uiLanguage ?? "en");
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
      setPath(location.pathname);
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

  return (
    <ToastProvider>
      <div className="app">
        <a className="skip" href="#main">
          {t("app.skip")}
        </a>
        <header className="topbar">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            <span>{t("app.name")}</span>
          </Link>
          <nav className="topnav" aria-label="Main">
            {GROUPS.map((g) => (
              <span key={g.label} className="nav-group" role="group" aria-label={t(g.label)}>
                {g.items.map((n) => (
                  <Link key={n.path} to={n.path} className={active(n.path) ? "active" : ""} current={active(n.path)}>
                    {t(n.label)}
                    {n.path === "/queue" && badge}
                  </Link>
                ))}
              </span>
            ))}
          </nav>
          <span className="topbar-end">
            {status.dryRun && (
              <Link to="/settings?tab=safety" className="mode-chip dry">
                {t("chip.dryRun")}
              </Link>
            )}
            <BellButton />
          </span>
          <FixHost />
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
        </main>
        <footer className="foot">
          {t("app.footer", { version: status.version })} ·{" "}
          <a href="https://ko-fi.com/moritranslates" target="_blank" rel="noreferrer">
            {t("app.support")}
          </a>
        </footer>
        <nav className="tabbar" aria-label="Main">
          {PHONE_TABS.map((n) => (
            <Link key={n.path} to={n.path} className={active(n.path) ? "active" : ""} current={active(n.path)}>
              <span aria-hidden="true">{n.icon}</span>
              {t(n.label)}
            </Link>
          ))}
          <button type="button" className={`tab-more${moreActive || moreOpen ? " active" : ""}`} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>
            <span aria-hidden="true">⋯</span>
            {t("nav.more")}
            {badge}
          </button>
        </nav>
        {moreOpen && <MoreSheet active={active} badge={badge} version={status.version} onClose={() => setMoreOpen(false)} />}
      </div>
    </ToastProvider>
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
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
                <span aria-hidden="true" className="more-icon">
                  {n.icon}
                </span>
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
