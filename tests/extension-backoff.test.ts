import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const backgroundPath = join(here, "..", "extension", "background.js");

type Listener = (...args: unknown[]) => void;

interface FakePort {
  name: string;
  onMessage: { fire: (message: unknown) => void };
  onDisconnect: { fire: () => void };
  postMessage: (message: unknown) => void;
  posted: unknown[];
}

interface Harness {
  connectNativeCalls: number;
  timers: Array<{ delay: number; fn: () => void }>;
  currentPort: () => FakePort | undefined;
  offscreenClosed: () => number;
  flush: () => Promise<void>;
  runNextTimer: () => Promise<void>;
  debuggerAttached: () => number[];
  debuggerDetached: () => number[];
}

async function loadBackground(): Promise<Harness> {
  const source = await readFile(backgroundPath, "utf8");

  const timers: Array<{ delay: number; fn: () => void }> = [];
  const ports: FakePort[] = [];
  let connectNativeCalls = 0;
  let offscreenClosed = 0;
  const attached: number[] = [];
  const detached: number[] = [];
  let uuid = 0;

  function makePort(name: string): FakePort {
    const messageListeners: Listener[] = [];
    const disconnectListeners: Listener[] = [];
    const port: FakePort = {
      name,
      posted: [],
      postMessage(message: unknown) {
        this.posted.push(message);
      },
      onMessage: { fire: (message: unknown) => messageListeners.forEach((l) => l(message)) },
      onDisconnect: { fire: () => disconnectListeners.forEach((l) => l()) },
    };
    (port.onMessage as unknown as { addListener: (l: Listener) => void }).addListener = (l) => messageListeners.push(l);
    (port.onDisconnect as unknown as { addListener: (l: Listener) => void }).addListener = (l) => disconnectListeners.push(l);
    return port;
  }

  const chrome = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      connectNative: (_name: string) => {
        connectNativeCalls += 1;
        const port = makePort("native");
        ports.push(port);
        return port;
      },
      connect: (_opts: unknown) => makePort("agent-hands-offscreen"),
      onConnect: { addListener: (_l: Listener) => {} },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {
        offscreenClosed += 1;
      },
    },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => { attached.push(tabId); },
      detach: async ({ tabId }: { tabId: number }) => { detached.push(tabId); },
      sendCommand: async () => ({}),
      onEvent: { addListener: (_l: Listener) => {} },
      onDetach: { addListener: (_l: Listener) => {} },
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 1 }),
    },
  };

  const context = createContext({
    chrome,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    console,
    setTimeout: (fn: () => void, delay: number) => {
      const handle = timers.length + 1;
      timers.push({ delay, fn });
      return handle;
    },
    clearTimeout: () => {},
    Promise,
    Math,
    Number,
    Boolean,
    String,
    Buffer,
  });

  runInContext(source, context, { filename: "background.js" });

  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    get connectNativeCalls() {
      return connectNativeCalls;
    },
    timers,
    currentPort: () => ports[ports.length - 1],
    offscreenClosed: () => offscreenClosed,
    debuggerAttached: () => attached,
    debuggerDetached: () => detached,
    flush,
    runNextTimer: async () => {
      const timer = timers.shift();
      if (!timer) throw new Error("no pending timer");
      timer.fn();
      await flush();
    },
  } as Harness;
}

describe("extension native reconnect backoff (real background.js)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await loadBackground();
    await h.flush();
  });

  it("grows the reconnect delay across successive reconnect attempts and stops after the cap", async () => {
    expect(h.connectNativeCalls).toBe(1);
    expect(h.currentPort()).toBeTruthy();

    const observedDelays: number[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      h.currentPort()!.onDisconnect.fire();
      await h.flush();
      if (h.timers.length > 0) {
        observedDelays.push(h.timers[0].delay);
        await h.runNextTimer();
      }
    }

    expect(observedDelays).toEqual([1000, 2000, 2000, 2000]);
    expect(h.offscreenClosed()).toBe(1);
    expect(h.timers.length).toBe(0);
  });

  it("resets backoff to the minimum only after a successful host message", async () => {
    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.timers[0].delay).toBe(1000);
    await h.runNextTimer();

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.timers[0].delay).toBe(2000);
    await h.runNextTimer();

    h.currentPort()!.onMessage.fire({ id: "x", kind: "control", op: "listTabs" });
    await h.flush();

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.timers[0].delay).toBe(1000);
  });

  it("routes separate controllers to separate tabs and rejects a second controller for the same tab", async () => {
    const port = h.currentPort()!;
    port.onMessage.fire({ id: 1, kind: "control", op: "attach", controllerId: "first", tabId: 10 });
    port.onMessage.fire({ id: 2, kind: "control", op: "attach", controllerId: "second", tabId: 20 });
    await h.flush();
    expect(h.debuggerAttached()).toEqual([10, 20]);
    expect(port.posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, controllerId: "first", ok: true }),
      expect.objectContaining({ id: 2, controllerId: "second", ok: true }),
    ]));

    port.onMessage.fire({ id: 3, kind: "control", op: "attach", controllerId: "third", tabId: 10 });
    await h.flush();
    expect(port.posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 3, controllerId: "third", ok: false, error: expect.objectContaining({ message: "Tab is already claimed by another controller." }) }),
    ]));

    port.onMessage.fire({ kind: "control", op: "disconnect", controllerId: "first" });
    await h.flush();
    expect(h.debuggerDetached()).toEqual([10]);
    port.onMessage.fire({ id: 4, kind: "cdp", controllerId: "second", sessionId: "uuid-2", method: "Runtime.evaluate" });
    await h.flush();
    expect(port.posted).toEqual(expect.arrayContaining([expect.objectContaining({ id: 4, controllerId: "second", ok: true })]));
  });
});
