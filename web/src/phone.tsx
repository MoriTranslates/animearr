/**
 * "Open on your phone": a QR code of AnimeArr's address (generated in the browser, no outside service), the address
 * as text with Copy, and how to add it to the home screen (AnimeArr is a PWA).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, selectText } from "./errors";
import { EllipsisVertical, Share, Smartphone } from "lucide-react";
import qrcode from "qrcode-generator";
import { api, store } from "./api";
import { t } from "./i18n";
import { Modal, useToast } from "./ui";

interface PhoneInfo { externalUrl: string; lan: string[]; bypassLocal: boolean }

const isLoopback = (host: string) => /^(localhost|127\.|\[?::1\]?$)/i.test(host);

/** The address a phone should open: the External URL, else this page's origin, else (on localhost) the LAN address. */
export function phoneUrl(info: PhoneInfo | null, origin = window.location.origin): { url: string; sameWifi: boolean } {
  if (info?.externalUrl) return { url: info.externalUrl.replace(/\/+$/, ""), sameWifi: false };
  const host = new URL(origin).hostname;
  if (isLoopback(host) && info?.lan[0]) return { url: info.lan[0], sameWifi: true };
  return { url: origin, sameWifi: !/\./.test(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".local") };
}

function QrSvg({ text }: { text: string }) {
  const svg = useMemo(() => {
    try {
      const q = qrcode(0, "M");
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch {
      return null; // too long for a QR code: the address below still works
    }
  }, [text]);
  if (!svg) return null;
  // Generated locally from our own string: safe markup.
  return <div className="qr" role="img" aria-label={t("phone.qrLabel", { url: text })} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PhonePanel() {
  const toast = useToast();
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  useEffect(() => void api<PhoneInfo>("/phone").then(setInfo, () => setInfo({ externalUrl: "", lan: [], bypassLocal: false })), []);
  const { url, sameWifi } = phoneUrl(info);
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div className="phone-panel">
      <QrSvg text={url} />
      <div className="stack">
        <div className="row phone-url">
          <code className="mono" ref={codeRef}>{url}</code>
          <button
            type="button"
            className="small"
            onClick={async () => {
              // The Clipboard API is missing on a plain-http LAN address; copyText falls back to the old way. If both
              // fail, the address is selected so Ctrl+C (or a long press) copies it.
              if (await copyText(url)) return toast(t("phone.copied"));
              selectText(codeRef.current);
              toast(t("phone.copyFailed"), true);
            }}
          >
            {t("phone.copy")}
          </button>
        </div>
        {sameWifi && <p className="small warn-text">{t("phone.sameWifi")}</p>}
        <ol className="small phone-steps">
          <li>{t("phone.step.scan")}</li>
          <li>
            <b>iPhone:</b> {t("phone.step.ios")}
          </li>
          <li>
            <b>Android:</b> {t("phone.step.android")}
          </li>
        </ol>
        {info?.bypassLocal && <p className="muted small">{t("phone.noPassword")}</p>}
      </div>
    </div>
  );
}

/** The phone icon in the top bar (next to the bell). */
export function PhoneButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn phone-btn" onClick={() => setOpen(true)} title={t("phone.open")} aria-label={t("phone.open")}>
        <Smartphone className="lucide" aria-hidden="true" />
      </button>
      {open && (
        <Modal title={t("phone.open")} onClose={() => setOpen(false)}>
          <PhonePanel />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- "Add to home screen" on the phone itself

interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

/** Called early (main.tsx): Chrome fires beforeinstallprompt once, often before the card mounts. */
export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((f) => f());
  });
}

const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);

/** Phones only, until it's installed or dismissed: Install (when the browser offers it) or the two taps to do it. */
export function InstallCard() {
  const [, bump] = useState(0);
  const [hidden, setHidden] = useState(() => store.get("installCardDismissed", false) || installed() || !window.matchMedia?.("(max-width: 760px)").matches);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  if (hidden || installed()) return null;
  const dismiss = () => (store.set("installCardDismissed", true), setHidden(true));
  const ios = isIos();
  const android = !ios && isAndroid();
  return (
    <div className="card pad install-card">
      <Smartphone className="lucide install-icon" aria-hidden="true" />
      <div className="stack">
        <p className="strong">{t("phone.install.title")}</p>
        {deferred ? (
          <p className="small muted">{t("phone.install.body")}</p>
        ) : ios ? (
          <p className="small">
            <Share className="lucide inline-icon" aria-hidden="true" /> {t("phone.install.ios")}
          </p>
        ) : android ? (
          <p className="small">
            <EllipsisVertical className="lucide inline-icon" aria-hidden="true" /> {t("phone.install.android")}
          </p>
        ) : (
          <ul className="small phone-steps">
            <li><b>iPhone:</b> {t("phone.step.ios")}</li>
            <li><b>Android:</b> {t("phone.step.android")}</li>
          </ul>
        )}
        <div className="row">
          {deferred && (
            <button
              className="primary"
              onClick={async () => {
                const p = deferred;
                if (!p) return;
                await p.prompt();
                if ((await p.userChoice).outcome === "accepted") setHidden(true);
                deferred = null;
                bump((n) => n + 1);
              }}
            >
              {t("phone.install.button")}
            </button>
          )}
          <button className="small" onClick={dismiss}>
            {t("phone.install.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
