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
- For browser control: Chrome with remote debugging enabled. Launch with:
  ```
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  ```
  agent-hands auto-detects the debug port from Chrome's `DevToolsActivePort` file if present.

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
| `CDP_HOST` | `127.0.0.1` | Chrome debug host |
| `CDP_PORT` | `9222` | Chrome debug port |

## How it works under the hood

The desktop surface dispatches to OpenAI's signed `codex app-server` binary (the same one Codex uses) through a retained session. The agent never runs its own model; it just executes what your agent asks for. Sessions stay alive across calls so Computer Use activation persists between reading the screen and acting on it. 30 seconds of idle closes the session automatically; if it dies, the next call creates a fresh one.

The browser surface connects to Chrome's DevTools Protocol over the debugging port. Standard CDP, nothing exotic.

## License

MIT
