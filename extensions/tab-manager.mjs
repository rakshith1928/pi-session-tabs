import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTabBar } from "./tab-bar.mjs";
import { HStack } from "@earendil-works/pi-tui";

// Opt-in diagnostic: when PI_SESSION_TABS_DEBUG is set, every raw sequence the
// Alt+arrow interceptor receives is appended (as char codes) to a log file. This
// is how we discover what a given terminal actually emits for Alt+Right.
const DEBUG_LOG = join(tmpdir(), "pi-session-tabs-alt.log");
function debugLog(data, direction) {
  if (!process.env.PI_SESSION_TABS_DEBUG) return;
  try {
    appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ t: Date.now(), bytes: [...data].map((c) => c.charCodeAt(0)), direction }) + "\n",
    );
  } catch {
    /* best effort */
  }
}

// Kitty / modifyOtherKeys Alt+arrow. The xterm modifier parameter is
// 1 + 2*shift + 4*alt + 8*ctrl + ...; Alt sets the value-4 bit, so the
// parameter (e.g. 5 = Alt, 7 = Alt+Shift, 13 = Alt+Ctrl) always has that bit
// set. An optional ":<event>" suffix (Kitty press/repeat/release) is allowed.
// Terminals that don't negotiate modifyOtherKeys instead emit a lone ESC
// followed by the bare arrow (handled via plainArrowDirection + ESC tracking).
const CSI_ALT_ARROW_RE = /^\x1b\[1;(\d+)(?::\d+)?([CD])$/;
const PLAIN_LEFT_RE = /^\x1bO?\[?D$/;
const PLAIN_RIGHT_RE = /^\x1bO?\[?C$/;
const ESC = "\x1b";

/** Return the requested tab direction for a Kitty/modifyOtherKeys Alt+arrow, or 0. */
export function altTabDirection(data) {
  const m = CSI_ALT_ARROW_RE.exec(data);
  if (!m) return 0;
  if ((parseInt(m[1], 10) & 4) === 0) return 0; // alt bit (value 4) not set
  return m[2] === "C" ? 1 : -1;
}

/** Return the direction for a plain arrow sequence (used after a lone ESC). */
export function plainArrowDirection(data) {
  if (PLAIN_LEFT_RE.test(data)) return -1;
  if (PLAIN_RIGHT_RE.test(data)) return 1;
  return 0;
}

/**
 * Build the Alt+arrow input listener. Recognizes the Kitty/modifyOtherKeys form
 * (\x1b[1;3C/D) directly, and the ESC-prefixed fallback (lone ESC then plain
 * arrow) by tracking a pending ESC across the two sequences pi-tui's StdinBuffer
 * emits for it. Returns undefined to let unrelated input pass through.
 */
export function makeAltArrowListener(mode, manager) {
  let pendingEsc = false;
  let escTimer = null;
  const clearPending = () => {
    pendingEsc = false;
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };
  return (data) => {
    // Lone ESC: remember it in case the next sequence is an arrow (Alt+Arrow
    // fallback). We let it through; the following arrow is what we consume.
    if (data === ESC) {
      pendingEsc = true;
      escTimer = setTimeout(clearPending, 50);
      debugLog(data, 0);
      return undefined;
    }
    let direction = altTabDirection(data);
    if (!direction && pendingEsc) direction = plainArrowDirection(data);
    debugLog(data, direction);
    if (!direction) return undefined;
    clearPending();
    if (hasOverlay(mode)) return undefined;
    void manager.cycle(direction);
    return { consume: true };
  };
}

export async function handleTabCommand(manager, cmd) {
  try {
    if (cmd.command === "tabnew") await manager.createTab(cmd.name);
    else if (cmd.command === "tabclose") await manager.closeActive();
    else if (cmd.command === "tabrename") manager.renameActive(cmd.name);
  } catch (err) {
    manager.mode.showStatus?.(`Tab command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Per-tab state machine driven purely by session events. */
export function parseTabCommand(text) {
  const t = (text ?? "").trim();
  if (!t.startsWith("/tab")) return null;
  if (t === "/tabnew" || t.startsWith("/tabnew ")) {
    const name = t.slice("/tabnew".length).trim();
    return { command: "tabnew", ...(name ? { name } : {}) };
  }
  if (t === "/tabclose") return { command: "tabclose" };
  if (t === "/tabrename" || t.startsWith("/tabrename ")) {
    const name = t.slice("/tabrename".length).trim();
    return name ? { command: "tabrename", name } : { command: "tabrename" };
  }
  return null;
}

export function hasOverlay(mode) {
  return Boolean(
    mode.extensionSelector ||
      mode.extensionInput ||
      mode.extensionEditor ||
      mode.activeSelectorToken,
  ) || mode.editor !== mode.defaultEditor;
}

export class TabManager {
  static attach(mode, { Container, HStack }) {
    const manager = new TabManager({ mode });
    mode.__tabManager = manager;

    const session = mode.runtimeHost.session;
    // Adopt the existing foreground Pi AgentSession as the single initial tab.
    // No new session is created here; the tab is labeled "Main" and Pi's own
    // session name/transcript/editor are left untouched, so normal startup
    // behavior is unchanged. Only /tabnew creates an additional session/tab.
    manager.addTab(session, { name: "Main", draft: mode.editor?.getText?.() ?? "", boundBefore: true });

    manager.setBar(
      createTabBar({
        Container,
        HStack,
        theme: mode.createExtensionUIContext().theme,
        documentContainer: mode.documentContainer,
        requestRender: () => mode.ui?.requestRender?.(),
      }),
    );

    // Tab commands (/tabnew, /tabclose, /tabrename) are registered as Pi slash
    // commands in commands.mjs via pi.registerCommand. Pi dispatches them through
    // prompt() -> _tryExecuteExtensionCommand, so we no longer intercept onSubmit
    // here (doing so would preempt that path and make the registered handler dead).
    manager._unsubAlt = mode.ui?.addInputListener?.(makeAltArrowListener(mode, manager));

    if (process.env.PI_SESSION_TABS_DEBUG) {
      try {
        appendFileSync(DEBUG_LOG, JSON.stringify({ t: Date.now(), event: "attach", note: "Alt+arrow interceptor registered" }) + "\n");
      } catch {
        /* best effort */
      }
    }

    return manager;
  }

  constructor({ mode }) {
    this.mode = mode;
    this.runtime = mode.runtimeHost;
    this.tabs = [];
    this.activeIndex = 0;
    this.shuttingDown = false;
    this.bar = undefined; // installed by attach (Task 10 wiring) via setBar
    this._unsubAlt = undefined;
    this._chain = Promise.resolve();
    // Pi swaps runtimeHost.session before invoking its rebind callback. Keep
    // the last known foreground identity so replacement reconciliation can
    // distinguish the outgoing session from the incoming one.
    this.foregroundSession = this.runtime.session;
  }

  _enqueue(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async createTab(name) {
    const result = await this.runtime.__piSessionTabsCreateTabSession();
    const session = result.session;
    const tab = this.addTab(session, { name });
    if (name) {
      try {
        session.setSessionName(name);
      } catch {
        /* name is cosmetic; ignore */
      }
    }
    await this.activate(this.tabs.indexOf(tab));
  }

  async activate(index) {
    return this._enqueue(async () => {
      if (index === this.activeIndex) return true;
      if (index < 0 || index >= this.tabs.length) return false;
      const target = this.tabs[index];
      const prev = this.runtime.session;
      try {
        await this.runtime.__piSessionTabsAttachSession(target.session);
      } catch (err) {
        try {
          await this.runtime.__piSessionTabsAttachSession(prev);
        } catch {
          /* restore failed; registry still consistent via hooks */
        }
        this.mode.showStatus?.(`Tab switch failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      this.activeIndex = index;
      this._applyDrafts(prev, target.session);
      this.updateBar();
      return true;
    });
  }

  _applyDrafts(prevSession, nextSession) {
    const prevTab = this.findBySession(prevSession);
    if (prevTab && this.mode.editor) prevTab.draft = this.mode.editor.getText();
    const nextTab = this.findBySession(nextSession);
    if (nextTab && this.mode.editor) {
      nextTab.draft ??= "";
      this.mode.editor.setText(nextTab.draft);
    }
  }

  async cycle(dir) {
    const n = this.tabs.length;
    if (n < 2) return;
    await this.activate((this.activeIndex + dir + n) % n);
  }

  async closeActive() {
    if (this.tabs.length <= 1) {
      this.mode.showStatus?.("Cannot close the last tab");
      return;
    }
    const idx = this.activeIndex;
    const closing = this.tabs[idx];
    const neighbor = this.tabs[idx === this.tabs.length - 1 ? idx - 1 : idx + 1];
    const activated = await this.activate(this.tabs.indexOf(neighbor));
    if (!activated) return;
    try {
      closing.session.dispose();
    } catch (err) {
      this.mode.showStatus?.(`Error closing tab: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.tabs.includes(closing)) this.removeTab(closing);
    this.updateBar();
  }

  closeTab(index) {
    if (this.tabs.length <= 1) return;            // keep at least one tab
    if (index === this.activeIndex) {
      return this.closeActive();                  // foreground advances to a neighbor
    }
    const removed = this.tabs[index];
    this.tabs.splice(index, 1);
    if (index < this.activeIndex) this.activeIndex -= 1; // keep foreground stable
    removed?.session.dispose?.();
    this.updateBar();
  }

  renameActive(name) {
    if (!name) {
      this.mode.showStatus?.("Usage: /tabrename <name>");
      return;
    }
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    try {
      tab.session.setSessionName(name);
    } catch (err) {
      this.mode.showStatus?.(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    tab.name = name;
    this.updateBar();
  }

  addTab(session, { name, draft = "", boundBefore = false } = {}) {
    const tab = {
      id: session.sessionId,
      name: name ?? `tab ${this.tabs.length + 1}`,
      session,
      state: session.isStreaming ? "running" : "idle",
      draft,
      unsubscribe: undefined,
    };
    if (boundBefore) session.__tabsFirstBind = true;
    tab.unsubscribe = this.subscribeStatus(tab);
    this.tabs.push(tab);
    if (this.tabs.length === 1) this.activeIndex = 0;
    this.updateBar();
    return tab;
  }

  removeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i === -1) return;
    tab.unsubscribe?.();
    this.tabs.splice(i, 1);
    if (this.activeIndex > i) this.activeIndex -= 1;
    if (this.activeIndex >= this.tabs.length) this.activeIndex = Math.max(0, this.tabs.length - 1);
    this.updateBar();
  }

  findBySession(session) {
    return this.tabs.find((t) => t.session === session);
  }

  isForeground(sessionId) {
    return this.runtime.session?.sessionId === sessionId;
  }

  hasBoundBefore(session) {
    return session.__tabsFirstBind === true;
  }

  subscribeStatus(tab) {
    return tab.session.subscribe((event) => this._handleSessionEvent(tab, event));
  }

  _handleSessionEvent(tab, event) {
    if (this.shuttingDown) return;
    switch (event.type) {
      case "agent_start":
        tab.state = "running";
        break;
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant" && msg.stopReason === "error") {
          tab.state = "needs_attention";
        } else if (msg?.role === "assistant") {
          tab.state = "running";
        }
        break;
      }
      case "agent_settled":
        if (tab.state !== "needs_attention") {
          tab.state = tab.session.isStreaming ? "running" : "idle";
        }
        break;
      case "compaction_start":
        tab.state = "running";
        break;
      case "compaction_end":
        if (tab.state !== "needs_attention") tab.state = "idle";
        break;
      default:
        return;
    }
    this.updateBar();
  }

  onForegroundChanged(prev, next) {
    if (prev === next) return;
    this._applyDrafts(prev, next);
    let nextTab = this.findBySession(next);
    if (!nextTab) {
      const name = next.sessionManager?.getSessionName?.() || `tab ${this.tabs.length + 1}`;
      nextTab = this.addTab(next, { name });
    }
    this.activeIndex = this.tabs.indexOf(nextTab);
    this.foregroundSession = next;
    this.updateBar();
  }

  onSessionDisposed(session) {
    const tab = this.findBySession(session);
    if (tab) this.removeTab(tab);
  }

  shutdown() {
    this.shuttingDown = true;
    this._unsubAlt?.();
    const active = this.runtime.session;
    for (const tab of [...this.tabs]) {
      if (tab.session === active) continue;
      try {
        tab.session.dispose();
      } catch {
        /* best effort */
      }
    }
  }

  setBar(bar) {
    this.bar = bar;
    this.updateBar();
  }

  updateBar() {
    if (!this.bar || this.shuttingDown) return;
    this.bar.update(
      this.tabs.map((t) => ({ name: t.name, state: t.state })),
      this.activeIndex,
    );
  }
}
