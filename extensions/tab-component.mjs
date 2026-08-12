import { Box, TruncatedText } from "@earendil-works/pi-tui";

/**
 * Build one tab as a native Pi TUI `Box`. The box fills the `selectedBg` background
 * when it is the active tab and leaves inactive tabs subdued (no fill). A child
 * `TruncatedText` renders the in-tab content: `<glyph> <name>`.
 *
 * `TruncatedText` (not `Text`) is deliberate: `Text` *wraps*, which would turn a
 * tab shrunk by the HStack into multiple lines. `TruncatedText` stays one line and
 * truncates to the width the HStack allocates at render time.
 *
 * Pi 0.84.1 `Component`s have no `onClick` API, so the strip is informational
 * only. Tab creation/closing is done via the `/tabnew` and `/tabclose` slash
 * commands, and Alt+Left/Right cycles between tabs. (Clickable tabs / a focus
 * mode were considered during planning and deferred — there is no `+`/`×` control.)
 */
export function createTabComponent({ theme, entry }) {
  const inner = `${theme.fg(entry.glyphColor, entry.glyph)} ${entry.displayName}`;
  const box = new Box(1, 0, (text) =>
    entry.isActive ? theme.bg("selectedBg", text) : text,
  );
  box.addChild(new TruncatedText(inner, 0, 0));
  return box;
}
