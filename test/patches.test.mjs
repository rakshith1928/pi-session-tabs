import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeAttachSession,
  makeCreateTabSession,
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
