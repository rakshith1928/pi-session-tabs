import { createTabComponent } from "./tab-component.mjs";

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
  }));
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

/** Build the top tab-bar row from native Box/HStack TabComponents and insert it
 * above the existing header. Widths are owned by HStack (basis:"auto" + shrink +
 * minSize); TruncatedText truncates each label to its allocated width at render. */
export function createTabBar({ Container, HStack, theme, documentContainer, requestRender }) {
  const root = new Container();
  const strip = new HStack([], { gap: 0, align: "start" });
  root.addChild(strip);
  documentContainer.children.unshift(root);
  return {
    container: root,
    strip,
    update(tabs, activeIndex) {
      strip.clear();
      for (const entry of layoutTabs(tabs, activeIndex)) {
        const comp = createTabComponent({ theme, entry });
        strip.addChild(comp, { basis: "auto", shrink: 1, minSize: 3 });
      }
      requestRender?.();
    },
  };
}