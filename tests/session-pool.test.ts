import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/desktop/broker/session.js", () => {
  class MockBrokerSession {
    isAlive = true;
    components: any;
    _onClose: (() => void) | null = null;
    start = vi.fn().mockResolvedValue(undefined);
    call = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {},
      isError: false,
      modelTurnsStarted: 0,
      ephemeralThread: true,
    });
    close = vi.fn().mockImplementation(async function(this: MockBrokerSession) { this.isAlive = false; this._onClose?.(); });

    constructor(components: any) {
      this.components = components;
    }

    set onClose(cb: () => void) { this._onClose = cb; }
  }

  return { BrokerSession: MockBrokerSession };
});

describe("session pool", () => {
  let acquireSession: typeof import("../src/desktop/broker/pool.js").acquireSession;
  let closePool: typeof import("../src/desktop/broker/pool.js").closePool;

  const fakeComponents = {
    codexPath: "/fake", clientPath: "/fake", codexVersion: "1.0", clientBuild: "1",
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    const pool = await import("../src/desktop/broker/pool.js");
    acquireSession = pool.acquireSession;
    closePool = pool.closePool;
  });

  afterEach(async () => {
    await closePool();
    vi.useRealTimers();
  });

  it("returns the same session on consecutive acquisitions", async () => {
    const l1 = await acquireSession(fakeComponents);
    l1.release();
    const l2 = await acquireSession(fakeComponents);
    expect(l1.session).toBe(l2.session);
    expect(l1.session.start).toHaveBeenCalledTimes(1);
    l2.release();
  });

  it("closes session after idle timeout when no leases active", async () => {
    const l1 = await acquireSession(fakeComponents);
    l1.release();
    await vi.advanceTimersByTimeAsync(31_000);
    const l2 = await acquireSession(fakeComponents);
    expect(l2.session).not.toBe(l1.session);
    expect(l1.session.close).toHaveBeenCalled();
    l2.release();
  });

  it("does not close session during idle timeout if lease is active", async () => {
    const l1 = await acquireSession(fakeComponents);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(l1.session.close).not.toHaveBeenCalled();
    expect(l1.session.isAlive).toBe(true);
    l1.release();
  });

  it("creates new session if previous died", async () => {
    const l1 = await acquireSession(fakeComponents);
    (l1.session as any).isAlive = false;
    l1.release();
    const l2 = await acquireSession(fakeComponents);
    expect(l2.session).not.toBe(l1.session);
    l2.release();
  });

  it("closePool terminates active session", async () => {
    const l1 = await acquireSession(fakeComponents);
    await closePool();
    expect(l1.session.close).toHaveBeenCalled();
  });

  it("concurrent acquireSession shares the creation promise", async () => {
    const [l1, l2] = await Promise.all([
      acquireSession(fakeComponents),
      acquireSession(fakeComponents),
    ]);
    expect(l1.session).toBe(l2.session);
    expect(l1.session.start).toHaveBeenCalledTimes(1);
    l1.release();
    l2.release();
  });

  it("reference counting prevents premature idle close", async () => {
    const l1 = await acquireSession(fakeComponents);
    const l2 = await acquireSession(fakeComponents);
    l1.release();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(l1.session.close).not.toHaveBeenCalled();
    l2.release();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(l1.session.close).toHaveBeenCalled();
  });

  it("unexpected session death triggers pool cleanup callback", async () => {
    const l1 = await acquireSession(fakeComponents);
    l1.release();
    (l1.session as any)._onClose?.();
    const l2 = await acquireSession(fakeComponents);
    expect(l2.session).not.toBe(l1.session);
    l2.release();
  });

  it("stale lease release does not affect new generation", async () => {
    const l1 = await acquireSession(fakeComponents);
    await closePool();
    const l2 = await acquireSession(fakeComponents);
    l1.release(); // stale — should be ignored
    // Advance past idle timeout; l2 should NOT be closed
    await vi.advanceTimersByTimeAsync(31_000);
    // l2 should still be alive because the stale release was ignored
    // and l2 still has an active lease
    expect(l2.session.isAlive).toBe(true);
    l2.release();
  });

  it("closePool does not close a newer generation session", async () => {
    const l1 = await acquireSession(fakeComponents);
    l1.release();
    (l1.session as any).isAlive = false;

    const p = acquireSession(fakeComponents);
    await closePool();
    const l2 = await p.catch(() => null);

    const l3 = await acquireSession(fakeComponents);
    expect(l3.session.isAlive).toBe(true);
    l3.release();
  });

  it("double lease release is idempotent", async () => {
    const l1 = await acquireSession(fakeComponents);
    const l2 = await acquireSession(fakeComponents);
    l1.release();
    l1.release(); // double release — should be no-op
    await vi.advanceTimersByTimeAsync(31_000);
    // l2 still holds a lease, session should be alive
    expect(l2.session.close).not.toHaveBeenCalled();
    l2.release();
  });

  it("explicit close evicts session from pool immediately", async () => {
    const l1 = await acquireSession(fakeComponents);
    l1.release();
    await l1.session.close();
    const l2 = await acquireSession(fakeComponents);
    expect(l2.session).not.toBe(l1.session);
    l2.release();
  });

  it("eviction with active lease invalidates old leases for replacement", async () => {
    const l1 = await acquireSession(fakeComponents);
    // Session dies while l1 is still active (not released)
    await l1.session.close();
    // Acquire replacement
    const l2 = await acquireSession(fakeComponents);
    expect(l2.session).not.toBe(l1.session);
    l2.release();
    // Old l1.release() should be a no-op (generation advanced)
    l1.release();
    // Idle timer should fire and close the replacement
    await vi.advanceTimersByTimeAsync(31_000);
    expect(l2.session.close).toHaveBeenCalled();
  });
});
