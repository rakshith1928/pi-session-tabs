# AGENTS.md — pi-session-tabs

Guidance for AI agents (and humans) working in this repository.

## Project concept

`pi-session-tabs` is a **Pi package extension** that adds OpenCode v2-style
multi-session tabs to Pi. Each tab is a *genuinely independent, concurrently
live* Pi `AgentSession` with its own persisted conversation — **not** a
fake/history view.

The core idea is to achieve this **without forking or reimplementing Pi**: the
package installs a small set of *additive, existence-guarded prototype patches*
onto Pi's own classes at load time (before `InteractiveMode` is constructed),
and then a `TabManager` swaps those sessions in and out of the single running
mode instance. Pi's existing TUI, editor, agent runtime, and session machinery
are left untouched.

It loads as a normal Pi package (`pi install <path>`) with **no separate
launcher** — the extension entry point runs inside Pi's
`createAgentSessionRuntime` lifecycle.

## Environment & constraints

- **Target host:** Pi `@earendil-works/pi-coding-agent` **0.84.1** (global nvm
  install). The patches rely on verified private members of this exact version
  (see `DESIGN.md` §0 "Verified ground truth").
- **Patches are existence-guarded** and degrade gracefully on other Pi versions.
  `checkVersion()` only emits a best-effort warning on mismatch — it never blocks
  startup. Do **not** assume Pi internals are stable across versions; if you
  touch a patch, re-verify against the installed package's compiled JS +
  source maps.
- **No build step.** Runtime is plain ESM `.mjs` (plus one `.ts` entry). The
  patched surfaces are private members absent from `.d.ts`, so JSDoc types are
  used for documentation instead of a compiler. Avoid introducing a TypeScript
  compile requirement for the shipped code.
- `package.json` `files` already scopes published contents to `extensions/` +
  `README.md`. Do not add build artifacts to the published set.
- Peer deps (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) are
  resolved from the **host's** module instances at runtime (the jiti loader
  aliases the specifiers so identity === host).

## Architecture (read this before changing anything)

Entry flow:

1. **`extensions/index.ts`** — the Pi `extensions` entry. Imports the real Pi
   classes (`AgentSessionRuntime`, `AgentSession`, `InteractiveMode`,
   `SessionManager`) and TUI `Container`/`HStack`. Calls `ensurePatched(...)` in
   **Phase A** (before `new InteractiveMode`) and injects TUI classes into the
   controller, then `checkVersion()`. Exports the default `piSessionTabs()`
   factory (**Phase B**) which registers `/tabnew`, `/tabclose` and
   `/tabrename` as Pi slash commands (via `registerTabCommands` in
   `commands.mjs`) so they appear in command autocomplete with descriptions and
   dispatch through Pi's normal command path.
2. **`extensions/controller.mjs`** — `SessionTabsController`, held on
   `globalThis[Symbol.for("pi.sessionTabs.controller")]`. **Survives `/reload`**:
   the extension module is re-imported but the controller (and the live
   `TabManager`) persist, so patching happens **exactly once per process**.
   `makeHooks()` turns lifecycle events into manager calls.
3. **`extensions/commands.mjs`** — `registerTabCommands(pi)` registers
   `/tabnew`, `/tabclose`, `/tabrename` as Pi slash commands (with descriptions
   and `/tabrename` name-completions) that delegate to the controller's
   `handleTabCommand`.
3. **`extensions/patches.mjs`** — **the integration surface.** Eight guarded
   integration points, all pure factory functions (`makeX(orig, opts) => fn`):
   - `AgentSessionRuntime.__piSessionTabsAttachSession` — non-destructive
     session swap (`_session` + `finishSessionReplacement`, no teardown).
   - `AgentSessionRuntime.__piSessionTabsCreateTabSession` — creates an
     independent persisted session via the runtime's own factory.
   - `AgentSession.bindExtensions` — wrapped so re-bind suppresses the
     `session_start` emit and resource rediscovery on background sessions.
   - `AgentSession.dispose` — wrapped to notify registry cleanup.
   - `InteractiveMode.init` — hooks `onModeReady` → `ensureManager`.
   - `InteractiveMode.rebindCurrentSession` — hooks `onForegroundChanged`.
   - `InteractiveMode.shutdown` — hooks `onShutdown`.
   - `InteractiveMode.createExtensionUIContext` — guards every mutating UI
     method by foreground-session identity so background sessions never render
     into the foreground TUI and never hang.
   - `installPatches()` records every patched member (snapshot) and `restore()`
     reverses it; namespaced `__piSessionTabs*` additions are deleted, original
     Pi members reinstated.
4. **`extensions/tab-manager.mjs`** — `TabManager` owns session registration,
   switching, lifecycle, per-tab drafts, and per-tab status. Handles
   `/tabnew`, `/tabclose`, `/tabrename`, and Alt+Left/Right cycling. Session
   events drive a small per-tab state machine (`idle` / `running` /
   `needs_attention`). `closeTab(index)` closes a specific tab (delegating to
   `closeActive()` when it is the active one) and keeps the foreground stable.
