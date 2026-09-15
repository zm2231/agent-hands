# agent-hands

[![npm version](https://img.shields.io/npm/v/@zmerchant/agent-hands?logo=npm&color=cb3837)](https://www.npmjs.com/package/@zmerchant/agent-hands)
[![macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](https://www.npmjs.com/package/@zmerchant/agent-hands)

Gives your agent hands. Real ones.

OpenAI built the best computer use out of any model and kept it locked inside Codex. agent-hands takes that same signed binary and exposes it as a standard MCP server. Claude, Hermes, OpenClaw, whatever agent you use; it can now see your screen, click buttons, type text, scroll through apps, and drive your actual logged-in Chrome. The full desktop and browser, not a sandbox.

## What this actually does

Your agent gets two capabilities through one server:

**Desktop control.** Read the accessibility tree and screenshot of any running macOS app. Click elements, type text, press key combos, scroll, drag, set values. The agent sees what you see and acts on it directly.

**Browser control.** Connect to your real Chrome session with all your cookies, logins, and tabs intact. Open URLs, click elements, fill forms, take screenshots, run JavaScript, read network activity. No fake browser, no separate profile.

Both run through standard MCP (stdio), so any agent that speaks the protocol can use them.

## Setup

Add to your agent's MCP config:

```json
{
  "mcpServers": {
    "agent-hands": {
      "command": "npx",
      "args": ["-y", "@zmerchant/agent-hands@latest"]
    }
  }
}
```

`npx` fetches the package on first run and caches it. Your agent now has hands.

### Updating

With the `@latest` config above, restart your agent (the MCP server process) and `npx` pulls the newest published version. There is no separate update command. To pin a version instead, replace `@latest` with `@0.3.1`; you then update by bumping that number.

### From source instead

```bash
git clone https://github.com/zm2231/agent-hands.git
cd agent-hands
npm install && npm run build
```

Then point the config at the local build (`"command": "node", "args": ["/path/to/agent-hands/dist/index.js"]`). A source checkout does not auto-update; `git pull && npm run build` to update.

### What you need installed

- **Node.js 22+**
- **Codex Computer Use** (ships inside the ChatGPT macOS app):
  1. Install [ChatGPT for Mac](https://openai.com/chatgpt/mac/) at `/Applications/ChatGPT.app`
  2. Open ChatGPT > Settings > enable **Computer Use**
  3. Grant **Screen Recording** and **Accessibility** permissions (System Settings > Privacy & Security)
- For browser control, one of two transports:
  - **Extension (recommended, reaches your real logged-in profile).** Load the unpacked MV3 extension and register its native host once, then agent-hands drives your actual Chrome with your cookies, logins, and tabs. No launch flag, no separate profile. See [Browser via extension](#browser-via-extension-no-debug-port) for the one-time setup.
  - **Remote-debugging port (fallback).** If no extension host is installed, agent-hands connects over Chrome's DevTools port. Launch Chrome with:
    ```
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
    ```
    It auto-detects the port from Chrome's `DevToolsActivePort` file if present. On Chrome 136+ this attaches to a dedicated debug profile, not your default one.

No ChatGPT subscription required at runtime. agent-hands uses the signed Codex Computer Use binary directly.

## Desktop tools

| Tool | What it does |
|---|---|
| `list_apps` | List running macOS apps |
| `get_app_state` | Screenshot + accessibility tree of an app |
| `click` | Click an element or coordinate |
| `type_text` | Type text into an app |
| `press_key` | Press a key combo (`cmd+c`, `Return`, etc.) |
| `set_value` | Set the value of a UI element |
| `select_text` | Select text in an element |
| `scroll` | Scroll within an app |
| `drag` | Drag between two points |
| `perform_secondary_action` | Right-click, expand, and other secondary actions |

All mutation tools accept `observe: true` to get a fresh screenshot and accessibility tree back after the action completes. One call instead of two.

`desktop_batch` lets you send up to 20 same-app actions in a single call. One connection, sequential execution, roughly a second saved per action in round-trip overhead.

## Browser actions

One tool (`browser`) with 17 actions: `start`, `tabs`, `open`, `find`, `click`, `type`, `screenshot`, `html`, `navigate`, `evaluate`, `network`, `load_all`, `raw`, `read_result`, `discard_result`, `stop`. Call `help` for the full reference.

### Browser via extension (no debug port)

By default the browser surface uses the unpacked MV3 extension when its native-host manifest is installed and reachable. Otherwise it connects to Chrome over the remote-debugging port. The extension path drives your real Chrome profile without a `--remote-debugging-port` launch flag. Install agent-hands globally or use a source checkout. Running the host from `npx` is not supported because its cache path is not stable across updates.

1. Load the extension: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` directory. Copy the resulting extension ID (stable across reloads because the manifest pins a `key`).
2. Register the native host, allowlisting the extension ID:
   ```bash
   agent-hands install-browser-host <extension-id>
   ```
   The default target is Chrome. Use `--browser brave`, `--browser edge`, `--browser chromium`, or `--browser all` to write the matching native-host manifests. Re-running the command safely merges extension IDs. Use `agent-hands uninstall-browser-host [--browser ...]` to remove the manifest, launcher, and install record. Use `agent-hands browser-host-status` to diagnose an installation.
3. Start agent-hands, then reload the unpacked extension before calling `browser start`. Automatic selection probes the installed host for three seconds before falling back to TCP. Set `AGENT_HANDS_BROWSER_TRANSPORT=extension` to require the extension, or `AGENT_HANDS_BROWSER_TRANSPORT=tcp` to require remote-debugging TCP. The extension stops retrying after five unavailable-host attempts and releases its offscreen document.

On a global install, run `npm update -g @zmerchant/agent-hands`; in a source checkout, run `git pull`. Neither update needs host reinstallation because the installed launcher points at the stable installation path. Re-run `agent-hands install-browser-host <extension-id>` after changing Node versions.

The CLI writes its socket path and a per-run auth token to `~/.config/agent-hands/browser-host.json` (mode `0600`) automatically; you do not create that file. With this transport, `browser start` attaches to your live tabs; it does not launch Chrome.

The native host reads one active controller configuration, so run one extension-transport agent-hands server at a time.

## Configuration

Only enable the surface you need:

```bash
AGENT_HANDS_SURFACES=desktop node dist/index.js   # desktop only
AGENT_HANDS_SURFACES=browser node dist/index.js   # browser only
```

Or in your MCP config:

```json
{
  "env": { "AGENT_HANDS_SURFACES": "desktop" }
}
```

| Variable | Default | What it does |
|---|---|---|
| `AGENT_HANDS_SURFACES` | `desktop,browser` | Which surfaces to enable |
| `AGENT_HANDS_BROWSER_TRANSPORT` | auto | Browser transport: auto-detect extension then TCP, `tcp` (debug port), or `extension` (required unpacked MV3 extension + native host) |
| `CDP_HOST` | `127.0.0.1` | Chrome debug host |
| `CDP_PORT` | `9222` | Chrome debug port |

## How it works under the hood

The desktop surface dispatches to OpenAI's signed `codex app-server` binary (the same one Codex uses) through a retained session. The agent never runs its own model; it just executes what your agent asks for. Sessions stay alive across calls so Computer Use activation persists between reading the screen and acting on it. 30 seconds of idle closes the session automatically; if it dies, the next call creates a fresh one.

The browser surface speaks the Chrome DevTools Protocol over one of two transports, chosen automatically. When the extension's native-host manifest is installed and reachable, it drives your real logged-in Chrome through an unpacked MV3 extension and a native-messaging host, bridged to the server over an authenticated per-run socket; commands run via `chrome.debugger`, so there is no separate debug profile and no `--remote-debugging-port` flag. Without the extension it falls back to CDP over Chrome's remote-debugging port. `AGENT_HANDS_BROWSER_TRANSPORT` forces either path.

## License

MIT
