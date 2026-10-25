import { useState } from "react";
import { api, ApiError } from "../api";
import { t } from "../i18n";
import { usePageTitle } from "../ui";

export function Login({ onDone }: { onDone: () => void }) {
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

/** First run: create the account (like Sonarr's "Authentication Required" screen, in plain words). */
export function Setup({ onDone }: { onDone: () => void }) {
  usePageTitle(t("setup.title"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"enabled" | "local">("enabled");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(t("setup.mismatch"));
    setBusy(true);
    setError(null);
    try {
      await api("/auth/setup", { body: { username, password, bypassLocal: mode === "local", setupToken: code || undefined } });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setNeedCode(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login card" onSubmit={submit}>
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>{t("setup.title")}</h1>
      <p className="muted small">{t("setup.intro")}</p>
      <label>
        {t("login.username")}
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label>
        {t("setup.password")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      <label>
        {t("setup.confirm")}
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </label>
      <label>
        {t("setup.mode")}
        <select value={mode} onChange={(e) => setMode(e.target.value as "enabled" | "local")}>
          <option value="enabled">{t("setup.always")}</option>
          <option value="local">{t("setup.local")}</option>
        </select>
      </label>
      {mode === "local" && <p className="muted small left">{t("setup.localHelp")}</p>}
      {needCode && (
        <label>
          {t("setup.code")}
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {t("setup.submit")}
      </button>
    </form>
  );
}
