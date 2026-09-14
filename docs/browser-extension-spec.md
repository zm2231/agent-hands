# Browser extension + native host: reaching the real logged-in Chrome

Status: spec / design. No code yet. This document is the plan for replacing the
CDP-over-TCP browser path with an extension-based path that controls the user's
actual logged-in Chrome profile, the way the ChatGPT/Codex browser plugin does.

## Why the current path cannot reach the real profile

`src/browser/cdp/discovery.ts` connects to Chrome purely over the DevTools
remote-debugging TCP port (`/json/version`, `DevToolsActivePort`, `ws://…`).
Since Chrome 136, Chrome refuses `--remote-debugging-port` on the **default user
data directory** as a security fix. It only opens the port for a non-default
`--user-data-dir`, which is a fresh profile with none of the user's cookies,
logins, or tabs.

Observed on this machine (Chrome 152):

- No `DevToolsActivePort` file in `~/Library/Application Support/Google/Chrome/`
  (the default profile).
- The only endpoint answering on `127.0.0.1:9222` was a throwaway
  `--user-data-dir=/tmp/claude-chrome-debug` instance.

So the CDP path can attach only to a dedicated debug profile, never the real
one. The README's "your actual logged-in Chrome, all your cookies and tabs
intact, no separate profile" describes the extension path below, not the CDP
path we ship today.

## How Codex/ChatGPT does it (primary evidence)

All paths below are on a machine with the ChatGPT app + Codex browser plugin
installed.

- **Published MV3 extension.** `chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg`
  ("ChatGPT", Chrome Web Store), plus an internal id
  `odlomjlbamekndcpllcnffbgeohgkmjh`, and a separate beta "Codex" extension
  `lfkehkpjohcoelkpembgemeipeppanef`.
  Source: `~/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/extension-ids.json`,
  `installManifest.mjs`.
