import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TabManager,
  parseTabState,
  planRestore,
  stateFilePath,
} from "../extensions/tab-manager.mjs";
import { makeOpenTabSession } from "../extensions/patches.mjs";

// --- stubs (mirroring test/tab-manager.test.mjs conventions) ---

function stubSession(id, { isStreaming = false, sessionFile, sessionManager } = {}) {
  const listeners = [];
  return {
    sessionId: id,
    sessionFile,
    isStreaming,
    sessionManager: sessionManager ?? { getSessionName: () => undefined },
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
  };
}

/**
 * Build a manager with a real tmp cwd + agentDir and (optionally) a state
 * file on disk. `saved` is [{ name, exists? }] describing the state's tabs in
 * order; `foreground` is "fresh" or an index into `saved` meaning Pi started
 * inside that saved session's file. `fresh` (default: true) controls whether
 * the startup session has real content; `foregroundName` is its persisted
 * session name, if any.
 */
function makeRestoreManager({ agentDir, saved, foreground = "fresh", activeIndex = 0, fresh = true, foregroundName } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pst-cwd-"));
  const statePath = stateFilePath(agentDir, cwd);
  mkdirSync(dirname(statePath), { recursive: true });

  const openFiles = {};
  const savedTabs = (saved ?? []).map((t, i) => {
    const file = join(cwd, `s${i}.jsonl`);
    if (t.exists !== false) writeFileSync(file, "{}");
    openFiles[file] = stubSession("s" + i, { sessionFile: file });
    return { file, name: t.name };
  });

  let fgFile;
  if (typeof foreground === "number" && savedTabs[foreground]) {
    fgFile = savedTabs[foreground].file;
  } else {
    fgFile = join(cwd, "fg.jsonl");
    writeFileSync(fgFile, "{}");
  }
  const fg = stubSession("fg", {
    sessionFile: fgFile,
    sessionManager: {
      getSessionName: () => foregroundName,
      getEntries: () => (fresh ? [] : [{ type: "message", id: "m1" }]),
    },
  });

  if (saved) {
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, cwd, activeIndex, tabs: savedTabs }),
    );
  }

  const statuses = [];
  const openCalls = [];
  const runtime = {
    session: fg,
    cwd,
    services: { agentDir },
    async __piSessionTabsAttachSession(s) {
      this.session = s;
    },
    async __piSessionTabsOpenTabSession(file) {
      openCalls.push(file);
      const session = openFiles[file];
      if (!session) throw new Error("open failed: " + file);
      return { session };
    },
    async __piSessionTabsCreateTabSession() {
      const file = join(cwd, "created.jsonl");
      writeFileSync(file, "{}");
      return { session: stubSession("created", { sessionFile: file }) };
    },
  };
  const ed = { getText: () => "", setText() {} };
  const mode = {
    runtimeHost: runtime,
    ui: { requestRender() {} },
    editor: ed,
    defaultEditor: ed,
    showStatus(msg) {
      statuses.push(msg);
    },
  };
  const m = new TabManager({ mode });
  m.addTab(fg, { name: "Main", boundBefore: true });
  return { m, runtime, fg, openCalls, statuses, cwd, savedTabs, statePath };
}

// --- pure: stateFilePath ---

test("stateFilePath is stable per cwd and distinct across cwds", () => {
  assert.equal(stateFilePath("/agent", "/proj"), stateFilePath("/agent", "/proj"));
  assert.notEqual(stateFilePath("/agent", "/proj"), stateFilePath("/agent", "/other"));
  assert.ok(stateFilePath("/agent", "/proj").endsWith(".json"));
});

// --- pure: parseTabState ---

test("parseTabState accepts a valid payload", () => {
  const out = parseTabState(
    JSON.stringify({
      version: 1,
      cwd: "/p",
      activeIndex: 1,
      tabs: [{ file: "/a", name: "A" }, { file: "/b" }],
    }),
    "/p",
  );
  assert.deepEqual(out, { tabs: [{ file: "/a", name: "A" }, { file: "/b", name: undefined }], activeIndex: 1 });
});

test("parseTabState rejects bad json, wrong version, cwd mismatch, and no valid entries", () => {
  assert.equal(parseTabState("{nope", "/p"), null);
  assert.equal(parseTabState(JSON.stringify({ version: 2, cwd: "/p", tabs: [{ file: "/a" }] }), "/p"), null);
  assert.equal(parseTabState(JSON.stringify({ version: 1, cwd: "/other", tabs: [{ file: "/a" }] }), "/p"), null);
  assert.equal(parseTabState(JSON.stringify({ version: 1, cwd: "/p", tabs: [] }), "/p"), null);
  assert.equal(parseTabState(JSON.stringify({ version: 1, cwd: "/p", tabs: [{ name: "no file" }] }), "/p"), null);
});

