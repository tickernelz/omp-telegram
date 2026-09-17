# omp-telegram

![omp-telegram screenshot](screenshot.png)

A Telegram companion hub for live [OMP (oh-my-pi)](https://omp.sh) coding agents.

omp-telegram turns a private Telegram DM or topic into a mobile operator cockpit for OMP. It accepts prompts, queues work, streams live progress, surfaces the agent's `ask` decisions as interactive buttons, delivers final replies and generated artifacts, and lets other extensions add Telegram-native capabilities without running their own bot loop.

It is a runtime adapter, not a remote terminal. You start or supervise work in the OMP TUI, then continue from Telegram while away from the keyboard. The bridge keeps OMP session semantics instead of pretending Telegram is a raw shell or PTY.

This repository is a native hard fork of `pi-telegram`, re-targeted onto OMP and versioned independently from `0.1.0`.

## Features

### Live progress tail

In-flight activity is aggregated into a single message that is edited in place, rather than one message per tool call or reasoning chunk.

- The active bubble shows the current prompt, the most recent reasoning, tool rows with arguments, and collapsible tool results.
- When the agent posts intermediate commentary or asks a question, the live bubble freezes and a new one starts beneath it, so the chat stays chronological and you never have to scroll up to follow along.
- Finished turns freeze into a compact audit summary and the final answer is delivered as a separate message.
- Turns with no tools and no reasoning produce no progress bubble at all; the answer just arrives.
- The render ladder measures UTF-8 bytes against the real Telegram collapse limit, so sections widen until the budget demands they shrink.
- Settled todo rows age out of the bubble instead of leaving a wall of checkmarks.

Default update cadence is 10 seconds. Tune it with the `interval` setting.

### Dual-surface ask

The bridge replaces OMP's built-in `ask` tool with an interactive decision race.

- When both the terminal and Telegram are active, a question appears on both surfaces at once.
- The first answer wins. The losing surface is dismissed and cleaned up automatically.
- Dismissing the TUI dialog does not abort the turn and does not invalidate the Telegram buttons.
- There is no artificial timeout. Waiting is bounded only by explicit cancellation.
- Single-select, multi-select, and free-text answers are supported, including the "Other (type your own)" option.

### Plan review and plan mode control

OMP plan mode is normally terminal-only. This extension puts it on Telegram.

When the agent proposes a plan, a review card arrives with the plan title, the plan file path, and the plan body, followed by inline buttons:

- Approve and execute
- Approve and compact context
- Approve and keep context (hidden when the measured context usage is high, because the host disables that option near the limit)
- Refine plan

The buttons drive the same approval overlay you would use in the terminal, by sending synthetic keystrokes to the focused TUI component. If you answer in the terminal first, the Telegram card is edited to show that the decision was made in the CLI and its buttons are removed. Only one side can win, and the losing side is always cleaned up.

Plan mode itself is controllable from Telegram:

- `/plan [goal]` enters plan mode
- `/plan_pause` pauses it
- `/plan_exit` turns it off

The status menu also carries a plan row whose marker reflects the real, prompt-derived plan-mode state. Every command restores whatever draft text was already sitting in the CLI composer, so a Telegram command never costs you unsent typing.

This whole surface sits behind the `planreview` setting, which is on by default.

### Topic naming

Each OMP session gets its own Telegram topic so parallel work stays separated.

- The default naming mode draws from a curated 312-word vocabulary, twelve readable names per letter, instead of cryptic slot letters.
- `/telegram-rename` generates a short title that matches the current task, using OMP's lightweight model roles.
- `/telegram-rename <name>` sets a title manually, and `/telegram-rename --reset` restores the automatic name.

### Settings

- `/telegram-settings` opens an interactive TUI overlay. Arrow keys navigate, space or enter cycles a value, typing filters, escape closes.
- `/telegram-settings <key> <value>` changes one setting directly from the prompt.
- Keys and values are tab-completed in the OMP prompt.

### Multi-instance bus

You can run several OMP sessions at once, in different directories or profiles.

- A local Unix socket, or a Windows named pipe, carries leader election and follower registration.
- Follower API calls are proxied through the leader.
- Cross-instance callbacks, such as an `ask` button tapped in a session that did not raise it, are forwarded to the instance actually waiting on the answer.

### Resident host

Telegram usually stops answering when the OMP process behind it exits. A resident host removes that dependency: `/telegram-host install` writes one systemd user unit that keeps a normal OMP session alive inside tmux, so the bridge keeps polling and keeps running turns while every terminal is closed.

The host is an ordinary OMP session with a real terminal, not a reduced headless mode. That is what preserves the features a stripped-down process would lose: plan mode, provider approvals, the interactive bash overlay, and every harness slash command. Because the terminal is a tmux session, you can attach to it from SSH, or through a web terminal, and watch or take over exactly what the agent is doing.

- `/telegram-host install` — write the unit and wrapper, then enable and start them.
- `/telegram-host uninstall` — stop and disable the unit, then remove its artifacts.
- `/telegram-host restart` — re-render the unit and restart it.
- `/telegram-host status` — report unit state and the pane serving the host.
- `/telegram-host attach` — print the tmux command that opens the host terminal.
- `--dry-run` — print the whole plan, every path and step, without changing anything.

Installation needs Linux with `systemctl` and `tmux`. The unit uses `Restart=always`, so the host comes back if the agent dies or the machine reboots.

### Flood control

Telegram rate limits are handled rather than propagated. Outbound calls to a chat back off when the API returns 429, automatic retry sleep is capped so a long administrative penalty fails fast instead of stalling the event loop, and topic provisioning falls back to an existing topic when topic creation is rate limited.

## Installation

### From npm

Install through the OMP plugin manager:

```bash
omp install @tickernelz/omp-telegram
```

The package is recorded in `~/.omp/plugins/omp-plugins.lock.json` and loaded on the next OMP start.

Related commands:

```bash
omp plugin list
omp plugin doctor
omp plugin uninstall @tickernelz/omp-telegram
```

### From source

```bash
git clone https://github.com/tickernelz/omp-telegram.git
cd omp-telegram
npm install
npm run typecheck
omp install /path/to/omp-telegram
```

Requires Node 22.19.0 or newer, and OMP `@oh-my-pi/pi-coding-agent` 17.4.2 or newer.

## Quick start

1. Store a bot token.

   ```text
   /telegram-setup
   ```

   Create the bot with [@BotFather](https://t.me/BotFather) and paste the token. Use `/telegram-setup <profile>` to keep several bots side by side.

2. Connect the bridge.

   ```text
   /telegram-connect
   ```

   The terminal reports pairing status and the Telegram topic assigned to this session.

3. Pair your account.

   Send `/start`, or any message, to the bot. The bridge binds your authorized user ID and creates the instance thread.

Once paired, send a prompt from Telegram and watch it run. Use `/telegram-settings` in the OMP terminal to adjust behaviour, and `/telegram-status` to inspect the bridge when something looks wrong.

## Commands

Commands you type in the OMP prompt:

| Command | Description |
| --- | --- |
| `/telegram-setup [profile]` | Store a bot token and credentials. Named profiles allow multiple bots. |
| `/telegram-connect [profile] [as=Name]` | Start the bridge, optionally for a profile or with a chosen topic name. |
| `/telegram-disconnect` | Stop the bridge and clean up the active instance thread. |
| `/telegram-status [--debug]` | Report bridge health, active tools, queued turns, and diagnostic paths. |
| `/telegram-settings [key] [value]` | Open the settings TUI, or read and write one setting. |
| `/telegram-rename [name\|--reset]` | Rename the current topic, by name, by generation, or back to automatic. |
| `/telegram-host [action]` | Install, remove, restart, inspect, or attach to a resident host that serves Telegram with no terminal open. |

Commands you type in Telegram:

| Command | Description |
| --- | --- |
| `/start` | Open the menu and pair the bridge. |
| `/name <name>` | Rename the current topic. |
| `/compact` | Compact the current session. |
| `/plan [goal]` | Enter plan mode. |
| `/plan_pause` | Pause plan mode. |
| `/plan_exit` | Exit plan mode. |
| `/next` | Force the next queued turn. |
| `/continue` | Queue a continue prompt. |
| `/abort` | Abort the current turn. |
| `/stop` | Abort the turn and clear the queue. |

## Settings

Change settings with `/telegram-settings`, or edit `<agentDir>/telegram.json` directly.

| Setting | Values | Default | Description |
| --- | --- | --- | --- |
| `mode` | `names`, `letters`, `directories` | `names` | Naming style for instance topics. |
| `activity` | `verbose`, `tools`, `thinking`, `quiet` | `verbose` | Detail level in the live progress bubble. |
| `interval` | `2000ms` to `30000ms` | `10000ms` | How often the live progress bubble is edited. |
| `drafts` | `on`, `off` | `on` | Stream draft previews before a turn finishes. |
| `voice` | `manual`, `mirror`, `always` | `manual` | When replies are delivered as audio. |
| `time` | `always`, `interval`, `hidden` | `hidden` | Wall-clock timestamp injection into prompt context. |
| `cleanup` | `on`, `off` | `on` | Delete the instance topic when the session exits cleanly. |
| `planreview` | `on`, `off` | `on` | Plan approval cards and plan mode control from Telegram. |

## State and files

State follows OMP conventions, resolved in this order:

1. `PI_CODING_AGENT_DIR`, which OMP sets when you run `omp --profile <name>`.
2. `~/.omp/agent`
3. `~/.pi/agent`, only when running through the legacy `pi` binary.

Files under `<agentDir>/`:

- `telegram.json` holds configuration, profiles, and tokens.
- `tmp/telegram/owners.json` holds the process-level multi-instance leadership lock.
- `tmp/telegram/logs.jsonl` holds structured runtime diagnostics.
- `tmp/telegram/bus.sock` is the multi-instance IPC socket.

## Development

```bash
npm run typecheck   # TypeScript, no emit
npm test            # full test suite
npm run validate    # typecheck, tests, audit, and pack check
```

The test suite covers the runtime domains, the extension composition invariants, and the package's public surface.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md) describes the runtime layout, domain DAG, and lifecycles.
- [Public API](docs/public-api.md) is the canonical list of stable extension surfaces.
- [Outbound](docs/outbound.md) covers the progress tail engine, formatting, roll-over, and finalization.
- [Activity](docs/activity.md) documents event contracts and assistant stream normalization.
- [Delivery](docs/delivery.md) covers target-aware delivery handles and lifecycle fencing.
- [Multi-instance bus](docs/multi-instance-bus.md) documents leader and follower routing.
- [Sections](docs/sections.md) documents the extension section standard.
- [Voice](docs/voice.md) covers STT and TTS provider registration.
- [Generative apps](docs/generative-apps.md) covers the managed app runtime.
- [UI style guide](docs/ui-style.md) sets the visual standard for buttons and status layouts.

Bundled Skills, available to the agent when this extension is installed: `telegram-bridge`, `show-me`, `generated-control-surface`, and `generative-apps`.

## Lineage

`@tickernelz/omp-telegram` is an independent hard fork of [`llblab/pi-telegram`](https://github.com/llblab/pi-telegram), forked at v0.45.8, which in turn descends from [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram) at commit `cb34008`.

This fork re-targets the bridge onto OMP, replaces the multi-bubble outbound system with the unified live progress tail, adds the dual-surface `ask` engine, adds plan review and plan mode control from Telegram, and introduces the interactive settings TUI.

Release history is in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT. See [LICENSE](./LICENSE).
