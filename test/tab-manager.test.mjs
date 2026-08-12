import { test } from "node:test";
import assert from "node:assert/strict";
import { TabManager } from "../extensions/tab-manager.mjs";

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
