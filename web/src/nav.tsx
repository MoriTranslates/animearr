/** Client-side navigation: links, navigate() and the query string (a leaf, so pages don't import App.tsx). */
import { withBase } from "./api";
import { confirmLeave } from "./unsaved";

export function navigate(to: string) {
  // Unsaved changes on the page: ask before leaving (they'd be lost).
  if (!confirmLeave()) return;
  history.pushState(null, "", withBase(to));
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function Link({
  to,
  children,
  className,
  current,
  style,
  title,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  current?: boolean;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <a
      href={withBase(to)}
      className={className}
      style={style}
      title={title}
      aria-current={current ? "page" : undefined}
      onClick={(e) => (e.preventDefault(), navigate(to))}
    >
      {children}
    </a>
  );
}

export const query = () => new URLSearchParams(location.search);
