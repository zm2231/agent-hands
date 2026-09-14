const sessions = new Map();
let hostPort;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
  if (contexts.length === 0) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Maintain the authenticated native-messaging connection for claimed browser tabs." });
}

function send(message) {
  hostPort?.postMessage(message);
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => /^https?:/.test(tab.url ?? "")).map((tab) => ({ tabId: tab.id, title: tab.title ?? "", url: tab.url ?? "" }));
}

async function handle(message) {
  try {
    if (message.kind === "control" && message.op === "listTabs") {
      send({ id: message.id, kind: "control", op: "listTabs", ok: true, result: { tabs: await listTabs() } });
      return;
    }
    if (message.kind === "control" && message.op === "attach") {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error("Invalid tab id.");
      const existing = [...sessions.entries()].find(([, sessionTabId]) => sessionTabId === tabId);
      if (existing) {
        send({ id: message.id, kind: "control", op: "attach", ok: true, result: { sessionId: existing[0] } });
        return;
      }
      const sessionId = crypto.randomUUID();
      await chrome.debugger.attach({ tabId }, "1.3");
      sessions.set(sessionId, tabId);
      send({ id: message.id, kind: "control", op: "attach", ok: true, result: { sessionId } });
      return;
    }
    if (message.kind === "control" && message.op === "detach") {
      const tabId = sessions.get(message.sessionId);
      if (tabId !== undefined) {
        sessions.delete(message.sessionId);
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
      send({ id: message.id, kind: "control", op: "detach", ok: true, result: {} });
      return;
    }
    if (message.kind === "cdp") {
      const tabId = sessions.get(message.sessionId);
      if (tabId === undefined) throw new Error("Unknown or detached browser session.");
      const result = await chrome.debugger.sendCommand({ tabId }, message.method, message.params ?? {});
      if (message.method === "Target.attachToTarget" && typeof result.sessionId === "string") sessions.set(result.sessionId, tabId);
      send({ id: message.id, kind: "cdp", ok: true, result });
      return;
    }
    throw new Error("Unsupported host message.");
  } catch (error) {
    send({ id: message.id, kind: message.kind, op: message.op, ok: false, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent-hands-offscreen") return;
  hostPort = port;
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => { if (hostPort === port) hostPort = undefined; });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const sessionId = [...sessions.entries()].find(([, tabId]) => tabId === source.tabId)?.[0];
  if (sessionId) send({ kind: "event", sessionId: params?.sessionId ?? sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  for (const [sessionId, tabId] of sessions) {
    if (tabId === source.tabId) {
      sessions.delete(sessionId);
      send({ kind: "detached", sessionId, tabId, params: { reason } });
    }
  }
});

ensureOffscreen();
