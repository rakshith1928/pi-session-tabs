import { test } from "node:test";
import assert from "node:assert/strict";
import { TabManager } from "../extensions/tab-manager.mjs";
import { parseTabCommand, hasOverlay } from "../extensions/tab-manager.mjs";

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
  return {
    runtimeHost: { session },
    ui,
    editor: editor ?? { getText: () => "", setText() {} },
    defaultEditor: editor ?? { getText: () => "", setText() {} },
  };
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

test("parseTabCommand recognizes only the three tab commands", () => {
  assert.deepEqual(parseTabCommand("/tabnew"), { command: "tabnew" });
  assert.deepEqual(parseTabCommand("/tabnew my session"), { command: "tabnew", name: "my session" });
  assert.deepEqual(parseTabCommand("  /tabclose  "), { command: "tabclose" });
  assert.deepEqual(parseTabCommand("/tabrename foo"), { command: "tabrename", name: "foo" });
  assert.equal(parseTabCommand("/tabx"), null);
  assert.equal(parseTabCommand("hello"), null);
  assert.equal(parseTabCommand(""), null);
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
