import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TabManager,
  heuristicTitle,
  sanitizeTitle,
} from "../extensions/tab-manager.mjs";

// --- stubs (no real Pi, no real LLM) ---

function stubSession(id, { model, complete } = {}) {
  const listeners = [];
  const s = {
    sessionId: id,
    isStreaming: false,
    model,
    modelRuntime: complete ? { complete } : undefined,
    name: undefined,
    setSessionName(name) {
      s.name = name;
      const event = { type: "session_info_changed", name };
      for (const fn of listeners) fn(event);
    },
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
  };
  return s;
}

function stubMode(session) {
  const ed = { getText: () => "", setText() {} };
  return {
    runtimeHost: { session },
    ui: { requestRender() {} },
    editor: ed,
    defaultEditor: ed,
    showStatus() {},
  };
}

const MODEL = { id: "m1", provider: "p", api: "a" };
const settle = () => new Promise((r) => setTimeout(r, 5));
const endEvent = (userText, assistantText) => ({
  type: "agent_end",
  messages: [
    { role: "user", content: userText },
    ...(assistantText ? [{ role: "assistant", content: [{ type: "text", text: assistantText }] }] : []),
  ],
});

// --- pure: heuristicTitle ---

test("heuristicTitle: plain text is capitalized, otherwise kept", () => {
  assert.equal(heuristicTitle("fix the alt+arrow bug"), "Fix the alt+arrow bug");
});

test("heuristicTitle: strips markdown and inline code", () => {
  assert.equal(
    heuristicTitle("**Bold** first `code` question"),
    "Bold first code question",
  );
});

test("heuristicTitle: ignores fenced code, uses the first real line", () => {
  assert.equal(
    heuristicTitle("Please review:\n```\nconst x = 1;\n```\nand tell me why"),
    "Please review",
  );
});

test("heuristicTitle: long text cuts at a word boundary at 36 chars", () => {
  const out = heuristicTitle("investigate the intermittent crash in the tab manager module");
  assert.ok(out.length <= 36, `got ${out.length}: ${out}`);
  assert.ok(!out.endsWith(" "), "no dangling space");
  assert.ok(out[0] === out[0].toUpperCase(), "capitalized");
});

test("heuristicTitle: junk/empty input yields empty string", () => {
  assert.equal(heuristicTitle(""), "");
  assert.equal(heuristicTitle("!!!"), "");
});

// --- pure: sanitizeTitle ---

test("sanitizeTitle: strips quotes, newlines, trailing punctuation", () => {
  assert.equal(sanitizeTitle('"Alt+arrow\ntab bug".'), "Alt+arrow tab bug");
  assert.equal(sanitizeTitle("“Fixed the bug”"), "Fixed the bug");
});

test("sanitizeTitle: caps at 40 chars on a word boundary", () => {
  const out = sanitizeTitle(
    "a very long generated title that should definitely be truncated here",
  );
  assert.ok(out.length <= 40, `got ${out.length}: ${out}`);
  assert.ok(!out.endsWith(" "));
});

test("sanitizeTitle: empty input yields empty string", () => {
  assert.equal(sanitizeTitle(""), "");
  assert.equal(sanitizeTitle("   "), "");
});

// --- integration (stubbed modelRuntime.complete) ---

test("first agent_end titles an unnamed tab via the session model", async () => {
  const calls = [];
  const complete = async (model, context) => {
    calls.push({ model, context });
    return { role: "assistant", content: [{ type: "text", text: '"Alt+arrow tab bug".' }] };
  };
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s); // unnamed -> placeholder
  assert.equal(tab.userRenamed, false);

  m._handleSessionEvent(tab, endEvent("fix the alt+arrow bug in tab-manager", "Done, fixed."));
  await settle();

  assert.equal(calls.length, 1, "exactly one LLM call");
  assert.equal(calls[0].model, MODEL, "uses the session's current model");
  assert.match(calls[0].context.systemPrompt, /ONLY a short title/i);
  assert.match(calls[0].context.messages[0].content, /fix the alt\+arrow bug/);
  assert.equal(s.name, "Alt+arrow tab bug", "title persisted via setSessionName");
  assert.equal(tab.name, "Alt+arrow tab bug", "tab adopted the title");
  assert.equal(tab.titled, true);
});

test("LLM failure falls back to the heuristic title", async () => {
  const complete = async () => {
    throw new Error("nope");
  };
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("fix the alt+arrow bug in tab-manager"));
  await settle();

  assert.equal(tab.name, "Fix the alt+arrow bug in tab-manager");
  assert.equal(tab.titled, true);
});

test("empty LLM result falls back to the heuristic title", async () => {
  const complete = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "   " }],
  });
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("investigate the flaky tab restore test", "Looking."));
  await settle();

  assert.equal(tab.name, "Investigate the flaky tab restore");
  assert.ok(tab.name.length <= 36);
  assert.equal(tab.titled, true);
});

test("no model selected -> heuristic without calling complete", async () => {
  const complete = async () => {
    throw new Error("must not be called");
  };
  const s = stubSession("s1", { model: undefined });
  s.modelRuntime = { complete }; // present but model is what's missing
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("debug the restore flow", "On it."));
  await settle();

  assert.equal(tab.name, "Debug the restore flow");
  assert.equal(tab.titled, true);
});

test("user-renamed tab is never auto-titled", async () => {
  const calls = [];
  const complete = async (m2, c) => {
    calls.push([m2, c]);
    return { role: "assistant", content: [{ type: "text", text: "Wrong" }] };
  };
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s, { name: "Backend" });

  m._handleSessionEvent(tab, endEvent("please do a thing", "Ok."));
  await settle();

  assert.equal(calls.length, 0);
  assert.equal(tab.name, "Backend");
  assert.equal(tab.titled, false);
});

test("second agent_end never re-titles", async () => {
  const calls = [];
  const complete = async () => {
    calls.push(1);
    return { role: "assistant", content: [{ type: "text", text: "First title" }] };
  };
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("first turn message", "reply"));
  await settle();
  m._handleSessionEvent(tab, endEvent("second turn message", "reply"));
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(tab.name, "First title");
});

test("a user rename during the in-flight call wins over the LLM result", async () => {
  let release;
  const complete = () => new Promise((r) => {
    release = r;
  });
  const s = stubSession("s1", { model: MODEL, complete });
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("fix the alt+arrow bug", "Working on it."));
  tab.userRenamed = true; // user ran /tabrename while the call was in flight
  tab.name = "Pinned";
  release({ role: "assistant", content: [{ type: "text", text: "Should not apply" }] });
  await settle();

  assert.equal(tab.name, "Pinned");
  assert.equal(tab.titled, false);
  assert.equal(s.name, undefined, "setSessionName never called");
});

test("tab closed while the title call is in flight: nothing applied, no throw", async () => {
  let release;
  const complete = () => new Promise((r) => {
    release = r;
  });
  const s = stubSession("s1", { model: MODEL, complete });
  s.setSessionName = () => {
    throw new Error("session disposed");
  };
  const m = new TabManager({ mode: stubMode(s) });
  const tab = m.addTab(s);

  m._handleSessionEvent(tab, endEvent("hello world", "hi"));
  m.removeTab(tab);
  release({ role: "assistant", content: [{ type: "text", text: "Title" }] });
  await settle();

  assert.equal(tab.titled, false);
  assert.equal(tab._titleInFlight, false, "in-flight flag cleared");
});
