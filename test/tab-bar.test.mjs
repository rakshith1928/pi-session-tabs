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

test("createTabBar installs container first in documentContainer and updates text", () => {
  const FakeContainer = class {
    constructor() {
      this.children = [];
    }
    addChild(c) {
      this.children.push(c);
    }
  };
  const FakeText = class {
    constructor() {
      this.value = "";
    }
    setText(v) {
      this.value = v;
    }
  };
  const theme = {
    fg: (color, s) => `<${color}>${s}</${color}>`,
  };
  const documentContainer = new FakeContainer();
  let renders = 0;
  const bar = createTabBar({
    Container: FakeContainer,
    Text: FakeText,
    theme,
    documentContainer,
    requestRender: () => renders++,
  });
  assert.equal(documentContainer.children[0], bar.container, "tab bar inserted at top");
  bar.update(
    [
      { name: "a", state: "idle" },
      { name: "b", state: "running" },
      { name: "c", state: "needs_attention" },
    ],
    0,
  );
  assert.ok(bar.text.value.includes("<accent>[<muted>○</muted> a]</accent>"));
  assert.ok(bar.text.value.includes("<muted> <text>●</text> b </muted>"));
  assert.ok(bar.text.value.includes("<muted> <warning>⚠</warning> c </muted>"));
  assert.ok(bar.text.value.includes("<text>●</text>"));
  assert.equal(renders, 1);
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