Release this package

Cut a new release of this package.

Arguments: $ARGUMENTS — the version bump, e.g. "patch", "minor", or "1.2.0".

Important: contributors do not publish. Publishing to npm is a maintainer action (or run by CI). As a contributor, prepare the release and open a pull request; do not run npm publish yourself.

Steps for a contributor

1. Clean tree + green tests. Ensure no uncommitted work you do not intend to ship, then run npm test (it must be green).

2. Bump the version (updates package.json):
   npm version patch        # or: minor | major | 1.2.0
   Commit the version bump.

3. Update docs if needed (README install section, user guide).

4. Open a pull request with the version bump and a short changelog, and ask a maintainer to review and publish.

Steps for a maintainer (not for contributors)

- Review and merge the release pull request.
- Publish:
  npm publish --access public
  The package files whitelist is extensions/ + README.md, and package.json declares "pi": { "extensions": ["./extensions/index.ts"] }.
- Verify the install in a Pi session:
  - From a clone of this repo: pi install .
  - From npm: pi install npm:<package-name>
  Then the slash commands and key bindings should work.

Notes

- The extension loads via package.json's pi.extensions entry. Do not move it to .pi/extensions/ — that directory is for in-repo, non-packaged extensions, not for a published package.
- No build step: the TypeScript index.ts is type-stripped by Node, and the .mjs files are plain ESM.
