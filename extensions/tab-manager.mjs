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
