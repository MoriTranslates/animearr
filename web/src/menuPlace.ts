/**
 * Where a ⋯ menu opens. The menu is drawn on <body> at fixed window coordinates (a parent with overflow: hidden, like
 * the Show page's hero, would otherwise clip it), next to its button: below it, or above when there's more room there
 * (or when asked and there is room), always inside the window sideways, and no taller than the room on that side (the
 * menu scrolls past that). Pure numbers, so it's tested without a browser (test/menu-place.test.ts).
 */
export const MENU_GAP = 4;
export const MENU_MARGIN = 8;

export interface MenuPlacement {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

export function placeMenu(o: {
  trigger: { top: number; bottom: number; left: number; right: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  align: "left" | "right";
  up?: boolean;
}): MenuPlacement {
  const { trigger: r, menu, viewport: vp } = o;
  const below = Math.max(0, vp.height - r.bottom - MENU_GAP - MENU_MARGIN);
  const above = Math.max(0, r.top - MENU_GAP - MENU_MARGIN);
  const fitsAbove = above >= menu.height;
  const fitsBelow = below >= menu.height;
  const goUp = o.up ? fitsAbove || (!fitsBelow && above > below) : !fitsBelow && above > below;
  const wanted = o.align === "right" ? r.right - menu.width : r.left;
  const left = Math.max(MENU_MARGIN, Math.min(wanted, vp.width - MENU_MARGIN - menu.width));
  return goUp ? { bottom: vp.height - r.top + MENU_GAP, left, maxHeight: above } : { top: r.bottom + MENU_GAP, left, maxHeight: below };
}
