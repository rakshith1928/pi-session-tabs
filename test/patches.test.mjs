import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeAttachSession,
  makeCreateTabSession,
  makeBindExtensionsWrapper,
  makeDisposeWrapper,
  installPatches,
} from "../extensions/patches.mjs";

test("makeAttachSession swaps _session and runs finishSessionReplacement without teardown", async () => {
  const calls = [];
  const A = { id: "A" };
  const B = { id: "B" };
  const stub = {
    _session: A,
    async finishSessionReplacement() {
      calls.push("finish:" + this._session.id);
    },
  };
  const attach = makeAttachSession();
  await attach.call(stub, B);
  assert.equal(stub._session, B);
  assert.deepEqual(calls, ["finish:B"]);
  // no-op when already current
  await attach.call(stub, B);
  assert.deepEqual(calls, ["finish:B"]);
});

test("makeCreateTabSession uses createRuntime with a fresh SessionManager", async () => {
  const fakeSM = { create: () => ({ fake: "sm" }) };
  const stub = {
    cwd: "/proj",
    services: { agentDir: "/agent" },
    async createRuntime(opts) {
      assert.equal(opts.cwd, "/proj");
      assert.equal(opts.agentDir, "/agent");
      assert.equal(opts.sessionManager.fake, "sm");
      return { session: { id: "new" }, services: {}, diagnostics: [] };
    },
  };
  const create = makeCreateTabSession(fakeSM);
  const result = await create.call(stub);
  assert.equal(result.session.id, "new");
});

test("installPatches attaches and restores namespaced methods on a stub runtime class", () => {
  class FakeRuntime {
    constructor() {
      this._session = null;
    }
    async finishSessionReplacement() {}
  }
  const FakeSM = { create: () => ({}) };
  const { restore } = installPatches({
    AgentSessionRuntime: FakeRuntime,
    AgentSession: class {},
    InteractiveMode: class {},
    SessionManager: FakeSM,
    hooks: {},
  });
  assert.equal(typeof FakeRuntime.prototype.__piSessionTabsAttachSession, "function");
  assert.equal(typeof FakeRuntime.prototype.__piSessionTabsCreateTabSession, "function");
  restore();
  assert.equal(FakeRuntime.prototype.__piSessionTabsAttachSession, undefined);
  assert.equal(FakeRuntime.prototype.__piSessionTabsCreateTabSession, undefined);
});

test("installPatches restore() reinstates pre-existing prototype members", () => {
  const originalDispose = function dispose() {
    return "original";
  };
  class FakeSession {}
  FakeSession.prototype.dispose = originalDispose;
  const FakeRuntime = class {};
  const FakeSM = { create: () => ({}) };
  const { restore } = installPatches({
    AgentSessionRuntime: FakeRuntime,
    AgentSession: FakeSession,
    InteractiveMode: class {},
    SessionManager: FakeSM,
    hooks: {},
  });
  assert.notEqual(FakeSession.prototype.dispose, originalDispose, "wrapped during install");
  assert.equal(typeof FakeSession.prototype.bindExtensions, "function", "new member added during install");
  restore();
  assert.equal(FakeSession.prototype.dispose, originalDispose, "pre-existing member reinstated");
  assert.equal(FakeSession.prototype.bindExtensions, undefined, "new member deleted by restore");
});

test("bindExtensions wrapper emits startup once, suppresses on re-attach", async () => {
  const emits = [];
  const runner = {
    setUIContext(ui, mode) {
      emits.push("setUI:" + (ui?.tag ?? "") + ":" + mode);
    },
    bindCommandContext(actions) {
      emits.push("bindCmd:" + (actions ? "set" : "none"));
    },
    onError(fn) {
      emits.push("onErr:" + (fn ? "set" : "none"));
    },
    emit(evt) {
      emits.push("emit:" + (evt?.type ?? "none"));
    },
  };
  const session = {
    _extensionRunner: runner,
    _sessionStartEvent: { type: "session_start", reason: "startup" },
    async _applyExtensionBindings(r) {
      r.setUIContext(this._extensionUIContext, this._extensionMode);
      r.bindCommandContext(this._extensionCommandContextActions);
    },
    async extendResourcesFromExtensions() {
      emits.push("resources");
    },
  };
  const orig = async function (bindings) {
    if (bindings.uiContext !== undefined) this._extensionUIContext = bindings.uiContext;
    if (bindings.mode !== undefined) this._extensionMode = bindings.mode;
    if (bindings.commandContextActions !== undefined) this._extensionCommandContextActions = bindings.commandContextActions;
    if (bindings.onError !== undefined) this._extensionErrorListener = bindings.onError;
    await this._applyExtensionBindings(this._extensionRunner);
    await this._extensionRunner.emit(this._sessionStartEvent);
    await this.extendResourcesFromExtensions("startup");
  };
  const bound = [];
  const wrap = makeBindExtensionsWrapper(orig, { onBindExtensions: (s, first) => bound.push(first) });
  const bindings = { uiContext: { tag: "A" }, mode: "tui", commandContextActions: { x: 1 }, onError: () => {} };
  await wrap.call(session, bindings); // first
  await wrap.call(session, { uiContext: { tag: "B" }, mode: "tui", commandContextActions: { y: 2 } }); // re-attach
  assert.deepEqual(bound, [true, false]);
  assert.ok(emits.includes("emit:session_start"));
  assert.equal(emits.filter((e) => e === "emit:session_start").length, 1, "startup emitted once");
  assert.equal(emits.filter((e) => e === "resources").length, 1, "resources discovered once");
  assert.ok(emits.includes("setUI:B:tui"), "re-attach rebinds uiContext");
  assert.ok(emits.includes("bindCmd:set"), "re-attach rebinds command context");
});

test("dispose wrapper dispatches onSessionDisposed after original", () => {
  const disposed = [];
  const session = { disposed: false };
  const orig = function () {
    this.disposed = true;
  };
  const wrap = makeDisposeWrapper(orig, { onSessionDisposed: (s) => disposed.push(s.id) });
  wrap.call({ ...session, id: "s1" });
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0], "s1");
});
