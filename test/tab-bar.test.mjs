import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTabs, createTabBar } from "../extensions/tab-bar.mjs";

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
  let textValue = "";
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
    ],
    0,
  );
  assert.ok(bar.text.value.includes("<accent>[<muted>○</muted> a]</accent>"));
  assert.ok(bar.text.value.includes("<muted> <text>●</text> b </muted>"));
  assert.ok(bar.text.value.includes("<text>●</text>"));
  assert.equal(renders, 1);
});