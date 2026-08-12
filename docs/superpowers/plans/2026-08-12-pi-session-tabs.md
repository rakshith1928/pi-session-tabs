# Pi Multi-Session Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved design (DESIGN.md §17) — OpenCode v2-style multi-session tabs inside Pi 0.84.1, delivered as a **normal Pi package** (`pi install npm:pi-session-tabs` → `pi` → tabs). No launcher, no `node pi-tabs.mjs`. Users install once and run plain `pi`.

**Architecture:** A Pi package whose extension entry (`extensions/index.ts`) runs in two phases. **Phase A (module top-level, before `new InteractiveMode`):** imports `AgentSessionRuntime`/`AgentSession`/`InteractiveMode`/`SessionManager` from `@earendil-works/pi-coding-agent` and `Container`/`Text` from `@earendil-works/pi-tui` — the jiti loader aliases these to the host's own module instances (verified: identity `===`, module executes once per process/cwd, `globalThis` shared) — then installs additive, existence-guarded prototype patches via a `globalThis`-backed **controller** (reload-safe/idempotent). **Phase B (per-session factory):** the required `export default function (pi) {}` no-op factory; tab commands are handled by an editor-submit interception installed at attach time. `TabManager` owns the tab registry, per-session status subscriptions, per-tab editor drafts, tab commands, and Alt+Left/Right cycling; `TabBar` renders a top row via `documentContainer.children.unshift`; background extension UI is identity-guarded.

**Tech Stack:** Node.js 24 (ESM `.mjs` + one `.ts` entry via jiti, `node:test`), installed Pi 0.84.1 + pi-tui 0.84.1 (imported through the loader alias — no npm install, zero runtime dependencies), JSDoc-typed JavaScript.

## Global Constraints

- Pi package pinned to **0.84.1**; best-effort version check warns on mismatch (never crash). Existence guards are the real safety.
- **Never modify** the installed Pi package or `node_modules`; all code lives in `C:/Users/DELL/pi-session-tabs/` and is installed like any Pi package.
- All patches are **additive and existence-guarded**: if a target member is missing, that patch skips itself and Pi runs without tabs, with a warning.
- Zero runtime dependencies in `package.json`; only `peerDependencies` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, both `"*"`). Pi bundles those for extensions.
- **Module identity:** the loader aliases `@earendil-works/pi-coding-agent` → host `dist/index.js` and `@earendil-works/pi-tui` → bundled host instance (verified `===` against host imports); the controller self-checks `mode instanceof InteractiveMode` at wiring time and skips with a warning if identity ever breaks.
- Patch method names are **namespaced** (user decision Q7): `AgentSessionRuntime.prototype.__piSessionTabsAttachSession` and `__piSessionTabsCreateTabSession`, plus the `__tabsFirstBind` session flag. Existing Pi members wrapped: `bindExtensions`, `dispose`, `init`, `rebindCurrentSession`, `shutdown`, `createExtensionUIContext`.
- Extension entry is **`.ts`** (user decision Q8): the loader loads TS via jiti; the installed `~/.pi/agent/extensions/hermes-welcome.ts` proves the path. Internal modules are JSDoc-typed `.mjs` for `node:test`.
- **No first-boot notice** (user decision Q9); the tab bar is the discovery affordance; usage documented in README.
- Alt+Left/Right are intercepted **only when no overlay/modal is active** (all of `extensionSelector`, `extensionInput`, `extensionEditor`, `activeSelectorToken` absent) **and** `mode.editor === mode.defaultEditor`. Elsewhere they pass through (tree fold/unfold, etc.).
- Editor draft is **per-tab**: saved on deactivate, restored on activate; new tabs start with an empty draft and cleared editor.
- `/new`, `/resume`, `/fork`, `/reload` remain destructive active-tab replacements: the dispose-hook removes the old tab; the rebind-hook registers the replacement session as a new tab.
- No tab layout persistence across restarts (V1).
- Tab state is one of `"idle" | "running" | "needs_attention"`. `needs_attention` is set **only** structurally (assistant `message_end` with `stopReason === "error"`), cleared on next `agent_start`. **No error-string heuristics.**
- `session_start` is emitted **once per session** (suppressed on re-attach); re-attach still rebinds uiContext/commandContextActions/handlers via `_applyExtensionBindings`.
- Background extension UI is isolated by identity-guarding every mutating `ExtensionUIContext` method; guarded dialogs resolve promptly with cancel values (never hang).
- Tab commands: `/tabnew [name]`, `/tabclose`, `/tabrename <name>` (unknown `/tab*` falls through to the original submit handler).
- Tab bar glyphs: `○` idle, `●` running, `⚠` needs_attention; active tab in `accent`, inactive in `muted`; total width truncated with `…`.
- Shutdown disposes all background tabs (after setting a `shuttingDown` flag so status callbacks no-op).
- Patches are installed **once per process** (controller `patched` flag survives `/reload` module re-imports); the manager survives on the mode (`mode.__tabManager`) and the controller.

---

## File Structure

```
pi-session-tabs/                       # the Pi package itself
├── package.json                       # pi manifest: extensions: ["./extensions/index.ts"]; pi-package keyword; peerDeps only
├── .gitignore                         # node_modules/, *.log
├── README.md                          # usage + install (Task 12)
├── docs/superpowers/plans/2026-08-12-pi-session-tabs.md
├── extensions/
│   ├── index.ts                       # Phase A: import classes → ensurePatched + tui; Phase B: no-op factory
│   ├── controller.mjs                 # globalThis-backed controller (patched flag, manager, hooks, version check)
│   ├── patches.mjs                    # additive prototype patches + hook dispatch (pure, DI)
│   ├── tab-manager.mjs                # registry, status machine, drafts, commands, reconciliation, attach
│   └── tab-bar.mjs                    # formatTabs + createTabBar (pure, DI)
└── test/
    ├── controller.test.mjs            # controller singleton/idempotency/hooks/version + wiring (Tasks 3, 10)
    ├── patches.test.mjs               # all patch makers (Tasks 2, 4–5)
    ├── tab-manager.test.mjs           # registry/status/lifecycle/reconciliation (Tasks 7–9)
    └── tab-bar.test.mjs               # formatTabs + createTabBar (Task 6)
```

Run tests with `node --test` (auto-discovery of `test/*.test.mjs`; Node ≥ 21 treats positional args after `--test` as globs, so no path is passed) from `pi-session-tabs/`. Manual verification (Task 11) installs the package locally (`pi install ./pi-session-tabs`) and boots plain `pi`.

---

## Interfaces (locked — later tasks depend on these exact names)

**controller.mjs**
```js
export const CONTROLLER_KEY: symbol;   // Symbol.for("pi.sessionTabs.controller")
export class SessionTabsController {
  patched: boolean;
  tui?: { Container: Function; Text: Function };
  InteractiveMode?: Function;
  manager: TabManager | null;
  mode: any;
  isForeground(sessionId: string): boolean;            // true when no manager (startup)
  ensureManager(mode): TabManager | null;              // Task 10: guards + TabManager.attach
  handleTabCommand(cmd): Promise<void>;                // Task 10: routes to manager
}
export function getController(): SessionTabsController; // globalThis singleton
export function ensurePatched(classes, { install }?): SessionTabsController; // idempotent
export function makeHooks(controller): { onModeReady, onForegroundChanged, onSessionDisposed, onShutdown, isForeground };
export function checkVersion({ warn, resolve, read }?): Promise<void>; // best-effort
```

