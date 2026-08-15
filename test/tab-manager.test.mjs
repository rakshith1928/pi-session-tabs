import { test } from "node:test";
import assert from "node:assert/strict";
import { TabManager } from "../extensions/tab-manager.mjs";
import { parseTabCommand, hasOverlay, altTabDirection, plainArrowDirection, makeAltArrowListener } from "../extensions/tab-manager.mjs";

function stubSession(id, { isStreaming = false } = {}) {
  const listeners = [];
  return {
    sessionId: id,
    isStreaming,
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    _emit(evt) {
      for (const fn of [...listeners]) fn(evt);
    },
  };
}

function stubMode(session, { editor } = {}) {
  const ui = { requestRender() {} };
  // A single editor object so mode.editor === mode.defaultEditor (as in a real
  // idle Pi session), otherwise hasOverlay() would gate the Alt+arrow listener.
  const ed = editor ?? { getText: () => "", setText() {} };
  return {
    runtimeHost: { session },
    ui,
    editor: ed,
    defaultEditor: ed,
  };
}

function makeManagerWithTabs(n) {
  const sessions = [];
  for (let i = 0; i < n; i++) sessions.push(stubSession("s" + i, { isStreaming: false }));
  const runtime = {
    session: sessions[0],
    async __piSessionTabsAttachSession(s) { this.session = s; },
  };
  const ed = { getText: () => "", setText() {} };
  const mode = { runtimeHost: runtime, ui: { requestRender() {} }, editor: ed, defaultEditor: ed, showStatus() {} };
  const m = new TabManager({ mode });
  for (let i = 0; i < n; i++) m.addTab(sessions[i], { name: "t" + i, boundBefore: i === 0 });
  if (n > 0) m.activeIndex = 0;
  return m;
}

test("addTab registers session with initial state from isStreaming", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", draft: "hi", boundBefore: true });
  assert.equal(m.tabs.length, 1);
  assert.equal(m.tabs[0].name, "one");
  assert.equal(m.tabs[0].draft, "hi");
  assert.equal(m.tabs[0].state, "idle");
  assert.equal(m.activeIndex, 0);
  assert.equal(m.isForeground("s1"), true);
  assert.equal(m.isForeground("other"), false);
  assert.equal(m.hasBoundBefore(mode.runtimeHost.session), true);
});

test("state machine: running on agent_start, needs_attention on error message_end, idle on settle", () => {
  const s = stubSession("s1");
  const mode = stubMode(s);
  const m = new TabManager({ mode });
  m.addTab(s, { name: "one" });
  const tab = m.tabs[0];
  s._emit({ type: "agent_start" });
  assert.equal(tab.state, "running");
  s._emit({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  assert.equal(tab.state, "needs_attention");
  s._emit({ type: "agent_settled" });
  assert.equal(tab.state, "needs_attention", "settle keeps attention");
  s._emit({ type: "agent_start" });
  assert.equal(tab.state, "running", "next turn clears attention");
  s._emit({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } });
  assert.equal(tab.state, "running");
  s._emit({ type: "agent_settled" });
  assert.equal(tab.state, "idle");
});

test("removeTab unsubscribes and updates activeIndex bounds", () => {
  const s1 = stubSession("s1");
  const s2 = stubSession("s2");
  const mode = stubMode(s1);
  const m = new TabManager({ mode });
  m.addTab(s1, { name: "a" });
  m.addTab(s2, { name: "b" });
  m.activeIndex = 1;
  m.removeTab(m.tabs[1]);
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
});

test("removeTab preserves the active tab when removing a preceding tab", () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const sC = stubSession("C");
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  const tabA = m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  const tabC = m.addTab(sC, { name: "c" });
  m.activeIndex = 2;
  m.removeTab(tabA);
  assert.equal(m.activeIndex, 1);
  assert.equal(m.tabs[m.activeIndex], tabC);
});

test("parseTabCommand recognizes only the three tab commands", () => {
  assert.deepEqual(parseTabCommand("/tabnew"), { command: "tabnew" });
  assert.deepEqual(parseTabCommand("/tabnew my session"), { command: "tabnew", name: "my session" });
  assert.deepEqual(parseTabCommand("  /tabclose  "), { command: "tabclose" });
  assert.deepEqual(parseTabCommand("/tabrename foo"), { command: "tabrename", name: "foo" });
  assert.equal(parseTabCommand("/tabx"), null);
  assert.equal(parseTabCommand("hello"), null);
  assert.equal(parseTabCommand(""), null);
});

