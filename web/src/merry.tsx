/**
 * The "-arr" pirate wink: a small original caravel with a sheep figurehead (our own drawing, not anyone's ship),
 * used on the 404 page, sailing by on the big "season complete" toast, and as the optional Merry theme.
 */
import { store } from "./api";
import { Link } from "./App";
import { t } from "./i18n";

export function SheepShip({ size = 120, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`sheep-ship ${className}`} width={size} height={size * 0.8} viewBox="0 0 150 120" role="img" aria-label={t("merry.ship")}>
      {/* sea */}
      <path className="ss-sea" d="M0 100 Q 12 94 25 100 T 50 100 T 75 100 T 100 100 T 125 100 T 150 100 V120 H0 Z" />
      {/* hull */}
      <path className="ss-hull" d="M22 78 H128 L118 98 Q 75 106 32 98 Z" />
      <path className="ss-rail" d="M22 78 H128" />
      <path className="ss-plank" d="M28 87 H122" />
      {/* mast + sail (round, puffy) */}
      <rect className="ss-mast" x="73" y="22" width="4" height="57" rx="2" />
      <path className="ss-sail" d="M48 30 Q 75 22 102 30 Q 106 50 102 68 Q 75 62 48 68 Q 44 50 48 30 Z" />
      <circle className="ss-mark" cx="75" cy="48" r="7" />
      <path className="ss-flag" d="M77 16 L92 20 L77 24 Z" />
      {/* sheep head figurehead: wool puff, face, curled horns */}
      <circle className="ss-wool" cx="134" cy="74" r="9" />
      <circle className="ss-wool" cx="141" cy="70" r="6" />
      <ellipse className="ss-face" cx="142" cy="78" rx="5" ry="6" />
      <path className="ss-horn" d="M136 70 q -6 -2 -4 5 q 2 4 5 1" />
      <circle className="ss-eye" cx="143.5" cy="76.5" r="1.1" />
    </svg>
  );
}

/** 404: "Lost at sea…" */
export function LostAtSea() {
  return (
    <section className="lost">
      <SheepShip size={180} className="bob" />
      <h1>{t("merry.lost")}</h1>
      <p className="muted">{t("merry.lostSub")}</p>
      <Link to="/" className="button primary">
        {t("merry.home")}
      </Link>
    </section>
  );
}

export const merryOn = () => store.get<string>("palette", "season") === "merry";
