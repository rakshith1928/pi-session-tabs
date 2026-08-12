# Add a tab slash command

Scaffold a new `/tab<name>` slash command for pi-session-tabs.

Arguments: `$ARGUMENTS` — the command name (without the slash) and a one-line
description, e.g. `tabmute: hide the current tab from the bar`.

## Steps

1. **Register the command.** Open `extensions/commands.mjs` and add an entry to
   `TAB_COMMANDS`:

   ```js
   {
     name: "tabmute",
     description: "Hide the current tab from the bar",
     // optional: getArgumentCompletions: (prefix) => tabNameCompletions(prefix),
   },
   ```

   `registerTabCommands(pi)` iterates `TAB_COMMANDS` and calls
   `pi.registerCommand(name, { description, handler: makeHandler(name), ... })`.
   The shared `makeHandler` already delegates to
   `getController().handleTabCommand(parseTabCommand("/<name> <args>"))`, so no new
   wiring is needed at the `pi.registerCommand` layer.

2. **Add execution.** In `extensions/tab-manager.mjs`:
   - add a branch in `handleTabCommand(manager, cmd)`:
     ```js
     else if (cmd.command === "tabmute") manager.muteActive(cmd.name);
     ```
   - add the method on `TabManager` (keep the foreground session stable and call
     `this.updateBar()` whenever the bar content changes).
   - `parseTabCommand` (same file) must recognize `/tabmute` and return
     `{ command: "tabmute", name }`.

3. **Test.** Add a case to `test/commands.test.mjs` asserting the command is
   registered with its description, and that its handler delegates to the
   controller/manager. Mirror the existing `/tabrename` tests.

4. **Docs.** Note the new command in `AGENTS.md` (Commands/keys) and in
   `DESIGN.md` if it changes behavior.

## Run

`npm test` (node --test via jiti) must pass.
