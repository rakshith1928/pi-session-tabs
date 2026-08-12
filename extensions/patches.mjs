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