5. **`extensions/tab-component.mjs`** — `createTabComponent({ theme, entry,
   onActivate, onClose })` builds one tab's `Box`: an accent background fill for
   the active tab, a `TruncatedText` label (`glyph + name + ×`), and a `+` box
   for the new-tab entry. `onActivate`/`onClose` are unused inside the component
   (Pi 0.84.1 has no `onClick` API); they are wired by the strip for the deferred
   mouse track. Interaction is keyboard-only — there is **no focus mode**
   (intentionally not implemented; Pi 0.84.1 has no clean free key for a
   tab-navigation toggle).
6. **`extensions/tab-bar.mjs`** — builds the tab strip above the header from Pi's
   native components: an `HStack` of per-tab `Box`es (each containing a
   `TruncatedText` label = `glyph + " " + name`). `layoutTabs()` is a **pure**
   function mapping `manager.tabs` + `activeIndex` to per-tab content + flags
   (glyph, color, active); `createTabBar()` assembles the `HStack`, owns width
   allocation via an explicit per-tab `basis = visibleWidth(glyph + " " + name) + 2`
   with `grow:0` / `shrink:1` / `minSize:3` (leftover terminal width stays after
   the strip; the longest tab truncates first when tight), and re-renders on
   every update. The active tab is filled with the `selectedBg` background;
   inactive tabs are subdued; each tab shows a status glyph (`○` idle / `●` running
   / `⚠` needs attention). There is no `+`/`×` control — the strip is
   informational only; creation/closing/rename go through the `/tabnew`
   `/tabclose` `/tabrename` commands and `Alt+Left`/`Alt+Right` cycle. Mouse
   clicks are deferred.

### Key invariants (preserve these or you will break the host)

- **Patch exactly once per process.** `ensurePatched` is idempotent via the
  `globalThis` controller; tests inject a fake `install` to assert this.
- **Never block the foreground.** Background UI-context calls resolve promptly
  with `GUARDED_CANCEL` values; they must not await user input.
- **Serialization.** Tab switching is enqueued on a promise chain
  (`_enqueue`) so concurrent tab ops can't interleave mid-swap.
- **Drafts.** Switching saves the outgoing tab's editor text and restores the
  incoming tab's draft via `_applyDrafts`.
- **Namespacing.** New prototype members use `__piSessionTabs*`; the
  first-bind flag is `session.__tabsFirstBind`; the manager hangs on
  `mode.__tabManager`. Don't collide with official Pi names.
- **Guard, don't fork.** Every change to a patch must remain additive and
  reversible via `restore()`. Prefer wrapping over replacing.

## Commands & keys (user-facing)

| Command / key | Action |
| --- | --- |
| `/tabnew [name]` | Create and activate an independent session tab. |
| `/tabclose` | Close the active tab (the last tab cannot be closed). |
| `/tabrename <name>` | Rename the active tab and persist its session name. |
| `Alt+Left` / `Alt+Right` | Switch to the previous / next tab, wrapping at either end. |

## Development

```sh
npm test          # runs node:test across test/*.test.mjs (54 tests, no Pi running)
node --test       # equivalent
pi -e .           # boot Pi with the local extension for manual / interactive checks
```

Contributor loop:

```sh
git clone <repo>
cd pi-session-tabs

npm test
pi -e .

# make your changes, then repeat:
npm test
pi -e .
```

`npm test` must stay green (it never touches a real Pi). `pi -e .` boots an
interactive Pi session with the local extension loaded so you can verify the tab
bar, slash commands, and `Alt+Left`/`Alt+Right` by hand.

- Tests **never touch real Pi classes.** They inject fake `AgentSessionRuntime` /
  `AgentSession` / `InteractiveMode` / `SessionManager` and stub `mode`/`session`.
  Patch factories are imported directly and tested in isolation; `installPatches`
  accepts an injectable `install` so patching can be asserted without a host.
- When adding a test, follow the existing stub helpers (`fakeMode`, `stubSession`)
  in the `test/*.test.mjs` files rather than importing Pi.

## Conventions

- **Pure where possible.** Patch factories, `layoutTabs`, `formatTabs`,
  `parseTabCommand`, `altTabDirection`, and `hasOverlay` are pure functions —
  keep them that way so they stay trivially testable.
- **JSDoc over TS** for the patched/prototype surfaces; document *why* a private
  Pi member is used in a comment (the code already does this — keep it up to
  date when Pi internals change).
- **Errors are non-fatal.** Tab commands and switches surface failures via
  `mode.showStatus?.(...)` instead of throwing into the host event loop.
- **Reference `DESIGN.md`** for the authoritative, version-pinned rationale
  behind each integration point before modifying a patch.
- Session/SDD working notes live under `.superpowers/sdd/` and `docs/`; these are
  process artifacts, not shipped code.

## Known limitations (don't "fix" these without a design change)

- Shared Pi chrome (header, footer, widgets, status) is last-writer-wins between
  sessions.
- Tabs are not restored as a group across restarts.
- `Alt+Left` / `Alt+Right` shadow Pi editor word movement while tabs are active.
- Tab-name truncation is single-line via `TruncatedText` (allocated width from
  the `HStack`); width math still uses ASCII-width assumptions, not true terminal
  display width.
- `needs_attention` is derived only from structural session events (e.g. an
  assistant message with `stopReason: "error"`), not arbitrary error text.
- `session_start` fires once per session, on its first extension bind.
