Debug tab-bar rendering

Diagnose issues with the interactive tab bar: wrong width, overflow, missing glyph, or wrong active highlight.

Arguments: $ARGUMENTS — the symptom, e.g. "last tab shows the wrong highlight" or "tabs overflow the terminal width".

Where rendering lives

- extensions/tab-bar.mjs
  - layoutTabs(tabs, activeIndex) — pure model. Produces one entry per tab: { key, displayName, glyph, glyphColor, isActive }. It does no width math.
  - createTabBar({ Container, HStack, theme, documentContainer, requestRender }) — builds an HStack of createTabComponent results. Per-child width is an explicit basis = visibleWidth(glyph + " " + name) + 2, with grow: 0, shrink: 1, minSize: 3. grow:0 leaves leftover terminal width after the strip; shrink:1 + minSize:3 truncate the longest tab first when tight. Width allocation is owned by the HStack, not by layoutTabs.
- extensions/tab-component.mjs — createTabComponent({ theme, entry }) builds one tab Box: selectedBg background for the active tab, a TruncatedText label (glyph + name). There is no × / + control (informational only).
- extensions/tab-manager.mjs — attach() installs the bar; tab creation/closing is via the /tabnew and /tabclose slash commands, and Alt+Left/Right cycles (manager.cycle).

Checklist

1. Glyph / color wrong? Check glyph / glyphColor produced by layoutTabs (idle -> muted, running -> text, needs_attention -> warning).
2. Wrong highlight? isActive from layoutTabs drives theme.bg("selectedBg"); confirm activate()/cycle() updates activeIndex and the bar re-renders.
3. Overflow / truncation? HStack shrink + minSize handle it; labels use TruncatedText so a shrunk tab stays one line. Do not add width math in layoutTabs.
4. Active highlight wrong? isActive from layoutTabs drives theme.bg("selectedBg").
5. Keys not working? Alt+Left/Right are intercepted in tab-manager.mjs (makeAltArrowListener); /tabnew /tabclose /tabrename are registered slash commands in commands.mjs. There is no focus mode.

Further reading

All rendering logic lives in the extensions/ files listed above. For install and usage, see README.md and docs/index.md (both shipped with the package).

Before you start

Run the contributor loop before and after changes:

```sh
git clone <repo>
cd pi-session-tabs

npm test
pi -e .

# make your changes, then repeat:
npm test
pi -e .
```

npm test runs the node:test suite (no real Pi). pi -e . boots an interactive Pi session with the local extension so you can see the tab bar and verify your fix.
