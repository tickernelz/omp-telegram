# omp-telegram

![omp-telegram screenshot](screenshot.png)

**A Telegram companion hub for live OMP sessions.**

`omp-telegram` turns a private Telegram DM into a mobile operator surface for [OMP (oh-my-pi)](https://omp.sh). It accepts prompts, queues work, streams readable previews, delivers final replies and files, raises the agent's own `ask` questions as inline buttons, exposes safe controls, and lets companion extensions add Telegram-native capabilities without owning a second bot loop.

It is a **runtime adapter**, not a remote terminal. Start or supervise work in the OMP TUI, then continue from Telegram while away from the keyboard. Each Telegram destination follows a running OMP instance and sends prompts into that instance's currently active session; it is not permanently bound to one session file or session identity. The bridge preserves OMP session semantics instead of pretending Telegram is a PTY, shell, process launcher, or session browser. That boundary is the product: Telegram gets safe runtime handles, not raw terminal power.

Every completed intermediate commentary block from a Telegram-originated turn is delivered once as its own message before the existing final reply. While Telegram is connected, local, autonomous, and unclassified extension follow-up work also projects visible checkpoints and the final answer to the authorized Telegram target once and in order, preserving assistant-authored `telegram_button` comments as interactive prompt buttons. This connected companion projection is always active rather than configurable. Neither path mirrors local prompts, thinking, tool traffic, token deltas, or stale-generation work. The separate `Activity` setting defaults to `verbose` so new installations discover collapsed provider-exposed thinking and tool evidence immediately; operators can narrow it to one class or choose `quiet`. See [Outbound](docs/outbound.md#public-assistant-output) and the [configuration reference](docs/public-api.md#configuration-api).

This repository is a standalone fork of [`llblab/pi-telegram`](https://github.com/llblab/pi-telegram), taken at v0.45.8, and re-targeted to run natively on OMP instead of Pi. `llblab/pi-telegram` is itself a fork of [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram), started from upstream commit [`cb34008`](https://github.com/badlogic/pi-telegram/commit/cb34008460b6c1ca036d92322f69d87f626be0fc). The fork's purpose is the OMP re-targeting: the OMP SDK as the only host, `~/.omp/agent` as the default state root, host events OMP does not emit remapped rather than dropped, and a Telegram-backed `ask` tool that replaces OMP's builtin. Upstream release history is preserved in [CHANGELOG.md](./CHANGELOG.md).

## Install

From npm, through OMP's plugin manager:

```bash
omp install @tickernelz/omp-telegram
```

`omp install` is an alias of `omp plugin install` / `omp plugin link`. The package is recorded in `~/.omp/plugins/omp-plugins.lock.json` and loaded on the next OMP start. Useful companions:

```bash
omp plugin list      # show installed plugins
omp plugin doctor    # diagnose a plugin that did not load
omp plugin uninstall @tickernelz/omp-telegram
```

From a local checkout, linked as a plugin:

```bash
git clone https://github.com/tickernelz/omp-telegram.git
omp install /path/to/omp-telegram
```

Or run it straight from source for one session, without installing anything:

```bash
omp --extension /path/to/omp-telegram
```

OMP reads the `omp` manifest block in `package.json` (falling back to `pi`), so `--extension` accepts the repository directory itself; this package declares `omp.extensions` as `["./index.ts"]` and `omp.skills` as `["./skills"]`.

The package requires OMP `17.4.2` or newer — the peer floor for `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`, and `@oh-my-pi/pi-agent-core` — and Node `>=22.19.0`.

OMP is the only supported host. `lib/pi.ts` is the single file that imports the host SDK, its host imports are type-only, and settings resolve through a dynamic import so loading the boundary never pulls the SDK into the module graph.

## The `ask` Tool

This fork registers a tool named `ask`, which **replaces OMP's builtin ask tool**. It is the reason the fork exists: an agent question no longer pins you to the keyboard.

When both a Telegram destination and the local TUI are live, the question is raised on **both surfaces at once and raced**. The first surface to answer wins, the losing surface is torn down, and the tool result names the winner by appending one line to its text: `Answered via Telegram.` or `Answered via CLI.` (the same value is exposed as `answeredVia` in the tool details). When the CLI wins, the Telegram message's keyboard is cleared and its body is edited to read `Answered: in the CLI`.

The tool **blocks indefinitely and has no timeout**. It settles only on an answer from one of the surfaces, or on the turn's own abort signal. A shutdown cancels every pending question rather than leaving it hanging.

Each question is sent as its own Telegram message, one option per button row, in order. With more than one question the body is headed `Question 1 of 3` and the questions are asked sequentially.

Three answering modes:

- **Single select** — tap one option button; the answer is recorded immediately and only that button is restyled to the selected `primary` style. A `recommended` index adds the ` (Recommended)` suffix to that option.
- **Multi select** (`multi: true`) — option buttons toggle, showing `☑️` when selected and `▫️` when not, and a trailing **`Done selecting (n)`** button carries a live count of the current selection. Nothing is submitted until that button is pressed.
- **Free text** — every question also gets an **`Other (type your own)`** button. Pressing it clears the keyboard, asks you to `Send your answer as the next message in this chat.`, and the next message you send in that exact chat/thread becomes the answer. That message is consumed as the answer instead of being queued as a new prompt.

Fallbacks are explicit rather than silent:

- **No Telegram destination** — the tool delegates to the native TUI ask through the host's `invokeTool`, so behavior matches OMP's builtin.
- **Neither surface available** — it returns a stated error (`Ask could not reach the user: …`) telling the model to choose the most conservative reasonable default, proceed, and state the assumption, instead of blocking forever. Answers already collected before the failure are included.
- **Telegram rejects the question message** — the same error result is returned with the partial answers, rather than stranding the turn.

Option labels never enter `callback_data`: it carries only the `tgask` prefix, a 10-character request id, and a short option/done/other token, so it stays far inside Telegram's 64-byte ceiling and a long label cannot truncate a selection. Button text is normalized and truncated at 48 characters, and the question body at 3800 characters, for display only.

## Quick Start

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather). BotFather's chat commands and Mini App are different surfaces; Telegram Desktop supports the Mini App through **Open App** / **Menu** in the BotFather profile.
2. Run `/newbot`.
3. Pick a name and username.
4. Copy the bot token.

### 2. Configure OMP

Run this inside OMP:

```bash
/telegram-setup
```

Paste the bot token. If `~/.omp/agent/telegram.json` already contains a saved token, setup offers it as the default. If no saved token exists, setup prefills the first supported alias (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY`) as an environment reference such as `$TELEGRAM_BOT_TOKEN`, validates the resolved value, and persists the reference instead of copying the secret. Bot/session identity persists under `profiles.default`; shared handlers and assistant/voice/time settings remain top-level. `/telegram-setup default` and `/telegram-connect default` are exact aliases for the bare commands. Use `/telegram-setup <name>` only when you want an additional bot profile. Cancelling or failing named-profile token validation leaves the currently active profile and polling runtime unchanged; setup reports the profile as saved and connected only after polling startup succeeds.

### 3. Connect this OMP instance and its active session

```bash
/telegram-connect
```

The connected OMP instance owns Telegram polling. Use `/telegram-connect <profile>` to activate a named profile, and optionally append `as=Name` to name a fresh Workspace Thread. Each profile is a parallel bot runtime with isolated polling, diagnostics, Threaded Mode state, and local bus transport; the `default` profile keeps unsuffixed runtime paths. In classic mode each profile uses a singleton lock. When Telegram private-chat Threaded Mode is available, one live instance becomes the profile's leader and later visible OMP instances register as followers. A reopened follower Workspace with a remembered Thread reconnects automatically at session startup; a new Workspace still requires explicit `/telegram-connect`.

After an unclean computer shutdown, `/telegram-connect` detects truncated or structurally invalid temporary ownership/routing files, quarantines only the damaged files under `tmp/telegram/recovery/`, and retries once. A journal snapshot removed by older broad temp cleanup is rebuilt when its complete segment history proves an empty result, while a revisionless snapshot is repaired from the first surviving segment's exact predecessor when the reconstructed tail validates. Otherwise the snapshot and segments are quarantined as recovery evidence, a fresh journal is published, and startup continues with an informational diagnostic instead of requiring manual JSON repair. Unsupported journal versions block recovery without rewriting or quarantining the retained files; use a compatible runtime rather than deleting journals. Saved `telegram.json` configuration and runtime diagnostics remain intact. Recovery never replaces a verifiable live owner; if safe automatic recovery cannot complete, the command gives one explicit OMP-restart instruction instead of requiring deletion of the whole `tmp/` directory.

Persistent competing `getUpdates` clients cause a bounded transport stand-down rather than endless retries. Accepted local work remains queued/executable, but Telegram delivery stops. Inspect `/telegram-status --debug`, stop the competing client, then reconnect. See [Runtime Ownership](./docs/architecture.md#runtime-ownership).

### 4. Pair your Telegram account

Open the bot DM and send:

```text
/start
```

The first Telegram user successfully paired with the bot becomes the allowed owner. Pairing is saved before the candidate is authorized in memory; a failed save remains unpaired and can retry without overwriting an already configured owner. Other users are ignored. This is a first-contact security boundary: keep the bot private and send `/start` immediately after connecting. For stricter setup, restrict access to your account in the BotFather Mini App when that control is available, or preconfigure your numeric Telegram user id as `profiles.default.allowedUserId` in the existing `~/.omp/agent/telegram.json` before connecting (preserve the saved `botToken` and any other settings):

```json
{
  "profiles": {
    "default": {
      "botToken": "<existing-token>",
      "allowedUserId": 123456789
    }
  }
}
```

After required pairing state is persisted, `/start` is admitted independently from best-effort menu rendering and BotFather command-list synchronization, so either Telegram side effect can fail or remain in flight without stopping later inbound updates.

### 5. Enable optional bot capabilities in BotFather

Enable the optional capabilities the bridge needs in the [@BotFather](https://t.me/BotFather) Mini App. On Telegram Desktop, open the BotFather profile and use **Open App** / **Menu**, select the configured bot, open **Settings**, and toggle **Threaded Mode** there rather than relying only on the inline chat-command interface. The bridge does not fail loudly when a capability is off; the feature simply never triggers.

1. Enable guest mode so the bot can answer mentions and replies in chats where it is not a member.
2. Enable private-chat Threaded Mode; when it is available, one live instance becomes the profile's leader and later visible OMP instances register as followers. Without it, the bridge stays in classic single-owner DM mode.
3. Make the bot an administrator in any chat where the queue reaction shortcuts should work. Reaction updates require admin rights, so the shortcuts silently do nothing in non-admin chats; private chats deliver reactions without admin rights.

## What It Feels Like

- Start a task in the terminal, walk away, and keep supervising it from your phone.
- Answer the agent's `ask` questions as inline buttons from the phone, or from the terminal — whichever you reach first.
- Send another prompt while OMP is busy; it becomes a queued Telegram turn instead of interrupting the active run.
- Open `/start` to inspect status, model, thinking, settings, prompt templates, and queue controls.
- Send voice, images, files, replies, edits, or media groups; the bridge turns them into OMP context.
- Ask for an artifact; `telegram_attach` returns it before the turn's separate final text, or through explicit direct Telegram delivery.
- In Threaded Mode, run multiple visible OMP instances through one bot, each with its own Telegram thread.
- Configure named profiles to run independent Telegram bots from the same OMP agent directory without sharing transport or routing state.

## Product Model

| Lens | What `omp-telegram` owns |
| --- | --- |
| Operator companion | A phone-width control surface for the active session of a running OMP instance |
| Runtime adapter | Telegram targets mapped to OMP instances, then into each instance's current session lifecycle, queueing, previews, final replies, and artifacts |
| Interactive input | The `ask` tool, raced across the Telegram keyboard and the OMP TUI dialog |
| Telegram UI harness | Menus, settings, callbacks, Rich Markdown, drafts, active status, buttons, voice, and files |
| Multi-instance organism | One leader plus explicit visible followers routed through Telegram private-chat threads |
| Extension platform | Commands, sections, status rows, update handlers, inbound/outbound handlers, and voice providers |
| Safety boundary | No hidden OMP processes, no fake terminal, no PTY tricks, no arbitrary TUI slash-command forwarding |

## Feature Showcase

`omp-telegram` is intentionally broad: it is a Telegram-shaped runtime surface, not only a message relay. This catalogue keeps the practical feature surface visible while detailed contracts stay in `/docs`.

| Surface | What you can do | Why it matters |
| --- | --- | --- |
| Prompt intake | Send text, replies, edits, images, files, albums, voice notes, forwards with adjacent comments, and handler output into OMP. | Telegram becomes a real mobile input surface; one forward-plus-comment gesture stays one attributed prompt even for photo-only forwards. |
| Ask questions | Answer the agent's `ask` questions from Telegram buttons or the TUI dialog, whichever you reach first, with single, multi, or free-text answers. | A blocking clarification no longer pins the operator to the keyboard, and the answer is never collected twice. |
| Queue control | Inspect waiting turns, keep or skip stale work, promote important prompts, continue, abort, stop, or force the next queued item. | Long OMP tasks keep running while new mobile prompts stay visible and controllable instead of interrupting or disappearing. |
| Operator menu | Use `/start` for status, prompt templates, model, thinking, settings, queue, extension sections, and diagnostics. | The bot is an operator panel, not a command cheat sheet. |
| Prompt templates | Run OMP prompt templates as Telegram-safe commands such as `/fix_tests`. | Reusable local workflows become phone-accessible without exposing arbitrary terminal commands. |
| Model and thinking | Switch model or thinking level from Telegram through safe continuation flows; the level list includes `inherit` to match OMP's own selector. | Mobile control can adjust execution strategy without tearing down the current session. |
| Compaction | Confirm `/compact`, show native active status during compaction, and preserve Telegram-owned turn semantics. | Context maintenance is visible and safe from the phone. |
| Draft previews | Show Telegram's native `…typing` indicator whenever the connected instance is doing agent work, or enable Rich Draft previews for streamed answer text. | Local prompts, Telegram turns, and autonomous continuations remain visibly active while draft visibility stays independent from final rendering. |
| Activity | Keep the default `verbose` technical surface, show only `thinking`, show only `tools`, or select `quiet` for answer-only delivery. Every instance reloads this shared file-backed choice before a new agent run; thinking uses a headerless expandable quote, while each tool uses one iconless closed root row containing nested evidence details. | Persistent collapsed technical activity minimizes chat height and stays bounded, redacted, target-fenced, free of URL previews, and visually separate from semantic assistant answers. |
| Assistant rendering | Choose Native Rich Markdown or legacy Markdown-to-HTML for final assistant replies. | Renderer compatibility is explicit instead of being conflated with draft previews. |
| Bridge UI rendering | Render thinking through headerless expandable HTML, render each tool as an iconless native Rich root details tree with immediately visible arguments and collapsed secondary evidence, and keep menus, queue controls, status, settings, diagnostics, and sections on Telegram HTML/plain UI. | Harness-owned surfaces remain operationally predictable and visually distinct from model-authored answers. |
| Inbound files | Download inbound files to the OMP agent temp directory with size limits. | Screenshots, PDFs, datasets, and artifacts enter OMP as inspectable local files. |
| Outbound artifacts | Return generated files through `telegram_attach` before separate active-turn text, or by explicit direct delivery. | Agents send real artifacts in causal order, not as pasted blobs. |
| Voice input | Route audio through configured command-template handlers, programmatic handlers, or STT providers. | Voice notes become usable prompt context. |
| Voice output | Choose `manual`, `mirror`, or `always`; active automatic turns carry one compact `[voice] delivery: automatic voice` line, while explicit `telegram_voice` remains available. | Voice policy stays dynamic and model-legible without duplicating the full action contract in every prompt. |
| Buttons | Use `telegram_button` comments for footer buttons or fenced blocks for native button rows between paragraphs. | Assistant-authored choices become native Telegram interactions. |
| Generative Apps | Install or explicitly replace a reviewed `.mjs` application whose generated JSON button view may mix direct `app::method` actions with ordinary model prompts. | Repeated games, controls, tutors, and adapters compile routine interaction without losing selective model interpretation, explanation, or adaptation. |
| Callback routing | Route known callbacks to the owner extension and unknown callbacks back into OMP. | Companion extensions can build UI without polling Telegram themselves. |
| Threaded Mode | Run one leader plus visible follower OMP instances through named private-chat threads. | One bot can host a local multi-instance OMP organism without hidden process spawning. |
| Reroute and restore | Give unknown and command-created temporary threads explicit forward and replace/restore choices. | Forward removes the temporary tab; restore rebinds it and removes only the replaced old tab, so Telegram client state repairs without orphan controls. |
| Extension sections | Add menu sections, commands, status rows, settings, callbacks, and delivery helpers from companion extensions. | `omp-telegram` becomes a platform surface for other OMP extensions. |
| Runtime diagnostics | Use `/telegram-status` and recent runtime events for connection, role, negotiated bus protocol/build/capabilities, separate polling and inbound-worker progress, journal depth, local/foreign queue ownership, automatic retry waits, transport, and failures. | Compatible build skew, foreign semantic authority, a healthy poller, durable backoff and an infrastructure-blocked worker remain distinguishable without hidden logs. |
| Safety and ownership | Pair one owner, lock transport, scope targets, and reject fake terminal behavior. | Remote access remains explicit, bounded, and understandable. |

## Core Loop

```text
Telegram message
  -> Telegram turn
  -> queue or active dispatch
  -> OMP agent lifecycle
  -> streaming preview / native active status
  -> optional raced `ask` question
  -> final Rich Markdown reply
  -> optional files, voice, buttons, or callback actions
```

The bridge keeps Telegram responsive without stealing OMP's runtime model. Queueing, model changes, compaction, aborts, final delivery, and direct artifact sends all stay scoped to the OMP instance that accepted the work.

## Telegram Controls

Use these in the bot DM.

| Command | Purpose |
| --- | --- |
| `/start` | Pair when needed and open the main operator menu |
| `/name [Name]` | Set a manual Thread title immediately, or open rename/reset controls when Name is omitted |
| `/compact` | Confirm and run session compaction when safe |
| `/next` | Dispatch the next queued turn, aborting first if needed |
| `/continue` | Enqueue a priority continuation prompt |
| `/abort` | Abort the active run while preserving the queue |
| `/stop` | Abort the active run and clear waiting Telegram turns |

Hidden compatibility shortcuts: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings` jump into the same menu system.

## OMP Commands

Run these inside OMP.

| Command | Purpose |
| --- | --- |
| `/telegram-setup` / `/telegram-setup default` | Save or update `profiles.default` |
| `/telegram-setup <profile>` | Save or update a named-profile bot token |
| `/telegram-connect` / `/telegram-connect default` | Activate `profiles.default` and acquire its transport ownership |
| `/telegram-connect <profile>` | Activate a named profile and acquire its transport ownership |
| `/telegram-connect [profile] as=Name` | Give a fresh Workspace Thread one unique capitalized Latin-word identity while connecting |
| `/telegram-disconnect` | Confirm, then stop polling, release ownership, and delete this instance's Threaded Mode tab; a graceful OMP quit always preserves restart ownership and independently deletes the tab only when automatic cleanup is enabled |
| `/telegram-status` | Inspect connection, mode, separate polling/worker progress, journal depth, queue, transport, automatic retry state, and recent diagnostics |

Named profile identifiers contain only lowercase ASCII letters and digits (maximum 32 characters); `default`, `main`, and `active` remain reserved. If graceful thread deletion was interrupted, a same-profile replacement reuses its still-active thread and cancels the superseded cleanup instead of deleting and recreating the tab during startup.

## Main Surfaces

### Operator Menu

`/start` opens the Telegram-native control panel: status, prompt-template commands, model selection, thinking level, settings, queue controls, and extension sections. It is the primary Telegram UI; reaction shortcuts are secondary queue affordances.

### Ask Dialogs

Agent `ask` questions arrive as their own messages with one inline button per option, an always-present `Other (type your own)` row, and — for multi-select questions — a `Done selecting (n)` row. The same question is live in the OMP TUI at the same time; answering either surface settles the tool and closes the other. See [The `ask` Tool](#the-ask-tool).

### Queue Runtime

Messages sent while OMP is busy become queued turns. Queue controls let you inspect, prioritize, keep or skip, and dispatch work without touching the terminal.

Queue policy:

- One prompt is one queue object with exactly one current lane and one current position; it never reserves a shadow place in the other lane.
- Priority and Normal are separate FIFO lanes; Priority dispatches first.
- Moving `Normal → Priority` removes the prompt from Normal and places it at the Priority tail. Moving `Priority → Normal` removes it from Priority and places it at the Normal tail; no former position is restored.
- Keep/Skip never changes lane position. Skip preserves durable authority while waiting so Keep remains reversible, then settles that authority and drops the prompt without a model turn when dispatch reaches it. Skipped prompts stay visible at their physical queue position with a struck-through ordinal, but are excluded immediately from the executable queue count shown in both the OMP status bar and Telegram main menu. Graceful session shutdown discards all remaining queued authority, so a new session starts empty.
- Reactions control two independent dimensions; changing one category preserves the other:
  - `Positive`: `👍`, `⚡️`, `❤️`, `🕊`, `🔥` — controls Priority.
  - `Negative`: `👎`, `👻`, `💔`, `💩`, `🗑` — controls Skip.
- Priority and Skip can coexist—for example `👍 + 💩`. Skip wins at dispatch, regardless of which negative emoji is selected.
- Menu selectors and reactions share queue state, but the bot cannot remove a user's reaction; Keep may clear internal Skip while the user's emoji remains visible until they remove it.

The detailed contract lives in [Priority, Reactions, Keep, and Skip](./docs/architecture.md#priority-reactions-keep-and-skip). If OMP automatically retries a transient provider failure, the active Telegram turn stays bound until the successful reply arrives or the run reaches its terminal end without a continuation.

### Native Rich Markdown

Rich Markdown is the default model-answer membrane. Complete assistant and guest model replies use Telegram's native Rich Message APIs; valid bot commands and URLs retain Telegram's native clickable affordances. Activity thinking uses persistent headerless expandable HTML, while each completed tool uses one iconless native Rich root details node whose arguments open with the root while secondary JSON evidence stays collapsed; `thinking`, `tools`, and `verbose` select the visible classes, while menus, status rows, queue controls, settings, diagnostics, and other operational UI retain explicit Telegram HTML/plain rendering. Three Settings controls keep the layers separate: `Draft previews` toggles streamed answer drafts, `Activity` chooses `quiet` or `verbose` technical activity, and `Assistant rendering` chooses final-answer delivery (`rich` Native Rich Markdown or `html` legacy Markdown-to-HTML).

### Files And Artifacts

Inbound files land under `<agent-dir>/tmp/telegram` and default to a 50 MiB limit. `telegram_attach` is the canonical outbound file path. During Telegram-originated turns it attaches to the active reply; during explicit local/TUI delivery it can send to the paired/default chat or routed Threaded Mode target.

### Voice And Media

Voice notes, audio, images, PDFs, and other media can pass through configured inbound handlers, programmatic handlers, or registered STT providers. Outbound voice can use configured `outboundHandlers` or registered TTS providers; `omp-telegram` owns reply policy and Telegram transport, while providers own synthesis. Configure provider-neutral local/API pipelines and ordered fallbacks through [`telegram.json` command templates](./docs/voice.md#choose-an-integration-path). The default `manual` reply mode still supports intentional voice delivery through explicit `telegram_voice` actions; `mirror` and `always` add automatic voice policy. Explicit actions prefer positional `{text}`, `{text|lang}`, or `{text|lang|rate}` cells and use JSON for multiline content, named fields, or escaping.

### Buttons And Callbacks

Assistant replies can place controls between paragraphs using standalone triple-backtick `telegram_button` blocks, or keep them in the footer using top-level hidden `telegram_button` comments. Both wrappers accept singleton cells and mixed JSON/CML matrices. Native in-body rows allow up to eight buttons; HTML compatibility moves these rows to the footer. In-body clicks acknowledge without recoloring the Rich body, while footer selection styles remain unchanged. Hidden comments accept a JSON object, adaptive JSON/CML matrix, or positional Compact Matrix Literal (CML). One adaptive matrix may mix named JSON objects with positional CML cells; separators are optional and one trailing comma is tolerated, including inside JSON objects. Top-level cells become full-width rows while nested rows group one or more buttons horizontally without an artificial parser-level width cap; generated surfaces default to five columns and use six to eight only for short position-bearing labels. CML uses `{value}`, `{label|prompt}`, `{|prompt}`, or the corresponding three-atom form with `selected_style` set to `primary`, `success`, or `danger`; omitting the first atom leaves the existing prompt-as-label fallback in charge, while the optional style still requires a non-empty prompt. A fourth atom adds disabled state: `{|Next||1}` or `{|Next||true}` disables, `0` or `false` enables (exact lowercase), and omission stays enabled; the third atom may be empty in this form. JSON uses boolean `disabled`. Disabled controls require no prompt or selected style: `{Next|||1}` shows only a label, while `{|||1}` is a blank disabled cell. Disabled controls remain visible without registering callbacks or invoking prompts/app methods. It trims atom boundaries, preserves non-structural text literally, and decodes only `\|`, `\}`, and `\\`. Prefer one matrix comment for multiple buttons. Buttons use `label` plus `prompt`, or the compact `value` key when both are identical. The bridge strips every assistant-authored HTML comment from Telegram previews and final replies regardless of Markdown position or owning extension, while only recognized top-level comments activate buttons or voice; comment-only output sends no text message and the OMP terminal transcript remains unchanged. It renders valid inline buttons and routes callbacks back into OMP as queued prompts or extension-owned callback actions. Button-only replies receive the standard `☑️ **Choose an option:**` heading as automatic visible fallback text. Once a generated prompt button is accepted, only that exact button switches to its optional `selected_style` (`primary` blue by default, `success` green, or `danger` red) without altering its agent-authored label or emoji; every style still queues the selected prompt.

### Threaded Mode And Multi-Instance Bus

Classic private DM mode is the base product mode. When Telegram private-chat Threaded Mode is available, the bridge enables a local leader/follower bus automatically:

- One live leader owns `getUpdates`.
- Followers are visible OMP processes started by the operator.
- Each connected instance gets a Telegram thread target.
- Queued work for a live follower transfers through authenticated exact-journal handoff rather than replaying under the transport owner.
- Follower session replacement preserves registration, and a reopened follower Workspace with a remembered Thread reconnects automatically without allocating a Thread for an unremembered Workspace.
- Unknown threads are preserved and offered explicit reroute/restore choices.
- Telegram never launches hidden OMP processes.

In Threaded Mode, open Settings → **🧵 Thread display** to choose **Letters** (default), **Names**, or **Directories** for this bot profile. Fresh tabs are created with the active mode's title instead of being visibly renamed afterward. Telegram tab titles, OMP terminal status, live Thread choosers/notices, prompt attribution, and named `telegram_message` targeting use the same acknowledged display name; target IDs and live registrations still own routing. Names shows the generated dictionary name chosen for the slot, such as `Anchor` for slot `A`. Directory mode adds persistent global-letter suffixes when a Workspace has multiple instances, such as `extensions_a` and `extensions_c`. `/name` sets a manual Thread display name; **Reset to automatic** restores the selected automatic projection. Switching preserves Thread IDs, slots, generated recovery identity, and queue ownership. Partial application reports an error and can be retried without recreating Threads.

| Mode | Best for | Runtime shape |
| --- | --- | --- |
| Classic DM | One running OMP instance and its active session controlled from one private bot chat | One polling owner, one queue/runtime surface |
| Threaded Mode | Several visible OMP instances sharing one bot | One leader owns transport; each named private-chat thread follows its assigned instance and current session |

## Environment Configuration

Most controls live in OMP commands or the Telegram menu. Environment variables remain for bootstrap and transport boundaries, and keep their historical `PI_` prefixes:

| Area | Variables |
| --- | --- |
| Bot token bootstrap | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_KEY` |
| HTTP proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, plus `NODE_USE_ENV_PROXY=1` or Node `--use-env-proxy` |
| Telegram network family | `PI_TELEGRAM_NETWORK_FAMILY=auto`, `ipv4`, `ipv6`, or `ipv4-fallback` |
| Agent data root | `PI_CODING_AGENT_DIR` |
| Inbound file limit | `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES`, `TELEGRAM_MAX_FILE_SIZE_BYTES` |
| Outbound attachment limit | `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES`, `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES` |

The agent data root resolves in three steps: `PI_CODING_AGENT_DIR` first, which OMP itself rewrites for `omp --profile <name>`; then `~/.pi/agent` when the running executable or `argv[1]` identifies a **legacy `pi` runtime**; otherwise `~/.omp/agent`. Under OMP the default is always `~/.omp/agent`.

Defaults are chosen for ordinary private-bot use: saved config in `~/.omp/agent`, inbound temp files in `~/.omp/agent/tmp/telegram`, `assistant: { rendering: "rich", draftPreviews: true, activity: "verbose", timeInjection: "interval" }` for assistant output and activity, and native Telegram active status for long-running turns.

## Extension Platform

Companion extensions can integrate with Telegram without owning polling or transport:

- Register Telegram slash commands.
- Add menu sections and settings surfaces.
- Add compact status rows.
- Deliver target-aware operational views and chat actions from companion code.
- Observe normalized assistant, thinking, tool, compaction, and settlement activity without blocking OMP.
- Handle update/callback namespaces.
- Provide inbound preprocessing handlers.
- Provide outbound voice synthesis.
- Use direct delivery helpers for explicit local/TUI sends.

Host events OMP does not emit are remapped rather than dropped: settlement folds into `agent_end` filtered on `willContinue`, prompt start/end map to `tool_approval_requested`/`tool_approval_resolved`, and a failed session compaction maps to `auto_compaction_end`.

Stable public entrypoints are documented in [Public API](./docs/public-api.md), [Telegram Delivery API](./docs/delivery.md), [Telegram Activity API](./docs/activity.md), [Extension Sections](./docs/sections.md), [Inbound Handlers](./docs/inbound.md), [Outbound Handlers](./docs/outbound.md), [Updates](./docs/updates.md), and [Voice Integration](./docs/voice.md).

## Safety Boundaries

Durable inbound admission is a **process-crash recovery** guarantee. Atomic private-file replacement preserves acknowledged journal authority and its journal-owned `acceptedThroughUpdateId` polling cursor across ordinary process exit, crash, kill, and replacement, but the extension does not flush files or parent directories for host/kernel/filesystem/device/power-loss durability. `telegram.json` contains configuration only. Keep `~/.omp/agent` on appropriately managed storage and backups if that stronger operational guarantee is required. Before downgrading to a runtime that predates the cursor-schema journal, run `node scripts/check-downgrade.mjs [agent-dir]`; it reports `BLOCKED` and exits non-zero while unresolved journal authority remains, because an older runtime could repoll admitted updates. See [Durable Admission And Recovery](./docs/architecture.md#durable-admission-and-recovery).

`omp-telegram` intentionally does not:

- Spawn hidden OMP follower processes.
- Pretend Telegram is a terminal or PTY.
- Forward arbitrary Telegram slash commands into the OMP TUI.
- Inject raw TTY input or terminal-control sequences.
- Replace OMP session lifecycle without an official OMP API.
- Let non-owner Telegram users control the bridge.

Telegram is a companion surface around a live OMP runtime, not a second runtime. It can compact the current session, but it cannot create, resume, fork, browse, or switch sessions until OMP exposes safe public extension APIs for those operations.

A Telegram prompt is a normal model turn in the active OMP session and therefore inherits that session's active post-compaction context; the bridge does not make token cost proportional only to the new mobile message. The bundled `telegram-bridge` Skill owns general agent operation; `show-me` turns current work and system behavior into truthful phone-width Markdown or focused browser-ready HTML while remaining useful in the terminal; `generated-control-surface` proactively compiles optional evidence-backed ephemeral controls when model interpretation remains useful; and `generative-apps` compiles stable repeated interaction into reviewed reusable applications whose bound buttons bypass model inference while ordinary prompt buttons retain it. Generative Apps may own a closed state machine or adapt another authoritative tool, service, Actor Run, or application through bounded methods. Disconnecting removes `omp-telegram`'s delivery tools and transient routing guidance from later requests until direct ownership or follower registration returns, without changing other active OMP tools. OMP session JSONL contains model history; profile-scoped `omp-telegram` `logs*.jsonl` contains redacted operational events and is never model context.

Global `Symbol.for` registry keys carry the `omp-telegram` identity, so installing this fork alongside `pi-telegram` cannot make the two share runtime state.

## Documentation Map

- [Architecture](./docs/architecture.md) — runtime, domains, queue, transport, and Threaded Mode overview.
- [Public API](./docs/public-api.md) — package entrypoints and stable companion-extension contracts.
- [Telegram Delivery API](./docs/delivery.md) — target-aware operational views, logical message handles, and lifecycle-safe transport.
- [Telegram Activity API](./docs/activity.md) — normalized lifecycle events, source identity, non-blocking delivery contexts, and consumer policy examples.
- [Inbound Handlers](./docs/inbound.md) — Telegram-to-OMP preprocessing pipelines.
- [Outbound Handlers](./docs/outbound.md) — final text/voice/file transformation and delivery.
- [Voice Integration](./docs/voice.md) — STT/TTS provider model and reply policies.
- [Extension Sections](./docs/sections.md) — Telegram-native companion UI surfaces.
- [Updates](./docs/updates.md) — update handler registry and callback interop.
- [Multi-Instance Bus](./docs/multi-instance-bus.md) — leader/follower routing in Threaded Mode.
- [UI Style](./docs/ui-style.md) — menu, emoji, labels, dialogs, and inline keyboard standards.
- [Callback Namespaces](./docs/callback-namespaces.md) — callback ownership and routing.
- [Command Templates](./docs/command-templates.md) — handler command-template conventions.
- [Generative Apps](./docs/generative-apps.md) — reusable application identity, state, generated button views, hybrid action routing, replacement, and bounded execution contract.

The docs index lives at [docs/README.md](./docs/README.md).

## Development

```bash
npm run typecheck
npm test
npm run audit
npm run pack:check
```

Full validation:

```bash
npm run validate
```

`npm run audit` fails closed over dependencies owned and shipped by `omp-telegram`, omitting OMP host packages declared as peers because the host selects and supplies their dependency graph. Use `npm run audit:host` separately to inspect the complete installed development graph, including upstream host advisories; host findings remain visible without being misattributed to this extension's release artifact.

To exercise a working copy against a real session without installing it:

```bash
omp --extension /path/to/omp-telegram
```

Project context:

- [AGENTS.md](./AGENTS.md) — engineering and runtime conventions.
- [BACKLOG.md](./BACKLOG.md) — release-relevant open work.
- [CHANGELOG.md](./CHANGELOG.md) — completed delivery history, including preserved upstream `pi-telegram` history.
