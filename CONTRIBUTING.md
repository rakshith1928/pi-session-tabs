# Contributing to pi-session-tabs

Thanks for contributing! This is a Pi package extension with **no build step** — the extension is plain TypeScript that Pi loads directly, so there is nothing to compile. The contributor loop is intentionally tiny.

## Contributor loop

```sh
git clone <repo>
cd pi-session-tabs

npm test     # all tests green before you start
pi -e .      # boot Pi with the local extension for interactive checks

# make your changes, then repeat:
npm test
pi -e .
```

`npm test` runs the `node:test` suite (it never touches a real Pi). `pi -e .` boots an interactive Pi session with the local extension loaded so you can exercise the tab bar, the `/tab*` commands, and `Alt+Left`/`Alt+Right` by hand.

## Where things live

- `extensions/` — the extension source (`tab-bar.mjs`, `tab-component.mjs`, `tab-manager.mjs`, `commands.mjs`, `controller.mjs`, `index.ts`).
- `test/*.test.mjs` — the test suite. Tests inject fake runtime/mode/session objects; they never load real Pi. Follow the existing `fakeMode` / `stubSession` helpers rather than importing Pi.
- `AGENTS.md` — architecture, key invariants, and test conventions. **Read this before changing anything.**
- `docs/index.md` — the user guide.

## Design notes

- **Width allocation** is owned by the HStack via an explicit per-tab `basis` (`visibleWidth(glyph + " " + name) + 2`, `grow:0`, `shrink:1`, `minSize:3`). Do not add width math inside `layoutTabs`.
- **No mouse, no focus mode** — by design. Pi 0.84.1 exposes no native click or hover API for extension widgets, so tabs are keyboard-driven.
- **Slash commands** (`/tabnew`, `/tabclose`, `/tabrename`) are registered via `pi.registerCommand` in `extensions/commands.mjs`; add new ones there.

## Pull requests

Keep changes focused. Make sure `npm test` stays green and `pi -e .` behaves before opening a PR, and update `README.md` / `docs/index.md` for any user-facing behavior change.
