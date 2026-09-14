let nativePort;
let bridgePort;
let bridgeTimer;
let nativeTimer;

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
  nativePort.onMessage.addListener((message) => bridgePort?.postMessage(message));
  nativePort.onDisconnect.addListener(() => {
    if (nativeTimer) return;
    nativeTimer = setTimeout(() => {
      nativeTimer = undefined;
      connectNative();
    }, 1000);
  });
}

connectBridge();
connectNative();
