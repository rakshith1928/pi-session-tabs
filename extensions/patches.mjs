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

/**
 * Apply additive patches. `hooks` dispatch events to the TabManager layer.
 * Safe by snapshot: every patched member is recorded before install, so
 * restore() can delete members that were absent pre-install (namespaced
 * additions) and reinstate pre-existing Pi members via defineProperty.
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

  const { onBindExtensions, onSessionDisposed } = hooks;
  const bindExtensionsWrapper = makeBindExtensionsWrapper(AgentSession.prototype.bindExtensions, { onBindExtensions });
  apply(AgentSession, "bindExtensions", bindExtensionsWrapper);
  const disposeWrapper = makeDisposeWrapper(AgentSession.prototype.dispose, { onSessionDisposed });
  apply(AgentSession, "dispose", disposeWrapper);

  const { onModeReady, onForegroundChanged, onShutdown, isForeground } = hooks;
  apply(InteractiveMode, "init", makeInitWrapper(InteractiveMode.prototype.init, { onModeReady }));
  apply(InteractiveMode, "rebindCurrentSession", makeRebindWrapper(InteractiveMode.prototype.rebindCurrentSession, { onForegroundChanged }));
  apply(InteractiveMode, "shutdown", makeShutdownWrapper(InteractiveMode.prototype.shutdown, { onShutdown }));
  apply(InteractiveMode, "createExtensionUIContext", makeUiContextGuardWrapper(InteractiveMode.prototype.createExtensionUIContext, { isForeground }));

  return {
    restore() {
      for (const [proto, name, orig] of originals) {
        if (orig === undefined) delete proto[name];
        else Object.defineProperty(proto, name, { value: orig, writable: true, configurable: true });
      }
    },
  };
}
