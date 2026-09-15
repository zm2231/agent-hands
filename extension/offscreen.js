let bridgePort;
let bridgeTimer;

function connectBridge() {
  bridgePort = chrome.runtime.connect({ name: "agent-hands-offscreen" });
  bridgePort.onDisconnect.addListener(() => {
    if (bridgeTimer) return;
    bridgeTimer = setTimeout(() => {
      bridgeTimer = undefined;
      connectBridge();
    }, 250);
  });
}

connectBridge();
setInterval(() => bridgePort?.postMessage({ kind: "keepalive" }), 20_000);