test("Alt navigation recognizes only Alt-left/right escape sequences", () => {
  // xterm modifier = 1 + 2*shift + 4*alt + ...; Alt sets the value-4 bit.
  assert.equal(altTabDirection("\x1b[1;5D"), -1, "Alt+Left");
  assert.equal(altTabDirection("\x1b[1;5C"), 1, "Alt+Right");
  assert.equal(altTabDirection("\x1b[1;7C"), 1, "Alt+Shift+Right");
  assert.equal(altTabDirection("\x1b[1;13D"), -1, "Alt+Ctrl+Left");
  // Kitty event-type suffix (press/repeat/release) is still matched.
  assert.equal(altTabDirection("\x1b[1;5:1C"), 1);
  // Shift-only (value 3) is NOT Alt and must be ignored.
  assert.equal(altTabDirection("\x1b[1;3C"), 0, "Shift+Right is not Alt");
  assert.equal(altTabDirection("\x1bb"), 0, "Alt-b remains editor word motion");
  assert.equal(altTabDirection("\x1bf"), 0, "Alt-f remains editor word motion");
  assert.equal(altTabDirection("\x1b[A"), 0);
});

test("plainArrowDirection maps bare arrows to directions", () => {
  assert.equal(plainArrowDirection("\x1b[D"), -1);
  assert.equal(plainArrowDirection("\x1b[C"), 1);
  assert.equal(plainArrowDirection("\x1bOD"), -1, "application mode");
  assert.equal(plainArrowDirection("\x1bOC"), 1, "application mode");
  assert.equal(plainArrowDirection("\x1b[A"), 0);
  assert.equal(plainArrowDirection("a"), 0);
});

test("alt arrow listener switches tabs on Kitty/modifyOtherKeys sequence", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", boundBefore: true });
  m.addTab(stubSession("s2"), { name: "two", boundBefore: true });
  assert.equal(m.tabs.length, 2);
  let consumed = null;
  const listener = makeAltArrowListener(mode, m);
  // Stub cycle so we observe intent without touching real switching.
  let cycled = null;
  m.cycle = async (dir) => { cycled = dir; };
  consumed = listener("\x1b[1;5C");
  assert.equal(cycled, 1);
  assert.deepEqual(consumed, { consume: true });
  cycled = null;
  consumed = listener("\x1b[1;5D");
  assert.equal(cycled, -1);
  assert.deepEqual(consumed, { consume: true });
});

test("alt arrow listener handles ESC-prefixed Alt+arrow fallback", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", boundBefore: true });
  m.addTab(stubSession("s2"), { name: "two", boundBefore: true });
  let cycled = null;
  m.cycle = async (dir) => { cycled = dir; };
  const listener = makeAltArrowListener(mode, m);
  // First sequence is a lone ESC (let through), second is the plain arrow.
  assert.equal(listener("\x1b"), undefined, "lone ESC passes through");
  const consumed = listener("\x1b[C");
  assert.equal(cycled, 1, "Alt+Right via ESC-prefixed fallback");
  assert.deepEqual(consumed, { consume: true });
  // A lone ESC not followed by an arrow does not switch.
  cycled = null;
  assert.equal(listener("\x1b"), undefined);
  assert.equal(listener("a"), undefined);
  assert.equal(cycled, null);
});

test("alt arrow listener passes through when only one tab exists", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", boundBefore: true });
  let cycled = null;
  m.cycle = async (dir) => { cycled = dir; };
  const listener = makeAltArrowListener(mode, m);
  assert.equal(listener("\x1b[1;5C"), undefined, "not consumed with a single tab");
  assert.equal(cycled, null, "cycle not called");
});

test("alt arrow listener passes the ESC-prefixed fallback through with one tab", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", boundBefore: true });
  let cycled = null;
  m.cycle = async (dir) => { cycled = dir; };
  const listener = makeAltArrowListener(mode, m);
  assert.equal(listener("\x1b"), undefined, "lone ESC passes through");
  assert.equal(listener("\x1b[C"), undefined, "fallback arrow not consumed");
  assert.equal(cycled, null, "cycle not called");
});

