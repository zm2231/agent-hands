# agent-hands: Browser Control (Implementation Spec)

Status: implementation-ready. Written by the analyst (dirty side) from the Chrome DevTools Protocol (public) and observed behavior. A clean implementer can build from this document without opening any existing package. Describes function, contracts, algorithms, and exact constants. It does not reproduce third-party source; CDP method names are the public protocol.

## 1. Purpose

Expose control of the user's real, logged-in Chrome-family browser to any MCP client, driven by the calling agent. Attach to a running browser over CDP; never launch a throwaway profile by default. The logged-in session (cookies, extensions, profile) is the product.

## 2. Runtime shape

- A single Node process, stdio MCP server, model-agnostic. Node 22+.
- Portable across macOS, Linux, Windows (discovery covers all three). Validate on the primary machine first.
- Requires a Chrome-family browser reachable over CDP (remote debugging enabled), or launchable via the `start` action.

## 3. Tool surface

Expose one tool, `browser`, taking an object with an `action` discriminator. (Exposing each action as its own MCP tool is an acceptable alternative; the single-tool form keeps the surface minimal and matches how the capability is driven.) Also accept a top-level array of action objects for batching (section 10).

Actions and their accepted fields (all other keys are rejected per action):

| action | fields (besides `action`) |
|---|---|
| `help` | none |
| `start` | none |
| `tabs` | `query?`, `offset?` |
| `open` | `ref_id?`, `url?`, `lineno?`, `response_length?` |
| `find` | `ref_id`, `pattern`, `lineno?`, `response_length?` |
| `click` | `ref_id`, `id?`, `selector?`, `x?`, `y?` |
| `type` | `ref_id`, `id?`, `text` |
| `screenshot` | `ref_id`, `id?`, `selector?` |
| `html` | `ref_id`, `id?`, `selector?` |
| `navigate` | `ref_id`, `url` |
| `evaluate` | `ref_id`, `expression` |
| `network` | `ref_id` |
| `load_all` | `ref_id`, `selector`, `interval_ms?` |
| `raw` | `ref_id`, `method`, `params?` |
| `read_result` | `handle`, `offset?` |
| `discard_result` | `handle` |
| `stop` | `ref_id?` |

### 3.1 Reference model (the two id kinds)

- `ref_id` identifies a tab. It is a prefix of the CDP `targetId`, taken at the minimum length (>= 8 chars, `MIN_TARGET_PREFIX_LENGTH = 8`) that is unique among currently open targets. Returned by `tabs` and `open`. A caller passes it back on every tab action; it is re-resolved against live targets by unique-prefix match at each call.
- `id` (element id) identifies an actionable element within one tab. It is a per-tab sequential integer (starting at 1) assigned during `open`/`find` snapshots. Internally it maps to a CDP `backendDOMNodeId` in a per-tab `Map<number, number>`. The map is cleared and repopulated on every snapshot of that tab, so element ids are only valid until the next snapshot of the same tab.

### 3.2 Validation rules (exact)

- Input must be a JSON object (or an array for batch). `action` must be one of the known actions.
- Unknown fields for the chosen action are rejected with `unknown <action> field(s): ...`.
- `ref_id` on a tab action must be a non-empty string, else `<action> requires a ref_id returned by tabs; call tabs first`.
- `offset` is a non-negative integer (default 0). `lineno` is a positive integer, default 1, minimum 1. `id` is a positive integer (`id must be a positive integer from open/find`). `response_length` is one of `short`/`medium`/`long` (default `medium`).
- `open` requires exactly one of `ref_id` or `url` (both-or-neither is an error). With `url` it opens a tab; with `ref_id` it snapshots.
- `click` requires exactly one of `id`, `selector`, or `x`+`y` (both x and y required together; finite numbers). `type` requires non-empty `text` and an optional `id` (id focuses the element first; without id it types at the current focus). `screenshot`/`html` accept `id` or `selector`, not both.
- `load_all` `interval_ms` is an integer 0..60000 (default 1500). `raw` `method` is a required string and `params` an object (default `{}`).
- `handle` (for `read_result`/`discard_result`) must match `^[a-f0-9-]{36}$` (a UUID).

## 4. Endpoint discovery (attach, not launch)

