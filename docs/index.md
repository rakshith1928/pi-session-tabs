# Pi Session Tabs

OpenCode v2-style multi-session tabs for [Pi](https://github.com/earendil-works/pi-coding-agent).
Each tab is an independent, concurrently-live Pi session with its own persisted
conversation — so you can keep several lines of work open and switch between them
instantly, the way OpenCode v2 does.

This is a Pi package extension: install it once and it loads automatically in
every Pi session.

## Install

```sh
pi install npm:pi-session-tabs                   # from npm
pi install git:github.com/<you>/pi-session-tabs  # from a fork
pi install ./pi-session-tabs                     # local clone (development)
```

See `README.md` for the full install/uninstall notes and requirements (Pi 0.84.1).

## Commands

All three are real Pi slash commands — they appear in command autocomplete with
descriptions and are never forwarded to the model.

| Command | Description | Notes |
| --- | --- | --- |
| `/tabnew [name]` | Open a new session tab and activate it. | Optional name; defaults to an auto name. |
| `/tabclose` | Close the active tab. | The last remaining tab cannot be closed. |
| `/tabrename <name>` | Rename the active tab. | Typing suggests existing tab names. |

## Keyboard

| Key | Action |
| --- | --- |
| `Alt+Left` / `Alt+Right` | Switch to the previous / next tab, wrapping at either end. |

## The tab bar

A native TUI strip is rendered above Pi's normal header. Each tab is a distinct
rectangular region:

- **Active tab** is highlighted with the `selectedBg` background.
- **Idle / running / needs-attention** tabs show a glyph: `○` idle, `●` running,
  `⚠` needs attention.
- `×` closes a tab; `+` opens a new one.
- Tab widths follow the session name (plus the status glyph and close control),
  and long names truncate safely so the strip always fits the terminal.
- Closing the last tab is disabled.

> **No mouse, no focus mode.** Pi 0.84.1 exposes no native click or hover API for
> extension widgets, so tabs are keyboard-driven (`Alt+Left` / `Alt+Right` and the
> `/tab*` commands). Click-to-switch is a deferred future enhancement.

## How sessions work

Each tab backs a real `AgentSession`. One tab is foreground at a time; switching
simply swaps which session Pi renders, while the others keep running in the
background and surface status (running / needs-attention) in their glyphs. There
is exactly one foreground and any number of concurrent background sessions — the
OpenCode v2 model.

## Requirements & compatibility

- **Pi 0.84.1** is pinned; patches are existence-guarded and degrade gracefully on
  other versions.
- `Alt+Left` / `Alt+Right` rely on your terminal sending the `modifyOtherKeys` /
  Kitty keyboard protocol sequences (e.g. `\x1b[1;5C`). Windows Terminal and most
  modern terminals do this out of the box.

## Troubleshooting

- **Tab bar doesn't appear** — the extension isn't loaded. Re-run
  `pi install ./pi-session-tabs` (or the npm form) and restart Pi.
- **Alt+Left / Alt+Right do nothing** — your terminal isn't emitting the
  modified-arrow sequences. Enable "modifyOtherKeys" / the Kitty keyboard protocol
  in the terminal, or use the `/tabnew` `/tabclose` `/tabrename` commands instead.
- **Shared chrome flickers between tabs** — known limitation: Pi's header/footer/
  status are last-writer-wins across sessions.

## Limitations

See `README.md` → *Known limitations* for the full list. Highlights: tabs are not
restored as a group across restarts, shared Pi chrome is last-writer-wins, and
mouse interaction is deferred.