**patches.mjs**
```js
export function makeAttachSession(): (session) => Promise<void>;                      // installed as __piSessionTabsAttachSession
export function makeCreateTabSession(SessionManager): () => Promise<{ session: any }>; // installed as __piSessionTabsCreateTabSession
export function makeBindExtensionsWrapper(orig, { onBindExtensions }): (bindings) => Promise<void>;
export function makeDisposeWrapper(orig, { onSessionDisposed }): () => void;
export function makeInitWrapper(origInit, { onModeReady }): (...args) => Promise<any>;
export function makeRebindWrapper(origRebind, { onForegroundChanged }): (opts?) => Promise<any>;
export function makeShutdownWrapper(origShutdown, { onShutdown }): (...args) => Promise<any>;
export function makeUiContextGuardWrapper(origCreate, { isForeground }): () => object;
export const GUARDED_CANCEL: Record<string, unknown>;
export function installPatches({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager, hooks }): { restore(): void };
// hooks: { onModeReady(mode), onForegroundChanged(mode, prev, next), onSessionDisposed(session),
//          onShutdown(mode), isForeground(sessionId) -> boolean }
```

**tab-manager.mjs**
```js
export function parseTabCommand(text: string): null | { command: "tabnew" | "tabclose" | "tabrename"; name?: string };
export function hasOverlay(mode): boolean;
export async function handleTabCommand(manager, cmd): Promise<void>;
export class TabManager {
  static attach(mode, { Container, Text }): TabManager;
  constructor({ mode });                     // reads mode.runtimeHost
  tabs: Array<{ id, name, session, state, draft, unsubscribe }>;  // readonly in practice
  activeIndex: number;
  isForeground(sessionId): boolean;
  hasBoundBefore(session): boolean;          // session.__tabsFirstBind === true
  async createTab(name?): Promise<void>;
  async activate(index): Promise<void>;
  async cycle(dir): Promise<void>;           // dir -1 | +1, wraps
  async closeActive(): Promise<void>;
  renameActive(name): void;
  onForegroundChanged(prev, next): void;
  onSessionDisposed(session): void;
  shutdown(): void;
}
```

**tab-bar.mjs**
```js
export function formatTabs(tabs: Array<{ name: string; state: "idle"|"running"|"needs_attention" }>, activeIndex: number, width: number): string;
export function createTabBar({ Container, Text, theme, documentContainer, requestRender }): {
  container; update(tabs, activeIndex): void;
};
```

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `.gitignore`
- Create: `test/smoke.test.mjs`

**Interfaces:**
- Produces: the Pi package skeleton with `npm test` working and a git repo.

- [ ] **Step 1: Create the project folder and git repo**

```bash
mkdir -p C:/Users/DELL/pi-session-tabs/extensions C:/Users/DELL/pi-session-tabs/test
cd C:/Users/DELL/pi-session-tabs
git init
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "pi-session-tabs",
  "version": "0.1.0",
  "description": "OpenCode v2-style multi-session tabs for Pi (loads as a normal Pi package; no launcher)",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "files": ["extensions/", "README.md"],
  "scripts": {
    "test": "node --test"
  }
}
```

Note: the `pi` manifest pins exactly one extension entry — conventional `extensions/` auto-discovery would otherwise load every `.ts`/`.mjs` file as a separate extension. `index.ts` will import the others as modules.

- [ ] **Step 3: Write .gitignore**

```gitignore
node_modules/
*.log
```

- [ ] **Step 4: Write the smoke test**

`test/smoke.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke: node --test runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Run tests — verify green**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: smoke test passes, `# pass 1`.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore test/smoke.test.mjs
git commit -m "chore: scaffold pi-session-tabs Pi package"
```

---

### Task 2: patches.mjs — namespaced attach/createTabSession + installPatches skeleton

**Files:**
- Create: `extensions/patches.mjs`
- Test: `test/patches.test.mjs`

**Interfaces:**
- Produces: `makeAttachSession()`, `makeCreateTabSession(SessionManager)`, and `installPatches({...})` with restore for the two namespaced members. Names are **namespaced** (Q7): installed as `__piSessionTabsAttachSession` / `__piSessionTabsCreateTabSession`; internal call sites only.

- [ ] **Step 1: Write the failing test**

`test/patches.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the two makers + installPatches skeleton**

`extensions/patches.mjs` (append to this file in later tasks):
```js
/**
 * Additive, existence-guarded prototype patches for Pi 0.84.1.
 * All patch factories are pure: they take the original method (or dependencies)
 * and return the replacement, so tests never touch real Pi classes.
 * New members are namespaced (__piSessionTabs*) to avoid clashing with future
 * official Pi APIs; existing Pi members are wrapped and recorded for restore.
 */

const BIND_FIELDS = [
  "uiContext",
  "mode",
  "commandContextActions",
  "abortHandler",
  "shutdownHandler",
  "onError",
];
const BIND_PRIVATE = [
  "_extensionUIContext",
  "_extensionMode",
  "_extensionCommandContextActions",
  "_extensionAbortHandler",
  "_extensionShutdownHandler",
  "_extensionErrorListener",
];

/** Non-destructive session reattachment: swap _session, fire rebind callback. No teardown/abort/dispose. */
export function makeAttachSession() {
  return async function __piSessionTabsAttachSession(session) {
    if (session === this._session) return;
    this._session = session;
    await this.finishSessionReplacement();
  };
}

/** Create an independent persisted session via the runtime's own factory (like /new, without teardown). */
export function makeCreateTabSession(SessionManager) {
  return async function __piSessionTabsCreateTabSession() {
    return this.createRuntime({
      cwd: this.cwd,
      agentDir: this.services.agentDir,
      sessionManager: SessionManager.create(this.cwd),
    });
  };
}

/**
 * Apply additive patches. `hooks` dispatch events to the TabManager layer.
 * Existence-guarded: a missing member skips its patch (tabs degrade gracefully).
 * New members are always (re)defined; existing members are recorded for restore().
 */
export function installPatches({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager, hooks = {} }) {
  const originals = [];
  const apply = (target, name, replacement) => {
    // Record EVERY patched member: pre-existing Pi members are reinstated by
    // restore(); undefined entries (our namespaced new members) are deleted.
    originals.push([target.prototype, name, target.prototype[name]]);
    Object.defineProperty(target.prototype, name, {
      value: replacement,
      writable: true,
      configurable: true,
    });
  };

  apply(AgentSessionRuntime, "__piSessionTabsAttachSession", makeAttachSession());
  apply(AgentSessionRuntime, "__piSessionTabsCreateTabSession", makeCreateTabSession(SessionManager));

  return {
    restore() {
      for (const [proto, name, orig] of originals) {
        if (orig === undefined) delete proto[name];
        else Object.defineProperty(proto, name, { value: orig, writable: true, configurable: true });
      }
    },
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/patches.mjs test/patches.test.mjs
git commit -m "feat: namespaced attach/createTabSession runtime patches"
```

---

### Task 3: Controller bootstrap (controller.mjs + extensions/index.ts)

**Files:**
- Create: `extensions/controller.mjs`, `extensions/index.ts`
- Test: `test/controller.test.mjs`

**Interfaces:**
- Produces: `CONTROLLER_KEY`, `SessionTabsController` (fields + `isForeground`), `getController()`, `ensurePatched(classes, { install })`, `makeHooks(controller)`, `checkVersion({ warn, resolve, read })`. The `ensureManager`/`handleTabCommand` methods are filled in Task 10.
- Phase A of `index.ts` runs at module top-level (before `new InteractiveMode`): imports the four classes from `@earendil-works/pi-coding-agent` and `Container`/`Text` from `@earendil-works/pi-tui`, calls `ensurePatched(...)`, stores the TUI classes on the controller, and kicks off the best-effort version check. Phase B is the required no-op factory.

**Verification background (0.84.1, empirically tested):** the loader (`dist/core/extensions/loader.js`) aliases `@earendil-works/pi-coding-agent` → host `dist/index.js` and `@earendil-works/pi-tui` → bundled host instance. Extensions load inside `createAgentSessionRuntime` (main.js ≈675) before `new InteractiveMode` (≈746). Cached loading executes the module once per process/cwd; `/reload` clears the cache and re-imports (idempotency needed).

- [ ] **Step 1: Write the failing test**

