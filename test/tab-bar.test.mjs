import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTabs, createTabBar, layoutTabs } from "../extensions/tab-bar.mjs";

test("formatTabs renders active bracket, glyphs, separators", () => {
  const tabs = [
    { name: "a", state: "idle" },
    { name: "b", state: "running" },
    { name: "c", state: "needs_attention" },
  ];
  assert.equal(formatTabs(tabs, 1, 40), " ○ a │[● b]│ ⚠ c ");
});

test("formatTabs truncates to width with ellipsis", () => {
  const tabs = [{ name: "very-long-name", state: "idle" }];
  const out = formatTabs(tabs, 0, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("…"));
});

test("strip lays out one component per tab plus a new-tab", () => {
  const FakeHStack = class { constructor() { this.children = []; } addChild(c, o) { this.children.push({ c, o }); } clear() { this.children = []; } render() { return [""]; } invalidate() {} };
  const bar = createTabBar({ Container: class { constructor() { this.children = []; } addChild(c) { this.children.unshift(c); } }, HStack: FakeHStack, theme: { fg: (c, t) => t, bg: (c, t) => t }, documentContainer: { children: [] }, requestRender() {}, onActivateTab() {}, onNewTab() {}, onCloseTab() {} });
  bar.update([{ name: "a", state: "idle" }, { name: "b", state: "running" }], 0);
  assert.equal(bar.strip.children.length, 3);
});

test("strip renders every tab on a single line (TruncatedText, not Text)", () => {
  const FakeHStack = class { constructor() { this.children = []; } addChild(c, o) { this.children.push({ c, o }); } clear() { this.children = []; } render() { return [""]; } invalidate() {} };
  const bar = createTabBar({ Container: class { constructor() { this.children = []; } addChild(c) { this.children.unshift(c); } }, HStack: FakeHStack, theme: { fg: (c, t) => t, bg: (c, t) => t }, documentContainer: { children: [] }, requestRender() {}, onActivateTab() {}, onNewTab() {}, onCloseTab() {} });
  bar.update([{ name: "a-very-long-session-name-that-exceeds-the-tab", state: "idle" }, { name: "b", state: "running" }], 0);
  assert.ok(bar.strip.children.every(({ c }) => c.render(20).length === 1), "every tab is a single line");
});

test("layout assigns content + flags and marks the active tab", () => {
  const tabs = [
    { name: "alpha", state: "running" },
    { name: "beta-with-a-very-long-name", state: "needs_attention" },
    { name: "gamma", state: "idle" },
  ];
  const out = layoutTabs(tabs, 1);
  assert.equal(out.length, 4, "3 tabs + new-tab");
  assert.equal(out[1].isActive, true);
  assert.equal(out[3].isNew, true);
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