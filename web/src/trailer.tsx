import { useState } from "react";
import { t } from "./i18n";
import { trailerLinks, type Trailer } from "./trailerLinks";
import { Modal } from "./ui";

/**
 * "▶ Trailer": only when the show has one. Opens the trailer in a dialog, playing from YouTube/Dailymotion; closing
 * the dialog removes the player, which stops it. Nothing is downloaded.
 */
export function TrailerButton({ trailer, title, className = "small" }: { trailer: Trailer | null | undefined; title: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const links = trailerLinks(trailer);
  if (!links) return null;
  return (
    <>
      <button type="button" className={`trailer-btn ${className}`} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={t("trailer.watch", { title })}>
        {t("trailer.button")}
      </button>
      {open && (
        <Modal title={t("trailer.title", { title })} onClose={() => setOpen(false)} className="trailer-modal">
          <div className="trailer-frame">
            <iframe
              src={links.embed}
              title={t("trailer.title", { title })}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              // YouTube's player needs to know which site embeds it (the page itself sends no referrer).
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          <p className="row small trailer-foot">
            <span className="muted grow">{t("trailer.note", { site: links.site })}</span>
            <a href={links.watch} target="_blank" rel="noopener noreferrer" className="button small">
              {t("trailer.open", { site: links.site })}
            </a>
          </p>
        </Modal>
      )}
    </>
  );
}
