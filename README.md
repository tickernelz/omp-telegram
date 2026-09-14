# omp-telegram

![omp-telegram screenshot](screenshot.png)

**A Telegram companion hub for live OMP (oh-my-pi) coding agents.**

`omp-telegram` turns a private Telegram DM or topic into a mobile operator cockpit for [OMP (oh-my-pi)](https://omp.sh). It accepts prompts, queues work, streams live progress, raises the agent's `ask` decisions as interactive inline buttons, delivers final replies and generated artifacts, and lets companion extensions integrate Telegram-native capabilities without managing a separate bot loop.

It is a **runtime adapter**, not a remote terminal. Start or supervise work in the OMP TUI, then continue from Telegram while away from the keyboard. The bridge preserves OMP session semantics instead of pretending Telegram is a raw shell or PTY.

---

## What Makes omp-telegram Different?

This repository is a native hard fork of upstream `pi-telegram`, redesigned from the ground up for OMP with several major architectural overhauls:

### 1. 🚀 Live Progress Tail (Single-Bubble Engine)
Say goodbye to spamming dozens of individual messages for every tool call and reasoning chunk!
- **Single Live Bubble**: All in-flight activity (reasoning, tool calls, and todo progress) is aggregated into a **single, in-place updated message**.
- **User Prompt Context (`▰ 👤 Prompt`)**: Displays the incoming user prompt at the top of the bubble so you immediately know which task is being worked on.
- **Direct Reasoning Display**: The latest 1–2 paragraphs of agent reasoning stream directly as open text, while earlier thoughts are neatly folded into an expandable `<blockquote expandable>`.
- **Rich Tool History & Output**: Displays up to 4 of the latest tools with generous 240-character argument visibility and collapsible tool results in expandable blockquotes.
- **Roll-Over on Commentary & Ask**: When the agent sends intermediate commentary or asks a question, the active progress bubble freezes in place, and a fresh live bubble begins beneath it for subsequent work—keeping the chat chronological without requiring you to scroll up.
- **Clean Finalization**: Completed turns freeze the progress bubble into a compact audit summary (`✅ Completed in 14.2s · 4 tools · Model`), delivering the final answer as a separate, clean chat message.
- **Lazy Initiation**: Simple conversational turns without tools or reasoning produce zero progress bubbles, delivering direct answers immediately.

### 2. ⚡ Dual-Surface `ask` Tool
Replaces OMP's built-in `ask` tool with an interactive decision race:
- **Simultaneous Prompting**: When both the terminal and Telegram are active, questions appear on **both** the OMP TUI dialog and Telegram inline buttons simultaneously.
- **First Answer Wins**: Answer from whichever surface you are currently looking at. The first response settles the decision, and the losing surface is automatically dismissed and cleaned up.
- **Safe Dismissal**: Pressing `Esc` to dismiss the TUI dialog simply lets the CLI arm lose the race—it **never** aborts the turn or invalidates the Telegram buttons.
- **Unbounded Human-in-the-Loop**: Waits indefinitely without artificial timeouts, bounded only by explicit user cancellation.
- **Full Schema Parity**: Supports single-select, multi-select (interactive checkbox toggles + "Done selecting"), and free-text custom input via "Other (type your own)".

### 3. 🏷️ Smart Topic Naming & `/telegram-rename`
- **Curated Word Palette**: Defaults to `names` display mode using a 312-word curated vocabulary (12 unique, readable names per letter A–Z, e.g. *Atlas*, *Falcon*, *Zephyr*), avoiding cryptic `A`, `B`, `C` slot letters.
- **AI-Powered Renaming**: `/telegram-rename` automatically generates a concise, 2-word topic title matching the current task using OMP's lightweight model roles (`tiny` / `commit` / `smol`).
- **Manual & Reset Controls**: Use `/telegram-rename <name>` to set a custom title, or `/telegram-rename --reset` to restore the automatic palette name.

### 4. ⚙️ Interactive Settings TUI (`/telegram-settings`)
- **TUI Overlay**: Run `/telegram-settings` in your OMP terminal to launch a rich, interactive configuration menu. Navigate with arrow keys, press Space/Enter to cycle options, filter by typing, and press Esc to save.
- **Direct CLI Adjustments**: Modify settings directly from the command line using `/telegram-settings <key> <value>` (e.g. `/telegram-settings interval 1500ms` or `/telegram-settings mode names`).
- **Tab Autocompletion**: Full tab completion for setting keys and values in the OMP prompt.

### 5. 🌐 Multi-Instance Bus Architecture
- Run multiple OMP sessions in parallel across different directories or profiles.
- Automatic leader election and follower registration over a local Unix socket / Windows named pipe.
- Follower API calls are proxied through the leader, and cross-instance callbacks (such as `ask` button clicks) are reliably forwarded to the instance waiting on them.

---

## Installation

### From npm (Recommended)

Install directly through OMP's plugin manager:

```bash
omp install @tickernelz/omp-telegram
```

The package is recorded in `~/.omp/plugins/omp-plugins.lock.json` and loaded automatically on the next OMP start.

Useful companion commands:
```bash
omp plugin list      # show installed plugins
omp plugin doctor    # diagnose plugin loading issues
omp plugin uninstall @tickernelz/omp-telegram
```

### From Local Source (Development)

```bash
git clone https://github.com/tickernelz/omp-telegram.git
cd omp-telegram
npm install
npm run typecheck
omp install /path/to/omp-telegram
```

---

## Quick Start

1. **Setup Bot Token**:
   ```text
   /telegram-setup
   ```
   Paste your Telegram Bot token obtained from [@BotFather](https://t.me/BotFather).

2. **Connect the Bridge**:
   ```text
   /telegram-connect
   ```
   Start the bridge. The terminal will display pairing status and your assigned Telegram topic.

3. **Pairing**:
   Send any message or `/start` to your bot in Telegram. The bridge will bind your authorized user ID and create an instance thread/topic.

---

## Command Reference

| Command | Description |
|---|---|
| `/telegram-setup [profile]` | Configure Telegram bot token and credentials. Use named profiles for multiple bots. |
| `/telegram-connect [profile] [as=Name]` | Start the Telegram bridge. Optionally specify a profile or custom topic name. |
| `/telegram-disconnect` | Disconnect Telegram and clean up the active instance thread. |
| `/telegram-status [--debug]` | Display bridge health, active tools, queued turns, and diagnostic paths. |
| `/telegram-settings [key] [value]` | Open the interactive TUI settings menu, or view/update runtime settings via CLI. |
| `/telegram-rename [name|--reset]` | Rename current topic: with `<name>` for manual, no args for AI generation, or `--reset`. |

---

## Configuration Settings

Adjust settings via `/telegram-settings` or directly in `<agentDir>/telegram.json`:

| Setting | Options | Default | Description |
|---|---|---|---|
| `mode` | `names` | `letters` | `directories` | `names` | Naming style for Telegram instance topics. |
| `activity` | `verbose` | `tools` | `thinking` | `quiet` | `verbose` | Detail level in the single live progress tail bubble. |
| `interval` | `500ms` – `60000ms` | `2000ms` | Cadence for updating the live progress bubble in Telegram. |
| `drafts` | `on` | `off` | `on` | Stream draft previews before turn completion. |
| `rendering` | `rich` | `html` | `rich` | Assistant message format on Telegram (native Rich blocks vs HTML). |
| `voice` | `manual` | `mirror` | `always` | `manual` | Audio voice reply mode. |
| `time` | `always` | `interval` | `hidden` | `interval` | Wall-clock timestamp injection mode for prompt context. |
| `cleanup` | `on` | `off` | `on` | Automatically delete the instance topic in Telegram on clean quit. |

---

## State & Directory Layout

State is resolved strictly from OMP conventions (see `lib/paths.ts`):

1. `PI_CODING_AGENT_DIR` environment variable (automatically set by OMP when using `omp --profile <name>`).
2. Default: `~/.omp/agent`
3. Legacy fallback: `~/.pi/agent` (only if executed via legacy `pi` binary).

Key files under `<agentDir>/`:
- `telegram.json`: Persistent configuration, profiles, and tokens.
- `tmp/telegram/owners.json`: Process-level multi-instance leadership lock.
- `tmp/telegram/logs.jsonl`: Structured diagnostics log for the bridge runtime.
- `tmp/telegram/bus.sock`: Multi-instance IPC socket.

---

## Documentation

- [Documentation Index](docs/README.md)
- [Architecture & Design](docs/architecture.md) — System layout, domain DAG, and runtime lifecycles.
- [Public API Reference](docs/public-api.md) — Extension points, commands, and programmatic APIs.
- [Outbound & Progress Tail](docs/outbound.md) — Live progress tail engine, formatting, roll-over, and finalization.
- [Activity API](docs/activity.md) — Event contracts, assistant stream normalization, and consumer handlers.
- [Multi-Instance Bus](docs/multi-instance-bus.md) — Leader/follower protocol, IPC sockets, and callback routing.
- [UI Style Guide](docs/ui-style.md) — Visual standards for inline buttons, expandable blockquotes, and status layouts.

---

## Lineage & Attribution

`@tickernelz/omp-telegram` is an independent hard fork of [`llblab/pi-telegram`](https://github.com/llblab/pi-telegram) (forked at v0.45.8), which originated from [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram) (commit `cb34008`).

This fork re-targets the bridge natively onto OMP (Oh My Pi), replaces the multi-bubble outbound system with a unified Live Progress Tail, adds the dual-surface `ask` decision engine, expands topic naming with AI generation, and introduces the interactive `/telegram-settings` TUI.

Upstream release history and detailed fork changelog are preserved in [CHANGELOG.md](./CHANGELOG.md).

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
