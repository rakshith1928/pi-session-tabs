Debug tab-bar rendering

Diagnose issues with the interactive tab bar: wrong width, overflow, missing glyph, or wrong active highlight.

Arguments: $ARGUMENTS — the symptom, e.g. "last tab shows × when it shouldn't" or "tabs overflow the terminal width".

Where rendering lives

- extensions/tab-bar.mjs
  - layoutTabs(tabs, activeIndex) — pure model. Produces one entry per tab: { key, displayName, glyph, glyphColor, isActive, isNew }. It does no width math.
  - createTabBar({ Container, HStack, theme, documentContainer, requestRender, onActivateTab, onNewTab, onCloseTab }) — builds an HStack of createTabComponent results plus a + new-tab box. Per-child basis: "auto", shrink: 1, minSize: 3 (new-tab minSize: 1). Width allocation is owned by the HStack, not by layoutTabs.
- extensions/tab-component.mjs — createTabComponent({ theme, entry, onActivate, onClose }) builds one tab Box: selectedBg background for the active tab, a TruncatedText label (glyph + name + ×), × only when entry.canClose (false when only one tab remains), + for the new-tab entry. onActivate / onClose are currently unused (Pi 0.84.1 has no onClick; they are wired by the strip for the deferred mouse track).
- extensions/tab-manager.mjs — attach() wires onActivateTab to manager.activate(i), onNewTab to manager.createTab(), onCloseTab to manager.closeTab(i).

Checklist

1. Glyph / color wrong? Check glyph / glyphColor produced by layoutTabs (idle -> muted, running -> text, needs_attention -> warning).
2. Last tab shows ×? canClose = !isNew && tabs.length > 1 in createTabBar; if × still appears, createTabComponent must honor entry.canClose (it does: entry.canClose ?? !isNew).
3. Overflow / truncation? HStack shrink + minSize handle it; labels use TruncatedText so a shrunk tab stays one line. Do not add width math in layoutTabs.
4. Active highlight wrong? isActive from layoutTabs drives theme.bg("selectedBg").
5. Keys not working? Alt+Left/Right are intercepted in tab-manager.mjs (makeAltArrowListener); /tabnew /tabclose /tabrename are registered slash commands in commands.mjs. There is no focus mode.

Further reading

All rendering logic lives in the extensions/ files listed above. For install and usage, see README.md and docs/index.md (both shipped with the package).
