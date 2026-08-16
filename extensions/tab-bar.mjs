import { createTabComponent, tabLabelWidth } from "./tab-component.mjs";

const GLYPH = { idle: "○", running: "●", needs_attention: "⚠" };
const GLYPH_COLOR = { idle: "muted", running: "text", needs_attention: "warning" };

// layoutTabs intentionally does NOT truncate names. Width allocation is owned by
// createTabBar, which sets an explicit per-tab basis = tabLabelWidth(entry)
// (full untruncated pill label width) with grow:0 / shrink:1 / minSize:3; the
// pill component truncates each label to its allocated width at render. The HStack
// gap of 1 cell separates tabs. Truncating names here would over-truncate a single
// short tab that has ample room.
export function layoutTabs(tabs, activeIndex) {
  const entries = tabs.map((tab, i) => ({
    key: `tab-${i}`,
    name: tab.name,
    displayName: tab.name,
    glyph: GLYPH[tab.state] ?? GLYPH.idle,
    glyphColor: GLYPH_COLOR[tab.state] ?? GLYPH_COLOR.idle,
    state: tab.state,
    isActive: i === activeIndex,
  }));
  return entries;
}

/** Build the top tab-bar row from pill TabComponents and insert it above the
 * existing header. Each tab is an OpenCode v2-style pill sized to its full
 * label via an explicit numeric `basis` (tabLabelWidth), with grow:0 so extra
 * terminal width stays after the strip and shrink:1/minSize:3 so long names
 * truncate before short ones when space is tight. The pill truncates only the
 * name (caps + status glyph always survive). The strip is glyph+name only
 * (no + / x controls). */
export function createTabBar({ Container, HStack, theme, documentContainer, requestRender }) {
  const root = new Container();
  const strip = new HStack([], { gap: 1, align: "start" });
  root.addChild(strip);
  return {
    container: root,
    strip,
    // Mount/unmount the strip above the header. The manager only mounts it
    // while two or more tabs exist, so a single-tab session looks exactly
    // like normal Pi (no strip).
    mount() {
      if (documentContainer.children.indexOf(root) === -1) documentContainer.children.unshift(root);
      requestRender?.();
    },
    unmount() {
      const i = documentContainer.children.indexOf(root);
      if (i !== -1) documentContainer.children.splice(i, 1);
      requestRender?.();
    },
    update(tabs, activeIndex) {
      strip.clear();
      for (const entry of layoutTabs(tabs, activeIndex)) {
        const comp = createTabComponent({ theme, entry });
        const basis = tabLabelWidth(entry);
        strip.addChild(comp, { basis, grow: 0, shrink: 1, minSize: 3 });
      }
      requestRender?.();
    },
  };
}