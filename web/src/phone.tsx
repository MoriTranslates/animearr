/**
 * "Open on your phone": a QR code of AnimeArr's address (generated in the browser, no outside service), the address
 * as text with Copy, and how to add it to the home screen (AnimeArr is a PWA).
 */
import { useEffect, useMemo, useState } from "react";
import { Smartphone } from "lucide-react";
import qrcode from "qrcode-generator";
import { api } from "./api";
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
  return (
    <div className="phone-panel">
      <QrSvg text={url} />
      <div className="stack">
        <div className="row phone-url">
          <code className="mono">{url}</code>
          <button
            type="button"
            className="small"
            onClick={() => {
              // navigator.clipboard only exists on HTTPS/localhost; a plain-HTTP LAN address needs the old way.
              const fallback = () => {
                const ta = document.createElement("textarea");
                ta.value = url;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand("copy");
                ta.remove();
                toast(ok ? t("phone.copied") : t("phone.copyFailed"), !ok);
              };
              if (navigator.clipboard) void navigator.clipboard.writeText(url).then(() => toast(t("phone.copied")), fallback);
              else fallback();
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
