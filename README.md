# agent-hands

Gives your agent hands. Real ones.

OpenAI built the best computer use out of any model and kept it locked inside Codex. agent-hands takes that same signed binary and exposes it as a standard MCP server. Claude, Hermes, OpenClaw, whatever agent you use; it can now see your screen, click buttons, type text, scroll through apps, and drive your actual logged-in Chrome. The full desktop and browser, not a sandbox.

## What this actually does

Your agent gets two capabilities through one server:

**Desktop control.** Read the accessibility tree and screenshot of any running macOS app. Click elements, type text, press key combos, scroll, drag, set values. The agent sees what you see and acts on it directly.

**Browser control.** Connect to your real Chrome session with all your cookies, logins, and tabs intact. Open URLs, click elements, fill forms, take screenshots, run JavaScript, read network activity. No fake browser, no separate profile.

Both run through standard MCP (stdio), so any agent that speaks the protocol can use them.

## Setup

```bash
npx agent-hands
```

Or install from source:

```bash
git clone https://github.com/softaworks/agent-hands.git
cd agent-hands
npm install && npm run build
```

Add to your agent's MCP config:

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

Your agent now has hands.

### What you need installed

- Node.js 22+
- ChatGPT macOS app at `/Applications/ChatGPT.app` with Computer Use enabled in Settings
- Screen Recording and Accessibility permissions granted (System Settings > Privacy & Security)
- For browser control: Chrome running with `--remote-debugging-port=9222`

No ChatGPT subscription required at runtime.

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
