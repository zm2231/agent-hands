// TabBridge: per-tab CDP session with element refs and serialized operations.

import type { CDPClient } from "./cdp/types.js";

const TAB_IDLE_MS = 20 * 60 * 1000; // 20 minutes

export class TabBridge {
  readonly targetId: string;
  readonly sessionId: string;
  readonly cdp: CDPClient;
  readonly elementRefs = new Map<number, number>(); // elementId -> backendDOMNodeId

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private tailPromise: Promise<unknown> = Promise.resolve();
  private onClose?: () => void;

  constructor(
    targetId: string,
    sessionId: string,
    cdp: CDPClient,
    onClose?: () => void
  ) {
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.cdp = cdp;
    this.onClose = onClose;
    this.resetIdle();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), TAB_IDLE_MS);
  }

  /** Serialize operations on this tab. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.resetIdle();
    const p = this.tailPromise.then(fn, fn);
    this.tailPromise = p.catch(() => {});
    return p;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.elementRefs.clear();
    try {
      this.cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    } catch {
      // Already closed.
    }
    this.onClose?.();
  }
}