test("parseTabState clamps out-of-range activeIndex to 0", () => {
  const out = parseTabState(
    JSON.stringify({ version: 1, cwd: "/p", activeIndex: 9, tabs: [{ file: "/a" }] }),
    "/p",
  );
  assert.equal(out.activeIndex, 0);
});

// --- pure: planRestore ---

const allExist = () => true;

test("planRestore: fresh startup, all tabs background -> startup 'new', opens all, activates saved active", () => {
  const state = {
    tabs: [{ file: "/a", name: "Main" }, { file: "/b", name: "Research" }, { file: "/c", name: "review" }],
    activeIndex: 1,
  };
  const plan = planRestore(state, null, { exists: allExist, fresh: true });
  assert.equal(plan.matched, false);
  assert.deepEqual(plan.startup, { name: "new", userRenamed: false });
  assert.deepEqual(plan.open.map((o) => o.index), [0, 1, 2]);
  assert.equal(plan.activate, 1);
});

test("planRestore: foreground matches saved active tab -> rename, no open of it, no switch", () => {
  const state = { tabs: [{ file: "/a", name: "Main" }, { file: "/b", name: "Research" }], activeIndex: 1 };
  const plan = planRestore(state, "/b", { exists: allExist });
  assert.equal(plan.matched, true);
  assert.deepEqual(plan.startup, { name: "Research", userRenamed: true });
  assert.deepEqual(plan.open.map((o) => o.index), [0]);
  assert.equal(plan.activate, null);
});

test("planRestore: foreground matches an inactive tab -> stays there (explicit pick wins over saved active)", () => {
  const state = { tabs: [{ file: "/a", name: "Main" }, { file: "/b", name: "Research" }], activeIndex: 0 };
  const plan = planRestore(state, "/b", { exists: allExist, fresh: false });
  assert.deepEqual(plan.startup, { name: "Research", userRenamed: true });
  assert.deepEqual(plan.open.map((o) => o.index), [0]);
  assert.equal(plan.activate, null, "no auto-activation away from the explicitly resumed tab");
});

test("planRestore: external existing session (pi resume <other>) -> no auto-activation, adopts its name", () => {
  const state = { tabs: [{ file: "/a", name: "Main" }, { file: "/b", name: "Research" }], activeIndex: 0 };
  const plan = planRestore(state, "/x", { exists: allExist, fresh: false, name: "Old Work" });
  assert.equal(plan.matched, false);
  assert.deepEqual(plan.startup, { name: "Old Work", userRenamed: true });
  assert.deepEqual(plan.open.map((o) => o.index), [0, 1]);
  assert.equal(plan.activate, null, "the session the user named stays up front");
});

test("planRestore: external existing session without a name -> 'new' placeholder, adoption enabled", () => {
  const state = { tabs: [{ file: "/a", name: "Main" }], activeIndex: 0 };
  const plan = planRestore(state, "/x", { exists: allExist, fresh: false });
  assert.deepEqual(plan.startup, { name: "new", userRenamed: false });
  assert.equal(plan.activate, null);
});

test("planRestore: fresh startup with a --name flag name keeps that name", () => {
  const state = { tabs: [{ file: "/a", name: "Main" }, { file: "/b", name: "Research" }], activeIndex: 1 };
  const plan = planRestore(state, null, { exists: allExist, fresh: true, name: "Flagged" });
  assert.deepEqual(plan.startup, { name: "Flagged", userRenamed: true });
  assert.equal(plan.activate, 1, "fresh start still resumes where you left off");
});

test("planRestore: missing files are skipped; nothing restorable keeps 'Main'", () => {
  const state = { tabs: [{ file: "/gone", name: "Gone" }], activeIndex: 0 };
  const plan = planRestore(state, null, { exists: () => false });
  assert.equal(plan.matched, false);
  assert.deepEqual(plan.startup, { name: "Main", userRenamed: true });
  assert.deepEqual(plan.open, []);
  assert.equal(plan.activate, null);
});

// --- restoreTabs integration (fake runtime; no real Pi) ---

test("restoreTabs: no state file -> single Main tab, nothing opened", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, openCalls } = makeRestoreManager({ agentDir, saved: null });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 1);
  assert.equal(m.tabs[0].name, "Main");
  assert.deepEqual(openCalls, []);
});

