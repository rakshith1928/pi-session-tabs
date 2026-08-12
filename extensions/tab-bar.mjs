const GLYPH = { idle: "○", running: "●", needs_attention: "⚠" };
const SEP = "│";

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