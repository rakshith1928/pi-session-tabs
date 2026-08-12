import { test } from "node:test";
import assert from "node:assert/strict";
import { createTabComponent } from "../extensions/tab-component.mjs";

const fakeTheme = {
  fg: (c, t) => `FG(${c}:${t})`,
  bg: (c, t) => `BG(${c}:${t})`,
};

test("active tab is filled with accent bg and shows glyph+name+close", () => {
  const box = createTabComponent({
    theme: fakeTheme,
    entry: { key: "tab-0", displayName: "alpha", glyph: "●", glyphColor: "text", isActive: true, isNew: false },
    onActivate: () => {}, onClose: () => {},
  });
  // Render wide enough that the (artificially long) literal fakeTheme wrappers
  // FG(...)/BG(...) don't get truncated away before the name — in production
  // theme.fg/bg return zero-width ANSI, so truncation only triggers on real tabs.
  const flat = box.render(40).join("");
  assert.ok(flat.includes("BG(accent:"), "active tab has accent background");
  // fakeTheme wraps the glyph (theme.fg), so the raw "● alpha" substring is not
  // present; assert the glyph and name independently.
  assert.ok(flat.includes("●"), "shows glyph");
  assert.ok(flat.includes("alpha"), "shows name");
  assert.ok(flat.includes("×"), "shows close control");
});

test("new-tab entry renders + with no close control", () => {
  const box = createTabComponent({
    theme: fakeTheme,
    entry: { key: "new-tab", displayName: "+", glyph: "", glyphColor: "muted", isActive: false, isNew: true },
    onActivate: () => {}, onClose: () => {},
  });
  const flat = box.render(20).join("");
  assert.ok(flat.includes("+"));
  assert.ok(!flat.includes("×"));
});

test("active tab uses accent bg, inactive tab has no fill", () => {
  const active = createTabComponent({ theme: fakeTheme, entry: { displayName: "a", glyph: "●", glyphColor: "text", isActive: true, isNew: false }, onActivate() {}, onClose() {} });
  const inactive = createTabComponent({ theme: fakeTheme, entry: { displayName: "b", glyph: "○", glyphColor: "muted", isActive: false, isNew: false }, onActivate() {}, onClose() {} });
  assert.ok(active.render(20).join("").includes("BG(accent:"));
  assert.ok(!inactive.render(20).join("").includes("BG("));
});

test("glyph color follows state", () => {
  const running = createTabComponent({ theme: fakeTheme, entry: { displayName: "a", glyph: "●", glyphColor: "text", isActive: false, isNew: false }, onActivate() {}, onClose() {} });
  const attention = createTabComponent({ theme: fakeTheme, entry: { displayName: "b", glyph: "⚠", glyphColor: "warning", isActive: false, isNew: false }, onActivate() {}, onClose() {} });
  assert.ok(running.render(20).join("").includes("FG(text:●)"));
  assert.ok(attention.render(20).join("").includes("FG(warning:⚠)"));
});
