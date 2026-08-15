import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // With a single tab there is nothing to cycle — don't swallow the keys,
    // let them fall through to Pi's editor (Alt+arrow = word motion).
    if (manager.tabs.length < 2) return undefined;
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

// ---------------------------------------------------------------------------
// Tab-set persistence (restore across restarts)
// ---------------------------------------------------------------------------

/** Per-project state file path under the Pi agent dir (never inside the user's repo). */
export function stateFilePath(agentDir, cwd) {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(agentDir, "session-tabs", `${hash}.json`);
}

/**
 * Validate raw state-file JSON. Returns { tabs: [{file, name?}], activeIndex }
 * or null when the payload is unusable (bad JSON, wrong version, cwd mismatch,
 * no valid entries). `name` is undefined for entries saved without one.
 */
export function parseTabState(raw, cwd) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.version !== 1 || data.cwd !== cwd) return null;
  if (!Array.isArray(data.tabs)) return null;
  const tabs = [];
  for (const t of data.tabs) {
    if (!t || typeof t.file !== "string" || t.file === "") continue;
    tabs.push({ file: t.file, name: typeof t.name === "string" && t.name !== "" ? t.name : undefined });
  }
  if (tabs.length === 0) return null;
  const activeIndex =
    Number.isInteger(data.activeIndex) && data.activeIndex >= 0 && data.activeIndex < tabs.length
      ? data.activeIndex
      : 0;
  return { tabs, activeIndex };
}

/**
 * Decide how to restore a validated state against Pi's startup session.
 * `foregroundFile` is the session file Pi started with (null when it has
 * none). `exists` is injectable for tests. Returns {
 *   matched:  boolean,                 // Pi started inside a saved tab's session
 *   startup:  { name, userRenamed },   // what to rename the initial tab to
 *   open:     [{ index, file, name }], // saved tabs to open in the background
 *   activate: number | null,           // state index to activate after opening
 * }
 */
export function planRestore(state, foregroundFile, exists = (f) => existsSync(f)) {
  const matchedIndex = foregroundFile ? state.tabs.findIndex((t) => t.file === foregroundFile) : -1;
  const open = [];
  state.tabs.forEach((t, index) => {
    if (index !== matchedIndex && exists(t.file)) open.push({ index, file: t.file, name: t.name });
  });
  const startup =
    matchedIndex !== -1
      ? { name: state.tabs[matchedIndex].name ?? "Main", userRenamed: true }
      : open.length > 0
        ? { name: "new", userRenamed: false } // fresh Pi session; auto-title may adopt it
        : { name: "Main", userRenamed: true }; // nothing restorable — unchanged
  const activate =
    matchedIndex === state.activeIndex || !open.some((o) => o.index === state.activeIndex)
      ? null
      : state.activeIndex;
  return { matched: matchedIndex !== -1, startup, open, activate };
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
    this._statePath = undefined; // set by restoreTabs; remembered for saves
    this._restored = false;
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
    this._saveState();
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
      this._saveState();
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
    this._saveState();
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
    this._saveState();
  }

  renameActive(name) {
    if (!name) {
      this.mode.showStatus?.("Usage: /tabrename <name>");
      return;
    }
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    // Mark the override first so the session_info_changed that setSessionName
    // emits does not try to re-adopt a (now identical) title later.
    tab.userRenamed = true;
    try {
      tab.session.setSessionName(name);
    } catch (err) {
      this.mode.showStatus?.(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    tab.name = name;
    this.updateBar();
    this._saveState();
  }

  /** Persist the tab set for this project (best effort; never throws). */
  _saveState() {
    const path = this._statePath;
    const cwd = this.runtime.cwd;
    if (!path || !cwd) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          cwd,
          activeIndex: this.activeIndex,
          tabs: this.tabs.map((t) => ({ file: t.session?.sessionFile ?? null, name: t.name })),
        }),
      );
    } catch {
      /* restore is a convenience; persistence failures stay silent */
    }
  }

  /**
   * Restore the saved tab set for this project (full restore). Pi's startup
   * session stays a tab; saved tabs are reopened in the background and the
   * previously active tab is activated. Best effort: missing/corrupt state or
   * session files degrade to the single-tab startup and are never fatal.
   */
  async restoreTabs() {
    if (this._restored) return;
    this._restored = true;
    const cwd = this.runtime.cwd;
    const agentDir = this.runtime.services?.agentDir;
    if (!cwd || !agentDir) return;
    this._statePath = stateFilePath(agentDir, cwd);
    let raw;
    try {
      raw = readFileSync(this._statePath, "utf8");
    } catch {
      return; // no saved state — first run, nothing to restore
    }
    const state = parseTabState(raw, cwd);
    if (!state) return;
    const plan = planRestore(state, this.runtime.session?.sessionFile);
    const startup = this.tabs[0];
    if (startup) {
      startup.name = plan.startup.name;
      startup.userRenamed = plan.startup.userRenamed;
    }
    const opened = new Map(); // state index -> tab
    for (const entry of plan.open) {
      try {
        const result = await this.runtime.__piSessionTabsOpenTabSession(entry.file);
        const name = entry.name ?? result.session.sessionManager?.getSessionName?.() ?? undefined;
        opened.set(entry.index, this.addTab(result.session, { name }));
      } catch {
        /* skip unreadable session file */
      }
    }
    if (plan.activate !== null && opened.has(plan.activate)) {
      await this.activate(this.tabs.indexOf(opened.get(plan.activate)));
    }
    const restored = opened.size + (plan.matched ? 1 : 0);
    if (restored < state.tabs.length) {
      this.mode.showStatus?.(`Restored ${restored} of ${state.tabs.length} tabs (missing or unreadable session files)`);
    } else if (restored > 1) {
      this.mode.showStatus?.(`Restored ${restored} tabs from last session`);
    }
  }

  addTab(session, { name, draft = "", boundBefore = false } = {}) {
    const tab = {
      id: session.sessionId,
      name: name ?? `tab ${this.tabs.length + 1}`,
      session,
      state: session.isStreaming ? "running" : "idle",
      draft,
      // A name we were explicitly given (Main, /tabnew <name>, or a resumed
      // session's existing name) is a user override: we must not let a later
      // session_info_changed (e.g. Pi's auto-generated conversation title)
      // silently replace it. Tabs created with no name adopt the title later.
      userRenamed: name !== undefined,
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
      case "session_info_changed":
        // Pi (or /name) changed the session name. Adopt it only for tabs we
        // created without an explicit name; user-named tabs (Main, /tabnew
        // <name>, /tabrename) keep their override.
        if (!tab.userRenamed && event.name) tab.name = event.name;
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
