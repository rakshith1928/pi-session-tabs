<div align="center">
  <pre>
██████╗ ██╗     ███████╗███████╗███████╗██╗ ██████╗ ███╗   ██╗    ████████╗ █████╗ ██████╗ ███████╗
██╔══██╗██║     ██╔════╝██╔════╝██╔════╝██║██╔═══██╗████╗  ██║    ╚══██╔══╝██╔══██╗██╔══██╗██╔════╝
██████╔╝██║     ███████╗█████╗  ███████╗██║██║   ██║██╔██╗ ██║       ██║   ███████║██████╔╝███████╗
██╔═══╝ ██║     ╚════██║██╔══╝  ╚════██║██║██║   ██║██║╚██╗██║       ██║   ██╔══██║██╔══██╗╚════██║
██║     ██║     ███████║███████╗███████║██║╚██████╔╝██║ ╚████║       ██║   ██║  ██║██████╔╝███████║
╚═╝     ╚═╝     ╚══════╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝       ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝
  </pre>

  <p>OpenCode v2-style multi-session tabs for Pi</p>
</div>
<p align="center">
  <a href="https://www.npmjs.com/package/pi-session-tabs"><img alt="npm" src="https://img.shields.io/npm/v/pi-session-tabs?style=flat-square" /></a>
  <img alt="Pi" src="https://img.shields.io/badge/Pi-0.84.1-5865F2?style=flat-square" />
</p>

Each tab is an independent, concurrently-live Pi session with its own persisted conversation — keep several lines of work open and switch between them instantly, the way OpenCode v2 does. It loads as a normal Pi package: install it once and it appears in every Pi session.

## Table of Contents

- [Quick Start](#quick-start)
- [Commands](#commands)
- [Keyboard](#keyboard)
- [The tab bar](#the-tab-bar)
- [How sessions work](#how-sessions-work)
- [Architecture](#architecture)
- [Known limitations](#known-limitations)
- [Requirements](#requirements)
- [Development](#development)
- [Uninstall](#uninstall)

---

## Quick Start

Published package:

```sh
pi install npm:pi-session-tabs
```

From GitHub:

```sh
pi install git:github.com/rakshith1928/pi-session-tabs
```

For local development:

```sh
pi install ./pi-session-tabs
```

Run plain `pi` after installing the package. The tab bar appears above Pi's header once two or more tabs are open.

## Commands

All three are real Pi slash commands — they appear in command autocomplete with descriptions and are never forwarded to the model.

| Command | Action |
| --- | --- |
| `/tabnew [name]` | Create and activate an independent session tab. Optional name; unnamed tabs are auto-titled from the first reply. |
| `/tabclose` | Close the active tab (the last tab cannot be closed). |
| `/tabrename <name>` | Rename the active tab and persist its session name. |

Pi's own built-ins keep working normally: `/new` starts a brand-new session and replaces the active tab in place (the previous conversation stays on disk — `/resume` can bring it back). `/resume` swaps the active tab for the resumed session; if that session is already open as another tab, it simply switches to it without creating a duplicate. At startup, `pi resume <id>` keeps the session you named in front while the project's saved tabs come back in the background.

## Keyboard

| Key | Action |
| --- | --- |
| `Alt+Left` / `Alt+Right` | Switch to the previous / next tab, wrapping at either end. |

## The tab bar

A native TUI strip is rendered above Pi's header **only while two or more tabs are open** — with a single tab Pi looks exactly as normal (no strip). Tabs are styled after OpenCode v2's titlebar — the active tab is a rounded, filled pill, the others are quiet:

```
◖ ● Main ◗   ○ Research   ⚠ deploy
```

- **Active tab** is a `selectedBg`-filled pill with rounded caps (`◖…◗`) and an accent, bold name.
- **Inactive tabs** are muted text with no fill.
- **Idle / running / needs-attention** tabs show a glyph: `○` idle, `●` running, `⚠` needs attention.
- Tab widths follow the session name (plus the status glyph), and long names truncate safely — only the name ever truncates, the caps and glyph always survive — so the strip always fits the terminal.
- Tabs start from the name you give them (or a `tab N` placeholder). Unnamed tabs are auto-titled ChatGPT-style: after the first assistant reply, one small LLM call on the session's current model names the conversation (a title derived from your first message is used if that call fails). Explicit names (via `/tabnew <name>` or `/tabrename`) are kept, and titles persist with the session across restarts.
- **Across restarts** the tab set is restored per project — tabs, names, and the active tab come back; per-tab editor drafts are not persisted.
- Closing the last tab is disabled.

> **No mouse, no focus mode.** Pi 0.84.1 exposes no native click or hover API for extension widgets, so tabs are keyboard-driven (`Alt+Left` / `Alt+Right` and the `/tab*` commands). Click-to-switch is a deferred future enhancement.

## How sessions work

Each tab backs a real `AgentSession`. One tab is foreground at a time; switching simply swaps which session Pi renders, while the others keep running in the background and surface status (running / needs-attention) in their glyphs. There is exactly one foreground and any number of concurrent background sessions — the OpenCode v2 model.

## Architecture

This is a Pi package extension. During startup its top-level module installs additive, guarded patches before Pi constructs `InteractiveMode`. A controller stored on `globalThis` survives extension reloads and keeps one `TabManager` per running mode. The implementation uses nine guarded integration points, while `TabManager` owns session registration, switching, lifecycle, drafts, and status; `TabBar` renders the shared tab strip.

See `AGENTS.md` for the architecture, invariants, and test conventions, and `docs/index.md` for the full user guide.

## Known limitations

- Shared Pi chrome (header, footer, widgets, and status) is last-writer-wins between sessions.
- `Alt+Left` / `Alt+Right` shadow Pi editor word movement only while two or more tabs are open; with a single tab the keys pass through to the editor.
- `needs_attention` is derived only from structural session events — an assistant `stopReason` of `"error"` or `"length"` (truncated output), an abort on a background tab, and a failed compaction; it does not classify arbitrary error text.
- `session_start` fires once per session, on its first extension bind.

## Requirements

- Pi 0.84.1.

Patches are existence-guarded and degrade gracefully on other Pi versions. When the installed host version can be inspected, the package emits a best-effort warning for a version mismatch; unavailable version metadata does not prevent Pi from starting.

## Development

For contributors, the loop is just:

```sh
git clone <repo>
cd pi-session-tabs

npm test     # all tests green before you start
pi -e .      # boot Pi with the local extension for interactive checks

# make your changes, then repeat:
npm test
pi -e .
```

`npm test` runs the `node:test` suite (it never touches a real Pi). `pi -e .` boots an interactive Pi session with the local extension loaded, so you can exercise the tab bar, the `/tab*` commands, and `Alt+Left`/`Alt+Right` by hand. `AGENTS.md` covers the architecture, invariants, and test conventions, and `CONTRIBUTING.md` covers where things live and pull-request expectations.

## Uninstall

```sh
pi remove pi-session-tabs
```

Pi itself is untouched.
