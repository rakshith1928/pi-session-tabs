// Phase A — module top-level. The jiti loader aliases these package specifiers to
// the host's own module instances (verified against 0.84.1: identity === host),
// and extensions load inside createAgentSessionRuntime, BEFORE new InteractiveMode.
// So these imports ARE the classes the CLI constructs, and patching here lands
// before the first init() call.
import { AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { ensurePatched, checkVersion } from "./controller.mjs";
import { registerTabCommands } from "./commands.mjs";

const controller = ensurePatched({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager });
controller.tui = { Container, Text };
void checkVersion();

// Phase B — per-session factory (extension contract requires a default export).
// Register /tabnew, /tabclose and /tabrename as Pi slash commands so they appear
// in command autocomplete with descriptions and dispatch through Pi's normal
// command path (handled in commands.mjs + controller.mjs).
export default function piSessionTabs(pi: any) {
  registerTabCommands(pi);
}
