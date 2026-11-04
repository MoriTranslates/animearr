/**
 * Where a ⋯ menu opens (web/src/menuPlace.ts). The menu is drawn on <body> at fixed coordinates, so a parent with
 * overflow: hidden (the Show page's hero) can't clip it; this places it next to its button, always inside the window,
 * and caps its height to the room there (it scrolls past that), so every item is reachable at desktop and phone sizes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { placeMenu, MENU_GAP, MENU_MARGIN } = await import("../web/src/menuPlace.js");

const inside = (p: ReturnType<typeof placeMenu>, menu: { width: number; height: number }, vw: number, vh: number) => {
  const h = Math.min(menu.height, p.maxHeight);
  const top = p.top ?? vh - (p.bottom ?? 0) - h;
  assert.ok(top >= MENU_MARGIN - 0.5, `top ${top}`);
  assert.ok(top + h <= vh - MENU_MARGIN + 0.5, `bottom edge ${top + h} of ${vh}`);
  assert.ok(p.left >= MENU_MARGIN - 0.5, `left ${p.left}`);
  assert.ok(p.left + menu.width <= vw - MENU_MARGIN + 0.5, `right edge ${p.left + menu.width} of ${vw}`);
};

test("the Show page's hero menu (desktop): opens under its button, fully inside the window", () => {
  const trigger = { top: 120, bottom: 160, left: 1200, right: 1240 };
  const menu = { width: 240, height: 520 };
  const p = placeMenu({ trigger, menu, viewport: { width: 1280, height: 900 }, align: "right" });
  assert.equal(p.top, trigger.bottom + MENU_GAP);
  assert.equal(p.left, trigger.right - menu.width, "right-aligned to the button");
  assert.ok(p.maxHeight >= menu.height, "room for every item");
  inside(p, menu, 1280, 900);
});

test("a menu taller than the room (phone): the bigger side, capped so it scrolls instead of running off-screen", () => {
  const menu = { width: 240, height: 640 };
  const vp = { width: 375, height: 667 };
  const p = placeMenu({ trigger: { top: 300, bottom: 344, left: 320, right: 364 }, menu, viewport: vp, align: "right" });
  assert.ok(p.maxHeight < menu.height, "capped");
  assert.equal(p.maxHeight, vp.height - 344 - MENU_GAP - MENU_MARGIN);
  inside(p, menu, vp.width, vp.height);
});

test("near the bottom of the window it opens upwards", () => {
  const menu = { width: 200, height: 300 };
  const p = placeMenu({
    trigger: { top: 820, bottom: 860, left: 40, right: 80 },
    menu,
    viewport: { width: 1280, height: 900 },
    align: "left",
  });
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 900 - 820 + MENU_GAP);
  inside(p, menu, 1280, 900);
});

test("asked to open upwards with no room above: it opens downwards", () => {
  const menu = { width: 200, height: 300 };
  const p = placeMenu({
    trigger: { top: 10, bottom: 40, left: 40, right: 80 },
    menu,
    viewport: { width: 800, height: 900 },
    align: "left",
    up: true,
  });
  assert.equal(p.top, 40 + MENU_GAP);
  inside(p, menu, 800, 900);
});

test("kept inside the window sideways (a right-aligned menu near the left edge, a left one near the right)", () => {
  const menu = { width: 260, height: 100 };
  const a = placeMenu({
    trigger: { top: 100, bottom: 130, left: 4, right: 40 },
    menu,
    viewport: { width: 375, height: 667 },
    align: "right",
  });
  assert.equal(a.left, MENU_MARGIN);
  const b = placeMenu({
    trigger: { top: 100, bottom: 130, left: 340, right: 370 },
    menu,
    viewport: { width: 375, height: 667 },
    align: "left",
  });
  assert.equal(b.left, 375 - MENU_MARGIN - menu.width);
});
