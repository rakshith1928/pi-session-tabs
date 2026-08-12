import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTabCommands } from "../extensions/commands.mjs";
import { getController } from "../extensions/controller.mjs";

/** Build a fake command ctx (Pi passes this to a registered command handler). */
function fakeCtx(over = {}) {
  return { mode: "tui", ui: { notify() {} }, ...over };
}

/** Capture every command registered on a mock pi extension API. */
function mockPi() {
  const registered = {};
  return { pi: { registerCommand: (name, opts) => { registered[name] = opts; } }, registered };
}

test("registerTabCommands registers the three tab commands with descriptions", () => {
  const { pi, registered } = mockPi();
  registerTabCommands(pi);
  assert.deepEqual(Object.keys(registered).sort(), ["tabclose", "tabnew", "tabrename"]);
  assert.equal(registered.tabnew.description, "Open a new session tab — give it a name or leave it blank.");
  assert.equal(registered.tabclose.description, "Close the tab you're currently on.");
  assert.equal(registered.tabrename.description, "Rename the current tab (type to match an existing name).");
  // Only /tabrename offers argument completions (existing tab names).
  assert.equal(typeof registered.tabrename.getArgumentCompletions, "function");
  assert.equal(registered.tabnew.getArgumentCompletions, undefined);
  assert.equal(registered.tabclose.getArgumentCompletions, undefined);
});

test("tab command handlers delegate to the controller's handleTabCommand", async () => {
  const c = getController();
  const calls = [];
  c.manager = {
    createTab: (n) => calls.push(["createTab", n]),
    closeActive: () => calls.push(["closeActive"]),
    renameActive: (n) => calls.push(["renameActive", n]),
    tabs: [{ name: "a" }, { name: "b" }],
  };
  const { pi, registered } = mockPi();
  registerTabCommands(pi);
  const ctx = fakeCtx();
  await registered.tabnew.handler("my new", ctx);
  await registered.tabclose.handler("", ctx);
  await registered.tabrename.handler("renamed", ctx);
  assert.deepEqual(calls, [
    ["createTab", "my new"],
    ["closeActive"],
    ["renameActive", "renamed"],
  ]);
});

test("tabrename argument completions suggest matching tab names", () => {
  const c = getController();
  c.manager = { tabs: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }] };
  const { pi, registered } = mockPi();
  registerTabCommands(pi);
  assert.deepEqual(registered.tabrename.getArgumentCompletions("al"), [
    { value: "alpha", label: "alpha", description: "session tab" },
  ]);
  assert.deepEqual(registered.tabrename.getArgumentCompletions(""), [
    { value: "alpha", label: "alpha", description: "session tab" },
    { value: "beta", label: "beta", description: "session tab" },
    { value: "gamma", label: "gamma", description: "session tab" },
  ]);
});

test("handlers warn (no crash) when not in tui mode or before manager is ready", async () => {
  const c = getController();
  c.manager = null;
  const { pi, registered } = mockPi();
  registerTabCommands(pi);
  const notifies = [];
  const ctx = fakeCtx({ mode: "rpc", ui: { notify: (m, k) => notifies.push([m, k]) } });
  await registered.tabnew.handler("x", ctx);
  assert.ok(notifies.length >= 1, "warns about non-tui mode");
});
