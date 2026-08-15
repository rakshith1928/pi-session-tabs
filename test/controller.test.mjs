import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROLLER_KEY,
  SessionTabsController,
  getController,
  ensurePatched,
  makeHooks,
  checkVersion,
} from "../extensions/controller.mjs";
import { TabManager, handleTabCommand } from "../extensions/tab-manager.mjs";

function fakeMode({ sessionId = "s0" } = {}) {
  const session = {
    sessionId,
    isStreaming: false,
    subscribe: () => () => {},
  };
  const editor = {
    text: "",
    getText() { return this.text; },
    setText(t) { this.text = t; },
    onSubmit: async () => {},
  };
  return {
    runtimeHost: { session, cwd: "/proj" },
    ui: {
      requestRender() {},
      addInputListener(fn) { this._listener = fn; return () => { this._listener = undefined; }; },
    },
    editor,
    defaultEditor: editor,
    documentContainer: { children: [] },
    createExtensionUIContext: () => ({ theme: { fg: (c, s) => s } }),
    showStatus() {},
  };
}

test("getController returns a singleton per realm", () => {
  delete globalThis[CONTROLLER_KEY];
  const a = getController();
  const b = getController();
  assert.equal(a, b);
  assert.ok(a instanceof SessionTabsController);
  assert.equal(a.patched, false);
  delete globalThis[CONTROLLER_KEY];
});

test("ensurePatched is idempotent across reload-style re-imports", async () => {
  delete globalThis[CONTROLLER_KEY];
  let patchRuns = 0;
  const classes = {
    AgentSessionRuntime: class {},
    AgentSession: class {},
    InteractiveMode: class {},
    SessionManager: {},
  };
  const c1 = ensurePatched(classes, { install: () => patchRuns++ });
  assert.equal(c1.patched, true);
  assert.equal(patchRuns, 1);
  const c2 = ensurePatched(classes, { install: () => patchRuns++ });
  assert.equal(c2, c1);
  assert.equal(patchRuns, 1, "second ensurePatched must not re-patch");
  delete globalThis[CONTROLLER_KEY];
});

test("makeHooks routes through the controller", () => {
  const c = new SessionTabsController();
  const hooks = makeHooks(c);
  assert.equal(typeof hooks.onModeReady, "function");
  assert.equal(typeof hooks.onForegroundChanged, "function");
  assert.equal(typeof hooks.onSessionDisposed, "function");
  assert.equal(typeof hooks.onShutdown, "function");
  assert.equal(hooks.isForeground("x"), true, "no manager → everything is foreground");
  c.manager = {
    isForeground: (id) => id === "s1",
    onForegroundChanged() {},
    onSessionDisposed() {},
    shutdown() {},
  };
  assert.equal(hooks.isForeground("s1"), true);
  assert.equal(hooks.isForeground("other"), false);
});

test("checkVersion warns on mismatch, silent on match or failure", async () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  await checkVersion({
    warn,
    resolve: async () => "file:///x/dist/index.js",
    read: async () => '{"version":"0.84.1"}',
  });
  assert.equal(warnings.length, 0);
  await checkVersion({
    warn,
    resolve: async () => "file:///x/dist/index.js",
    read: async () => '{"version":"9.9.9"}',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("9.9.9"));
  await checkVersion({ warn, resolve: async () => { throw new Error("unresolvable"); } });
  assert.equal(warnings.length, 1, "failure is silent (guards are the real safety)");
});

test("ensureManager wires a stub mode once (bar, submit wrap, alt listener, initial tab)", () => {
  delete globalThis[CONTROLLER_KEY];
  const c = getController();
  c.tui = {
    Container: class {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    },
    HStack: class {
      constructor() { this.children = []; }
      addChild(child) { this.children.push({ c: child }); }
      clear() { this.children = []; }
      render() { return [""]; }
      invalidate() {}
    },
  };
  class FakeInteractiveMode {}
  c.InteractiveMode = FakeInteractiveMode;
  const mode = fakeMode();
  Object.setPrototypeOf(mode, FakeInteractiveMode.prototype);
  const m1 = c.ensureManager(mode);
  assert.ok(m1 instanceof TabManager);
  assert.equal(m1, c.manager);
  assert.equal(mode.__tabManager, m1);
  assert.equal(m1.tabs.length, 1);
  assert.equal(m1.tabs[0].name, "Main");
  assert.equal(mode.documentContainer.children.length, 0, "strip hidden while a single tab exists (normal Pi look)");
  assert.equal(typeof mode.defaultEditor.onSubmit, "function", "submit handler present (commands now dispatched via Pi slash-command registry)");
  assert.equal(typeof mode.ui._listener, "function", "alt listener registered");
  const m2 = c.ensureManager(mode);
  assert.equal(m2, m1, "idempotent for the same mode");
  delete globalThis[CONTROLLER_KEY];
});

test("ensureManager skips non-TUI modes and foreign InteractiveMode instances", () => {
  delete globalThis[CONTROLLER_KEY];
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    const c = getController();
    c.tui = { Container: class {}, HStack: class {} };
    c.InteractiveMode = class {};
    assert.equal(c.ensureManager({}), null, "no TUI wiring → skip");
    assert.equal(c.ensureManager({ documentContainer: { children: [] }, defaultEditor: {}, ui: {} }), null);
    const mode = fakeMode();
    assert.equal(c.ensureManager(mode), null, "foreign InteractiveMode → skip");
    assert.ok(warns.length >= 1);
  } finally {
    console.warn = origWarn;
    delete globalThis[CONTROLLER_KEY];
  }
});

test("handleTabCommand routes through the controller to the manager", async () => {
  delete globalThis[CONTROLLER_KEY];
  const c = getController();
  const calls = [];
  c.manager = {
    createTab: async (n) => calls.push(["create", n]),
    closeActive: async () => calls.push(["close"]),
    renameActive: (n) => calls.push(["rename", n]),
  };
  await c.handleTabCommand({ command: "tabnew", name: "x" });
  await c.handleTabCommand({ command: "tabclose" });
  await c.handleTabCommand({ command: "tabrename", name: "y" });
  assert.deepEqual(calls, [["create", "x"], ["close"], ["rename", "y"]]);
  delete globalThis[CONTROLLER_KEY];
});
