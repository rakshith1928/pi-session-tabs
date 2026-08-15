import { test } from "node:test";
import assert from "node:assert/strict";
import { createTabBar, layoutTabs } from "../extensions/tab-bar.mjs";
import { visibleWidth } from "@earendil-works/pi-tui";

test("strip lays out one component per tab", () => {
  const FakeHStack = class { constructor() { this.children = []; } addChild(c, o) { this.children.push({ c, o }); } clear() { this.children = []; } render() { return [""]; } invalidate() {} };
  const bar = createTabBar({ Container: class { constructor() { this.children = []; } addChild(c) { this.children.unshift(c); } }, HStack: FakeHStack, theme: { fg: (c, t) => t, bg: (c, t) => t }, documentContainer: { children: [] }, requestRender() {} });
  bar.update([{ name: "a", state: "idle" }, { name: "b", state: "running" }], 0);
  assert.equal(bar.strip.children.length, 2);
});

test("strip renders every tab on a single line (TruncatedText, not Text)", () => {
  const FakeHStack = class { constructor() { this.children = []; } addChild(c, o) { this.children.push({ c, o }); } clear() { this.children = []; } render() { return [""]; } invalidate() {} };
  const bar = createTabBar({ Container: class { constructor() { this.children = []; } addChild(c) { this.children.unshift(c); } }, HStack: FakeHStack, theme: { fg: (c, t) => t, bg: (c, t) => t }, documentContainer: { children: [] }, requestRender() {} });
  bar.update([{ name: "a-very-long-session-name-that-exceeds-the-tab", state: "idle" }, { name: "b", state: "running" }], 0);
  assert.ok(bar.strip.children.every(({ c }) => c.render(20).length === 1), "every tab is a single line");
});

test("strip sizes each tab to its name via explicit basis (no grow)", () => {
  const GLYPH = { idle: "○", running: "●", needs_attention: "⚠" };
  const FakeHStack = class { constructor() { this.children = []; } addChild(c, o) { this.children.push({ c, o }); } clear() { this.children = []; } render() { return [""]; } invalidate() {} };
  const bar = createTabBar({ Container: class { constructor() { this.children = []; } addChild(c) { this.children.unshift(c); } }, HStack: FakeHStack, theme: { fg: (c, t) => t, bg: (c, t) => t }, documentContainer: { children: [] }, requestRender() {} });
  bar.update([{ name: "a", state: "idle" }, { name: "Backend", state: "running" }], 0);
  const bases = bar.strip.children.map(({ o }) => o.basis);
  const expected = [
    visibleWidth(`${GLYPH.idle} a`) + 2,
    visibleWidth(`${GLYPH.running} Backend`) + 2,
  ];
  assert.deepEqual(bases, expected, "each tab basis = glyph+name width + 2 (box padding)");
  assert.ok(bar.strip.children.every(({ o }) => o.grow === 0), "no grow: extra terminal width stays after the strip");
});

test("layout assigns content + flags and marks the active tab", () => {
  const tabs = [
    { name: "alpha", state: "running" },
    { name: "beta-with-a-very-long-name", state: "needs_attention" },
    { name: "gamma", state: "idle" },
  ];
  const out = layoutTabs(tabs, 1);
  assert.equal(out.length, 3, "3 tabs");
  assert.equal(out[1].isActive, true);
  assert.ok(out[0].glyph === "●" && out[0].glyphColor === "text");
  assert.ok(out[1].glyph === "⚠" && out[1].glyphColor === "warning");
});

test("layout passes names through untouched (HStack/TruncatedText own truncation)", () => {
  const tabs = [
    { name: "alpha", state: "running" },
    { name: "beta-with-a-very-long-name", state: "needs_attention" },
    { name: "gamma", state: "idle" },
  ];
  const out = layoutTabs(tabs, 0);
  assert.equal(out[1].displayName, "beta-with-a-very-long-name");
});