`test/controller.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: FAIL — module `../extensions/controller.mjs` not found.

- [ ] **Step 3: Implement controller.mjs**

`extensions/controller.mjs`:
```js
/**
 * globalThis-backed controller for pi-session-tabs.
 * Survives /reload: the extension module is re-imported (loader cache cleared),
 * but this object persists, so patching happens exactly once per process and the
 * live TabManager keeps working across reloads.
 */
import { installPatches } from "./patches.mjs";

export const CONTROLLER_KEY = Symbol.for("pi.sessionTabs.controller");

export class SessionTabsController {
  constructor() {
    this.patched = false;
    this.tui = undefined; // { Container, Text } set by index.ts Phase A
    this.InteractiveMode = undefined; // for the identity self-check
    this.manager = null;
    this.mode = null;
  }

  isForeground(sessionId) {
    return this.manager ? this.manager.isForeground(sessionId) : true;
  }

  // ensureManager(mode) and handleTabCommand(cmd) are implemented in Task 10.
}

export function getController() {
  let c = globalThis[CONTROLLER_KEY];
  if (!c) {
    c = new SessionTabsController();
    globalThis[CONTROLLER_KEY] = c;
  }
  return c;
}

/**
 * Install the prototype patches exactly once per process. `install` is injectable
 * for tests; production uses the real installPatches.
 */
export function ensurePatched({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager }, { install } = {}) {
  const c = getController();
  if (c.patched) return c;
  c.patched = true;
  c.InteractiveMode = InteractiveMode;
  (install ?? installPatches)({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager, hooks: makeHooks(c) });
  return c;
}

/** Hook implementations for installPatches; all dispatch through the controller. */
export function makeHooks(controller) {
  return {
    onModeReady(mode) {
      controller.ensureManager(mode);
    },
    onForegroundChanged(mode, prev, next) {
      controller.manager?.onForegroundChanged(prev, next);
    },
    onSessionDisposed(session) {
      controller.manager?.onSessionDisposed(session);
    },
    onShutdown(mode) {
      controller.manager?.shutdown();
    },
    isForeground(sessionId) {
      return controller.isForeground(sessionId);
    },
  };
}

/**
 * Best-effort host-version check: warn when the installed pi version is not
 * 0.84.1. Silently no-ops if the host package cannot be resolved (e.g. the
 * loader does not provide import.meta.resolve) — existence guards handle it.
 */
