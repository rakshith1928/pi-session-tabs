# Release pi-session-tabs

Publish a new version of the pi-session-tabs package.

Arguments: `$ARGUMENTS` — the version bump, e.g. `patch`, `minor`, or `1.2.0`.

## Steps

1. **Clean tree + green tests.** Ensure no uncommitted work you don't intend to
   ship, then run `npm test` (must be green — currently 54/54).

2. **Bump version** (updates `package.json`):

   ```sh
   npm version patch        # or: minor | major | 1.2.0
   ```

3. **Publish to npm:**

   ```sh
   npm publish --access public
   ```

   The package `files` whitelist is `extensions/` + `README.md`, and
   `package.json` declares `"pi": { "extensions": ["./extensions/index.ts"] }`.

4. **Install / verify in a Pi session:**
   - From a clone of this repo: `pi install .` (loads the local
     `./extensions/index.ts`).
   - From npm: `pi install npm:pi-session-tabs`.
   Then `/tabnew`, `/tabclose`, `/tabrename` and Alt+Left/Right should work.

5. **Docs.** Update the `README.md` install section if the install command
   changed.

## Notes

- The extension loads via `package.json`'s `pi.extensions` entry. Do **not** move
  it to `.pi/extensions/` — that directory is for in-repo, non-packaged
  extensions, not for a published package like this one.
- No build step: TypeScript `index.ts` is type-stripped by Node, and the `.mjs`
  files are plain ESM.