Resolve a CDP WebSocket debugger URL in this order:
1. HTTP probe `http://<CDP_HOST>:<CDP_PORT>/json/version` (defaults `CDP_HOST=127.0.0.1`, `CDP_PORT=9222`, 2 s timeout) and read `webSocketDebuggerUrl`.
2. If that fails, look for a `DevToolsActivePort` file among candidates and build `ws://<host>:<line1><line2>` from its first two lines. Candidate list, in order: `CDP_PORT_FILE` (explicit override), then per-browser paths on the current OS:
   - macOS: `~/Library/Application Support/<b>/DevToolsActivePort` and `.../<b>/Default/DevToolsActivePort` for b in `Google/Chrome`, `Google/Chrome Beta`, `Google/Chrome for Testing`, `Chromium`, `BraveSoftware/Brave-Browser`, `Microsoft Edge`.
   - Linux: `~/.config/<b>/DevToolsActivePort` and `.../Default/...` for b in `google-chrome`, `google-chrome-beta`, `chromium`, `vivaldi`, `vivaldi-snapshot`, `BraveSoftware/Brave-Browser`, `microsoft-edge`; plus Flatpak `~/.var/app/<appId>/config/<b>/...` for the chromium/chrome/brave/edge/vivaldi app ids.
   - Windows: `%LOCALAPPDATA%\<b>\User Data\DevToolsActivePort` and `...\Default\...` for `Google/Chrome`, `BraveSoftware/Brave-Browser`, `Microsoft/Edge`.
3. If nothing resolves, error with the recovery hint: `Enable remote debugging or set CDP_PORT/CDP_PORT_FILE.`

`start` is the only action that launches a browser, and only when nothing is attachable. Its behavior is platform-split, and this matters for a macOS audience:

- It first probes the debug port; if a browser is already there, it just reports that.
- **Linux only:** it launches the browser as a transient systemd user unit (`systemd-run --user --unit=chrome-cdp-browser`), running `CDP_BROWSER` (default `/usr/bin/chromium`) with `--remote-debugging-address`/`--remote-debugging-port` and optional `--profile-directory` (`CDP_PROFILE_DIRECTORY`), then waits for the endpoint. Overridable binaries: `CDP_SYSTEMCTL`, `CDP_SYSTEMD_RUN`.
- **macOS and Windows:** `start` does **not** auto-launch. It throws: automatic launch requires a Linux systemd session; the user must start their authenticated browser manually with remote debugging enabled (`--remote-debugging-port=9222`). So on the primary (macOS) target, the setup step is "launch Chrome with remote debugging," and `start` is only a convenience elsewhere.

A browser the module attached to is never closed by the module.

Timeouts: `CDP_TIMEOUT_MS = 15000`, `NAVIGATION_TIMEOUT_MS = 30000`.

## 5. Session model

- One root CDP client (connected to the discovered ws URL) is used for listing and opening tabs (`Target.getTargets` via a pages helper, `Target.createTarget`). It reconnects lazily and clears itself on close.
- Each operated tab gets a `TabBridge`: connect a CDP client, `Target.attachToTarget { targetId, flatten: true }`, keep the returned `sessionId`. The bridge holds the per-tab element-ref map.
- Turns within one tab are serialized: each call chains on the previous via a tail promise, so no two operations interleave on the same tab. Different tabs run independently.
- A bridge auto-closes on `Target.targetDestroyed` (its target), `Target.detachedFromTarget` (its session), root CDP close, or a 20-minute idle timer (`TAB_IDLE_MS = 20 * 60 * 1000`, reset on each use). Closing detaches (`Target.detachFromTarget`) and clears the element map.
- `stop` with a `ref_id` closes that tab bridge; without one, closes all bridges. It does not close the browser.

`open`/`withTab` resolve a `ref_id` to a live `targetId` by unique-prefix match against current targets. Ambiguous or missing prefixes error (`Ambiguous prefix ... Use more characters.` / `No target matching prefix ...`). The returned `ref_id` is recomputed to the minimum unique prefix length across the current target set.

## 6. Snapshot (structured, bounded page view)

On `open` (with `ref_id`) or `find`, produce a snapshot:
1. `Accessibility.getFullAXTree` for the tab session. Build parent/child maps from `nodeId`/`parentId`/`childIds`.
2. Walk the tree in document order. For each shown node (skip `none`, `generic`, `InlineTextBox`, and empty name+value):
   - If the role is interactive and the node has a `backendDOMNodeId`, assign the next element id, record `elementRefs[id] = backendDOMNodeId`, and emit a line `[id] role name = value`. Interactive roles: button, checkbox, combobox, link, listbox, menuitem, option, menuitemcheckbox, menuitemradio, radio, searchbox, slider, spinbutton, switch, tab, textbox, treeitem.
   - `StaticText` coalesces into the previous text line (up to 700 chars). `heading`/`image` emit a labeled line.
   - Long text is split into 700-char pieces.
