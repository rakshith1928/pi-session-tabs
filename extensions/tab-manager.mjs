/** Per-tab state machine driven purely by session events. */
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

  _enqueue(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async createTab(name) {
    const result = await this.runtime.__piSessionTabsCreateTabSession();
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
      if (index === this.activeIndex) return true;
      if (index < 0 || index >= this.tabs.length) return false;
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
        return false;
      }
      this.activeIndex = index;
      this._applyDrafts(prev, target.session);
      this.updateBar();
      return true;
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
    const activated = await this.activate(this.tabs.indexOf(neighbor));
    if (!activated) return;
    try {
      closing.session.dispose();
    } catch (err) {
      this.mode.showStatus?.(`Error closing tab: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.tabs.includes(closing)) this.removeTab(closing);
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