test("alt arrow listener consumes again once a second tab exists", () => {
  const mode = stubMode(stubSession("s1"));
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "one", boundBefore: true });
  let cycled = null;
  m.cycle = async (dir) => { cycled = dir; };
  const listener = makeAltArrowListener(mode, m);
  m.addTab(stubSession("s2"), { name: "two", boundBefore: true });
  const consumed = listener("\x1b[1;5C");
  assert.equal(cycled, 1, "cycle fires once a second tab exists");
  assert.deepEqual(consumed, { consume: true });
});

test("hasOverlay detects open overlays and custom editors", () => {
  const base = { editor: "editor", defaultEditor: "editor" };
  assert.equal(hasOverlay(base), false);
  assert.equal(hasOverlay({ ...base, extensionSelector: {} }), true);
  assert.equal(hasOverlay({ ...base, extensionInput: {} }), true);
  assert.equal(hasOverlay({ ...base, extensionEditor: {} }), true);
  assert.equal(hasOverlay({ ...base, activeSelectorToken: {} }), true);
  assert.equal(hasOverlay({ ...base, editor: "custom" }), true);
});

test("activate swaps via namespaced attach, saves/restores drafts, serializes", async () => {
  const events = [];
  const sA = stubSession("A");
  const sB = stubSession("B");
  const runtime = {
    session: sA,
    async __piSessionTabsAttachSession(s) {
      events.push("attach:" + s.sessionId);
      this.session = s;
    },
  };
  const editor = { text: "draft-a", getText() { return this.text; }, setText(t) { this.text = t; } };
  const mode = { runtimeHost: runtime, ui: { requestRender() {} }, editor, defaultEditor: editor };
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a", draft: "draft-a" });
  m.addTab(sB, { name: "b", draft: "" });
  await m.activate(1);
  assert.deepEqual(events, ["attach:B"]);
  assert.equal(runtime.session, sB);
  assert.equal(m.activeIndex, 1);
  assert.equal(m.tabs[0].draft, "draft-a", "outgoing draft saved");
  assert.equal(editor.text, "", "incoming empty draft restored");
  m.tabs[1].draft = "draft-b";
  editor.text = "draft-b";
  await m.activate(0);
  assert.equal(editor.text, "draft-a", "previous draft restored");
  assert.equal(m.tabs[1].draft, "draft-b", "outgoing draft saved on switch back");
});

test("createTab creates a session via runtime.createTabSession and activates it", async () => {
  const sA = stubSession("A");
  const sNew = stubSession("N");
  const runtime = {
    session: sA,
    async __piSessionTabsCreateTabSession() {
      return { session: sNew };
    },
    async __piSessionTabsAttachSession(s) {
      this.session = s;
    },
  };
  const editor = { text: "", getText() { return this.text; }, setText(t) { this.text = t; } };
  const mode = { runtimeHost: runtime, ui: { requestRender() {} }, editor, defaultEditor: editor };
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  await m.createTab("work");
  assert.equal(m.tabs.length, 2);
  assert.equal(m.tabs[1].name, "work");
  assert.equal(m.activeIndex, 1);
});

test("cycle wraps around; closeActive refuses last tab and closes with neighbor activation", async () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const disposed = [];
  const runtime = {
    session: sA,
    async __piSessionTabsAttachSession(s) {
      this.session = s;
    },
  };
  const mode = {
    runtimeHost: runtime,
    ui: { requestRender() {} },
    editor: { getText: () => "", setText() {} },
    defaultEditor: { getText: () => "", setText() {} },
    showStatus(msg) { this._status = msg; },
  };
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  sB.dispose = () => disposed.push("B");
  m.tabs[1].unsubscribe = () => {};
  await m.cycle(+1);
  assert.equal(m.activeIndex, 1);
  await m.cycle(+1);
  assert.equal(m.activeIndex, 0, "wraps");
  await m.activate(1);
  await m.closeActive();
  assert.deepEqual(disposed, ["B"]);
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
  assert.equal(runtime.session, sA);
  await m.closeActive();
  assert.equal(mode._status, "Cannot close the last tab");
});