3. Read page `title` and `url` via `Runtime.evaluate` of `({title: document.title, url: location.href})`.
4. Filter by `pattern` (case-insensitive substring) for `find`. Apply the line window: start at `lineno-1`, take `SNAPSHOT_LIMITS[response_length]` lines (`short: 60`, `medium: 140`, `long: 300`).
5. Apply a second bound after the line window: serialize the result and cap it at a 38 KB output budget (`OUTPUT_BUDGET_BYTES = 38000`), dropping trailing content lines (and their elements) until it fits, setting `truncated: true` and `next_lineno` when it does. Per-field caps also apply: title 1000, url 8000, pattern 2000, element name 2000, element value 4000, role 128 bytes.
6. Return `{ ref_id?, title, url, lineno, content: [{line, text, element_id?}], elements: [{id, role, name?, value?}] (only those referenced by included lines), pattern?, truncated?, next_lineno? }`. `next_lineno` is present when more lines remain (from either the line window or the byte budget).

So a snapshot has two truncation layers: the line-count window (`SNAPSHOT_LIMITS`) and the 38 KB byte budget. The element map is cleared before each snapshot, so ids refer to that snapshot only.

## 7. Element resolution and per-action behavior (step level)

Every action result carries `ref_id`. Simple mutating actions return `{ ref_id, result }` where `result` defaults to `"ok"`; snapshots, screenshots, and text-returning actions have the shapes given below.

### 7.1 Element resolution (id to backend node to live object)

- `requireElementRef(id)`: parse `id` as a positive integer, look it up in the tab's `Map<elementId, backendDOMNodeId>`. A miss errors `Unknown element id <id>; run open again and use a current element id`.
- To act on a backend node, resolve it to a live JS handle: `DOM.resolveNode { backendNodeId }` gives an `object.objectId`. No objectId means the node is gone: error `Element is no longer available; run open again`. Always `Runtime.releaseObject` the objectId after use.
- This is the freshness mechanism. The element id is a stable handle to a `backendDOMNodeId` captured at snapshot; every action re-resolves that backend node to a live object at call time, so a superseded DOM fails cleanly rather than acting on the wrong node.

### 7.2 click

- by `id`: resolve the backend node; scroll into view (`this.scrollIntoView({block:"center",inline:"center"})` via `Runtime.callFunctionOn`, then 50 ms settle); compute the center and guard it in one page function: read `getBoundingClientRect`, reject if hidden (zero box, `display:none`, `visibility:hidden/collapse`, `pointer-events:none`, opacity 0, or inside `[inert]`) or disabled (`:disabled` or `aria-disabled=true`), and **hit-test** `elementFromPoint(center)`: if the hit node is neither the target nor a descendant, reject `Element center is covered by <blocker>`. Then dispatch `Input.dispatchMouseEvent` moved, pressed, wait 50 ms, released at the center. Returns `Clicked element <id>`.
- by `selector`: `Runtime.evaluate` `querySelectorAll`; error on 0 (`Element not found`) or more than 1 (`Selector matched N elements`); `DOM.describeNode` to a `backendNodeId`; then the same center-guard-and-click. Returns `Clicked <tag> "text"`.
- by `x`/`y`: dispatch moved, pressed, 50 ms, released at those CSS-pixel coordinates. Returns `Clicked at CSS (x, y)`.

### 7.3 type

- with `id`: resolve the backend node and scroll into view; via `callFunctionOn`, verify the element is editable (INPUT of type text/search/email/url/tel/password/number, or TEXTAREA, or contentEditable; not disabled/readonly), `focus({preventScroll:true})`, confirm it is the active element, capture the before-value; re-confirm active; `Input.insertText { text }`; confirm still active and the value changed, else error. Returns `Typed N characters into referenced <tag>`.
- without `id` (type at focus): evaluate `document.activeElement`; error if none, body, non-editable, or disabled; `Input.insertText`; for same-origin, re-read and require both that focus is unchanged and the value changed. A cross-origin (iframe) target is reported as sent-but-not-inspectable. Returns `Typed N characters into focused <tag>`.

### 7.4 screenshot

