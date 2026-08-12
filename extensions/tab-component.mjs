import { Box, TruncatedText } from "@earendil-works/pi-tui";

/**
 * Build one tab as a native Pi TUI `Box`. The box fills the `accent` background
 * when it is the active tab and leaves inactive tabs subdued (no fill). A child
 * `TruncatedText` renders the in-tab content:
 *   - a normal tab:  <glyph> <name> <×>   (close control when closable)
 *   - the new-tab entry:  +
 *
 * `TruncatedText` (not `Text`) is deliberate: `Text` *wraps*, which would turn a
 * tab shrunk by the HStack into multiple lines. `TruncatedText` stays one line and
 * truncates to the width the HStack allocates at render time.
 *
 * Pi 0.84.1 `Component`s have no `onClick`/`onActivate` API — `onActivate`/
 * `onClose` are accepted for interface symmetry but are NOT used inside the
 * component (interaction is wired by the strip in tab-manager.mjs via keyboard
 * shortcuts, and deferred mouse via an OSC8 hack). Do not add click handlers here.
 */
export function createTabComponent({ theme, entry, onActivate, onClose }) {
  const isNew = entry.isNew;
  const closable = entry.canClose ?? !isNew;
  const inner = isNew
    ? "+"
    : `${theme.fg(entry.glyphColor, entry.glyph)} ${entry.displayName}${closable ? ` ${theme.fg("muted", "×")}` : ""}`;
  const box = new Box(1, 0, (text) =>
    entry.isActive ? theme.bg("accent", text) : text,
  );
  box.addChild(new TruncatedText(inner, 0, 0));
  return box;
}
