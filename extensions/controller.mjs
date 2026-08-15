/**
 * globalThis-backed controller for pi-session-tabs.
 * Survives /reload: the extension module is re-imported (loader cache cleared),
 * but this object persists, so patching happens exactly once per process and the
 * live TabManager keeps working across reloads.
 */
import { installPatches } from "./patches.mjs";
import { TabManager, handleTabCommand } from "./tab-manager.mjs";

export const CONTROLLER_KEY = Symbol.for("pi.sessionTabs.controller");

export class SessionTabsController {
  constructor() {
    this.patched = false;
    this.tui = undefined; // { Container, HStack } set by index.ts Phase A
    this.InteractiveMode = undefined; // for the identity self-check
    this.manager = null;
    this.mode = null;
  }

  isForeground(sessionId) {
    return this.manager ? this.manager.isForeground(sessionId) : true;
  }

  ensureManager(mode) {
    if (this.mode === mode && this.manager) return this.manager;
    if (!this.tui) {
      console.warn("pi-session-tabs: TUI classes unavailable; tabs disabled.");
      return null;
    }
    if (!mode || !mode.documentContainer || !mode.defaultEditor || !mode.ui?.addInputListener) {
      console.warn("pi-session-tabs: TUI wiring unavailable; tabs disabled for this mode.");
      return null;
    }
    if (this.InteractiveMode && !(mode instanceof this.InteractiveMode)) {
      console.warn("pi-session-tabs: mode is not an InteractiveMode instance; tabs disabled.");
      return null;
    }
    this.mode = mode;
    this.manager = TabManager.attach(mode, { Container: this.tui.Container, HStack: this.tui.HStack });
    // Restore the saved tab set for this project (best effort; no-ops on the
    // first run). Fire-and-forget so startup is never blocked by it.
    void this.manager.restoreTabs();
    return this.manager;
  }

  async handleTabCommand(cmd) {
    if (!this.manager) return;
    await handleTabCommand(this.manager, cmd);
  }
}

export function getController() {
  let c = globalThis[CONTROLLER_KEY];
  if (!c) {
    c = new SessionTabsController();
    globalThis[CONTROLLER_KEY] = c;
  }
  return c;
}

/**
 * Install the prototype patches exactly once per process. `install` is injectable
 * for tests; production uses the real installPatches.
 */
export function ensurePatched({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager }, { install } = {}) {
  const c = getController();
  if (c.patched) return c;
  c.patched = true;
  c.InteractiveMode = InteractiveMode;
  (install ?? installPatches)({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager, hooks: makeHooks(c) });
  return c;
}

/** Hook implementations for installPatches; all dispatch through the controller. */
export function makeHooks(controller) {
  return {
    onModeReady(mode) {
      controller.ensureManager(mode);
    },
    onForegroundChanged(mode, prev, next) {
      controller.manager?.onForegroundChanged(prev, next);
    },
    onSessionDisposed(session) {
      controller.manager?.onSessionDisposed(session);
    },
    onShutdown(mode) {
      controller.manager?.shutdown();
    },
    isForeground(sessionId) {
      return controller.isForeground(sessionId);
    },
  };
}

/**
 * Best-effort host-version check: warn when the installed pi version is not
 * 0.84.1. Silently no-ops if the host package cannot be resolved (e.g. the
 * loader does not provide import.meta.resolve) — existence guards handle it.
 */
export async function checkVersion({ warn = console.warn, resolve, read } = {}) {
  try {
    const r = resolve ?? import.meta.resolve;
    const pkgUrl = new URL("../package.json", await r("@earendil-works/pi-coding-agent"));
    const rd =
      read ?? (async (p, enc) => (await import("node:fs/promises")).readFile(p, enc));
    const { version } = JSON.parse(await rd(pkgUrl, "utf8"));
    if (version !== "0.84.1") {
      warn(`pi-session-tabs: installed pi version ${version} != 0.84.1; tabs may not apply cleanly.`);
    }
  } catch {
    /* best effort only */
  }
}