`Page.captureScreenshot { format: "jpeg", quality: 80, clip?, captureBeyondViewport: false }`; decode the base64 `data`, write the JPEG to the artifact path (section 8); read `window.devicePixelRatio` (default 1 on failure). Returns `{ ref_id, id?, selector?, file, dpr, coordinates: "CSS pixels; screenshot pixels / DPR" }`.

- viewport: no clip.
- by `selector`: querySelector, `scrollIntoView`, `getBoundingClientRect` plus 10 px padding clamped to the window, as the clip.
- by `id`: resolve backend node, scroll into view, `DOM.getBoxModel` border quad, clamp to the layout viewport (`Page.getLayoutMetrics`) with 10 px padding, as the clip.

### 7.5 html / evaluate / network / raw / navigate / load_all

- `evaluate`: `Runtime.enable`, then `Runtime.evaluate { expression, returnByValue: true, awaitPromise: true }`; on `exceptionDetails`, throw its description or text; return the value. The text form JSON-stringifies objects (2-space indent), else `String(value ?? "")`. This primitive underlies `html`, `network`, and the navigation `readyState` poll.
- `html`: no `id`/`selector` returns `document.documentElement.outerHTML`; `selector` returns that element's `outerHTML` (error `Element not found: <selector>`); `id` resolves the backend node and `callFunctionOn` `this.outerHTML`.
- `network`: evaluate `performance.getEntriesByType('resource')` mapped to `{ name: first 120 chars, type: initiatorType, duration: round(ms), size: transferSize }`, formatted as aligned lines `<dur>ms  <size>B  <type>  <name>`.
- `raw`: send the given CDP `method` with `params` to the tab session; return the result JSON pretty-printed. The escape hatch for any CDP surface no named action covers (error `CDP method required` if empty).
- `navigate`: assert an http(s) URL; `Page.enable`; arm `Page.loadEventFired` (30 s); `Page.navigate { url }`; if the response has `errorText`, throw it; if it returned a `loaderId`, await the load event; then poll `document.readyState === "complete"` up to 5 s. Returns `Navigated to <url>`.
- `load_all`: loop up to a 5-minute deadline: if the `selector` exists, `click` it (selector path) and wait `interval_ms`; stop when it disappears. Returns the click count and why it stopped. This is the infinite-scroll / "load more" driver.

All non-snapshot text-returning actions (`evaluate`, `html`, `network`, `raw`) pass through the 32 KB inline budget with `result_handle` continuation (section 8).

## 8. Screenshot and large-text artifacts

Artifact directory: `$XDG_RUNTIME_DIR/browser-tool` if set, else `<tmpdir>/browser-tool-<uid>` (created 0700).

- Screenshots: JPEG named `browser-<safeRef>[-element[-<id>]]-<uuid>.jpg` (safeRef = first 12 chars of ref_id, sanitized). Returned as a file path plus device pixel ratio. TTL 24 h (`SCREENSHOT_TTL_MS`).
- Large text (from `evaluate`, `html`, `network`, `raw`): capped at a 32 KB JSON budget (`TEXT_BUDGET_BYTES = 32000`) computed by exact JSON-encoded byte length. If it fits, return inline; if not, write the full text to `result-<uuid>.txt` (0600) and return `{ ...base, <field>: <first chunk>, truncated: true, omitted_chars, result_handle, next_offset }`. TTL 1 h (`RESULT_TTL_MS`).
- `read_result { handle, offset? }` returns the next chunk `{ handle, offset, text, complete, next_offset? }`; when the read completes, the cached file is deleted. `discard_result { handle }` deletes it. Handles are the 36-char UUID form. A missing handle errors with a re-run hint.

Screenshots are returned as file paths, never inline, so image bytes never compete with the caller's context. Note: an MCP client running the tool remotely must be able to read that path; for local use it is a real file on disk.

## 9. Help

The `help` action returns a compact machine-readable map: the input convention (JSON object; batch = top-level array), each action's field signature (matching the table in section 3), the continuation convention (`next_lineno`/`next_offset`, `response_length=short|medium|long`), and, when host routing is configured, the `host` field. Call `help` once before first use.

## 10. Batching

Accept a top-level non-empty array of action objects and execute them in sequence, returning an array of results. Batched items are independent (no data flows between them) and share the session-level `response_length`/`host`; per-item fields exclude `host`/`response_length`. Single-action clients simply send one object. Batching is an efficiency adapter over the same verbs and changes no semantics.

