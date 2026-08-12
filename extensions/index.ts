// Phase A — module top-level. The jiti loader aliases these package specifiers to
// the host's own module instances (verified against 0.84.1: identity === host),
// and extensions load inside createAgentSessionRuntime, BEFORE new InteractiveMode.
// So these imports ARE the classes the CLI constructs, and patching here lands
// before the first init() call.
import { AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { ensurePatched, getController, checkVersion } from "./controller.mjs";

const controller = ensurePatched({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager });
controller.tui = { Container, Text };
void checkVersion();

// Phase B — per-session factory (extension contract requires a default export).
// Tab commands (/tabnew, /tabclose, /tabrename) are handled by the editor-submit
// interception installed at attach time; there is nothing to register here.
export default function piSessionTabs() {}
