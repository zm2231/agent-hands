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

interface Timer { id: number; delay: number; fn: () => void }

interface Harness {
  connectNativeCalls: number;
  timers: Timer[];
  backoffTimers: () => Timer[];
  alarms: Map<string, unknown>;
  fireAlarm: (name: string) => Promise<void>;
  runStableTimer: () => Promise<void>;
  currentPort: () => FakePort | undefined;
  offscreenClosed: () => number;
  flush: () => Promise<void>;
  runNextTimer: () => Promise<void>;
  debuggerAttached: () => number[];
  debuggerDetached: () => number[];
}

async function loadBackground(existingAlarms = new Map<string, unknown>()): Promise<Harness> {
  const source = await readFile(backgroundPath, "utf8");

  const timers: Timer[] = [];
  let timerId = 0;
  const alarms = existingAlarms;
  const alarmListeners: Listener[] = [];
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
    alarms: {
      create: (name: string, info: unknown) => { alarms.set(name, info); },
      get: async (name: string) => (alarms.has(name) ? { name, ...(alarms.get(name) as object) } : undefined),
      clear: async (name: string) => alarms.delete(name),
      onAlarm: { addListener: (l: Listener) => alarmListeners.push(l) },
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
      const id = ++timerId;
      timers.push({ id, delay, fn });
      return id;
    },
    clearTimeout: (id: number | undefined) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
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
    backoffTimers: () => timers.filter((t) => t.delay !== 10_000),
    alarms,
    fireAlarm: async (name: string) => {
      alarmListeners.forEach((l) => l({ name }));
      await flush();
    },
    runStableTimer: async () => {
      const i = timers.findIndex((t) => t.delay === 10_000);
      if (i < 0) throw new Error("no stable timer");
      const [timer] = timers.splice(i, 1);
      timer.fn();
      await flush();
    },
    currentPort: () => ports[ports.length - 1],
    offscreenClosed: () => offscreenClosed,
    debuggerAttached: () => attached,
    debuggerDetached: () => detached,
    flush,
    runNextTimer: async () => {
      const i = timers.findIndex((t) => t.delay !== 10_000);
      if (i < 0) throw new Error("no pending timer");
      const [timer] = timers.splice(i, 1);
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
      if (h.backoffTimers().length > 0) {
        observedDelays.push(h.backoffTimers()[0].delay);
        await h.runNextTimer();
      }
    }

    expect(observedDelays).toEqual([1000, 2000, 2000, 2000]);
    expect(h.offscreenClosed()).toBe(1);
    expect(h.timers.length).toBe(0);
    expect(h.alarms.get("agent-hands-reconnect")).toEqual({ periodInMinutes: 1 });
  });

  it("keeps retrying once per alarm after the cap and clears the alarm once a connection holds", async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      h.currentPort()!.onDisconnect.fire();
      await h.flush();
      if (h.backoffTimers().length > 0) await h.runNextTimer();
    }
    expect(h.alarms.has("agent-hands-reconnect")).toBe(true);
    const calls = h.connectNativeCalls;

    await h.fireAlarm("agent-hands-reconnect");
    expect(h.connectNativeCalls).toBe(calls + 1);
    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers()).toEqual([]);
    expect(h.alarms.has("agent-hands-reconnect")).toBe(true);

    await h.fireAlarm("agent-hands-reconnect");
    expect(h.connectNativeCalls).toBe(calls + 2);
    await h.runStableTimer();
    expect(h.alarms.has("agent-hands-reconnect")).toBe(false);

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers().map((t) => t.delay)).toEqual([1000]);
  });

  it("stays in alarm retry mode when the service worker restarts with the alarm still set", async () => {
    const restarted = await loadBackground(new Map([["agent-hands-reconnect", { periodInMinutes: 1 }]]));
    await restarted.flush();
    expect(restarted.connectNativeCalls).toBe(1);

    restarted.currentPort()!.onDisconnect.fire();
    await restarted.flush();
    expect(restarted.backoffTimers()).toEqual([]);
    expect(restarted.alarms.has("agent-hands-reconnect")).toBe(true);

    await restarted.fireAlarm("agent-hands-reconnect");
    expect(restarted.connectNativeCalls).toBe(2);
    await restarted.runStableTimer();
    expect(restarted.alarms.has("agent-hands-reconnect")).toBe(false);
  });

  it("resets the attempt count after a connection stays up, without any host message", async () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      h.currentPort()!.onDisconnect.fire();
      await h.flush();
      await h.runNextTimer();
    }
    await h.runStableTimer();

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers().map((t) => t.delay)).toEqual([1000]);
    expect(h.offscreenClosed()).toBe(0);
    expect(h.alarms.size).toBe(0);
  });

  it("resets backoff to the minimum after a successful host message", async () => {
    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers()[0].delay).toBe(1000);
    await h.runNextTimer();

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers()[0].delay).toBe(2000);
    await h.runNextTimer();

    h.currentPort()!.onMessage.fire({ id: "x", kind: "control", op: "listTabs" });
    await h.flush();

    h.currentPort()!.onDisconnect.fire();
    await h.flush();
    expect(h.backoffTimers()[0].delay).toBe(1000);
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
