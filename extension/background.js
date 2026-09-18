const sessions = new Map();
const tabOwners = new Map();
let nativePort;
let nativeTimer;
let nativeAttempts = 0;

const NATIVE_BACKOFF_MIN_MS = 1000;
const NATIVE_BACKOFF_MAX_MS = 2000;
const MAX_NATIVE_ATTEMPTS = 5;
let nativeBackoff = NATIVE_BACKOFF_MIN_MS;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
  if (contexts.length === 0) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Maintain the authenticated native-messaging connection for claimed browser tabs." });
}

function send(message) {
  nativePort?.postMessage(message);
}

async function closeBrowserSession() {
  for (const tabId of new Set([...sessions.values()].map(({ tabId }) => tabId))) await chrome.debugger.detach({ tabId }).catch(() => {});
  sessions.clear();
  tabOwners.clear();
  await chrome.offscreen.closeDocument().catch(() => {});
}

function connectNative() {
  if (nativePort || nativeTimer) return;
  const port = chrome.runtime.connectNative("com.zmerchant.agenthands");
  nativePort = port;
  port.onMessage.addListener((message) => {
    nativeAttempts = 0;
    nativeBackoff = NATIVE_BACKOFF_MIN_MS;
    void handle(message);
  });
  port.onDisconnect.addListener(() => {
    chrome.runtime.lastError?.message;
    if (nativePort !== port) return;
    nativePort = undefined;
    nativeAttempts += 1;
    if (nativeAttempts >= MAX_NATIVE_ATTEMPTS) {
      void closeBrowserSession();
      return;
    }
    if (nativeTimer) return;
    const delay = nativeBackoff;
    nativeBackoff = Math.min(nativeBackoff * 2, NATIVE_BACKOFF_MAX_MS);
    nativeTimer = setTimeout(() => {
      nativeTimer = undefined;
      connectNative();
    }, delay);
  });
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => /^https?:/.test(tab.url ?? "")).map((tab) => ({ tabId: tab.id, title: tab.title ?? "", url: tab.url ?? "" }));
}

async function handle(message) {
  try {
    const controllerId = message.controllerId;
    if (typeof controllerId !== "string") throw new Error("Missing controller id.");
    if (message.kind === "control" && message.op === "listTabs") {
      send({ id: message.id, kind: "control", op: "listTabs", controllerId, ok: true, result: { tabs: await listTabs() } });
      return;
    }
    if (message.kind === "control" && message.op === "attach") {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error("Invalid tab id.");
      const owner = tabOwners.get(tabId);
      if (owner && owner !== controllerId) throw new Error("Tab is already claimed by another controller.");
      const existing = [...sessions.entries()].find(([, session]) => session.tabId === tabId && session.controllerId === controllerId);
      if (existing) {
        send({ id: message.id, kind: "control", op: "attach", controllerId, ok: true, result: { sessionId: existing[0] } });
        return;
      }
      const sessionId = crypto.randomUUID();
      await chrome.debugger.attach({ tabId }, "1.3");
      sessions.set(sessionId, { tabId, controllerId });
      tabOwners.set(tabId, controllerId);
      send({ id: message.id, kind: "control", op: "attach", controllerId, ok: true, result: { sessionId } });
      return;
    }
    if (message.kind === "control" && message.op === "createTarget") {
      const tab = await chrome.tabs.create({ url: String(message.url ?? "about:blank") });
      if (tab.id === undefined) throw new Error("Chrome did not provide a tab id.");
      send({ id: message.id, kind: "control", op: "createTarget", controllerId, ok: true, result: { targetId: String(tab.id) } });
      return;
    }
    if (message.kind === "control" && message.op === "detach") {
      const session = sessions.get(message.sessionId);
      if (session?.controllerId !== controllerId) throw new Error("Unknown or detached browser session.");
      if (session) {
        sessions.delete(message.sessionId);
        if (![...sessions.values()].some(({ tabId }) => tabId === session.tabId)) {
          tabOwners.delete(session.tabId);
          await chrome.debugger.detach({ tabId: session.tabId }).catch(() => {});
        }
      }
      send({ id: message.id, kind: "control", op: "detach", controllerId, ok: true, result: {} });
      return;
    }
    if (message.kind === "control" && message.op === "disconnect") {
      for (const [sessionId, session] of sessions) if (session.controllerId === controllerId) sessions.delete(sessionId);
      for (const [tabId, owner] of tabOwners) if (owner === controllerId) {
        tabOwners.delete(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
      return;
    }
    if (message.kind === "cdp") {
      const session = sessions.get(message.sessionId);
      if (!session || session.controllerId !== controllerId) throw new Error("Unknown or detached browser session.");
      const result = await chrome.debugger.sendCommand({ tabId: session.tabId }, message.method, message.params ?? {});
      if (message.method === "Target.attachToTarget" && typeof result.sessionId === "string") sessions.set(result.sessionId, session);
      send({ id: message.id, kind: "cdp", controllerId, ok: true, result });
      return;
    }
    throw new Error("Unsupported host message.");
  } catch (error) {
    send({ id: message.id, kind: message.kind, op: message.op, controllerId: message.controllerId, ok: false, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent-hands-offscreen") return;
  port.onMessage.addListener(() => connectNative());
  connectNative();
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  for (const [sessionId, session] of sessions) if (session.tabId === source.tabId) send({ kind: "event", controllerId: session.controllerId, sessionId: params?.sessionId ?? sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  for (const [sessionId, session] of sessions) {
    if (session.tabId === source.tabId) {
      sessions.delete(sessionId);
      tabOwners.delete(session.tabId);
      send({ kind: "detached", controllerId: session.controllerId, sessionId, tabId: session.tabId, params: { reason } });
    }
  }
});

void ensureOffscreen().then(connectNative);