test("closeActive preserves the closing tab when neighbor activation fails", async () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  let disposed = false;
  sA.dispose = () => { disposed = true; };
  const runtime = {
    session: sA,
    async __piSessionTabsAttachSession(session) {
      if (session === sB) throw new Error("attach failed");
      this.session = session;
    },
  };
  const mode = {
    runtimeHost: runtime,
    ui: { requestRender() {} },
    editor: { getText: () => "", setText() {} },
    defaultEditor: { getText: () => "", setText() {} },
  };
  const m = new TabManager({ mode });
  const closing = m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  const tabsBefore = [...m.tabs];
  await m.closeActive();
  assert.equal(disposed, false, "closing session is not disposed");
  assert.deepEqual(m.tabs, tabsBefore, "registry is unchanged");
  assert.equal(m.activeIndex, 0);
  assert.equal(runtime.session, closing.session);
});

test("renameActive persists via setSessionName and updates label", () => {
  const sA = stubSession("A");
  sA.setSessionName = (n) => { sA._name = n; };
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.renameActive("renamed");
  assert.equal(sA._name, "renamed");
  assert.equal(m.tabs[0].name, "renamed");
  m.renameActive("");
  assert.equal(mode._status, undefined, "no-op without a name");
});

test("session_info_changed adopts Pi's generated title for an unnamed tab", () => {
  const s = stubSession("s1");
  const mode = stubMode(s);
  const m = new TabManager({ mode });
  const tab = m.addTab(s, {}); // no name → adopt later
  assert.equal(tab.name, "tab 1");
  assert.equal(tab.userRenamed, false);
  s._emit({ type: "session_info_changed", name: "Research" });
  assert.equal(tab.name, "Research", "adopts generated title");
  assert.equal(m.tabs[m.activeIndex].name, "Research", "bar updated");
});

test("session_info_changed is ignored for a user-named tab", () => {
  const s = stubSession("s1");
  const mode = stubMode(s);
  const m = new TabManager({ mode });
  const tab = m.addTab(s, { name: "Backend" });
  assert.equal(tab.userRenamed, true);
  s._emit({ type: "session_info_changed", name: "WrongTitle" });
  assert.equal(tab.name, "Backend", "override preserved");
});

test("renameActive override survives a later session_info_changed", () => {
  const s = stubSession("s1");
  s.setSessionName = () => {};
  const mode = stubMode(s);
  const m = new TabManager({ mode });
  const tab = m.addTab(s, {}); // adopt-later
  m.renameActive("Pinned");
  assert.equal(tab.userRenamed, true);
  assert.equal(tab.name, "Pinned");
  s._emit({ type: "session_info_changed", name: "AutoTitle" });
  assert.equal(tab.name, "Pinned", "override wins over auto title");
});

test("onForegroundChanged registers runtime replacements as new tabs", () => {
  const sA = stubSession("A");
  const sR = stubSession("R"); // replacement from /new, /resume, /fork, /reload
  sR.sessionManager = { getSessionName: () => "replaced" };
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a", draft: "draft-a" });
  m.onForegroundChanged(sA, sR);
  assert.equal(m.tabs.length, 2);
  assert.equal(m.tabs[1].name, "replaced");
  assert.equal(m.activeIndex, 1);
});

test("onSessionDisposed removes the tab", () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  m.activeIndex = 1;
  m.onSessionDisposed(sB);
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
  assert.equal(m.tabs[0].session, sA);
});

test("shutdown disposes background tabs and silences updates", () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const disposed = [];
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  sB.dispose = () => disposed.push("B");
  m.shutdown();
  assert.deepEqual(disposed, ["B"], "background disposed, active kept (runtime disposes it)");
  assert.equal(m.shuttingDown, true);
  const bar = { update: () => { throw new Error("should not update after shutdown"); } };
  m.setBar(bar);
  m.updateBar(); // must no-op via shuttingDown guard
});

test("closeTab(nonActive) removes that tab and keeps the foreground", () => {
  const mgr = makeManagerWithTabs(3);
  const prevActive = mgr.activeIndex;
  mgr.closeTab((mgr.activeIndex + 1) % mgr.tabs.length);
  assert.equal(mgr.tabs.length, 2);
  assert.equal(mgr.activeIndex, prevActive, "foreground unchanged");
});

test("closeTab(active) behaves like closeActive", async () => {
  const mgr = makeManagerWithTabs(3);
  await mgr.closeTab(mgr.activeIndex);
  assert.equal(mgr.tabs.length, 2);
});

test("closeTab refuses when only one tab remains", () => {
  const mgr = makeManagerWithTabs(1);
  mgr.closeTab(0);
  assert.equal(mgr.tabs.length, 1);
});
