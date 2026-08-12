# pi-session-tabs

OpenCode v2-style multi-session tabs for Pi 0.84.1. Each tab is an independent, concurrently live Pi session with its own persisted conversation.

## Install

Published package:

```sh
pi install npm:pi-session-tabs
```

From GitHub:

```sh
pi install git:github.com/<you>/pi-session-tabs
```

For local development:

```sh
pi install ./pi-session-tabs
```

To publish, remove nothing: the package `files` setting already scopes the published contents. Run `npm publish`, then install it with `pi install npm:pi-session-tabs`.

## Use

Run plain `pi` after installing the package. The tab bar appears above Pi's normal header.

| Command / key | Action |
| --- | --- |
| `/tabnew [name]` | Create and activate an independent session tab. |
| `/tabclose` | Close the active tab (the last tab cannot be closed). |
| `/tabrename <name>` | Rename the active tab and persist its session name. |
| `Alt+Left` / `Alt+Right` | Switch to the previous / next tab, wrapping at either end. |

## Architecture

This is a Pi package extension. During Phase A, its top-level module installs additive, guarded patches before Pi constructs `InteractiveMode`. A controller stored on `globalThis` survives extension reloads and keeps one `TabManager` per running mode. The implementation uses eight guarded integration points, while `TabManager` owns session registration, switching, lifecycle, drafts, and status; `TabBar` renders the shared tab strip.

## Known limitations

- Shared Pi chrome (header, footer, widgets, and status) is last-writer-wins between sessions.
- Tabs are not restored across restarts; Pi restores its normal session, but the tab set is not persisted as a group.
- While tabs are active, `Alt+Left` and `Alt+Right` shadow Pi editor word movement.
- Tab-name truncation uses ASCII-width assumptions rather than terminal display width.
- `needs_attention` is derived only from structural session events, including an assistant message with `stopReason: "error"`; it does not classify arbitrary error text.
- `session_start` fires once per session, on its first extension bind.

## Uninstall

```sh
pi remove pi-session-tabs
```

Pi itself is untouched.

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

`npm test` runs the `node:test` suite (it never touches a real Pi). `pi -e .` boots an interactive Pi session with the local extension loaded, so you can exercise the tab bar, the `/tab*` commands, and `Alt+Left`/`Alt+Right` by hand. `AGENTS.md` covers the architecture, invariants, and test conventions.
