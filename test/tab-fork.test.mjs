import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { TabManager, handleTabCommand, parseTabCommand } from "../extensions/tab-manager.mjs";

function stubSession(id, { sessionFile = null, sessionName = undefined } = {}) {
  const listeners = [];
  const s = {
    sessionId: id,
    sessionFile,
    isStreaming: false,
    setNameCalls: [],
    setSessionName(name) {
      s.setNameCalls.push(name);
    },
    sessionManager: {
      getSessionName: () => sessionName,
      getEntries: () => [],
    },
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
  return s;
}

// Attach a forkFrom static to the stub sessionManager's constructor slot (the
// production path reaches the host class via sessionManager.constructor).
function withForkFrom(session, forkFrom) {
  session.sessionManager.constructor = { forkFrom };
  return session;
}

function stubMode(session, { forkFrom, openedSession, status = [] } = {}) {
  const src = withForkFrom(
    session,
    forkFrom ?? (() => ({ sessionFile: "/sessions/fork1.jsonl" })),
  );
  const ed = { getText: () => "", setText() {} };
  const runtime = {
    session: src,
    cwd: "/proj",
    async __piSessionTabsAttachSession(s) {
      this.session = s;
    },
    async __piSessionTabsOpenTabSession(file) {
      runtime.openedFile = file;
      return { session: openedSession ?? stubSession("fork-s1", { sessionFile: file }) };
    },
  };
  return {
    runtimeHost: runtime,
    ui: { requestRender() {} },
    editor: ed,
    defaultEditor: ed,
    showStatus(msg) {
      status.push(msg);
    },
  };
}

function makeManager(session, opts) {
  const status = [];
  const mode = stubMode(session, { ...opts, status });
  const m = new TabManager({ mode });
  m.addTab(mode.runtimeHost.session, { name: "Main" });
  return { m, mode, status };
}

test("parseTabCommand parses /tabfork with optional name", () => {
  assert.deepEqual(parseTabCommand("/tabfork"), { command: "tabfork" });
  assert.deepEqual(parseTabCommand("/tabfork Spike"), { command: "tabfork", name: "Spike" });
  assert.deepEqual(parseTabCommand("  /tabfork   Alt approach  "), {
    command: "tabfork",
    name: "Alt approach",
  });
});

test("forkActive forks the foreground file, opens it, appends + activates", async () => {
  const forkCalls = [];
  const src = stubSession("s0", { sessionFile: "/sessions/main.jsonl", sessionName: "Main" });
  const { m, mode } = makeManager(src, {
    forkFrom: (sourcePath, targetCwd, sessionDir) => {
      forkCalls.push([sourcePath, targetCwd, sessionDir]);
      return { sessionFile: "/sessions/fork1.jsonl" };
    },
  });
  await m.forkActive();
  assert.deepEqual(forkCalls, [["/sessions/main.jsonl", "/proj", undefined]]);
  assert.equal(mode.runtimeHost.openedFile, "/sessions/fork1.jsonl");
  assert.equal(m.tabs.length, 2);
  assert.equal(m.activeIndex, 1, "forked tab is activated like /tabnew");
  assert.equal(m.tabs[0].name, "Main", "source tab untouched");
});

test("forkActive without a name uses a placeholder and ignores the copied source name", async () => {
  const src = stubSession("s0", { sessionFile: "/sessions/main.jsonl", sessionName: "Main" });
  // The forked file carries the source's persisted name (forkFrom copies all
  // non-header entries, including session_info) — the tab must NOT adopt it.
  const opened = stubSession("fork-s1", {
    sessionFile: "/sessions/fork1.jsonl",
    sessionName: "Main",
  });
  const { m } = makeManager(src, { openedSession: opened });
  await m.forkActive();
  const fork = m.tabs[1];
  assert.equal(fork.name, "tab 1");
  assert.equal(fork.userRenamed, false, "placeholder adopts later titles");
  assert.deepEqual(opened.setNameCalls, [], "no setSessionName without an explicit name");
  assert.equal(fork.titled, false, "first reply on the fork auto-titles it");
});

test("forkActive with a name applies it as an override", async () => {
  const src = stubSession("s0", { sessionFile: "/sessions/main.jsonl", sessionName: "Main" });
  const opened = stubSession("fork-s1", { sessionFile: "/sessions/fork1.jsonl" });
  const { m } = makeManager(src, { openedSession: opened });
  await m.forkActive("Spike");
  const fork = m.tabs[1];
  assert.equal(fork.name, "Spike");
  assert.equal(fork.userRenamed, true);
  assert.deepEqual(opened.setNameCalls, ["Spike"]);
});

test("forkActive failure leaves the tabs untouched and reports via handleTabCommand", async () => {
  const src = stubSession("s0", { sessionFile: "/sessions/main.jsonl" });
  const { m, mode, status } = makeManager(src, {
    forkFrom: () => {
      throw new Error("Cannot fork: source session file is empty or invalid");
    },
  });
  await handleTabCommand(m, { command: "tabfork" });
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
  assert.match(status.join("\n"), /Tab command failed: Cannot fork/);
  assert.equal(mode.runtimeHost.openedFile, undefined, "failed fork never opens");
});

test("forkActive without a session file reports instead of forking", async () => {
  const src = stubSession("s0", { sessionFile: null });
  const { m, status } = makeManager(src);
  await handleTabCommand(m, { command: "tabfork", name: "X" });
  assert.equal(m.tabs.length, 1);
  assert.match(status.join("\n"), /no session file/);
});

test("forkActive persists the new tab set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tabfork-"));
  const src = stubSession("s0", { sessionFile: "/sessions/main.jsonl" });
  const { m } = makeManager(src);
  m._statePath = join(dir, "tabs.json");
  await m.forkActive("Spike");
  const saved = JSON.parse(readFileSync(join(dir, "tabs.json"), "utf8"));
  assert.equal(saved.tabs.length, 2);
  assert.equal(saved.tabs[1].file, "/sessions/fork1.jsonl");
  assert.equal(saved.tabs[1].name, "Spike");
  assert.equal(saved.activeIndex, 1);
});
