const GLYPH = { idle: "○", running: "●", needs_attention: "⚠" };
const GLYPH_COLOR = { idle: "muted", running: "text", needs_attention: "warning" };
const SEP = "│";

// layoutTabs intentionally does NOT truncate names. Width allocation is owned
// entirely by HStack (basis:"auto" + shrink + minSize) and TruncatedText
// (truncates each label to its allocated width at render). Truncating here would
// over-truncate a single short tab that has ample room. See "Width allocation"
// in the plan's Global Constraints.
export function layoutTabs(tabs, activeIndex) {
  const entries = tabs.map((tab, i) => ({
    key: `tab-${i}`,
    name: tab.name,
    displayName: tab.name,
    glyph: GLYPH[tab.state] ?? GLYPH.idle,
    glyphColor: GLYPH_COLOR[tab.state] ?? GLYPH_COLOR.idle,
    state: tab.state,
    isActive: i === activeIndex,
    isNew: false,
  }));
  entries.push({
    key: "new-tab", name: "", displayName: "+", glyph: "", glyphColor: "muted",
    state: "idle", isActive: false, isNew: true,
  });
  return entries;
}

/** Pure single-line rendering of the tab strip (no color). */
export function formatTabs(tabs, activeIndex, width) {
  const segments = tabs.map((tab, i) => {
    const glyph = GLYPH[tab.state] ?? GLYPH.idle;
    const inner = `${glyph} ${tab.name}`;
    return i === activeIndex ? `[${inner}]` : ` ${inner} `;
  });
  let out = segments.join(SEP);
  if (out.length > width) {
    out = out.slice(0, Math.max(0, width - 1)) + "…";
  }
  return out;
}

/** Build the top tab-bar row and insert it above the existing header. */
export function createTabBar({ Container, Text, theme, documentContainer, requestRender }) {
  const container = new Container();
  const text = new Text("");
  container.addChild(text);
  documentContainer.children.unshift(container);
  return {
    container,
    text,
    update(tabs, activeIndex) {
      const parts = tabs.map((tab, i) => {
        const glyph = GLYPH[tab.state] ?? GLYPH.idle;
        const glyphColor = tab.state === "needs_attention" ? "warning" : tab.state === "running" ? "text" : "muted";
        const coloredGlyph = theme.fg(glyphColor, glyph);
        const inner = `${coloredGlyph} ${tab.name}`;
        const seg = i === activeIndex ? `[${inner}]` : ` ${inner} `;
        return i === activeIndex ? theme.fg("accent", seg) : theme.fg("muted", seg);
      });
      text.setText(parts.join(SEP));
      requestRender?.();
    },
  };
}