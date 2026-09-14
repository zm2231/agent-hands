let nativePort;
let bridgePort;
let bridgeTimer;
let nativeTimer;

const NATIVE_BACKOFF_MIN_MS = 1000;
const NATIVE_BACKOFF_MAX_MS = 30000;
let nativeBackoff = NATIVE_BACKOFF_MIN_MS;

function connectBridge() {
  bridgePort = chrome.runtime.connect({ name: "agent-hands-offscreen" });
  bridgePort.onMessage.addListener((message) => nativePort?.postMessage(message));
  bridgePort.onDisconnect.addListener(() => {
    if (bridgeTimer) return;
    bridgeTimer = setTimeout(() => {
      bridgeTimer = undefined;
      connectBridge();
    }, 250);
  });
}

function connectNative() {
  nativePort = chrome.runtime.connectNative("com.zmerchant.agenthands");
  nativePort.onMessage.addListener((message) => {
    nativeBackoff = NATIVE_BACKOFF_MIN_MS;
    bridgePort?.postMessage(message);
  });
  nativePort.onDisconnect.addListener(() => {
    if (nativeTimer) return;
    const delay = nativeBackoff;
    nativeBackoff = Math.min(nativeBackoff * 2, NATIVE_BACKOFF_MAX_MS);
    nativeTimer = setTimeout(() => {
      nativeTimer = undefined;
      connectNative();
    }, delay);
  });
}

connectBridge();
connectNative();