test("restoreTabs: foreground matched -> other tabs open in background, no switch", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, runtime, fg, openCalls, savedTabs } = makeRestoreManager({
    agentDir,
    saved: [{ name: "Home" }, { name: "Research" }],
    foreground: 0,
  });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 2);
  assert.equal(m.tabs[0].name, "Home", "startup tab renamed to the saved name");
  assert.equal(m.tabs[0].userRenamed, true);
  assert.equal(m.tabs[1].name, "Research");
  assert.equal(m.activeIndex, 0, "stays on the foreground tab");
  assert.equal(runtime.session, fg);
  assert.deepEqual(openCalls, [savedTabs[1].file]);
});

test("restoreTabs: fresh foreground -> startup becomes 'new', saved active tab activated", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, runtime, openCalls, savedTabs } = makeRestoreManager({
    agentDir,
    saved: [{ name: "Main" }, { name: "Research" }],
    activeIndex: 1,
    foreground: "fresh",
  });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 3);
  assert.equal(m.tabs[0].name, "new");
  assert.equal(m.tabs[0].userRenamed, false, "auto-title adoption stays enabled");
  assert.equal(m.activeIndex, 2, "activates the restored 'Research' tab");
  assert.equal(runtime.session.sessionId, "s1", "foreground swapped to the restored session");
  assert.deepEqual(openCalls, [savedTabs[0].file, savedTabs[1].file]);
});

test("restoreTabs: missing session file is skipped with a status note", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, openCalls, statuses, savedTabs } = makeRestoreManager({
    agentDir,
    saved: [{ name: "Main" }, { name: "Gone", exists: false }],
    foreground: "fresh",
  });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 2, "startup + the one restorable tab");
  assert.deepEqual(openCalls, [savedTabs[0].file], "the missing file is not even attempted");
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /Restored 1 of 2 tabs/);
});

test("restoreTabs: external existing session (pi resume <other>) -> stays up front, adopts its name", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, runtime, openCalls, savedTabs } = makeRestoreManager({
    agentDir,
    saved: [{ name: "Main" }, { name: "Research" }],
    activeIndex: 0,
    foreground: "fresh", // file-wise: not one of the saved tabs
    fresh: false, // but the session has real content (it was resumed)
    foregroundName: "Old Work",
  });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 3, "startup + both restored tabs");
  assert.equal(m.tabs[0].name, "Old Work", "startup tab takes the resumed session's name");
  assert.equal(m.tabs[0].userRenamed, true);
  assert.equal(m.activeIndex, 0, "no auto-activation away from the resumed session");
  assert.equal(runtime.session.sessionId, "fg");
  assert.deepEqual(openCalls, [savedTabs[0].file, savedTabs[1].file]);
});

test("restoreTabs: resumed saved inactive tab -> stays on it, saved active not reactivated", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, runtime, openCalls, savedTabs } = makeRestoreManager({
    agentDir,
    saved: [{ name: "Main" }, { name: "Research" }],
    activeIndex: 0,
    foreground: 1, // Pi started inside the non-active saved tab
  });
  await m.restoreTabs();
  assert.equal(m.tabs.length, 2);
  assert.equal(m.tabs[0].name, "Research");
  assert.equal(m.activeIndex, 0, "stays on the explicitly resumed tab");
  assert.equal(runtime.session.sessionId, "fg");
  assert.deepEqual(openCalls, [savedTabs[0].file]);
});

// --- persistence on structural changes ---

test("createTab persists the tab set to the state file", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pst-agent-"));
  const { m, statePath } = makeRestoreManager({ agentDir, saved: null });
  m._statePath = statePath; // normally set by restoreTabs; set directly here
  await m.createTab("Backend");
  const savedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(savedState.version, 1);
  assert.equal(savedState.tabs.length, 2);
  assert.equal(savedState.tabs[1].name, "Backend");
  assert.equal(savedState.activeIndex, 1);
  assert.ok(savedState.tabs[1].file.endsWith(".jsonl"));
});

// --- patch factory ---

test("makeOpenTabSession opens the file via the runtime factory", async () => {
  let opened = null;
  const FakeSessionManager = {
    open: (f) => {
      opened = f;
      return { opened: f };
    },
  };
  const fn = makeOpenTabSession(FakeSessionManager);
  const runtime = {
    cwd: "/proj",
    services: { agentDir: "/agent" },
    async createRuntime(opts) {
      return { opts };
    },
  };
  const out = await fn.call(runtime, "/proj/s0.jsonl");
  assert.equal(opened, "/proj/s0.jsonl");
  assert.equal(out.opts.sessionManager.opened, "/proj/s0.jsonl");
  assert.equal(out.opts.cwd, "/proj");
  assert.equal(out.opts.agentDir, "/agent");
});
