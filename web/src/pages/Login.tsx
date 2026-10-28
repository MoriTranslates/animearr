import { useState } from "react";
import { api, DEFAULT_LOGIN } from "../api";
import { t } from "../i18n";
import { usePageTitle } from "../ui";

export function Login({ onDone, defaultLogin }: { onDone: () => void; defaultLogin?: string }) {
  usePageTitle(t("login.title"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/auth/login", { body: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login card" onSubmit={submit}>
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>{t("app.name")}</h1>
      {defaultLogin && <p className="muted small">{t("login.defaultHint")}</p>}
      <label>
        {t("login.username")}
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label>
        {t("login.password")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {t("login.submit")}
      </button>
    </form>
  );
}

/**
 * "Your login is captain / morebooty. Change it now?" — the first-run prompt (wizard account step). Changing it lifts
 * the home-network-only rule and the banner; "Later" leaves it (the banner keeps asking).
 */
export function ChangeDefaultLogin({ onDone, onLater }: { onDone: () => void; onLater?: () => void }) {
  const [username, setUsername] = useState<string>(DEFAULT_LOGIN.username);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(t("security.mismatch"));
    setBusy(true);
    setError(null);
    try {
      await api("/auth/account", { method: "PUT", body: { currentPassword: DEFAULT_LOGIN.password, username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card pad stack" onSubmit={submit}>
      <p>
        <strong>{t("wiz.account.default")}</strong>
      </p>
      <p className="muted small">{t("wiz.account.defaultHelp")}</p>
      <div className="form">
        <label>
          {t("security.username")}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          {t("security.new")}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        <label>
          {t("security.confirm")}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={busy}>
          {t("wiz.account.change")}
        </button>
        {onLater && (
          <button type="button" className="ghost" onClick={onLater}>
            {t("wiz.account.later")}
          </button>
        )}
      </div>
    </form>
  );
}
