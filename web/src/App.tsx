import { useCallback, useEffect, useState } from "react";
import { api, store, type Status } from "./api";
import { setLanguage, t, type I18nKey } from "./i18n";
import { Activity } from "./pages/Activity";
import { Audit } from "./pages/Audit";
import { Home } from "./pages/Home";
import { Login, Setup } from "./pages/Login";
import { Managed } from "./pages/Managed";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Show } from "./pages/Show";
import { Shows } from "./pages/Shows";
import { ToastProvider } from "./ui";

const NAV: { path: string; label: I18nKey; icon: string; phone: boolean }[] = [
  { path: "/", label: "nav.home", icon: "⌂", phone: true },
  { path: "/managed", label: "nav.managed", icon: "★", phone: true },
  { path: "/shows", label: "nav.shows", icon: "▦", phone: false },
  { path: "/audit", label: "nav.audit", icon: "✓", phone: true },
  { path: "/search", label: "nav.search", icon: "⌕", phone: true },
  { path: "/activity", label: "nav.activity", icon: "≡", phone: false },
  { path: "/settings", label: "nav.settings", icon: "⚙", phone: true },
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
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [, setSearch] = useState(location.search);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      document.getElementById("main")?.focus();
    };
    const onAuth = () => void refreshStatus();
    window.addEventListener("popstate", onPop);
    window.addEventListener("animearr:auth", onAuth);
    return () => {
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
  const active = (p: string) => (p === "/" ? path === "/" : section === p || (p === "/shows" && section === "/show"));

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
            {NAV.map((n) => (
              <Link key={n.path} to={n.path} className={active(n.path) ? "active" : ""} current={active(n.path)}>
                {t(n.label)}
              </Link>
            ))}
          </nav>
          <span className={`mode-chip ${status.dryRun ? "dry" : "live"}`} title={status.dryRun ? t("home.dryRunOn") : t("home.dryRunOff")}>
            {status.dryRun ? t("chip.dryRun") : t("chip.live")}
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          {status.warnings?.map((w) => (
            <p key={w} className="banner warn" role="alert">
              {w}
            </p>
          ))}
          {path === "/" && <Home status={status} onChanged={refreshStatus} />}
          {section === "/managed" && <Managed status={status} />}
          {section === "/shows" && <Shows status={status} />}
          {section === "/show" && <Show tvdbId={Number(path.split("/")[2])} />}
          {section === "/audit" && <Audit />}
          {section === "/search" && <Search />}
          {section === "/activity" && <Activity />}
          {section === "/settings" && <Settings status={status} onSaved={refreshStatus} />}
        </main>
        <footer className="foot">{t("app.footer", { version: status.version })}</footer>
        <nav className="tabbar" aria-label="Main">
          {NAV.filter((n) => n.phone).map((n) => (
            <Link key={n.path} to={n.path} className={active(n.path) ? "active" : ""} current={active(n.path)}>
              <span aria-hidden="true">{n.icon}</span>
              {t(n.label)}
            </Link>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