- **Native-messaging host** `com.openai.codexextension`, a signed Mach-O binary at
  `~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome`.
  Registered by a manifest in
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`
  whose `allowed_origins` list the extension ids and whose `path` points at the
  bundled binary. `type: stdio`.
- **Transport is `chrome.debugger`, not the TCP port.** The host
  (`scripts/browser-service.mjs`) relays standard CDP commands with
  `sessionId`/`targetId`: `Page.getLayoutMetrics`, `Page.getFrameTree`,
  `Input.dispatchMouseEvent`, `Runtime.evaluate`, `Page.frameNavigated`, etc.
  These are delivered through the extension's `chrome.debugger` API, which is an
  in-process browser API operating on the real profile. Because no
  remote-debugging TCP port is opened, the Chrome 136+ block does not apply.
- **Tab claiming.** The agent does not spawn a browser. It enumerates the user's
  existing tabs and "claims" one: `browser.user.openTabs()` then
  `browser.user.claimTab(tab)`, matching on a provider tab id plus a title/url
  snapshot that fails closed if a tab id was reused after a restart.
  Source: `docs/tab-claiming-chrome.md`.
- **Control surface** exposed to the agent is documented in `docs/api.json`:
  `Agent.browsers` -> `Browser` -> `Tab` with `ax` (accessibility), `cua`,
  `dom_cua`, `playwright`, `content`, `clipboard`, `screenshot`, `goto`, etc.
  The CUA/AX methods (`click`, `type`, `scroll`, `drag`, `pressKey`,
  `setValue`) mirror the desktop broker's vocabulary.

### The load-bearing insight

The command vocabulary is the same CDP that `src/browser/actions/*` already
emit (`Runtime.evaluate`, `Input.*`, `Page.*`, `DOM.*`). Only the wire
underneath changes:

| Layer | Today (CDP-over-TCP) | Target (extension) |
| --- | --- | --- |
| Command semantics | CDP | CDP (unchanged) |
| Transport | websocket to `ws://127.0.0.1:9222/...` | native messaging stdio <-> extension |
| Command delivery | Chrome's remote-debugging server | `chrome.debugger.sendCommand` in the extension |
| Reachable profile | separate `--user-data-dir` only | the user's real default profile |
| Target selection | `/json/list` targets | `chrome.tabs` + explicit tab claim |

So most of `src/browser/actions/*` and `snapshot.ts` should survive. The work is
a new transport and a new discovery/attach model, plus the extension and host
that did not exist before.

## Target architecture for agent-hands

Four components:

1. **MV3 extension (`extension/`):** our own, published to the Chrome Web Store
   under our own id. Holds `chrome.debugger` attachments to claimed tabs and a
   `chrome.runtime.connectNative` port to our host. Pure relay: it forwards CDP
   commands from the host to `chrome.debugger.sendCommand` and forwards
   `chrome.debugger` events back, plus a small control channel for
   list-tabs/claim-tab/attach/detach.
2. **Native host (`host/`):** a small binary registered in each browser's
   `NativeMessagingHosts` directory. Speaks Chrome's native-messaging framing on
   stdio to the extension, and a local IPC (unix socket or stdio) to the MCP
   server. It is a dumb, authenticated pipe; it holds no automation logic.
3. **Transport shim in the MCP server:** a new `CDPTransport` implementation
   (the interface already exists in `src/browser/cdp/types.ts`) that sends CDP
   over the host<->extension channel instead of the websocket in
   `src/browser/cdp/websocket.ts`. `discoverEndpoint()` is replaced by an
   extension-presence check plus tab enumeration.
4. **Action + snapshot layer (existing):** `src/browser/actions/*`,
   `snapshot.ts`, `surface.ts` largely unchanged; they consume a `CDPClient`
   and should not care which transport backs it.

```
agent (MCP client)
  -> agent-hands MCP server
       -> CDPClient (existing) over new ExtensionTransport
            -> native host (stdio, native-messaging framing)
                 -> our MV3 extension (connectNative port)
                      -> chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", …)
                           -> the real logged-in tab
```

## Native-messaging protocol (host <-> extension)

Chrome native messaging framing is fixed by the platform: each message is a
little-endian `uint32` byte-length prefix followed by that many bytes of UTF-8
JSON. Max 1 MB per message from the extension, 64 MB toward it. Screenshots and
large DOM dumps must be chunked or fetched out of band (see Open questions).

Proposed envelope (ours; OpenAI's exact schema is reference only and not
reusable, since we cannot talk to their signed host or private extension):

```jsonc
// request: host -> extension
{ "id": 42, "kind": "cdp", "sessionId": "<debugger session>", "method": "Input.dispatchMouseEvent", "params": { … } }
{ "id": 43, "kind": "control", "op": "listTabs" }
{ "id": 44, "kind": "control", "op": "attach", "tabId": 12 }
{ "id": 45, "kind": "control", "op": "detach", "tabId": 12 }

// response: extension -> host
{ "id": 42, "ok": true, "result": { … } }
{ "id": 44, "ok": false, "error": { "message": "tab gone", "code": "TAB_UNAVAILABLE" } }

// event (unsolicited): extension -> host
{ "kind": "event", "sessionId": "…", "method": "Page.frameNavigated", "params": { … } }
{ "kind": "event", "method": "detached", "params": { "tabId": 12, "reason": "target_closed" } }
```

Session model: one `chrome.debugger` attach per claimed tab; the extension maps
our `sessionId` to a `chrome.debugger.Debuggee`. Events carry the originating
`sessionId` so the transport can route them exactly like the websocket client
routes CDP events today.

## Extension design (MV3)

Manifest essentials:

- `manifest_version: 3`.
- Permissions: `debugger` (CDP), `tabs` (enumerate/claim), `nativeMessaging`
  (talk to the host), `scripting` if we inject any claim UI.
- `host_permissions`: `<all_urls>` is required to attach the debugger to
  arbitrary claimed tabs. This is the single biggest Web Store review risk and
  must be justified in the listing.
- Background: a service worker. MV3 service workers are killed after ~30s idle.
  The long-lived `connectNative` port keeps the worker alive while a session is
  active; when no session is active the worker may suspend, so the host must
  tolerate reconnecting the port on demand. If keep-alive proves unreliable, use
  an **offscreen document** to hold the port (the standard MV3 workaround).

Behavior:

- On `connectNative`, open the port to `com.openai.codexextension`'s analogue
  for us (our host name, e.g. `com.<org>.agenthands`).
- `listTabs` -> `chrome.tabs.query({})` filtered to http/https, returning
  `{ tabId, title, url, windowId, active }`.
- `attach` -> `chrome.debugger.attach({ tabId }, "1.3")`, then relay. Chrome
  shows the "extension is debugging this browser" banner on the tab; that is
  unavoidable and is part of the honest UX.
- Relay `chrome.debugger.onEvent` -> host as `event`; relay host `cdp` requests
  -> `chrome.debugger.sendCommand`.
- On `chrome.debugger.onDetach` (user clicked cancel, tab closed), emit a
  `detached` event so the server fails closed.

The extension holds no policy. Claim decisions, safety prompts, and output
budgeting stay server-side.

## Native host design

- Small Node single-file binary (pkg/SEA) or a tiny Rust/Go binary. Node reuses
  our existing framing helpers and keeps one language.
- stdio side: implement the `uint32`-length native-messaging framing exactly.
- server side: listen on a per-user unix domain socket (e.g.
  `$XDG_RUNTIME_DIR`/temp) with a random token the MCP server reads from a
  known file; reject unauthenticated connectors. The host must not be a general
  localhost service.
- The host is stateless beyond the live pipe; if the MCP server dies, the host
  drops the extension port and exits.

Install (mirror `installManifest.mjs`): write the host manifest into each
browser's `NativeMessagingHosts` directory with our host name, `type: stdio`,
`path` to our binary, and `allowed_origins: ["chrome-extension://<our id>/"]`.
Per-OS locations:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (and
  Edge, Brave, etc. equivalents).
- Linux: `~/.config/google-chrome/NativeMessagingHosts/` and Flatpak variants.
- Windows: a registry key under
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` pointing at a manifest
  file; manifest dir `AppData/Local/<org>/extension` per the Codex bundle.

`allowed_origins` must contain the exact published extension id, which is only
known after the first Web Store upload (or by shipping a key in the manifest to
pin the id). Pin the id via a packed key so dev and prod match.

## Distribution and install flow

1. Publish the extension to the Chrome Web Store (and Edge Add-ons). Reserve the
   id / pin it with a manifest key.
2. Ship the native host binary + an installer inside the npm package. On first
   browser use, if the host manifest is absent, guide the user to run the
   installer (writes the manifest, points at the bundled binary). Do not silently
   modify browser config without consent.
3. First-run UX: check extension present (probe a `listTabs`), check host
   manifest present, else surface the store URL and the installer. This mirrors
   `docs/chrome-troubleshooting.md`'s ordered checks (installed? running?
   host manifest? extension enabled?).

## Security and correctness

- The `chrome.debugger` banner is visible and non-suppressible. Honest; keep it.
- Fail closed on tab identity: match claimed tabs on `(tabId, title, url)` and
  refuse if the snapshot no longer matches, exactly as
  `docs/tab-claiming-chrome.md` prescribes, because numeric tab ids are reused
  after restart.
- Never fall back to AppleScript/shell/CDP-TCP when the extension path fails;
  report unavailability (same stance as Codex's troubleshooting docs).
- Enterprise policy may disable the extension or `debugger`; detect and report,
  never try to override.
- The native host is an authenticated local pipe, not an open port.

## Phased build plan (smallest working slice first)

1. **Transport seam.** Refactor so `CDPClient` is transport-agnostic (confirm
   `src/browser/cdp/types.ts` already allows this) and the websocket becomes one
   `CDPTransport` among two. No behavior change; keeps CDP-TCP working.
2. **Host skeleton.** Native-messaging framing on stdio; local socket to the
   server; manual `listTabs` round trip against a hand-loaded unpacked
   extension.
3. **Unpacked extension.** `debugger` + `nativeMessaging` + `tabs`; implement
   `listTabs`, `attach`, CDP relay, event relay, `onDetach`. Prove one claimed
   real-profile tab does `Page.captureScreenshot` + `Input.dispatchMouseEvent`.
4. **Wire the actions layer** to the extension transport; run the existing
   browser actions against a claimed tab. This is the moment the README claim
   becomes true.
5. **Tab claim UX + safety** (snapshot match, detach handling, budgets).
6. **Packaging**: SEA host binary, installer, per-OS manifest writer.
7. **Store submission**: listing, permission justification, id pinning.
8. Only after the extension path is solid, decide whether to keep CDP-TCP as a
   power-user escape hatch or remove it.

## Open questions to resolve before coding

- Large payloads: `chrome.debugger` screenshot/DOM results vs the 1 MB
  extension->host native-messaging cap. Options: JPEG/quality caps, tiling, or a
  localhost fetch the extension authorizes. Measure against `screenshot.ts`
  output sizes.
- Service-worker lifetime vs long sessions: confirm whether the native port
  keeps MV3 alive reliably, or commit to the offscreen-document pattern up front.
- Id pinning: ship a manifest `key` so the unpacked dev id equals the published
  id, so one host `allowed_origins` works everywhere.
- How much of `browser-service.mjs` is worth reverse-engineering further: its
  session/target mapping and its handling of frame trees and OOPIFs are the
  non-obvious parts and are worth a focused read before step 3.