export async function checkVersion({ warn = console.warn, resolve, read } = {}) {
  try {
    const r = resolve ?? import.meta.resolve;
    const pkgUrl = new URL("../package.json", await r("@earendil-works/pi-coding-agent"));
    const rd =
      read ?? (async (p, enc) => (await import("node:fs/promises")).readFile(p, enc));
    const { version } = JSON.parse(await rd(pkgUrl, "utf8"));
    if (version !== "0.84.1") {
      warn(`pi-session-tabs: installed pi version ${version} != 0.84.1; tabs may not apply cleanly.`);
    }
  } catch {
    /* best effort only */
  }
}
```

- [ ] **Step 4: Implement extensions/index.ts (Phase A + no-op factory)**

`extensions/index.ts`:
```ts
// Phase A — module top-level. The jiti loader aliases these package specifiers to
// the host's own module instances (verified against 0.84.1: identity === host),
// and extensions load inside createAgentSessionRuntime, BEFORE new InteractiveMode.
// So these imports ARE the classes the CLI constructs, and patching here lands
// before the first init() call.
import { AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { ensurePatched, getController, checkVersion } from "./controller.mjs";

const controller = ensurePatched({ AgentSessionRuntime, AgentSession, InteractiveMode, SessionManager });
controller.tui = { Container, Text };
void checkVersion();

// Phase B — per-session factory (extension contract requires a default export).
// Tab commands (/tabnew, /tabclose, /tabrename) are handled by the editor-submit
// interception installed at attach time; there is nothing to register here.
export default function piSessionTabs() {}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all 4 tests pass. (index.ts is not imported by tests — it needs the real loader alias; verified in Task 11.)

- [ ] **Step 6: Commit**

```bash
git add extensions/controller.mjs extensions/index.ts test/controller.test.mjs
git commit -m "feat: globalThis controller, idempotent patching, no-op package factory"
```

---

### Task 4: patches.mjs — bindExtensions + dispose wrappers

**Files:**
- Modify: `extensions/patches.mjs`
- Test: `test/patches.test.mjs`

**Interfaces:**
- Produces: `makeBindExtensionsWrapper(orig, { onBindExtensions })`, `makeDisposeWrapper(orig, { onSessionDisposed })`; `installPatches` now also patches `AgentSession.prototype.bindExtensions` and `AgentSession.prototype.dispose`.

- [ ] **Step 1: Write the failing tests**

Append to `test/patches.test.mjs`:
```js
import { makeBindExtensionsWrapper, makeDisposeWrapper } from "../extensions/patches.mjs";

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
```

- [ ] **Step 2: Run tests — verify the new ones fail**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: new tests FAIL (`makeBindExtensionsWrapper is not a function`).

- [ ] **Step 3: Implement the wrappers**

Append to `extensions/patches.mjs`:
```js
/**
 * Wrap AgentSession.bindExtensions. First bind behaves exactly like the original
 * (emits session_start, rediscovers resources). Re-attach rebinds uiContext /
 * commandContextActions / handlers but suppresses the startup emit and resource
 * rediscovery (which would churn a background session's system prompt per switch).
 */
export function makeBindExtensionsWrapper(orig, { onBindExtensions } = {}) {
  return async function bindExtensions(bindings) {
    const self = this;
    const first = !self.__tabsFirstBind;
    self.__tabsFirstBind = true;
    if (first) {
      await orig.call(self, bindings);
    } else {
      for (let i = 0; i < BIND_FIELDS.length; i++) {
        if (bindings[BIND_FIELDS[i]] !== undefined) {
          self[BIND_PRIVATE[i]] = bindings[BIND_FIELDS[i]];
        }
      }
      await self._applyExtensionBindings(self._extensionRunner);
    }
    onBindExtensions?.(self, first);
  };
}

/** Wrap AgentSession.dispose: run original, then notify (registry cleanup). */
export function makeDisposeWrapper(orig, { onSessionDisposed } = {}) {
  return function dispose() {
    try {
      orig.call(this);
    } finally {
      onSessionDisposed?.(this);
    }
  };
}
```

Update `installPatches` to apply them:
```js
  const { onBindExtensions, onSessionDisposed } = hooks;
  const bindExtensionsWrapper = makeBindExtensionsWrapper(AgentSession.prototype.bindExtensions, { onBindExtensions });
  apply(AgentSession, "bindExtensions", bindExtensionsWrapper);
  const disposeWrapper = makeDisposeWrapper(AgentSession.prototype.dispose, { onSessionDisposed });
  apply(AgentSession, "dispose", disposeWrapper);
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/patches.mjs test/patches.test.mjs
git commit -m "feat: bindExtensions re-attach suppression + dispose hooks"
```

---

### Task 5: patches.mjs — init / rebindCurrentSession / shutdown / uiContext guard wrappers

**Files:**
- Modify: `extensions/patches.mjs`
- Test: `test/patches.test.mjs`

**Interfaces:**
- Produces: `makeInitWrapper(origInit, { onModeReady })`, `makeRebindWrapper(origRebind, { onForegroundChanged })`, `makeShutdownWrapper(origShutdown, { onShutdown })`, `makeUiContextGuardWrapper(origCreate, { isForeground })`, `GUARDED_CANCEL`. `installPatches` now also patches `InteractiveMode.prototype.init/rebindCurrentSession/shutdown/createExtensionUIContext`.

- [ ] **Step 1: Write the failing tests**

Append to `test/patches.test.mjs`:
```js
import {
  makeInitWrapper,
  makeRebindWrapper,
  makeShutdownWrapper,
  makeUiContextGuardWrapper,
  GUARDED_CANCEL,
} from "../extensions/patches.mjs";

test("init wrapper dispatches onModeReady after original", async () => {
  const order = [];
  const orig = async function () {
    order.push("init");
  };
  const wrap = makeInitWrapper(orig, { onModeReady: (m) => order.push("ready:" + m.tag) });
  await wrap.call({ tag: "mode" });
  assert.deepEqual(order, ["init", "ready:mode"]);
});

test("rebind wrapper dispatches onForegroundChanged with prev/next in finally", async () => {
  const events = [];
  const A = { id: "A" };
  const B = { id: "B" };
  const mode = { runtimeHost: { session: B } };
  const orig = async function () {
    this.runtimeHost.session = B; // simulate swap performed during rebind
  };
  const wrap = makeRebindWrapper(orig, {
    onForegroundChanged: (m, prev, next) => events.push([prev?.id, next?.id]),
  });
  await wrap.call(mode, { renderBeforeBind: true });
  assert.deepEqual(events, [["A", "B"]]);

  // hook still fires when orig throws
  const mode2 = { runtimeHost: { session: B } };
  const failing = async function () {
    throw new Error("bind failed");
  };
  const wrap2 = makeRebindWrapper(failing, {
    onForegroundChanged: (m, prev, next) => events.push(["f:" + prev?.id, "f:" + next?.id]),
  });
  await assert.rejects(() => wrap2.call(mode2), /bind failed/);
  assert.deepEqual(events[1], ["f:A", "f:B"]);
});

test("shutdown wrapper dispatches onShutdown before original", async () => {
  const order = [];
  const orig = async function () {
    order.push("shutdown");
  };
  const wrap = makeShutdownWrapper(orig, { onShutdown: () => order.push("pre") });
  await wrap.call({});
  assert.deepEqual(order, ["pre", "shutdown"]);
});

test("uiContext guard: foreground passes through, background cancels promptly", async () => {
  let fg = "A";
  const isForeground = (id) => id === fg;
  const ctx = {
    select: () => "selected",
    confirm: () => "confirmed",
    input: () => "inputted",
    notify: () => "notified",
    custom: () => Promise.resolve("mounted"),
    setWidget: () => "widget",
    getEditorText: () => "text",
    onTerminalInput: (h) => {
      h("data");
      return () => {};
    },
    theme: { fg: () => "colored" },
  };
  const origCreate = function () {
    return ctx;
  };
  const wrap = makeUiContextGuardWrapper(origCreate, { isForeground });
  const tagged = wrap.call({ session: { sessionId: "A" } });
  assert.equal(tagged.select("x"), "selected");
  fg = "B"; // A is now background
  assert.equal(tagged.select("x"), GUARDED_CANCEL.select);
  assert.equal(tagged.confirm("q"), GUARDED_CANCEL.confirm);
  assert.equal(tagged.input("t"), GUARDED_CANCEL.input);
  assert.equal(tagged.notify("n"), GUARDED_CANCEL.notify);
  assert.equal(await tagged.custom(() => {}), undefined);
  assert.equal(tagged.setWidget("k", "v"), undefined);
  assert.equal(tagged.getEditorText(), "");
  assert.equal(typeof tagged.theme.fg, "function");
});
```

- [ ] **Step 2: Run test — verify the new ones fail**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

Append to `extensions/patches.mjs`:
```js
/** Cancel values returned by guarded background UI methods (resolve promptly, never hang). */
export const GUARDED_CANCEL = {
  select: undefined,
  confirm: false,
  input: undefined,
  editor: undefined,
  custom: undefined,
  notify: undefined,
};

const UI_MUTATORS = [
  "select", "confirm", "input", "editor", "custom", "notify",
  "setWidget", "setFooter", "setHeader", "setStatus",
  "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel",
  "pasteToEditor", "setEditorText", "setEditorComponent", "addAutocompleteProvider",
  "setTitle", "setToolsExpanded",
];
const UI_GETTERS = ["getEditorText", "getEditorComponent", "getToolsExpanded"];

export function makeInitWrapper(origInit, { onModeReady } = {}) {
  return async function init(...args) {
    const result = await origInit.apply(this, args);
    onModeReady?.(this);
    return result;
  };
}

export function makeRebindWrapper(origRebind, { onForegroundChanged } = {}) {
  return async function rebindCurrentSession(opts) {
    const prev = this.runtimeHost?.session;
    try {
      return await origRebind.call(this, opts);
    } finally {
      onForegroundChanged?.(this, prev, this.runtimeHost?.session);
    }
  };
}

export function makeShutdownWrapper(origShutdown, { onShutdown } = {}) {
  return async function shutdown(...args) {
    onShutdown?.(this);
    return origShutdown.apply(this, args);
  };
}

/**
 * Guard every mutating ExtensionUIContext method by foreground-session identity.
 * The context is tagged with `this.session.sessionId` at creation (during
 * bindCurrentSessionExtensions, this.session is the session being bound).
 * Backgrounded calls resolve promptly with cancel values — never block, never
 * render into the foreground TUI.
 */
export function makeUiContextGuardWrapper(origCreate, { isForeground } = {}) {
  return function createExtensionUIContext() {
    const ctx = origCreate.call(this);
    const sessionId = this.session?.sessionId;
    const guard = () => {
      if (!isForeground) return true;
      return sessionId !== undefined && isForeground(sessionId);
    };
    const out = { ...ctx };
    for (const key of UI_MUTATORS) {
      const fn = ctx[key];
      if (typeof fn !== "function") continue;
      out[key] = (...args) => {
        if (!guard()) {
          if (key === "custom") return Promise.resolve();
          if (key === "confirm") return GUARDED_CANCEL.confirm;
          return GUARDED_CANCEL[key];
        }
        return fn.apply(ctx, args);
      };
    }
    for (const key of UI_GETTERS) {
      const fn = ctx[key];
      if (typeof fn !== "function") continue;
      out[key] = (...args) => (guard() ? fn.apply(ctx, args) : key === "getEditorText" ? "" : undefined);
    }
    // onTerminalInput: identity check at invocation time.
    if (typeof ctx.onTerminalInput === "function") {
      const origHandler = ctx.onTerminalInput;
      out.onTerminalInput = (handler) =>
        origHandler((data) => (guard() ? handler(data) : undefined));
    }
    return out;
  };
}
```

Update `installPatches` to apply the InteractiveMode patches:
```js
  const { onModeReady, onForegroundChanged, onShutdown, isForeground } = hooks;
  apply(InteractiveMode, "init", makeInitWrapper(InteractiveMode.prototype.init, { onModeReady }));
  apply(InteractiveMode, "rebindCurrentSession", makeRebindWrapper(InteractiveMode.prototype.rebindCurrentSession, { onForegroundChanged }));
  apply(InteractiveMode, "shutdown", makeShutdownWrapper(InteractiveMode.prototype.shutdown, { onShutdown }));
  apply(InteractiveMode, "createExtensionUIContext", makeUiContextGuardWrapper(InteractiveMode.prototype.createExtensionUIContext, { isForeground }));
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/patches.mjs test/patches.test.mjs
git commit -m "feat: mode lifecycle wraps + background UI isolation guard"
```

---

### Task 6: Tab bar (tab-bar.mjs)

**Files:**
- Create: `extensions/tab-bar.mjs`
- Test: `test/tab-bar.test.mjs`

**Interfaces:**
- Consumes: `Container`, `Text` (pi-tui classes, injected via the controller), `theme` (from `mode.createExtensionUIContext().theme`, has `.fg(color, text)`; verified palette keys: `accent`, `muted`, `warning`, `text`, `dim`, `border`).
- Produces: `formatTabs(tabs, activeIndex, width)` and `createTabBar({ Container, Text, theme, documentContainer, requestRender })` → `{ container, update(tabs, activeIndex) }`.

**Format rules (exact):** glyph `○` idle, `●` running, `⚠` needs_attention. Active segment: `[<glyph> <name>]`; inactive: ` <glyph> <name> `. Joined with `│`. If visible length > `width`, truncate to `width - 1` chars + `…`. Colors applied by the component (not `formatTabs`): active segment `accent`, inactive segment `muted`, attention glyph `warning`, running glyph `text`.

- [ ] **Step 1: Write the failing test**

`test/tab-bar.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTabs, createTabBar } from "../extensions/tab-bar.mjs";

test("formatTabs renders active bracket, glyphs, separators", () => {
  const tabs = [
    { name: "a", state: "idle" },
    { name: "b", state: "running" },
    { name: "c", state: "needs_attention" },
  ];
  assert.equal(formatTabs(tabs, 1, 40), "[● b]│ ○ a │ ⚠ c ");
});

test("formatTabs truncates to width with ellipsis", () => {
  const tabs = [{ name: "very-long-name", state: "idle" }];
  const out = formatTabs(tabs, 0, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("…"));
});

test("createTabBar installs container first in documentContainer and updates text", () => {
  let textValue = "";
  const FakeContainer = class {
    constructor() {
      this.children = [];
    }
    addChild(c) {
      this.children.push(c);
    }
  };
  const FakeText = class {
    constructor() {
      this.value = "";
    }
    setText(v) {
      this.value = v;
    }
  };
  const theme = {
    fg: (color, s) => `<${color}>${s}</${color}>`,
  };
  const documentContainer = new FakeContainer();
  let renders = 0;
  const bar = createTabBar({
    Container: FakeContainer,
    Text: FakeText,
    theme,
    documentContainer,
    requestRender: () => renders++,
  });
  assert.equal(documentContainer.children[0], bar.container, "tab bar inserted at top");
  bar.update(
    [
      { name: "a", state: "idle" },
      { name: "b", state: "running" },
    ],
    0,
  );
  assert.ok(bar.text.value.includes("<accent>[○ a]</accent>"));
  assert.ok(bar.text.value.includes("<muted> ● b </muted>"));
  assert.ok(bar.text.value.includes("<text>●</text>"));
  assert.equal(renders, 1);
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`extensions/tab-bar.mjs`:
```js
const GLYPH = { idle: "○", running: "●", needs_attention: "⚠" };
const SEP = "│";

/** Pure single-line rendering of the tab strip (no color). */
export function formatTabs(tabs, activeIndex, width) {
  const segments = tabs.map((tab, i) => {
    const glyph = GLYPH[tab.state] ?? GLYPH.idle;
    const inner = `${glyph} ${tab.name}`;
    return i === activeIndex ? `[${inner}]` : ` ${inner} `;
  });
  let out = segments.join(SEP);
  if (out.length > width) {
    out = out.slice(0, Math.max(0, width - 1)) + "…";
  }
  return out;
}

/** Build the top tab-bar row and insert it above the existing header. */
export function createTabBar({ Container, Text, theme, documentContainer, requestRender }) {
  const container = new Container();
  const text = new Text("");
  container.addChild(text);
  documentContainer.children.unshift(container);
  return {
    container,
    text,
    update(tabs, activeIndex) {
      const parts = tabs.map((tab, i) => {
        const glyph = GLYPH[tab.state] ?? GLYPH.idle;
        const glyphColor = tab.state === "needs_attention" ? "warning" : tab.state === "running" ? "text" : "muted";
        const coloredGlyph = theme.fg(glyphColor, glyph);
        const inner = `${coloredGlyph} ${tab.name}`;
        const seg = i === activeIndex ? `[${inner}]` : ` ${inner} `;
        return i === activeIndex ? theme.fg("accent", seg) : theme.fg("muted", seg);
      });
      text.setText(parts.join(SEP));
      requestRender?.();
    },
  };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all pass. NOTE: `formatTabs` truncation uses JS string length (ASCII assumptions); fine for V1 — recorded in README limitations.

- [ ] **Step 5: Commit**

```bash
git add extensions/tab-bar.mjs test/tab-bar.test.mjs
git commit -m "feat: tab bar strip rendering + top-row installation"
```

---

### Task 7: TabManager — registry + status state machine

**Files:**
- Create: `extensions/tab-manager.mjs`
- Test: `test/tab-manager.test.mjs`

**Interfaces:**
- Consumes: nothing yet beyond stubs (mode/runtime accessed via properties).
- Produces: `class TabManager` with `constructor({ mode })`, `tabs`, `activeIndex`, `addTab(session, { name, draft, boundBefore })`, `removeTab(tab)`, `findBySession(session)`, `isForeground(sessionId)`, `hasBoundBefore(session)`, `_handleSessionEvent(tab, event)` (state machine), `updateBar()`, `subscribeStatus(tab)`.

- [ ] **Step 1: Write the failing test**

`test/tab-manager.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry + state machine**

`extensions/tab-manager.mjs`:
```js
/** Per-tab state machine driven purely by session events. */
export class TabManager {
  constructor({ mode }) {
    this.mode = mode;
    this.runtime = mode.runtimeHost;
    this.tabs = [];
    this.activeIndex = 0;
    this.shuttingDown = false;
    this.bar = undefined; // installed by attach (Task 10 wiring) via setBar
    this._unsubAlt = undefined;
    this._chain = Promise.resolve();
    this._origSubmit = undefined;
  }

  addTab(session, { name, draft = "", boundBefore = false } = {}) {
    const tab = {
      id: session.sessionId,
      name: name ?? `tab ${this.tabs.length + 1}`,
      session,
      state: session.isStreaming ? "running" : "idle",
      draft,
      unsubscribe: undefined,
    };
    if (boundBefore) session.__tabsFirstBind = true;
    tab.unsubscribe = this.subscribeStatus(tab);
    this.tabs.push(tab);
    if (this.tabs.length === 1) this.activeIndex = 0;
    this.updateBar();
    return tab;
  }

  removeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i === -1) return;
    tab.unsubscribe?.();
    this.tabs.splice(i, 1);
    if (this.activeIndex >= this.tabs.length) this.activeIndex = Math.max(0, this.tabs.length - 1);
    this.updateBar();
  }

  findBySession(session) {
    return this.tabs.find((t) => t.session === session);
  }

  isForeground(sessionId) {
    return this.runtime.session?.sessionId === sessionId;
  }

  hasBoundBefore(session) {
    return session.__tabsFirstBind === true;
  }

  subscribeStatus(tab) {
    return tab.session.subscribe((event) => this._handleSessionEvent(tab, event));
  }

  _handleSessionEvent(tab, event) {
    if (this.shuttingDown) return;
    switch (event.type) {
      case "agent_start":
        tab.state = "running";
        break;
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant" && msg.stopReason === "error") {
          tab.state = "needs_attention";
        } else if (msg?.role === "assistant") {
          tab.state = "running";
        }
        break;
      }
      case "agent_settled":
        if (tab.state !== "needs_attention") {
          tab.state = tab.session.isStreaming ? "running" : "idle";
        }
        break;
      case "compaction_start":
        tab.state = "running";
        break;
      case "compaction_end":
        if (tab.state !== "needs_attention") tab.state = "idle";
        break;
      default:
        return;
    }
    this.updateBar();
  }

  setBar(bar) {
    this.bar = bar;
    this.updateBar();
  }

  updateBar() {
    if (!this.bar || this.shuttingDown) return;
    this.bar.update(
      this.tabs.map((t) => ({ name: t.name, state: t.state })),
      this.activeIndex,
    );
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/tab-manager.mjs test/tab-manager.test.mjs
git commit -m "feat: tab registry + per-session status state machine"
```

---

### Task 8: TabManager — commands, lifecycle ops, drafts

**Files:**
- Modify: `extensions/tab-manager.mjs`
- Test: `test/tab-manager.test.mjs`

**Interfaces:**
- Produces: `parseTabCommand(text)`, `hasOverlay(mode)`, `TabManager.createTab(name?)`, `activate(index)`, `cycle(dir)`, `closeActive()`, `renameActive(name)`. Adds `_enqueue(fn)` serialization and per-tab draft save/restore inside `activate`. Lifecycle ops call the **namespaced** runtime methods `__piSessionTabsCreateTabSession()` / `__piSessionTabsAttachSession(session)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tab-manager.test.mjs`:
```js
import { parseTabCommand, hasOverlay } from "../extensions/tab-manager.mjs";

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
  await m.closeActive();
  assert.equal(mode._status, "Cannot close the last tab");
  await m.activate(1);
  await m.closeActive();
  assert.deepEqual(disposed, ["B"]);
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
  assert.equal(runtime.session, sA);
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
```

- [ ] **Step 2: Run test — verify new ones fail**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: new tests FAIL (`parseTabCommand is not a function`).

- [ ] **Step 3: Implement**

Append to `extensions/tab-manager.mjs`:
```js
export function parseTabCommand(text) {
  const t = (text ?? "").trim();
  if (!t.startsWith("/tab")) return null;
  if (t === "/tabnew" || t.startsWith("/tabnew ")) {
    const name = t.slice("/tabnew".length).trim();
    return { command: "tabnew", ...(name ? { name } : {}) };
  }
  if (t === "/tabclose") return { command: "tabclose" };
  if (t === "/tabrename" || t.startsWith("/tabrename ")) {
    const name = t.slice("/tabrename".length).trim();
    return name ? { command: "tabrename", name } : { command: "tabrename" };
  }
  return null;
}

export function hasOverlay(mode) {
  return Boolean(
    mode.extensionSelector ||
      mode.extensionInput ||
      mode.extensionEditor ||
      mode.activeSelectorToken,
  ) || mode.editor !== mode.defaultEditor;
}
```

Inside class `TabManager` (append the following methods):
```js
  _enqueue(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async createTab(name) {
    const result = await this.runtime.__piSessionTabsCreateTabSession(); // throws → caller surfaces
    const session = result.session;
    const tab = this.addTab(session, { name });
    if (name) {
      try {
        session.setSessionName(name);
      } catch {
        /* name is cosmetic; ignore */
      }
    }
    await this.activate(this.tabs.indexOf(tab));
  }

  async activate(index) {
    return this._enqueue(async () => {
      if (index === this.activeIndex || index < 0 || index >= this.tabs.length) return;
      const target = this.tabs[index];
      const prev = this.runtime.session;
      try {
        await this.runtime.__piSessionTabsAttachSession(target.session);
      } catch (err) {
        try {
          await this.runtime.__piSessionTabsAttachSession(prev);
        } catch {
          /* restore failed; registry still consistent via hooks */
        }
        this.mode.showStatus?.(`Tab switch failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      // Draft save/restore happens in onForegroundChanged (Task 9) — the attach
      // above already triggered rebind → hook. This guard is for direct attach
      // calls in tests without the hook wired.
      this._applyDrafts(prev, target.session);
    });
  }

  _applyDrafts(prevSession, nextSession) {
    const prevTab = this.findBySession(prevSession);
    if (prevTab && this.mode.editor) prevTab.draft = this.mode.editor.getText();
    const nextTab = this.findBySession(nextSession);
    if (nextTab && this.mode.editor) {
      nextTab.draft ??= "";
      this.mode.editor.setText(nextTab.draft);
    }
  }

  async cycle(dir) {
    const n = this.tabs.length;
    if (n < 2) return;
    await this.activate((this.activeIndex + dir + n) % n);
  }

  async closeActive() {
    if (this.tabs.length <= 1) {
      this.mode.showStatus?.("Cannot close the last tab");
      return;
    }
    const idx = this.activeIndex;
    const closing = this.tabs[idx];
    const neighbor = this.tabs[idx === this.tabs.length - 1 ? idx - 1 : idx + 1];
    await this.activate(this.tabs.indexOf(neighbor));
    try {
      closing.session.dispose(); // dispose-hook removes the tab from the registry
    } catch (err) {
      this.mode.showStatus?.(`Error closing tab: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.tabs.includes(closing)) this.removeTab(closing); // safety net if hook absent
    this.updateBar();
  }

  renameActive(name) {
    if (!name) {
      this.mode.showStatus?.("Usage: /tabrename <name>");
      return;
    }
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    try {
      tab.session.setSessionName(name);
    } catch (err) {
      this.mode.showStatus?.(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    tab.name = name;
    this.updateBar();
  }
```

- [ ] **Step 4: Run test — verify all pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/tab-manager.mjs test/tab-manager.test.mjs
git commit -m "feat: tab commands, activate/cycle/close lifecycle, per-tab drafts"
```

---

### Task 9: TabManager — reconciliation (onForegroundChanged, onSessionDisposed, shutdown)

**Files:**
- Modify: `extensions/tab-manager.mjs`
- Test: `test/tab-manager.test.mjs`

**Interfaces:**
- Produces: `onForegroundChanged(prev, next)` (runtime-driven replacements become new tabs; drafts reconciled), `onSessionDisposed(session)`, `shutdown()` (dispose all background tabs).

- [ ] **Step 1: Write the failing tests**

Append to `test/tab-manager.test.mjs`:
```js
test("onForegroundChanged registers runtime replacements as new tabs", () => {
  const sA = stubSession("A");
  const sR = stubSession("R"); // replacement from /new, /resume, /fork, /reload
  sR.sessionManager = { getSessionName: () => "replaced" };
  const runtime = { session: sA };
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a", draft: "draft-a" });
  m.onForegroundChanged(sA, sR);
  assert.equal(m.tabs.length, 2);
  assert.equal(m.tabs[1].name, "replaced");
  assert.equal(m.activeIndex, 1);
});

test("onSessionDisposed removes the tab", () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  m.activeIndex = 1;
  m.onSessionDisposed(sB);
  assert.equal(m.tabs.length, 1);
  assert.equal(m.activeIndex, 0);
  assert.equal(m.tabs[0].session, sA);
});

test("shutdown disposes background tabs and silences updates", () => {
  const sA = stubSession("A");
  const sB = stubSession("B");
  const disposed = [];
  const mode = stubMode(sA);
  const m = new TabManager({ mode });
  m.addTab(sA, { name: "a" });
  m.addTab(sB, { name: "b" });
  sB.dispose = () => disposed.push("B");
  m.shutdown();
  assert.deepEqual(disposed, ["B"], "background disposed, active kept (runtime disposes it)");
  assert.equal(m.shuttingDown, true);
  const bar = { update: () => { throw new Error("should not update after shutdown"); } };
  m.setBar(bar);
  m.updateBar(); // must no-op via shuttingDown guard
});
```

- [ ] **Step 2: Run test — verify new ones fail**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: new tests FAIL (`m.onForegroundChanged is not a function`).

- [ ] **Step 3: Implement**

Append inside `TabManager`:
```js
  onForegroundChanged(prev, next) {
    if (prev === next) return;
    this._applyDrafts(prev, next);
    let nextTab = this.findBySession(next);
    if (!nextTab) {
      const name = next.sessionManager?.getSessionName?.() || `tab ${this.tabs.length + 1}`;
      nextTab = this.addTab(next, { name });
    }
    this.activeIndex = this.tabs.indexOf(nextTab);
    this.updateBar();
  }

  onSessionDisposed(session) {
    const tab = this.findBySession(session);
    if (tab) this.removeTab(tab);
  }

  shutdown() {
    this.shuttingDown = true;
    this._unsubAlt?.();
    const active = this.runtime.session;
    for (const tab of [...this.tabs]) {
      if (tab.session === active) continue;
      try {
        tab.session.dispose();
      } catch {
        /* best effort */
      }
    }
  }
```

- [ ] **Step 4: Run test — verify all pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/tab-manager.mjs test/tab-manager.test.mjs
git commit -m "feat: foreground reconciliation, disposal removal, shutdown disposal"
```

---

### Task 10: Controller wiring — ensureManager, TabManager.attach, handleTabCommand

**Files:**
- Modify: `extensions/controller.mjs`, `extensions/tab-manager.mjs`
- Test: `test/controller.test.mjs` (append)

**Interfaces:**
- Produces: full `SessionTabsController.ensureManager(mode)` (guards + `TabManager.attach`), `handleTabCommand(cmd)`, `TabManager.attach(mode, { Container, Text })` (tab bar install, submit wrap, Alt+Left/Right listener), `handleTabCommand(manager, cmd)`. Adds `import { basename } from "node:path";` to `tab-manager.mjs` (Node builtin — keeps the module dependency-free otherwise).

**Wiring (exact):**
1. `ensureManager(mode)`:
   - Return existing manager when `this.mode === mode && this.manager`.
   - Skip with a warning (no crash) when: `!this.tui`, or mode lacks TUI wiring (`documentContainer`/`defaultEditor`/`ui?.addInputListener`), or the identity self-check fails (`this.InteractiveMode && !(mode instanceof this.InteractiveMode)`).
   - Otherwise `this.mode = mode; this.manager = TabManager.attach(mode, { Container: this.tui.Container, Text: this.tui.Text });`.
2. `TabManager.attach(mode, { Container, Text })`:
   - `const manager = new TabManager({ mode }); mode.__tabManager = manager;`
   - Initial tab: `manager.addTab(session, { name, draft: mode.editor?.getText?.() ?? "", boundBefore: true })` where `name = session.sessionManager?.getSessionName?.() || basename(mode.runtimeHost.cwd ?? process.cwd()) || "tab 1"` (wrapped in try/catch).
   - Tab bar: `manager.setBar(createTabBar({ Container, Text, theme: mode.createExtensionUIContext().theme, documentContainer: mode.documentContainer, requestRender: () => mode.ui?.requestRender?.() }))`.
   - Submit wrap: `manager._origSubmit = mode.defaultEditor.onSubmit; mode.defaultEditor.onSubmit = async (text) => { const cmd = parseTabCommand(text); if (cmd) { await handleTabCommand(manager, cmd); return; } return manager._origSubmit(text); };`
   - Alt+Left/Right listener via `mode.ui?.addInputListener` (matches CSI `\x1b[1;3D/C`, kitty `\x1b[1;3:<n>D/C`, legacy `\x1bb`/`\x1bf`); consumed only when `!hasOverlay(mode)`; store unsubscribe in `manager._unsubAlt`.
3. `handleTabCommand(manager, cmd)`: `tabnew` → `manager.createTab(cmd.name)`; `tabclose` → `manager.closeActive()`; `tabrename` → `manager.renameActive(cmd.name)`; each wrapped in try/catch → `manager.mode.showStatus?.(...)` on error.

- [ ] **Step 1: Write the failing tests**

Append to `test/controller.test.mjs`:
```js
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

test("ensureManager wires a stub mode once (bar, submit wrap, alt listener, initial tab)", () => {
  delete globalThis[CONTROLLER_KEY];
  const c = getController();
  c.tui = { Container: class {}, Text: class {} };
  class FakeInteractiveMode {}
  c.InteractiveMode = FakeInteractiveMode;
  const mode = fakeMode();
  Object.setPrototypeOf(mode, FakeInteractiveMode.prototype); // pass the instanceof self-check
  const m1 = c.ensureManager(mode);
  assert.ok(m1 instanceof TabManager);
  assert.equal(m1, c.manager);
  assert.equal(mode.__tabManager, m1);
  assert.equal(m1.tabs.length, 1);
  assert.equal(m1.tabs[0].name, "proj");
  assert.equal(mode.documentContainer.children.length, 1, "tab bar installed");
  assert.equal(typeof mode.defaultEditor.onSubmit, "function", "submit wrapped");
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
    c.tui = { Container: class {}, Text: class {} };
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
```

- [ ] **Step 2: Run test — verify new ones fail**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: new tests FAIL (`c.ensureManager is not a function`).

- [ ] **Step 3: Implement**

Add to `extensions/tab-manager.mjs` — import at the top:
```js
import { basename } from "node:path";
```
And append (module scope + class members):
```js
const ALT_LEFT_RE = /^\x1b\[1;3(?::\d+)?D$/;
const ALT_RIGHT_RE = /^\x1b\[1;3(?::\d+)?C$/;

export async function handleTabCommand(manager, cmd) {
  try {
    if (cmd.command === "tabnew") await manager.createTab(cmd.name);
    else if (cmd.command === "tabclose") await manager.closeActive();
    else if (cmd.command === "tabrename") manager.renameActive(cmd.name);
  } catch (err) {
    manager.mode.showStatus?.(`Tab command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Inside `TabManager` (static + helper):
```js
  static attach(mode, { Container, Text }) {
    const manager = new TabManager({ mode });
    mode.__tabManager = manager;

    const session = mode.runtimeHost.session;
    let name;
    try {
      name =
        session.sessionManager?.getSessionName?.() ||
        basename(mode.runtimeHost.cwd ?? process.cwd()) ||
        "tab 1";
    } catch {
      name = "tab 1";
    }
    manager.addTab(session, { name, draft: mode.editor?.getText?.() ?? "", boundBefore: true });

    manager.setBar(
      createTabBar({
        Container,
        Text,
        theme: mode.createExtensionUIContext().theme,
        documentContainer: mode.documentContainer,
        requestRender: () => mode.ui?.requestRender?.(),
      }),
    );

    manager._origSubmit = mode.defaultEditor.onSubmit;
    mode.defaultEditor.onSubmit = async (text) => {
      const cmd = parseTabCommand(text);
      if (cmd) {
        await handleTabCommand(manager, cmd);
        return;
      }
      return manager._origSubmit(text);
    };

    manager._unsubAlt = mode.ui?.addInputListener?.((data) => {
      const isLeft = ALT_LEFT_RE.test(data);
      const isRight = ALT_RIGHT_RE.test(data);
      if (!isLeft && !isRight && data !== "\x1bb" && data !== "\x1bf") return undefined;
      if (hasOverlay(mode)) return undefined;
      void manager.cycle(isLeft || data === "\x1bb" ? -1 : +1);
      return { consume: true };
    });

    return manager;
  }
```
(`createTabBar` must be imported at the top of `tab-manager.mjs`: `import { createTabBar } from "./tab-bar.mjs";`)

Add to `extensions/controller.mjs` — imports and methods:
```js
import { TabManager, handleTabCommand } from "./tab-manager.mjs";
```
Inside `SessionTabsController`:
```js
  ensureManager(mode) {
    if (this.mode === mode && this.manager) return this.manager;
    if (!this.tui) {
      console.warn("pi-session-tabs: TUI classes unavailable; tabs disabled.");
      return null;
    }
    if (!mode || !mode.documentContainer || !mode.defaultEditor || !mode.ui?.addInputListener) {
      console.warn("pi-session-tabs: TUI wiring unavailable; tabs disabled for this mode.");
      return null;
    }
    if (this.InteractiveMode && !(mode instanceof this.InteractiveMode)) {
      console.warn("pi-session-tabs: mode is not an InteractiveMode instance; tabs disabled.");
      return null;
    }
    this.mode = mode;
    this.manager = TabManager.attach(mode, { Container: this.tui.Container, Text: this.tui.Text });
    return this.manager;
  }

  async handleTabCommand(cmd) {
    if (!this.manager) return;
    await handleTabCommand(this.manager, cmd);
  }
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all pass (controller wiring tests included).

- [ ] **Step 5: Commit**

```bash
git add extensions/controller.mjs extensions/tab-manager.mjs test/controller.test.mjs
git commit -m "feat: controller wiring — ensureManager, tab bar install, command/alt-arrow interception"
```

---

### Task 11: Manual end-to-end verification

**Files:**
- Modify: none expected; bugfixes as discovered.

**Interfaces:**
- Consumes: the finished package, installed like any Pi package.

- [ ] **Step 1: Install the package and boot plain pi**

```bash
cd C:/Users/DELL
pi install ./pi-session-tabs
pi
```

Expected: Pi interactive mode boots with a tab bar row on top showing one tab (`[○ <name>]`), all existing UI intact. Note the installed location (`~/.pi/agent/npm/` or the local-path reference) and that plain `pi` was used — no launcher.

- [ ] **Step 2: Verify the checklist (DESIGN.md §Verification)**

Run each and record results:
1. `/tabnew a` then `/tabnew b` → three tabs; each a distinct session (verify via `/session` output and distinct session files under the agentDir sessions dir).
2. Alt+Right / Alt+Left cycle and wrap; with a selector open (e.g. `/model`), Alt+Left/Right still do their original action (fold/unfold), not tab cycling.
3. Conversation isolation: type a message in tab A, switch to B, switch back — A's history is intact and the transcript re-renders correctly.
4. Background execution: start a long-running task in A (e.g. a bash loop), switch to B — A keeps running (its tab glyph shows `●`), B's transcript shows no A output.
5. Status glyphs: `●` while a turn runs, `○` after `agent_settled`, `⚠` after a turn that ends in error (e.g. an invalid tool call that errors out).
6. `/tabclose`: closes the active tab, activates neighbor, history persists on disk; `/tabclose` on the last tab shows "Cannot close the last tab".
7. Drafts: type text in A, switch to B, back to A — draft preserved; new tabs start with an empty editor.
8. `/tabrename work` → tab label updates; `/name` also updates it; rename persists after restart of the session.
9. Re-attach: switching tabs does not re-show welcome/notices; no `session_start` spam (check extension logs if any).
10. `/reload` (or `/new`): old tab disappears, replacement session appears as a new tab; **after `/reload`, tabs still work** (controller idempotency — the extension module was re-imported).
11. Quit: no leaked background processes; all tabs' JSONL on disk.
12. Cleanup: `pi remove pi-session-tabs` then `pi` again — Pi runs unchanged (unpatched).

- [ ] **Step 3: Fix any issues found, re-run affected tests and the checklist item**

Each fix is its own commit, e.g.:
```bash
git add -A
git commit -m "fix: <described issue>"
```

- [ ] **Step 4: Commit final verification notes**

```bash
git add -A
git commit -m "docs: manual verification results"
```

---

### Task 12: README + polish

**Files:**
- Create: `README.md`

**Interfaces:**
- Produces: usage documentation.

- [ ] **Step 1: Write README.md**

`README.md` content: purpose (OpenCode v2-style multi-session tabs for Pi 0.84.1); **install** — `pi install npm:pi-session-tabs` (published) / `pi install git:github.com/<you>/pi-session-tabs` / `pi install ./pi-session-tabs` (local dev; to publish remove nothing — `files` already scopes the package — run `npm publish`, then `pi install npm:pi-session-tabs`); **use** — run plain `pi`; commands table (`/tabnew [name]`, `/tabclose`, `/tabrename <name>`, Alt+Left/Alt+Right); **architecture** (Pi package extension: Phase A top-level patch install before `new InteractiveMode`, controller on `globalThis`, 8 additive guards, TabManager + TabBar); **known limitations** (shared chrome last-writer-wins, tabs not restored across restarts, Alt+Left/Right shadow editor word movement while tabs are active, ASCII-width truncation, `needs_attention` is structural-error-based only, `session_start` fires once per session); **uninstall** — `pi remove pi-session-tabs` (Pi untouched); **requirements** — Pi 0.84.1 (patches are existence-guarded and degrade gracefully on other versions, with a best-effort warning).

- [ ] **Step 2: Run the full test suite once more**

Run: `cd C:/Users/DELL/pi-session-tabs && npm test`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: install, usage, and limitations"
```

---

## Self-Review

**1. Spec coverage (DESIGN.md §17 sections → tasks):**
- §17.1/17.2/17.3 package loading lifecycle (pre-InteractiveMode, alias identity, module singleton) → Task 3 (controller + index.ts Phase A) + Task 11 (manual boot) ✓
- §17.4 two-phase patch application → Task 3 (Phase A) + Task 10 (Phase B wiring) ✓
- §17.5 user start (`pi install` → `pi`) → Task 11, Task 12 ✓
- §17.6 compatibility (guards, identity self-check, version warn, namespaced methods) → Task 3 (checkVersion, ensureManager guards), Task 2 (namespaced + existence-guarded installPatches), Task 12 ✓
- §2 attach (namespaced `__piSessionTabsAttachSession`) → Task 2 ✓
- §3 TabManager → Tasks 7–9 ✓
- §4 creation/persistence (`__piSessionTabsCreateTabSession`, `SessionManager.create`) → Task 2, 8 ✓
- §5 foreground/background switching + drafts → Task 8 (activate) + Task 9 (onForegroundChanged) ✓
- §6 tab bar → Task 6 ✓
- §7 commands → Task 8 (parseTabCommand) + Task 10 (interception) ✓
- §8 Alt+Left/Right (overlay-gated) → Task 10 (regex incl. CSI/kitty/legacy forms) ✓
- §9 running/activity state → Task 7 ✓
- §10 needs_attention (structural only, ⚠) → Task 7 ✓
- §11 background UI isolation (identity guard, prompt cancel values) → Task 5 ✓
- §12 re-attach duplication (bindExtensions suppress) → Task 4 ✓
- §13 safe close + disposal → Task 8 (closeActive) + Task 9 (onSessionDisposed/shutdown) ✓
- §14 error handling → Task 5 (finally-hook in rebind), Task 8 (activate rollback, command errors), Task 9 (best-effort dispose), Task 10 (ensureManager skips) ✓
- §15 compatibility guards → Task 3 (checkVersion + identity self-check), Task 2 (existence-guarded install) ✓
- §17.10 resolved decisions (Q7 namespaced names, Q8 `.ts` entry, Q9 no notice) → Tasks 2–3 (names), Task 3 (index.ts), all tasks (no notice code) ✓

**2. Placeholder scan:** every task has concrete code and expected test output; no "TBD"/"similar to" steps. The only discovery-dependent items are resolved: loader alias behavior and module singletons (empirically verified), root exports (`AgentSession`, `AgentSessionRuntime`, `InteractiveMode`, `SessionManager` all exported from `dist/index.js`), overlay fields, escape codes, theme keys, pi-tui Container/Text API — all verified against 0.84.1 sources before writing this plan.

**3. Type/name consistency:** namespaced runtime members `__piSessionTabsAttachSession`/`__piSessionTabsCreateTabSession` used consistently in patches.mjs (install), tab-manager.mjs (calls), tests, and interfaces; wrapped Pi members (`bindExtensions`, `dispose`, `init`, `rebindCurrentSession`, `shutdown`, `createExtensionUIContext`) match the compiled 0.84.1 members; hook names (`onModeReady`, `onForegroundChanged`, `onSessionDisposed`, `onShutdown`, `isForeground`) consistent across patches.mjs / controller.mjs / tab-manager.mjs; `formatTabs(tabs, activeIndex, width)`, `createTabBar({...})`, `parseTabCommand`, `hasOverlay`, `TabManager.attach(mode, {Container, Text})` signatures match across tasks. `state` values are the locked `"idle"|"running"|"needs_attention"` everywhere.

**Known residual risk (documented, not plan-blocking):** real-rebind integration (attachSession → finishSessionReplacement → rebindCurrentSession) is exercised only in Task 11 manual verification (a TUI cannot be unit-tested headlessly); `checkVersion` depends on `import.meta.resolve` inside jiti and silently no-ops if unavailable (guards are the real safety); `TabManager.attach` imports `node:path` (builtin) for the initial tab name — no runtime dependency added.
