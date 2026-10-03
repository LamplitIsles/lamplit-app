import type { ChatView } from "@lamplit/contracts";

/** Native notices owned by one mounted chat page, discovered only from live views. */
export class CompanionNotifications {
  private session?: string;
  private observed = new Set<string>();
  private notices = new Set<Notification>();
  private closed = false;
  private attempted = false;

  constructor(
    private window: Window & typeof globalThis,
    private document: Document,
    private label: () => { title: string; body: string },
  ) {
    document.addEventListener("click", this.firstClick, true);
  }

  private firstClick = (event: MouseEvent) => {
    if (this.closed || this.attempted || !event.isTrusted) return;
    this.attempted = true;
    this.document.removeEventListener("click", this.firstClick, true);
    try {
      if (this.available() && this.window.Notification.permission === "default")
        // Keep the request inside the trusted gesture, before any async work.
        void this.window.Notification.requestPermission().catch(() => {});
    } catch {
      // Permission failures must never interrupt chat.
    }
  };

  private available() {
    return this.window.isSecureContext && "Notification" in this.window;
  }

  observe(view: ChatView) {
    if (this.closed) return;
    const baseline = this.session !== view.sessionId;
    if (baseline) {
      this.session = view.sessionId;
      this.observed.clear();
    }
    for (const message of view.messages) {
      if (this.observed.has(message.id)) continue;
      this.observed.add(message.id);
      if (baseline || message.role !== "agent") continue;
      try {
        if (
          !this.available() ||
          this.window.Notification.permission !== "granted" ||
          (this.document.visibilityState !== "hidden" &&
            this.document.hasFocus())
        )
          continue;
        const { title, body } = this.label();
        const notice = new this.window.Notification(title, { body });
        this.notices.add(notice);
        notice.onclick = () => {
          if (this.closed) return;
          try {
            this.window.focus();
          } catch {}
          try {
            notice.close();
          } catch {}
          this.release(notice);
        };
        notice.onclose = () => this.release(notice);
        notice.onerror = () => this.release(notice);
      } catch {
        // Construction failures consume the observation and are never retried.
      }
    }
  }

  private release(notice: Notification) {
    notice.onclick = notice.onclose = notice.onerror = null;
    this.notices.delete(notice);
  }

  close() {
    this.closed = true;
    this.document.removeEventListener("click", this.firstClick, true);
    for (const notice of this.notices) {
      this.release(notice);
      try {
        notice.close();
      } catch {}
    }
    this.observed.clear();
  }
}
