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
