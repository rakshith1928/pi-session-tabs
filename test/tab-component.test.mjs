import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createTabComponent,
  renderTabPill,
  tabLabelWidth,
} from "../extensions/tab-component.mjs";

// Mimic Pi's interactive Theme with REAL zero-width ANSI codes (as in
// production), so visibleWidth math in the component behaves exactly like it
// does against the real theme. Each token maps to a distinct 256-color code
// so assertions can tell fg tokens and the selectedBg fill apart.
const FG_CODE = { text: 252, muted: 241, warning: 214, accent: 39 };
const BG_CODE = { selectedBg: 238 };
const fakeTheme = {
  fg: (c, t) => `\x1b[38;5;${FG_CODE[c] ?? 245}m${t}\x1b[39m`,
  bg: (c, t) => `\x1b[48;5;${BG_CODE[c] ?? 236}m${t}\x1b[49m`,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
};
const fgOf = (c) => `\x1b[38;5;${FG_CODE[c] ?? 245}m`;
const BG_SELECTED = `\x1b[48;5;${BG_CODE.selectedBg}m`;
const BOLD = "\x1b[1m";

test("active tab renders a filled pill: caps, selectedBg fill, accent bold name", () => {
  const comp = createTabComponent({
    theme: fakeTheme,
    entry: { key: "tab-0", displayName: "alpha", glyph: "●", glyphColor: "text", isActive: true },
  });
  const flat = comp.render(40).join("");
  assert.ok(flat.includes("◖"), "has left cap");
  assert.ok(flat.includes("◗"), "has right cap");
  assert.ok(flat.includes(BG_SELECTED), "active tab has selectedBg background");
  assert.ok(flat.includes(fgOf("text") + "●"), "shows glyph in state color");
  assert.ok(flat.includes(BOLD + "alpha"), "name is accent + bold");
});

test("active tab uses selectedBg fill, inactive tab is unfilled and capless", () => {
  const active = createTabComponent({ theme: fakeTheme, entry: { displayName: "a", glyph: "●", glyphColor: "text", isActive: true } });
  const inactive = createTabComponent({ theme: fakeTheme, entry: { displayName: "b", glyph: "○", glyphColor: "muted", isActive: false } });
  const a = active.render(20).join("");
  const b = inactive.render(20).join("");
  assert.ok(a.includes(BG_SELECTED), "active has selectedBg fill");
  assert.ok(a.includes("◖") && a.includes("◗"), "active has caps");
  assert.ok(!b.includes("\x1b[48;5;"), "inactive has no fill");
  assert.ok(!b.includes("◖") && !b.includes("◗"), "inactive has no caps");
});

test("glyph color follows state", () => {
  const running = createTabComponent({ theme: fakeTheme, entry: { displayName: "a", glyph: "●", glyphColor: "text", isActive: false } });
  const attention = createTabComponent({ theme: fakeTheme, entry: { displayName: "b", glyph: "⚠", glyphColor: "warning", isActive: false } });
  assert.ok(running.render(20).join("").includes(fgOf("text") + "●"));
  assert.ok(attention.render(20).join("").includes(fgOf("warning") + "⚠"));
});

test("inactive tab name is muted", () => {
  const comp = createTabComponent({ theme: fakeTheme, entry: { displayName: "beta", glyph: "○", glyphColor: "muted", isActive: false } });
  assert.ok(comp.render(30).join("").includes(fgOf("muted") + "beta"));
});

test("renderTabPill pads to exactly the requested width", () => {
  const entry = { displayName: "alpha", glyph: "●", glyphColor: "text", isActive: true };
  const line = renderTabPill(fakeTheme, entry, 40)[0];
  assert.equal(visibleWidth(line), 40, "padded to width");
});

test("shrink truncates the name but caps and glyph survive", () => {
  const entry = { displayName: "alpha backend services", glyph: "●", glyphColor: "text", isActive: true };
  const full = tabLabelWidth(entry);
  assert.ok(full > 16, "full label is wider than the allocation");
  const line = renderTabPill(fakeTheme, entry, 16)[0];
  assert.equal(visibleWidth(line), 16, "fits the allocated width");
  assert.ok(line.includes("◖") && line.includes("◗"), "caps survive the shrink");
  assert.ok(line.includes(fgOf("text") + "●"), "glyph survives the shrink");
  assert.ok(!line.includes("alpha backend services"), "long name was truncated");
});

test("extreme shrink degrades to glyph + short name without throwing", () => {
  const entry = { displayName: "alpha backend services", glyph: "●", glyphColor: "text", isActive: true };
  const line = renderTabPill(fakeTheme, entry, 3)[0];
  assert.ok(visibleWidth(line) <= 3, "fits even 3 cells");
  assert.ok(line.includes(fgOf("text") + "●"), "status glyph is the last thing to survive");
});

test("CJK names size and truncate on display width (Unicode-aware)", () => {
  const name = "日本語のセッション"; // 9 fullwidth chars = 18 cells
  const entry = { displayName: name, glyph: "●", glyphColor: "text", isActive: true };
  assert.equal(tabLabelWidth(entry), 1 + 18 + 5, "basis counts fullwidth cells");
  // Full width: name intact.
  const full = renderTabPill(fakeTheme, entry, tabLabelWidth(entry))[0];
  assert.ok(full.includes(name), "untruncated at basis width");
  // Tight: truncated on a grapheme boundary, still fits.
  const tight = renderTabPill(fakeTheme, entry, 10)[0];
  assert.equal(visibleWidth(tight), 10);
  assert.ok(!tight.includes(name), "long CJK name was truncated");
});

test("tabLabelWidth is name-sized and active-only adds caps", () => {
  const base = { displayName: "abc", glyph: "○", glyphColor: "muted", isActive: false };
  assert.equal(tabLabelWidth(base), 1 + 3 + 1, "inactive = glyph + space + name");
  assert.equal(tabLabelWidth({ ...base, isActive: true }), 1 + 3 + 5, "active adds caps + spaces");
});
