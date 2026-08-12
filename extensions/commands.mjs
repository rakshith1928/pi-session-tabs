// Tab slash-command registration.
//
// Each command is a thin wrapper that delegates to the controller's existing
// handleTabCommand (the single source of truth for parsing + execution).
// Registering them via pi.registerCommand makes /tabnew, /tabclose and
// /tabrename appear in Pi's command autocomplete with a description — the same
// discoverability built-in commands like /resume get — and lets Pi dispatch
// them through its normal prompt() -> _tryExecuteExtensionCommand path, so the
// typed text is never forwarded to the LLM.
import { getController } from "./controller.mjs";
import { parseTabCommand } from "./tab-manager.mjs";

/** Tab commands exposed as Pi slash commands (name + description). */
export const TAB_COMMANDS = [
  {
    name: "tabnew",
    description: "Open a new session tab — give it a name or leave it blank.",
  },
  {
    name: "tabclose",
    description: "Close the tab you're currently on.",
  },
  {
    name: "tabrename",
    description: "Rename the current tab (type to match an existing name).",
    // Suggest existing tab names as the rename target while typing.
    getArgumentCompletions: (prefix) => tabNameCompletions(prefix),
  },
];

/** Fuzzy-match existing tab names against the partial argument the user typed. */
function tabNameCompletions(prefix) {
  const names = (getController().manager?.tabs ?? [])
    .map((t) => t.name)
    .filter(Boolean);
  const p = (prefix ?? "").toLowerCase();
  return names
    .filter((n) => n.toLowerCase().includes(p))
    .map((n) => ({ value: n, label: n, description: "session tab" }));
}

/** Build the handler Pi invokes for a registered tab command. */
function makeHandler(commandName) {
  return async (args, ctx) => {
    const c = getController();
    if (ctx.mode !== "tui") {
      ctx.ui?.notify?.(`/${commandName} is available in interactive mode`, "warning");
      return;
    }
    if (!c.manager) {
      ctx.ui?.notify?.("Session tabs are not available yet", "warning");
      return;
    }
    const text = `/${commandName}${args ? ` ${args}` : ""}`.trim();
    const parsed = parseTabCommand(text);
    if (parsed) await c.handleTabCommand(parsed);
  };
}

/** Register the tab slash commands on the Pi extension API. */
export function registerTabCommands(pi) {
  for (const cmd of TAB_COMMANDS) {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      ...(cmd.getArgumentCompletions
        ? { getArgumentCompletions: cmd.getArgumentCompletions }
        : {}),
      handler: makeHandler(cmd.name),
    });
  }
}
