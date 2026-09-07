# agent-hands

MCP server giving any coding agent **hands**: the ability to operate the user's real macOS desktop and their real logged-in Chrome.

Two deep modules behind one name:

| Module | Capability | What it stands on |
|---|---|---|
| **Desktop Control** | Inspect and operate native macOS apps: click, type, scroll, read the accessibility tree and screenshots | OpenAI's signed `codex app-server` (zero model turn) |
| **Browser Control** | Inspect and drive the user's persistent, logged-in Chrome | Chrome DevTools Protocol (CDP) |

## Install

```bash
npm install
npm run build
```

Requires Node 22+.

## Usage

Run as a stdio MCP server:

```bash
node dist/index.js
```

Check status:

```bash
node dist/index.js --status
```

### Surface selection

By default both surfaces are enabled. Use `AGENT_HANDS_SURFACES` to run only one:

```bash
# Desktop only (no Chrome/CDP)
AGENT_HANDS_SURFACES=desktop node dist/index.js

# Browser only (no macOS desktop control)
AGENT_HANDS_SURFACES=browser node dist/index.js
```

In an MCP client config:

```json
{
  "mcpServers": {
    "agent-hands": {
      "command": "node",
      "args": ["/path/to/agent-hands/dist/index.js"],
      "env": { "AGENT_HANDS_SURFACES": "desktop" }
    }
  }
}
```

### MCP client configuration

Add to your MCP client config (e.g. Claude Code, Pi):

```json
{
  "mcpServers": {
    "agent-hands": {
      "command": "node",
      "args": ["/path/to/agent-hands/dist/index.js"]
    }
  }
}
```

## Tools

### Desktop (10 tools, macOS only)

Advertised only when the required signed components are installed and verified.

| Tool | Purpose |
|---|---|
| `list_apps` | List running macOS applications |
| `get_app_state` | Get accessibility tree and screenshot of an app (call before interacting) |
| `click` | Click on an element or coordinate |
| `perform_secondary_action` | Perform a secondary accessibility action |
| `set_value` | Set the value of an accessibility element |
| `select_text` | Select text in an app element |
| `scroll` | Scroll within an app element |
| `drag` | Drag from one point to another |
| `press_key` | Press a key or key combination (xdotool syntax) |
| `type_text` | Type text into an app |

**Auto-snapshot (`observe: true`):** All 8 mutation tools accept an optional `observe: true` flag. When set, the server calls `get_app_state` in the same broker session after the action completes and returns the updated AX tree + screenshot alongside the action result. This halves round-trips for the common act→observe pattern (one process spawn instead of two).

**Batching (`desktop_batch`):** Run up to 20 same-app actions in a single MCP call. One identity resolution, one lock, one broker process spawn — all actions execute sequentially in the same ephemeral session. Stops on first error by default; set `continue_on_error: true` to keep going. Example:

```json
{
  "app": "com.apple.TextEdit",
  "actions": [
    { "method": "click", "element_index": "5" },
    { "method": "type_text", "text": "Hello world" },
    { "method": "press_key", "key": "Return" },
    { "method": "get_app_state" }
  ]
}
```

Returns an array of per-action results. Allowed methods: all desktop tools except `list_apps` and `desktop_batch` (no recursion).

#### Desktop prerequisites

1. **ChatGPT macOS app** installed at `/Applications/ChatGPT.app`
2. **Computer Use component** enabled (ChatGPT > Settings > Computer Use)
3. **macOS permissions**: Screen Recording and Accessibility granted (System Settings > Privacy & Security)

No active ChatGPT login or subscription is required at runtime.

### Browser (1 tool, cross-platform)

Always advertised. Call `help` for the action reference.

| Action | Purpose |
|---|---|
| `help` | Full action reference |
| `start` | Attach to a running browser (Linux: launch if needed) |
| `tabs` | List open tabs, get ref_ids |
| `open` | Open a URL or snapshot a tab |
| `find` | Search the accessibility tree with a pattern |
| `click` | Click by element id, CSS selector, or coordinates |
| `type` | Type text (at element or current focus) |
| `screenshot` | Capture viewport, element, or selector region |
| `html` | Get outerHTML of page/element/selector |
| `navigate` | Navigate a tab to a URL |
| `evaluate` | Evaluate a JS expression |
| `network` | List network resource entries |
| `load_all` | Click "load more" until it disappears |
| `raw` | Send any CDP method directly |
| `read_result` | Continue reading a large result |
| `discard_result` | Discard a stored result |
| `stop` | Close tab bridges |

#### Browser prerequisites

Chrome (or any Chrome-family browser) with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
chromium --remote-debugging-port=9222
```

Or set `CDP_PORT` / `CDP_PORT_FILE` environment variables.

## Session Management

The broker retains a single app-server session across calls instead of spawning per call. This keeps Computer Use activation alive between `get_app_state` and subsequent actions.

- **Idle timeout**: 30 seconds of inactivity closes the session automatically
- **Auto-recovery**: if the session dies, the next call creates a fresh one
- **Graceful shutdown**: `SIGTERM`/`SIGINT` close the session before exit

## Architecture

One Node process, two capability surfaces, one shared kernel:

```
MCP client (stdio)
    │
    ▼
┌─────────────────────┐
│   Kernel            │  transport, routing, validation,
│                     │  error sanitizing, status, audit
├──────────┬──────────┤
│ Desktop  │ Browser  │  two deep modules
│ 10 tools │ 1 tool   │
├──────────┼──────────┤
│ Broker   │ CDP      │  seams with prod + test adapters
│ (signed) │ (ws)     │
└──────────┴──────────┘
```

- **Conditional registration**: desktop tools appear only when signed components verify
- **Model-agnostic**: plain MCP over stdio, no vendor lock-in
- **No nested model**: the calling agent chooses every action
- **Fail closed**: unverified components, schema drift, or audit failures block the call

## Test

```bash
npm test
```

39 tests across kernel validation, browser snapshots, actions, tab bridge, artifacts, and key normalization — all using a scripted fake CDP adapter (no real Chrome needed).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CDP_HOST` | `127.0.0.1` | CDP debug host |
| `CDP_PORT` | `9222` | CDP debug port |
| `CDP_PORT_FILE` | — | Explicit DevToolsActivePort file path |
| `CODEX_COMPUTER_USE_HOME` | `~/.direct-computer-use` | Audit log location |

## License

MIT
