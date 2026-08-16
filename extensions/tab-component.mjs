import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * OpenCode v2-style "pill" tab, rendered as a single terminal row.
 *
 * - Active tab:  `◖ ● Name ◗` — rounded caps, `selectedBg` fill (the same
 *   token Pi's own selectors use for selected rows), accent + bold name.
 * - Inactive:    `○ Name` — muted name, status glyph in the left slot, no
 *   fill (OpenCode v2 renders inactive tabs as faint text without decoration).
 * - The NAME is the only part that ever truncates: the caps and the status
 *   glyph always survive, so a shrunk tab still shows its state.
 *
 * Pi 0.84.1 `Component`s are render-only (no `onClick`), so the strip is
 * informational only: tabs are created/closed via `/tabnew` / `/tabclose`
 * and cycled with Alt+Left / Alt+Right (no + / x control by design).
 *
 * `theme` is Pi's interactive `Theme` (fg/bg/bold verified in 0.84.1).
 */

const CAP_LEFT = "◖";
const CAP_RIGHT = "◗";

/**
 * Pure: width (cells) of the full, untruncated pill label for an entry.
 * Single source of truth for the HStack `basis` in tab-bar.mjs.
 */
export function tabLabelWidth(entry) {
  const gW = visibleWidth(entry.glyph);
  const nameW = visibleWidth(entry.displayName);
  // caps (2) + spaces around glyph/name (3) for active, one space otherwise
  return gW + nameW + (entry.isActive ? 5 : 1);
}

/**
 * Pure: render one pill to exactly `width` cells (one line, space-padded).
 * `truncateToWidth` is Unicode-aware (grapheme clusters, East Asian Width),
 * so CJK/emoji names truncate on correct boundaries.
 */
export function renderTabPill(theme, entry, width) {
  const glyphStyled = theme.fg(entry.glyphColor, entry.glyph);
  const styleName = (t) =>
    entry.isActive ? theme.fg("accent", theme.bold(t)) : theme.fg("muted", t);
  const gW = visibleWidth(entry.glyph);
  const fits = (s) => visibleWidth(s) <= width;

  let label;
  if (entry.isActive) {
    const cappedAvail =
      width - gW - visibleWidth(CAP_LEFT) - visibleWidth(CAP_RIGHT) - 3;
    if (cappedAvail >= 1) {
      const name = truncateToWidth(entry.displayName, cappedAvail);
      label = `${CAP_LEFT} ${glyphStyled} ${styleName(name)} ${CAP_RIGHT}`;
    }
  }
  if (label === undefined) {
    // Too narrow for the caps (extreme shrink): keep glyph + as much of the
    // name as fits, degrading to the bare status glyph as the last resort.
    const plainAvail = width - gW - 1;
    label =
      plainAvail >= 1
        ? `${glyphStyled} ${styleName(truncateToWidth(entry.displayName, plainAvail))}`
        : glyphStyled;
  }
  if (!fits(label)) label = glyphStyled;

  // Fill ends exactly at the label (the right cap); padding stays unfilled.
  const line =
    (entry.isActive ? theme.bg("selectedBg", label) : label) +
    " ".repeat(Math.max(0, width - visibleWidth(label)));
  return [line];
}

/** Render-only tab component; the HStack sizes it via an explicit basis. */
export class TabPill {
  constructor({ theme, entry }) {
    this.theme = theme;
    this.entry = entry;
  }
  invalidate() {}
  render(width) {
    return renderTabPill(this.theme, this.entry, Math.max(1, Math.floor(width)));
  }
}

/** Keep the historical factory signature used by createTabBar. */
export function createTabComponent({ theme, entry }) {
  return new TabPill({ theme, entry });
}