## 11. Host routing (optional, v2)

The south side may target a browser on a remote host reached over SSH. The module installs or updates a small managed worker on that host (under the remote user's agent directory), invokes it against that host's local CDP browser, and proxies the same operations back; screenshots transfer back over the same channel and the remote temp file is removed. The north interface is unchanged whether the browser is local or remote; `host` becomes an accepted field and appears in `help`. This is an adapter on the discovery/transport seam only. Treat as a v2 add-on; v1 targets the local browser.

## 12. Cancellation and concurrency

- Every CDP call accepts an abort signal. A cancelled long action stops pending CDP work. A mutation already dispatched to the page may still take effect; report the uncertain effect honestly rather than claiming it was undone.
- Same-tab operations serialize (section 5). Different tabs proceed in parallel. Reference re-resolution (section 7) is the backstop that keeps concurrent use from acting on a stale element.

## 13. Consequential-action posture

The module does not implement a permission UI. `help` carries one behavioral contract: for unfamiliar low-trust navigation or consequential external actions (sending, posting, purchasing, uploading, deleting, changing account settings), the agent should confirm with the user unless already authorized. Enforcement belongs to the calling agent and its host; the module keeps actions legible (clear names, clear targets, explicit `ref_id`) so the host can gate them. Same delegation posture as the desktop module.

## 14. Failure modes

| Condition | Behavior |
|---|---|
| No attachable browser and `start` not run | Error with the enable-remote-debugging recovery hint |
| Ambiguous or unknown `ref_id` prefix | Error asking for more characters or to run `tabs` |
| Element `id` from a superseded snapshot / node gone | Box-model resolution fails; action errors, no blind click |
| Output exceeds 32 KB JSON | Truncate, cache, return `result_handle` + `next_offset` |
| Snapshot exceeds the line window | Return `next_lineno`; caller pages with `lineno` |
| CDP socket drops | Bridge auto-closes; next call reconnects; if it cannot, surface the error |
| Action dispatched then cancelled | Report the uncertain effect honestly |
| Missing result handle | Error with a re-run hint |

## 15. Constants (reference)

`MIN_TARGET_PREFIX_LENGTH = 8`; `TAB_IDLE_MS = 1200000` (20 min); `CDP_TIMEOUT_MS = 15000`; `NAVIGATION_TIMEOUT_MS = 30000`; navigation `readyState` poll window 5000 ms; `SNAPSHOT_LIMITS = { short: 60, medium: 140, long: 300 }` lines; text split piece = 700 chars; `OUTPUT_BUDGET_BYTES = 38000` (snapshot and tabs serialized cap); snapshot field caps title 1000 / url 8000 / pattern 2000 / element name 2000 / element value 4000 / role 128 bytes; tabs field caps title 500 / url 8000; `TEXT_BUDGET_BYTES = 32000` (inline text before a result handle); `RESULT_TTL_MS = 3600000` (1 h); `SCREENSHOT_TTL_MS = 86400000` (24 h); handle pattern `^[a-f0-9-]{36}$`; click press-release gap 50 ms; scroll-into-view settle 50 ms; `load_all` deadline 5 min; `start` endpoint wait 10000 ms; `start` process output cap 1 MiB; artifact dir mode 0700, files 0600.

`tabs` result shape: `getPages` lists `Target.getTargets` filtered to `type === "page"` and non-`chrome://` URLs; returns `{ offset, tabs: [{ ref_id, title, url }], truncated?, omitted_tabs?, next_offset? }`, page-able via `offset`/`next_offset` under the same 38 KB budget.

## 16. Testability

- Inject the CDP transport, the endpoint discoverer, and the clock. A scripted fake CDP server (canned responses and target/attach events) exercises the whole module with no real Chrome.
- Every action returns structured output (references, handles, resolved-target evidence). Assert on structure, not a live page.
- The isolated core is element resolution: given an element-ref map and current page state, return a live clickable point or a stale-reference failure. Unit-test it in isolation; it is where correctness is won or lost.

## 17. Rejected framings

- Launch a fresh headless browser: throws away the logged-in session, which is the value. Attach.
- Return raw CDP node ids to the agent: they go stale silently. Use per-tab element ids over backend node ids, re-resolved at action time.
- Dump the whole DOM or a11y tree: destroys the context budget. Bounded, resumable snapshots only.
- Close the browser when done: it is the user's shared session. Never close what the module did not exclusively own.
