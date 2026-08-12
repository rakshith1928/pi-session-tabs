# Pi Multi-Session Tabs — Design Spec

**Target:** Pi `@earendil-works/pi-coding-agent` **0.84.1** (installed globally under nvm).
**Goal:** OpenCode v2-style multi-session tabs — each tab is a genuinely independent, concurrently live `AgentSession`, with a top tab bar, tab commands, and Alt+Left/Right cycling — while keeping Pi's existing `InteractiveMode`, TUI, editor, agent runtime, and session machinery untouched.
**Approach:** Project-local launcher + minimal additive prototype patches. No fork, no reimplementation, no `node_modules` modification, no history-array tab fakes.
**Status:** Design spec for review. No implementation yet.

---

## 0. Verified ground truth (0.84.1) the design relies on

All of the following were confirmed by reading the installed package's compiled JS and embedded source maps (`dist/core/agent-session-runtime.js`, `dist/core/agent-session.js`, `dist/modes/interactive/interactive-mode.js`, `dist/main.js`, `.d.ts` files). Compiled TypeScript `private` members are plain JS properties/methods (no `#` fields) — reachable from our launcher.

| Fact | Where |
|---|---|
| `AgentSession` is fully independent (own `Agent`, `SessionManager`, internal persistence/compaction/retry listener `_handleAgentEvent`, own extension runner, own tool hooks). Background sessions keep running, persisting, auto-compacting with zero UI involvement. | `agent-session.ts:610, 397` |
| `AgentSession.subscribe(listener)` is per-session and returns an unsubscribe. `isStreaming` / `isIdle` getters. | `agent-session.ts:815, 878, 883` |
| `AgentSession.bindExtensions(bindings)` is **public** and rebinds the extension runner with a fresh `uiContext`/`mode`/`commandContextActions`/handlers. It always emits `_sessionStartEvent` and re-discovers resources. | `agent-session.ts:2237` |
| `AgentSession.setSessionName(name)` persists via `sessionManager.appendSessionInfo(name)` and emits `session_info_changed`. | `agent-session.ts:2883` |
| `AgentSessionRuntime` compiled privates: `_session`, `_services`, `createRuntime` (factory), `_diagnostics`, `_modelFallbackMessage`. Public: `session`, `services`, `cwd`, `setRebindSession`, `setBeforeSessionInvalidate`. Private: `apply(result)`, `finishSessionReplacement(withSession?)` (fires `rebindSession?.(this.session)`). | `agent-session-runtime.js` |
| `CreateAgentSessionRuntimeFactory` = `({cwd, agentDir, sessionManager, sessionStartEvent?, projectTrustContext?}) => Promise<CreateAgentSessionRuntimeResult>` where result has `{session, services, extensionsResult, diagnostics, modelFallbackMessage}`. The CLI's own `createRuntime` closes over session options (model scoping, thinking, tools) — the canonical way to create a consistent new session. | `sdk.d.ts`, `main.js:640-680` |
| `InteractiveMode` constructor installs `runtimeHost.setBeforeSessionInvalidate(() => this.resetExtensionUI())` and `runtimeHost.setRebindSession(async () => this.rebindCurrentSession({ renderBeforeBind: true }))`. | `interactive-mode.ts:533-538` |
| `rebindCurrentSession({renderBeforeBind})` = unsubscribe agent listener → `applyRuntimeSettings` (footer binds `this.session`) → if renderBeforeBind: `renderCurrentSessionState()` + `subscribeToAgent()` → `bindCurrentSessionExtensions()` → (if session unchanged) `subscribeToAgent()` → update provider count / editor border / terminal title. | `interactive-mode.ts:1922` |
| `renderCurrentSessionState()` clears loaded-resources/chat/pending/streaming/tool UI and calls `renderInitialMessages()`, which rebuilds the transcript from `this.sessionManager.buildContextEntries()` (getter → current session's manager). **Swapping the runtime session therefore re-renders the correct transcript automatically.** | `interactive-mode.ts:1957, 3693` |
| `bindCurrentSessionExtensions()` calls `this.session.bindExtensions({uiContext: createExtensionUIContext(), mode:"tui", abortHandler, commandContextActions, shutdownHandler, onError})`, then `setRegisteredThemes`, `setupAutocompleteProvider`, `setupExtensionShortcuts(runner)`, `showLoadedResources({force:false})`, `showStartupNoticesIfNeeded()`. | `interactive-mode.ts:1817` |
| `showStartupNoticesIfNeeded()` is already one-shot (`startupNoticesShown` flag). | `interactive-mode.ts:427, 741` |
| Editor submit handler routes everything through `this.session` (getter for `runtimeHost.session`): commands → handlers, `!` → bash, compaction → queue, streaming → `this.session.prompt(text, {streamingBehavior:"steer"})`, idle → `onInputCallback`/`pendingUserInputs`. **Swapping `_session` redirects all input routing automatically.** | `interactive-mode.ts:2870` |
| Compiled privates on InteractiveMode: `ui`, `documentContainer`, `headerContainer`, `builtInHeader`, `defaultEditor`, `editor`, `statusContainer`, `footer`, `footerDataProvider`, `runtimeHost`, `keybindings`, `unsubscribe`, `activeStatusIndicator`, `extensionSelector/Input/Editor`, `extensionTerminalInputSubscriptions`, methods `resetExtensionUI`, `setupEditorSubmitHandler`, `subscribeToAgent`, `bindCurrentSessionExtensions`, `rebindCurrentSession`, `renderCurrentSessionState`, `createExtensionUIContext`, `isExtensionCommand`, `showError`, `showStatus`, `getUserInput`. | `interactive-mode.js` |
| `ui.addInputListener(handler)` (returns unsubscribe) is the extension raw-input mechanism — idiomatic way to intercept keys before the focused component. Handler returns `{consume?, data?} | undefined`. | `interactive-mode.ts:2303` |
| Extension UI context methods (`select`, `confirm`, `input`, `notify`, `editor`, `custom`, `setWidget`, `setFooter`, `setHeader`, `setStatus`, `setWorkingMessage/Visible/Indicator`, `setHiddenThinkingLabel`, `pasteToEditor`, `setEditorText`, `setEditorComponent`, `addAutocompleteProvider`, `onTerminalInput`, `setTitle`, `setToolsExpanded`, …) all mutate shared TUI chrome via the single mode instance. | `interactive-mode.ts:2344` |
| `main.js` flow: build `createRuntime` factory → `createAgentSessionRuntime(createRuntime, {cwd, agentDir, sessionManager})` → `new InteractiveMode(runtime, opts)` → `init()` → `run()`. `dist/cli.js` top-level: `main(process.argv.slice(2))`. | `main.js:675-790` |
| Pi's default keybindings reserve Alt+Left/Alt+Right for editor word movement and tree fold/unfold. | keybindings manager |
| No `awaiting_auth` event exists in `AgentSessionEvent`. Auth failures surface as message errors (`formatNoApiKeyFoundMessage`, "Authentication failed…", "Run /login …"). | `agent-session.d.ts`, `agent-session.ts:438` |

---

## 1. Project-local launcher / bootstrap

**Location:** a self-contained project-local package, e.g. `C:/Users/DELL/pi-session-tabs/` (movable into any project; nothing depends on its absolute path).

```
pi-session-tabs/
├── package.json          # name pi-session-tabs, "type": "module", bin: { "pi-tabs": "src/launcher.mjs" }
├── src/
│   ├── patches.mjs       # additive prototype patches (runtime attachSession, bindExtensions wrap, dispose hook)
│   ├── tabs.mjs          # TabManager + per-tab status derivation (JSDoc-typed)
│   ├── tab-bar.mjs       # tab bar TUI component (theme-aware)
│   └── launcher.mjs      # entry: apply patches → boot real CLI
└── DESIGN.md
```

**Runtime:** plain ESM `.mjs` with JSDoc types — zero build step, runs with the system `node` (`node src/launcher.mjs`). TypeScript is unnecessary here: the patched surfaces are private members absent from `.d.ts`, so we would cast to `any` anyway; JSDoc types give the same documentation value without a compiler. (TS/tsx variant is a trivial swap if preferred.)

**Dependency & module identity (critical):** `launcher.mjs` does

```js
import { AgentSessionRuntime, InteractiveMode } from "@earendil-works/pi-coding-agent";
installPatches();                    // additive, existence-guarded
await import("@earendil-works/pi-coding-agent/dist/cli.js");  // boots the real app
```

Both specifiers resolve to the same absolute files, so the ESM registry yields **one** set of class objects — the CLI constructs `InteractiveMode` from the already-patched prototype. `package.json` declares `@earendil-works/pi-coding-agent` as a dependency pinned to `0.84.1` so resolution is deterministic from the project folder (the global nvm install is a fallback if absent locally).

**Runtime guards:**
- After patching, verify `AgentSessionRuntime.prototype.attachSession` exists and that the class object identity matches what the CLI will use; otherwise print a warning and continue without tabs (never crash).
- Check installed version against `0.84.1` (read `node_modules/@earendil-works/pi-coding-agent/package.json`); warn on mismatch — patches are existence-guarded regardless.
- `process.argv`, stdio, TTY, env all pass through untouched (`cli.js` reads them itself).

---

## 2. Runtime `attachSession()` patch — the non-destructive seam

**The one mandated new API** (additive; no existing behavior changes):

```js
// AgentSessionRuntime.prototype.attachSession
if (typeof AgentSessionRuntime.prototype.attachSession !== "function") {
  AgentSessionRuntime.prototype.attachSession = async function (session) {
    if (session === this._session) return;          // no-op re-attach
    this._session = session;                        // plain property (verified)
    await this.finishSessionReplacement();          // fires InteractiveMode's rebind callback
  };
}
```

**Exact lifecycle:**
1. `_session` is swapped **without** `teardownCurrent()` — no `abort()`, no `session_shutdown` emit, no `dispose()`, no `beforeSessionInvalidate`. The outgoing session stays alive and keeps running in the background.
2. `finishSessionReplacement()` invokes the rebind callback InteractiveMode installed in its constructor → `rebindCurrentSession({ renderBeforeBind: true })`.
3. `rebindCurrentSession` then performs the complete, existing foreground swap: unsubscribe old agent listener → `applyRuntimeSettings` (footer binds new session) → `renderCurrentSessionState()` (clears chat/tools/streaming, re-renders transcript from **new** session's context entries) → `subscribeToAgent()` → `bindCurrentSessionExtensions()` (fresh UI context for the new session; see §11/§12) → title/border/provider-count refresh.

**Guarantees provided for free by the existing machinery:** transcript swap, footer/session metadata swap, per-session event subscription swap, input-routing redirection (all editor submit paths dereference `this.session` at call time), extension command execution targeting the new session.

**Failure semantics:** `finishSessionReplacement` can throw if `bindCurrentSessionExtensions` throws (extension load error). Callers (TabManager) must catch, re-attach the previous session, and surface the error (§14).

**Concurrency:** a session running in the background is never interrupted by attach; its steer/follow-up queues remain its own. TabManager serializes attaches with a simple promise queue (see §5).

---

## 3. Tab / session manager

`tabs.mjs` defines `TabManager` — one instance per launcher run, bound to the single `InteractiveMode` instance. It is the only owner of tab-registry state; InteractiveMode and patches stay dumb.

**Tab record:**
```js
{ id: string,            // session.sessionId
  name: string,          // session name or "tab N"
  session: AgentSession,
  state: "idle" | "running" | "awaiting",   // §9/§10
  firstBind: boolean,    // true until its first bindExtensions emit (§12)
  unsubscribe?: () => void }
```

**Registry invariants:**
- Tabs are ordered (`tabs[]`); active index tracked. Active tab's `session` always equals `runtimeHost.session`.
- A session appears in at most one tab.
- `isForeground(sessionId)` and `hasBoundBefore(session)` are the identity queries used by the UI-context guard (§11) and re-attach suppression (§12).

**Hooks installed by TabManager (all additive, instance-level, existence-guarded):**

| Hook | Purpose |
|---|---|
| Wrap `InteractiveMode.prototype.init` | After original `init()` completes: register the CLI-created session as tab 0 (name from `sessionManager.getSessionName()` or `cwd` basename or "tab 1"), install tab bar (§6), register /tabnew /tabclose /tabrename as Pi slash commands, register Alt+arrow listener (§8), wire per-tab status subscriptions. |
| Wrap `InteractiveMode.prototype.rebindCurrentSession` | Detect foreground changes from **any** source (attach, or destructive `/new` `/resume` `/fork` `/reload`): capture previous session, call original, then reconcile registry — if new session not in registry, add a tab entry; re-install tab bar (idempotent). |
| Wrap `AgentSession.prototype.dispose` | Remove the disposed session's tab from the registry (covers `/tabclose` and destructive replacement teardown). Runs after original dispose. |
| Wrap `AgentSession.prototype.bindExtensions` | First-bind vs re-attach discrimination + startup-emit suppression (§12). |
| Wrap `AgentSession.prototype.dispose` on shutdown path (`InteractiveMode.prototype.shutdown`/`stop`) | `disposeAllBackground()` — dispose every non-active tab so no agent/bash/model handles leak at exit (§14). |

**Registration rules:**
- **tab 0:** the CLI's session, registered at init-wrap time.
- **`/tabnew`:** create (§4) + push + activate.
- **Runtime-driven replacement** (destructive commands): old session disposed → tab removed via dispose-hook; new session appears in rebind-hook as a new tab. Net effect: `/new`, `/resume`, `/fork`, `/reload` become "replace active tab with a new tab" — matching Pi semantics, now visible in the bar.

---

## 4. Session creation and persistence

**Creation:** each tab gets a real, independently persisted `AgentSession`, created through the runtime's own `createRuntime` factory (the same factory the CLI uses) so model scoping, thinking level, tool configuration, and extension loading stay consistent with the app:

```js
const result = await runtimeHost.createRuntime({
  cwd: runtimeHost.cwd,
  agentDir: runtimeHost.services.agentDir,
  sessionManager: SessionManager.create(runtimeHost.cwd),   // new JSONL session file
});
return result.session;   // NOT attached yet
```

- `createRuntime` is a compiled plain property on the runtime instance (verified). Expose it either as a second small additive patch `AgentSessionRuntime.prototype.createTabSession()` (recommended — keeps TabManager from reaching into privates with `as any`; ~6 lines, same additive discipline) **or** via a single documented `(runtimeHost as any).createRuntime(...)` cast. Both are acceptable; prefer the patch for type clarity. *(Open question Q5.)*
- **Persistence:** `SessionManager.create(cwd)` gives each tab its own JSONL session file — same persistence contract as `/new`. Every tab auto-persists via its own internal `_handleAgentEvent` (message_end → append). No manual save logic needed.
- **Startup event:** the new session's `_sessionStartEvent` defaults to `{type:"session_start", reason:"startup"}` and is emitted on its **first** `bindExtensions` (which happens at first attach). Correct semantics: a tab's startup is its creation/activation.
- **Restart behavior:** the CLI resumes the last session as tab 0; previously opened tabs are *not* restored (they remain on disk, discoverable via `/resume`). Restoring a whole tab set across restarts is out of scope (future work).
- **Naming:** `/tabnew <name>` → `setSessionName(name)` immediately; default names are sequential ("tab 2", …).

---

## 5. Foreground / background switching

`TabManager.activate(index)` (and cycle/close variants) runs:

1. **No-op** if already active.
2. **Serialize** with the TabManager attach-queue (one attach at a time; guards against interleaving with a destructive command mid-flight).
3. `await runtimeHost.attachSession(target.session)` → §2 full rebind sequence.
4. **Guarantees:**
   - Foreground listener for the outgoing session is unsubscribed; only the active session's events reach the shared chat/streaming/tool UI.
   - Background session keeps running: its internal persistence listener, tool hooks, extension runner, and steer/follow-up queues are untouched; its `prompt()` continues.
   - All new editor input routes to the active session (§2, verified submit-handler dereference).
   - Foreground transcript is re-rendered from the active session's entries by existing machinery (verified).
5. **Shared state (documented limitations):**
   - The editor is shared — draft text carries across tabs (no per-tab drafts). *(Open question Q2.)*
   - Footer/header/widgets/status chrome is shared, last-writer-wins, cleared on attach (§11/§12).
6. **During streaming:** switching mid-stream is supported; the outgoing session's stream continues in the background (its events only update its own tab glyph). Input typed after the switch steers the *new* active session.

---

## 6. Tab bar component and layout

**Placement:** a dedicated `tabBarContainer` (a `Container` with a horizontal row layout) inserted as the **first child of `documentContainer`**, i.e. a full-width row **above** the existing `headerContainer` (logo/hints row stays as-is). This survives `resetExtensionUI()` (which only mutates extension chrome, never `documentContainer` children) and every rebind.

**Rendering** (theme-aware, no animation):
- Built from Pi's native primitives: an `HStack` of per-tab `Box`es (each containing a
  `TruncatedText` label) plus a `+` new-tab `Box`. `HStack` owns width allocation
  (`basis:"auto"` + `shrink` + `minSize`), so tabs size to their name and shrink
  safely when space is tight; `TruncatedText` keeps each label on a single line.
- **Active tab:** filled with the theme `accent` background; inactive tabs are subdued
  (no fill).
- **Status glyph** (per-tab, §9/§10):
  - `○` idle
  - `●` running (glyph flips on state change only, then `ui.requestRender()`)
  - `⚠` awaiting/attention (derived, §10)
- Each non-new tab shows a `×` close control; the new-tab box shows `+`.
- A subtle separator line between the tab bar and the header row (optional, theme color).

**Refreshing:** state changes from per-tab subscriptions call `tabBar.invalidate()` + `ui.requestRender()`. Theme changes re-render via the existing theme hook (no extra wiring).

**Interaction:** native keyboard only — there is **no focus mode** (intentionally not
implemented: Pi 0.84.1 binds every clean key, so no free key exists for a tab-navigation
toggle). Tabs are cycled with Alt+Left/Right intercepted at the TUI raw-input level (§8),
and `/tabnew` `/tabclose` `/tabrename` are registered Pi slash commands (§7). **Mouse
clicks are NOT a Pi 0.84.1 native capability** (the `Component` interface is render +
optional keyboard only) and are deferred to a future OSC8-link enhancement (not shipped
in V1).

---

## 7. `/tabnew`, `/tabclose`, `/tabrename`

Registered as Pi slash commands via `registerTabCommands` (commands.mjs); Pi dispatches
them through `prompt()` → `_tryExecuteExtensionCommand` **before** the editor sees input:

```js
// commands.mjs — delegate each handler to the controller's manager
pi.registerCommand("tabnew",  { description: "…", handler: async (args) => getController().handleTabCommand("/tabnew " + args) });
pi.registerCommand("tabclose", { description: "…", handler: async () => getController().handleTabCommand("/tabclose") });
pi.registerCommand("tabrename", { description: "…", getArgumentCompletions: suggestTabNames, handler: async (args) => getController().handleTabCommand("/tabrename " + args) });
```

The original handler is untouched, so all existing commands, extension commands, `!` bash, compaction queueing, and streaming-steer routing keep working (they dereference `this.session` dynamically → target the active tab).

| Command | Behavior |
|---|---|
| `/tabnew [name]` | Create session (§4) → push tab → `setSessionName(name?)` → activate. Works while another tab streams. Errors surface via the mode's standard error path (§14). |
| `/tabclose` | If >1 tab: choose target = next tab (else previous) → `activate(target)` → unsubscribe target's status listener → `target.session.dispose()` (aborts any run, flushes persistence). The closed session's JSONL remains on disk, resumable via `/resume`. If it is the **last** tab: show a status message "Cannot close the last tab" and do nothing (no confirm dialog — smallest implementation; the closed session's history is never lost because it is persisted). |
| `/tabrename <name>` | `active.session.setSessionName(name)` → persisted (§0) + `session_info_changed` event → tab label updates. No argument → status message with usage. |

Edge: `/tabclose` while the active tab is mid-stream — activate the neighbor first (attach is safe mid-stream), then dispose the outgoing (dispose aborts its agent run; its partial turn is persisted by its own listener).

---

## 8. Alt+Left / Alt+Right

**Default Pi behavior:** Alt+Left/Right = editor word movement; in tree selectors = fold/unfold. Requirement: cycle tabs with Alt+Left/Right **without breaking Pi's editor behavior**.

**Design:** intercept at the TUI raw-input layer (the idiomatic extension mechanism — same one `createExtensionUIContext().onTerminalInput` uses):

```js
const unsub = mode.ui.addInputListener((data) => {
  const isAltLeft  = data === "\x1b[1;3D";
  const isAltRight = data === "\x1b[1;3C";
  if (!isAltLeft && !isAltRight) return undefined;
  if (overlayOpen(mode)) return undefined;          // selector/extension-input/extension-editor open → pass through
  if (mode.editor !== mode.defaultEditor) return undefined; // custom editor active → pass through
  tabManager.cycle(isAltLeft ? -1 : +1);
  return { consume: true };                          // editor never sees the key
});
```

- **Consumed only when** the default editor is the focused surface **and** no modal overlay (selector, extension input, extension editor, login dialog, status overlay) is open.
- **Everywhere else** (tree selectors with fold/unfold, extension editors, dialogs), the key passes through untouched → existing behavior preserved.
- **Deliberate, documented trade-off:** while tabs are active, Alt+Left/Right in the editor cycles tabs instead of moving by word — this is the user-requested binding; it is confined to the tab layer (Pi's keybinding config is untouched, and running plain `pi` restores word movement). If that trade-off is unacceptable, the fallback is Ctrl+Tab / Ctrl+Shift+Tab for editor-focus cycling while Alt+arrows keep word movement. *(Open question Q1.)*
- No rebinding of `KeybindingsManager`; no config file changes; the interception is a raw-input consumer, removed on shutdown.

---

## 9. Per-session running / activity state

Per-tab state machine fed by that session's own `subscribe()` listener (registered when the tab is created and again… no — once, at creation; the subscription is **per-session**, independent of foreground/background):

| Event | State transition |
|---|---|
| `agent_start` (or `turn_start`/`message_start` of assistant role) | → `running` |
| `agent_settled` | → `idle` |
| `compaction_start` | → `running` (busy) |
| `compaction_end` | → recompute from `session.isStreaming` |
| initialization | `session.isStreaming ? "running" : "idle"` |

- The subscription lives for the tab's lifetime (unlike the foreground UI listener, which is swapped on attach). Background turns update the tab's glyph without touching the foreground transcript.
- `updateTerminalTitle` continues to reflect the active session (existing behavior — untouched).
- No timers, no polling: strictly event-driven + initial getter.

---

## 10. Permission / attention state

**Constraint from requirements:** show an `awaiting`/attention state per tab while **avoiding unreliable heuristics** where possible.

**Reality (verified):** there is no `awaiting_auth` event; auth/permission problems surface as agent message errors (`formatNoApiKeyFoundMessage`, "Authentication failed for provider …", "Credentials may have expired …", "Run /login …"). InteractiveMode's own login flows (`/login`, OAuth selector) are foreground actions on the active session.

**Design — conservative derivation, cosmetic only:**
- A tab enters `awaiting` **only** when all of: (a) its last completed turn ended with `stopReason: "error"`, and (b) the error text matches a small allowlist of known auth/permission markers (the three message templates above plus "permission" / "not trusted"), and (c) the session is now idle.
- The marker set is explicit and version-scoped; anything unrecognized stays `idle`.
- `awaiting` is cleared on the next `agent_start` or when the user logs in (we do not attempt to detect login completion — it clears naturally on the next turn).
- The glyph is purely informational; no behavior depends on it.

**Rationale:** this avoids a flapping, untrustworthy "awaiting" indicator. If the user prefers zero heuristics, the fallback is to drop the `awaiting` state entirely and show only `idle`/`running` (+ last-error tooltip). *(Open question Q6.)*

---

## 11. Background extension UI isolation

**Problem:** `bindExtensions` stores one `uiContext` per session (created at its last attach). If a *background* session's extension (or a background agent turn executing an extension command) calls `ui.select` / `ui.confirm` / `ui.input` / `ui.editor` / `ui.custom` / `ui.setWidget` / `ui.setFooter` / `ui.setHeader` / `ui.setStatus` / `ui.notify` / `ui.pasteToEditor` / `ui.setEditorText` / `ui.setEditorComponent` / `ui.addAutocompleteProvider` / `ui.setTitle` / `ui.setToolsExpanded`, it would render into the **shared foreground TUI** and corrupt the visible tab.

**Design — identity-guarded UI context.** Wrap `createExtensionUIContext()` so the returned context is tagged with the session it is created for (`this.session.sessionId` at creation time — during `bindCurrentSessionExtensions`, `this.session` is the session being bound). Every mutating method becomes:

```
if (tabManager.isForeground(taggedSessionId)) → original behavior
else → resolve immediately with the "cancelled" value (select→undefined, confirm→false, input→undefined, editor→undefined, custom→resolve immediately, others→no-op)
```

**Critical detail:** guarded methods must **resolve promptly** with cancel semantics, never block — a background extension awaiting `ui.input()` must get `undefined` back, not a hung promise.

- `onTerminalInput(handler)`: returns a wrapper that checks foreground identity **at invocation time** and returns `undefined` (not consumed) when backgrounded — no unsubscribe bookkeeping needed.
- Read-only getters (`getEditorText`, `getEditorComponent`, `getToolsExpanded`) return safe defaults when backgrounded.
- Because the guard is checked at call time against the *current* foreground session, stale context objects (from earlier binds) remain safe — this is what makes re-binding a fresh uiContext on re-attach a convenience rather than a correctness requirement.

**Chrome clearing on attach:** when switching tabs, call `mode.resetExtensionUI()` (instance-level, via wrap) before the rebind, so the outgoing session's footer/header/widgets/status don't bleed into the incoming tab, then re-install the tab bar afterwards. This deliberately gives each tab a clean chrome slate (extension chrome re-appears event-driven); per-tab chrome persistence is out of scope.

---

## 12. Re-attach behavior — avoiding duplicate `session_start` / notices

**Verified:** `bindCurrentSessionExtensions` runs on *every* rebind (including every tab attach) and calls `session.bindExtensions(...)`, which **re-emits `_sessionStartEvent`** to that session's extensions and **re-discovers extension resources** (rebuilding the session's system prompt). `showStartupNoticesIfNeeded` is already one-shot (safe); `showLoadedResources({force:false})` only shows on change (safe).

**Design — suppress startup emission on re-attach.** Wrap `AgentSession.prototype.bindExtensions`:

```js
const orig = AgentSession.prototype.bindExtensions;
AgentSession.prototype.bindExtensions = async function (bindings) {
  const self = this;
  const first = !self.__tabsFirstBind;
  self.__tabsFirstBind = true;
  if (first) return orig.call(this, bindings);   // full startup: emit + resource discovery
  // Re-attach: apply the binding fields + rebind the runner, skip startup emit + resource rediscovery.
  for (const key of ["uiContext","mode","commandContextActions","abortHandler","shutdownHandler","onError"]) {
    if (bindings[key] !== undefined) self[`_extension${...}`] = ...; // mirrors original field copies
  }
  self._applyExtensionBindings(self._extensionRunner);
};
```

- **First bind** (tab creation / CLI startup): unchanged — `session_start` emitted exactly once.
- **Re-attach:** the session's extension runner gets the fresh `uiContext`/`mode`/`commandContextActions`/handlers and `_applyExtensionBindings` (setUIContext/bindCommandContext/onError) — everything needed for correct foreground routing and identity guarding — while **skipping** the `session_start` re-emit and resource rediscovery (which would otherwise churn the background session's system prompt on every switch).
- This is the one moderately invasive patch (mirrors ~10 lines of a private method). It is existence-guarded and version-pinned; if `_applyExtensionBindings` or the field names are absent in a future build, the patch skips itself and we fall back to accepting the duplicate emit (documented degradation, no crash).

**Net result:** no welcome spam, no per-switch system-prompt rebuild, no duplicate resource discovery; extension chrome is re-established event-driven (per §11).

---

## 13. Safe tab closing and session disposal

- **`/tabclose`** (§7): attach neighbor → unsubscribe status listener → `dispose()`. `dispose()` (verified) aborts retry/compaction/branch-summary/bash, `agent.abort()`, invalidates the extension ctx, disconnects the agent listener, clears listeners, cleans session resources. The dispose-hook removes the tab from the registry.
- **Destructive Pi commands** (`/new`, `/resume`, `/fork`, `/reload`): unchanged semantics — the runtime tears down the old session (which our dispose-hook removes from the registry) and the rebind-hook registers the replacement as a new tab.
- **No disposal on backgrounding:** switching tabs never disposes; only explicit close or destructive commands do.
- **Shutdown** (`/quit`, Ctrl+C ×2): wrap `shutdown`/`stop` — set `tabManager.shuttingDown = true` (status handlers no-op), dispose all background tabs (abort agent/bash, close handles), then run original shutdown (which disposes the active session via `runtimeHost.dispose()`). Ensures no leaked model requests or bash processes at exit; persistence is already flushed by each session's listener.

---

## 14. Error handling and cleanup

| Failure | Handling |
|---|---|
| `createTabSession` throws (extension load, model, services) | Surface via the mode's standard error path (`showError` via instance access; fallback: footer status). No registry mutation. |
| `attachSession` throws mid-rebind (extension error in `bindCurrentSessionExtensions`) | TabManager catches, re-attaches the previous session, shows the error, keeps registry consistent (active index restored). |
| Background session turn fails | Agent handles internally; tab glyph shows last-error attention only per §10; no crash. |
| Rebind hook throws | Wrapped in try/catch; registry reconciliation best-effort; error surfaced. |
| Patch guard failures (missing private members in a future build) | Patches skip themselves; launcher warns; app runs without tabs. |
| Shutdown | §13 — all sessions disposed; listeners unsubscribed; `shuttingDown` flag silences status callbacks during teardown. |
| Double-attach / interleaved attach | TabManager attach-queue serializes; `attachSession` is a no-op when already current. |

---

## 15. Compatibility / update risks (0.84.1)

1. **Pinned version:** package.json pins `@earendil-works/pi-coding-agent@0.84.1`; launcher reads the installed version and warns on mismatch.
2. **Private-member coupling:** the design touches `_session`, `finishSessionReplacement`, `createRuntime`, `_applyExtensionBindings`, `rebindCurrentSession`, `renderCurrentSessionState`, `bindCurrentSessionExtensions`, `createExtensionUIContext`, `resetExtensionUI`, `defaultEditor`, `documentContainer`, `ui`, `showError`. All verified as plain JS members in 0.84.1. Risk: a future version could switch to `#`-private fields or rename members → every patch is existence-guarded and fails **soft** (feature disabled + warning, never a crash).
3. **Module identity:** patches apply only if the launcher and the CLI share one module instance (same resolved path). Local dependency pin guarantees this; a post-patch verification assert catches silent drift.
4. **Keybinding shadowing:** Alt+Left/Right word movement is deliberately shadowed in the editor while tabs are active (§8); reversible by running plain `pi`. Tree-selector fold/unfold and other surfaces unaffected.
5. **Extension behavior change:** `session_start` fires once per session, not per foreground-switch (§12). Extensions that legitimately react to `session_start` on each switch would previously have relied on destructive replacement — now they don't fire on tab switches. Documented, intentional.
6. **Shared chrome:** footer/header/widgets are last-writer-wins and cleared on attach (§11) — a deliberate simplification vs. per-tab chrome (documented limitation).
7. **No `node_modules` modification:** all changes live in the project-local package; uninstalling the launcher leaves Pi pristine.

---

## Verification checklist (maps to the original success criteria)

1. `/tabnew a` then `/tabnew b` → three tabs render in the bar; each is a real session (distinct `sessionId`, distinct session file on disk).
2. Alt+Right/Left cycles and wraps; selector overlays keep their fold/unfold; word movement is gone in the editor only while tabs are active.
3. Conversation isolation: message history per tab preserved after switching back (transcript re-renders from the correct session).
4. Background execution: start a long task in tab A, switch to B — A keeps running (check its agent events), B's transcript/status show no A output; B's input routes only to B.
5. Status glyphs: `running` on `agent_start`, `idle` on `agent_settled`, `awaiting` only on verified auth/permission error patterns.
6. `/tabclose` on a multi-tab bar closes the right tab, activates a neighbor, persists history; last-tab close is refused with a message.
7. Session failure: a tab whose turn errors does not crash the app; glyph shows attention only per §10.
8. Re-attach: no duplicate welcome/notices; system prompt unchanged across switches (no resource rediscovery churn).
9. Quit: no leaked background processes; all tabs' sessions persisted on disk.
10. `pi` (unpatched) still runs exactly as before.

## Out of scope (future work)

- Restoring a full tab set across restarts.
- Per-tab editor drafts, scrollback, and extension chrome.
- Mouse support on the tab bar (deferred OSC8-link hack; not in V1).
- Tab drag/reorder; tab overflow menu.

## Open questions for review

- **Q1:** Accept Alt+Left/Right shadowing editor word movement while tabs are active (per your explicit binding request), or switch to Ctrl+Tab / Ctrl+Shift+Tab for editor-focus cycling?
- **Q2:** Shared editor draft across tabs (no per-tab draft) acceptable?
- **Q3:** Keep `/new`, `/resume`, `/fork`, `/reload` as destructive "replace active tab" (removing the old tab), rather than mapping `/new` → `/tabnew`?
- **Q4:** Tabs are not restored across restarts (only the last session resumes as tab 0); the rest are on disk via `/resume`. Acceptable?
- **Q5:** Add a second small additive patch `AgentSessionRuntime.prototype.createTabSession()` (recommended), or reach into the private `createRuntime` from TabManager with a documented cast?
- **Q6:** Keep the conservative `awaiting` derivation (§10), or drop it to two states (`idle`/`running`) with a last-error tooltip?

---

# §17 Package Delivery (V2 — replaces the standalone launcher)

**Decision (2026-08-12, user-directed):** ship session tabs as a **normal Pi package** installed via `pi install`, loaded automatically by plain `pi`. No launcher, no `node pi-tabs.mjs`, no env var. Normal `pi` = session tabs available.

## 17.1 Feasibility verdict

**Package-only delivery is technically feasible in Pi 0.84.1.** The runtime patch can be applied from inside the package before InteractiveMode needs it. Evidence (all verified against the installed 0.84.1 source and empirically):

| # | Claim | Evidence |
|---|-------|----------|
| E1 | Extension modules load **before** `new InteractiveMode(...)` | `dist/main.js`: `createAgentSessionRuntime` (line 675) → runtime `apply()` → `createRuntime` factory (`core/sdk.js` 76–78: `await resourceLoader.reload()` inside `createAgentSessionServices`, which also awaits `loadFinalExtensionSet` → `loadExtensionsCached` at `core/resource-loader.js` 318/411) — all **before** `new InteractiveMode` (main.js 746) and `init()` (757) |
| E2 | An extension's `import "@earendil-works/pi-coding-agent"` returns **the same class objects** as the host | `core/extensions/loader.js`: jiti aliases `@earendil-works/pi-coding-agent` → host `dist/index.js` (`getAliases()`; `virtualModules` in Bun). Empirically: extension-imported `AgentSessionRuntime`/`InteractiveMode`/`SessionManager`/`createAgentSession` are `===` the host's |
| E3 | Extension modules execute **once** per process/cwd (module-scope state is a singleton) | `loadExtensionsCached` + loader `extensionCache` keyed by path+cwd+generation. Empirically: two session creations → module top-level executed 1×, factory 2×; after `clearExtensionCache()` (i.e. `/reload`) → re-executed once |
| E4 | `globalThis` is shared with the host realm | jiti loads in-process, same realm. Empirically verified |
| E5 | All seam members exist in the compiled 0.84.1 dist | `AgentSessionRuntime{_session, _services(getter services→{cwd,agentDir}), createRuntime, finishSessionReplacement}`, `InteractiveMode{init, rebindCurrentSession, createExtensionUIContext, shutdown, defaultEditor, documentContainer, ui}`, `AgentSession{bindExtensions, dispose, _applyExtensionBindings, _extensionRunner, _extensionUIContext, _extensionMode, _sessionStartEvent}` (verified at agent-session-runtime.js 37–45, 116, 139/163; agent-session.js 1805/2037) |
| E6 | Extensions load even before project trust is resolved | `resource-loader.js` `loadProjectTrustExtensions()` runs as part of `reload()` (pre-trust pass), still inside `createAgentSessionServices`, before InteractiveMode exists |

## 17.2 How the package is installed

```
pi install npm:pi-session-tabs          # → ~/.pi/agent/settings.json (global, all projects)
pi install -l ./pi-session-tabs        # → .pi/settings.json (project-local, team-shareable)
pi install git:github.com/me/pi-session-tabs
pi -e ./pi-session-tabs                # temporary, current run only (dev loop)
pi remove pi-session-tabs              # uninstall (Pi itself untouched)
```

- The deliverable is an ordinary npm package/git repo with `package.json` containing:
  `"keywords": ["pi-package"]` (gallery discoverability at pi.dev/packages) and
  `"pi": { "extensions": ["./extensions/index.ts"] }`.
- Zero runtime `dependencies`; `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` listed in `peerDependencies` with `"*"` (Pi bundles them for extensions — do not bundle).
- Install writes a `packages` entry in settings; `pi config` enables/disables the extension exactly like any other package resource.

## 17.3 How Pi loads it

`main.js` → `createAgentSessionRuntime(createRuntime, …)` → `apply()` → `createRuntime()` → `createAgentSessionServices()`:

1. `await resourceLoader.reload()` — pre-trust extension pass (user/global + CLI temp) runs `loadProjectTrustExtensions()`; project trust is resolved; then the final pass computes `packageManager.resolve()` extension paths (packages from settings) and `loadExtensionsCached()`.
2. Our package's `extensions/index.ts` is imported through jiti (Node alias `@earendil-works/pi-coding-agent` → host `dist/index.js`; Bun `virtualModules`), **module top-level executes now — before any InteractiveMode exists**.
3. `warehouse`: the extension factory (`export default function (pi)`) runs next; it may only *register* (commands/events) — action methods throw during load.
4. `loadExtensionsCached` caches the factory per path+cwd+generation, so the **module runs once**, but the factory **re-runs** for every session creation in that cwd (each tab's runtime builds a fresh `DefaultResourceLoader`).
5. Later, `AgentSession` (per session) wraps the *shared* extension objects in its own `ExtensionRunner` (`agent-session.js` 2037); `InteractiveMode.init()` → first `rebindCurrentSession` → `bindCurrentSessionExtensions` → `session.bindExtensions` binds the uiContext and emits `session_start`.

## 17.4 How the runtime patch is applied before InteractiveMode needs it

Two-phase package code:

**Phase A — module top-level (pre-InteractiveMode, once per process/cwd):**
- Static-import the four classes (identity = host classes, E2) and run `installPatches`, guarded by a controller stored at `globalThis[Symbol.for("pi.sessionTabs.controller")]` so re-imports after `/reload` (E3) are idempotent and share one mutable state object.
- Patch surface **unchanged from §3–§16** (still minimal/additive/existence-guarded):
  `AgentSessionRuntime.attachSession` + `createTabSession`, `AgentSession.bindExtensions` + `dispose`, `InteractiveMode.init` / `rebindCurrentSession` / `createExtensionUIContext` / `shutdown`.
- Because Phase A precedes construction (E1), the **`init()` wrapper wraps the real first `init()`**. Its `onModeReady(mode)` hook therefore fires for the very first boot — `TabManager.attach(mode, {Container, Text})` runs exactly as designed in §6/§7, without the launcher's pre-import diet or any stash trick. `Container`/`Text` are imported from `@earendil-works/pi-tui` (same-identity, E2).

**Phase B — extension factory (per session, post-InteractiveMode):**
- `pi.registerCommand("tabnew"/"tabclose"/"tabrename")` on the session's extension object. Handlers dispatch through the controller to `controller.manager` (`mode.__tabsManager`). Registration on every session's runner is fine — only the active session's runner is consulted on input.
- No action methods at load time (they throw — documented loader contract).
- Non-TUI modes (rpc/json/print): `ensureManager` is a no-op when `mode.documentContainer`/`defaultEditor`/`ui?.addInputListener` are absent; the patches themselves are inert. The package is safe in every mode.

**Why this works without the launcher:** the launcher existed only to (a) import the classes before construction and (b) import `dist/cli.js` so patches land on the same instances. (a) is now satisfied by the package loading lifecycle itself (E1 + E2) and (b) is free: an extension's imports *are* the host classes (E2), so the CLI's own construction uses already-patched prototypes.

## 17.5 How users start it

```
pi install npm:pi-session-tabs   # once
pi                                # normal Pi
```
- A tab bar appears above the header with the first session (`[○ <name>]`).
- `/tabnew [name]`, `/tabclose`, `/tabrename <name>`, Alt+Left/Alt+Right all work as designed.
- Uninstall: `pi remove pi-session-tabs`. Pi's own files are never modified.
- Project-scoped installs are covered by the existing project-trust flow (one-time prompt).

## 17.6 Compatibility risks across Pi versions

All patches remain pinned to 0.84.1, additive, and existence-guarded (missing member → that feature degrades to "no tabs, Pi unchanged" with a warning; never a crash). Version row: `pkgVersion !== "0.84.1"` → warn at module load. Specific risks:

| Change in future Pi | Effect | Mitigation |
|---|---|---|
| `AgentSessionRuntime._session` / `finishSessionReplacement()` / `createRuntime` renamed or removed | `attachSession`/`createTabSession` silently no-op or break | guard + version pin; warn; degrade |
| `rebindCur
`rebindCurrentSession`/`createExtensionUIContext`/`init`/`shutdown` rename | switching/UI-guard/attach hooks stop firing | guard; degrade |
| `bindExtensions` internal field flow (`_applyExtensionBindings`, `_extensionUIContext`, `_extensionMode`, `_sessionStartEvent`) changes | re-attach suppression or session_start dedup misbehaves | guard; on failure fall back to full original bind (no suppression) |
| Loader drops the `@earendil-works/pi-coding-agent` alias (or repeated loads stop being cached) | extension imports become foreign class objects → patches apply to the wrong classes | **self-verification at wiring time**: `ensureManager` checks `mode instanceof InteractiveMode` (package import) — mismatch → warn + skip; all patched members stay guarded |
| `extensionCache` clearing semantics change (`/reload`) | duplicate re-patch | controller idempotency (`patched` flag, once-only wraps) |
| Package manifest rules change (`pi.extensions`, enable/disable) | load semantics change | follow docs at install time |
| `attachSession`/`createTabSession` names collide with a future official API | clobbering the official method | namespaced alternative recorded as Q7; user-mandated names kept for now |

Known remaining *behavioral* limitations are unchanged from §16: tabs are not restored across restarts (V1), Alt+arrows shadow editor word movement while the TUI is focused, shared chrome is last-writer-wins, `needs_attention` is structural only, and each tab's session is persisted to its own JSONL via `SessionManager.create(cwd)`.

## 17.7 Updated delivery layout (replaces §4)

```
pi-session-tabs/                       # the Pi package itself
├── package.json                       # pi manifest (extensions: ["./extensions/index.ts"]), pi-package keyword, peerDeps only
├── extensions/
│   ├── index.ts                       # Phase A: installPatches via controller; Phase B: factory registers tab commands
│   ├── controller.mjs                 # globalThis-backed controller (patched flag, manager, hook dispatch) — reload-safe
│   ├── patches.mjs                    # unchanged from previous design (DI'd makers)
│   ├── tab-manager.mjs                # registry, state machine, lifecycle, reconciliation; closeTab(index)
│   ├── tab-component.mjs              # NEW: createTabComponent (Box + TruncatedText per tab)
│   └── tab-bar.mjs                    # NEW: layoutTabs (pure) + createTabBar (native HStack strip); formatTabs kept
├── test/                              # patches/tab-manager/tab-bar tests unchanged; wiring test targets the controller
└── docs/
```

`resolve-package.mjs` and `launcher.mjs` from the V1 layout are deleted; `test/launcher-wiring.test.mjs` is replaced by a controller test (install controller state, simulate init → wiring, command dispatch, reload idempotency).

## 17.8 Plan delta

The implementation plan (`docs/superpowers/plans/2026-08-12-pi-session-tabs.md`) has been **revised to package-only delivery**: `resolve-package.mjs`/`launcher.mjs` are removed; Tasks 1–2 scaffold the Pi package manifest and the `globalThis` controller + `extensions/index.ts` two-phase entry; Task 3 uses the namespaced patch names; Task 10 wires `ensureManager`/`TabManager.attach`/`handleTabCommand` through the controller; Task 11 installs the package (`pi install ./pi-session-tabs`) and boots plain `pi`. Tasks 4–9 (bindExtensions/dispose/init/rebind/shutdown/uiContext-guard wraps, tab bar, TabManager core/lifecycle/reconciliation) stand unchanged apart from paths and the namespaced names. Q7–Q9 resolved in §17.10. No implementation code existed before this revision (user gate: design review first).

## 17.9 Open questions (package delivery)

- **Q7:** Keep user-mandated patch names `attachSession`/`createTabSession`, or namespaced `tabsAttachSession`/`tabsCreateTabSession` to eliminate future-collision risk with official Pi APIs? (Current: keep mandated names.)
- **Q8:** Ship the extension entry as `.ts` (jiti-transpiled, ecosystem convention) or plain `.js`/`.mjs` (no transform needed)? (Current: `.ts`.)
- **Q9:** Emit an explicit one-line notice on first boot ("pi-session-tabs active · /tabnew for a new tab"), or keep startup silent (tab bar presence is the affordance)? (Current: silent.)

## 17.10 Resolved decisions (2026-08-12, user-approved)

- **Q7 → RESOLVED:** Namespace the patch methods. Use `AgentSessionRuntime.prototype.__piSessionTabsAttachSession` and `AgentSessionRuntime.prototype.__piSessionTabsCreateTabSession` (double-underscore namespaced, matching the `__tabsFirstBind` convention) instead of generic `attachSession`/`createTabSession`, minimizing collision risk with future official Pi APIs. Internal call sites only.
- **Q8 → RESOLVED:** TypeScript package entrypoint. Pi 0.84.1's verified jiti loader supports `.ts` reliably (extensions are TS modules loaded via jiti; the installed `~/.pi/agent/extensions/hermes-welcome.ts` is itself a `.ts` extension), and the module-level identity/singleton behavior was empirically verified through the same loader. Entry: `extensions/index.ts`. Internal modules stay JSDoc-typed `.mjs` for testability via `node:test`.
- **Q9 → RESOLVED:** No first-boot notice. The tab bar is the discovery affordance; usage documented in README.
