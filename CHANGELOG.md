# Changelog

> Each release keeps at most 8 outcome records of at most 512 characters.

## Unreleased

## 0.6.6: Delivery Reconcile, Plan Review Hardening, and Stream Optimizations

- `Multi-Chunk Edit Reconciliation`: Bridge delivery reconciles unchanged chunks during `editView` without failing when Telegram returns 400 'message is not modified', allowing multi-chunk plan review cards to reliably update and clear inline keyboards.
- `Plan Review Hardening`: `resolveFromUpdate` validates choices against active card options, sends keystrokes immediately to the CLI overlay, records failures accurately, and gracefully supersedes stale pending cards when newer plans arrive.
- `Progress Tail & Memory Leaks`: Removed per-delta reasoning line derivation on streaming thinking deltas, bounded summary retention for completed tools, deleted expired guest placeholder rotation sessions, and resolved retired ask callbacks cleanly.

- `Full Plan Details Presentation`: Approval cards for plan review no longer truncate plan content to a single message ceiling. Telegram rich message delivery automatically chunks long plans across messages while anchoring inline action buttons to the terminal chunk.
- `English Localization`: Converted remaining Indonesian status messages and callback warnings in plan review and plan mode runtimes to standard English.

## 0.6.4: Auto-Connect Belongs To The Host

- `Host Auto-Connect Scope`: The cold-start gate only read the agent-wide `host.json` anchor, so every ordinary OMP session sharing that agent directory typed `/telegram-connect` into its own terminal seconds after session start and took the bot from the resident host. Auto-connect now requires the host session itself, identified by the wrapper's `OMP_TELEGRAM_HOST` stamp or the host's private tmux socket.

## 0.6.3: Host Startup Failures Are Visible

- `Bun Virtual Path Rejection`: Inside a Bun standalone binary `existsSync("/$bunfs/...")` answers true, so the 0.6.2 existence check still emitted a virtual executable path that no other process could run, and the installed host restarted forever. Candidate executables are now confirmed with `realpathSync` plus an executable-bit check, and a bare `node`/`bun`/`deno` runtime no longer stands in for the OMP command.
- `Silent Restart Loop`: A tmux session whose command died at startup returned success, so the wrapper exited 0 and the unit restarted endlessly with no journal reason. The wrapper now probes the session after startup and exits non-zero naming the executable it tried to run.

## 0.6.2: Host Executables Are Absolute

- `Host Executables Are Absolute`: The generated wrapper looked up `tmux` on `PATH`, which a systemd user unit does not inherit, so the installed host crash-looped with `tmux: command not found` while the same wrapper worked when run by hand. Both the tmux and OMP executables are now baked in as absolute paths at render time.
- `Bun Standalone Executable Resolution`: A Bun-compiled OMP reports a virtual `/$bunfs/...` path in `process.argv[1]` that does not exist on disk, so the rendered wrapper pointed at a file nothing could execute. The resolver now verifies the candidate on the filesystem and otherwise resolves `omp` from `PATH`.


- `Cross-Platform Host Tests`: The host test suite asserted POSIX path shapes, so Windows CI failed on a feature it correctly refuses to install there. Path, binary, and socket assertions are now separator-agnostic and verified against simulated Windows paths.

## 0.6.0: Resident Telegram Host

- `Resident Telegram Host`: `/telegram-host` installs one systemd user unit that keeps a normal OMP session alive in tmux, so Telegram keeps polling and answering turns with no terminal open. The host is a real interactive session, which is what keeps plan mode, provider approvals, the PTY bash overlay, and harness slash commands working; `attach` prints the tmux command to watch or take over it.
- `Host Cold-Start Auto-Connect`: A hosted agent directory runs `/telegram-connect` on session start, but only while it owns neither the transport lock nor a follower registration. A resident host starts with neither, so the ordinary auto-start path could not claim the bot before.
- `Deterministic Unit Plan`: `install`, `uninstall`, `restart`, and `status` are rendered as an ordered step list before anything runs, so artifacts are written before a unit is enabled and uninstall disables before it deletes. Failures stop the sequence and report the exact command.

## 0.5.2: Plain Prose README

- `README Rewritten`: Replaced the emoji-heavy README with plain prose a person would write. Removed every pictograph, added the plan review and plan mode control surface, documented the Telegram-side command set, corrected the progress interval default to 10 seconds, and listed the bundled Skills.

## 0.5.1: Plan Commands Actually Reach The Runtime

- `Plan Commands Reach The Runtime`: `/plan`, `/plan_pause`, and `/plan_exit` were registered as reserved names but the composed command runtime never forwarded `handlePlanMode`, so every invocation returned unhandled and fell through to the model as a literal prompt. The runtime now routes them through the plan-mode runtime.
- `Status Plan Row Is Reachable`: The status menu plan row was built conditionally on `planModeOptions`, which no caller ever supplied, so the row never rendered. The option is now threaded from the extension through the menu action runtime into both status render paths.
- `Status Plan Callbacks Wired`: `handlePlanModeAction` was accepted by the status callback handler but never passed by the routing composition, making every `plan:` tap answer "Interactive message expired". It is now wired end to end.
- `Truthful Plan State`: The row previously marked `Exit` with the live indicator whenever plan mode was off. It now carries one marker on `Plan on` that reflects the real prompt-derived state, and the `as any` cast in the command-runtime wiring was replaced with a typed adapter.

## 0.5.0: Telegram Plan Review And Plan-Mode Control

- `Plan Review Cards in Telegram`: Propose dispatches (`write xd://propose`) automatically generate a Telegram plan-review card with inline buttons (`Approve and execute`, `Approve and compact context`, `Approve and keep context`, `Refine plan`).
- `Keystroke Driving for Terminal Overlays`: Tapping an approval button sends synthetic TUI keystrokes to control the interactive CLI plan review overlay without touching the keyboard.
- `CLI-Won Race Handling`: If the plan is approved or refined directly from the terminal, the Telegram review card flips to show decided in CLI and strips buttons.
- `Plan Mode Commands`: Added `/plan [goal]`, `/plan_pause`, and `/plan_exit` bot commands to enter, pause, and exit OMP plan mode directly from Telegram.
- `Draft Preservation`: Plan mode command toggles use composer APIs and restore the operator's current CLI draft without character loss.
- `Status Menu Integration`: Added live plan mode controls to the status menu (`📝 Plan on`, `⏸ Pause`, `⏹ Exit`).
- `Plan Review Setting`: Controlled via `assistant.planReview` in config and toggleable via `/telegram-settings planreview on|off`.

## 0.4.3: Telegram 429 Resilience, Topic Reuse, And 10s Paced Progress

- `Topic Reuse by Default`: `/telegram-connect` no longer forces `createForumTopic` on every run. Existing active workspace topics are preserved and reused cleanly; pass `--fresh` or `as=Name` to explicitly request a fresh topic.
- `Graceful 429 Topic Fallback`: When Telegram supergroup flood control returns 429 (e.g. `retry after 1703`) on `createForumTopic`, provisioning catches the error and falls back to an existing topic or General chat, letting the bridge connect immediately instead of aborting.
- `Outbound Chat Pacing & 429 Cooldown`: Per-chat outbound message and multipart calls enforce flood cooldown tracking. When a 429 is received on a chat, subsequent calls to that chat back off until the `retry_after` window expires.
- `Capped 429 Retry Sleep`: Automatic API retry sleep is capped at 60s via `TELEGRAM_MAX_RATE_LIMIT_SLEEP_MS`. Long administrative penalties (>60s) fail fast so callers can execute graceful fallbacks instead of stalling the event loop for half an hour.
- `10s Default Progress Cadence`: Raised default progress tail update interval from 5s to 10s (`TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS = 10_000`) and added dynamic 429 backoff on edits without dropping the live bubble.

## 0.4.2: Todo Retention, Command-Free Prompt, And Wider Sections

- `Settled Todos Age Out`: A task that reaches completed or cancelled stays in the Todo table for `TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS` (60s) and then drops out, so the newest work is visible instead of a wall of checkmarks. The header keeps counting every task (`9/11`), hidden rows are reported as `[N settled tasks hidden]`, a dedicated expiry timer republishes the bubble when the window elapses, and an all-settled list removes the section entirely.
- `Slash Commands Are Not Prompts`: `isCommandInvocationPrompt` keeps `/reload-plugins` and friends out of the Prompt section on both `agent-start` and `prompt-update`, preserving the last real prompt. Paths such as `tolong cek /tmp/x.log` are unaffected.
- `Byte-Accurate Size Budget`: The render ladder now measures UTF-8 bytes against `TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_BYTES` (8,000) instead of characters, which is the real limit behind Telegram's Show more collapse.
- `Wider Sections`: Tool rows 4 → 10, todo rows 8 → 20, tool results 250 → 600 chars, tool arguments 120 → 200 chars, reasoning lines 8 → 14, reasoning budget 4,000 → 5,000 chars, and the Prompt section 140 → 600 chars, each degrading through the ladder only when the byte budget demands it.

## 0.4.1: Progress Tail Survives A Mid-Turn Connect

- `Live Bubble Re-Homes On Target Change`: Running `/telegram-connect` mid-turn binds the tail to the DM fallback before the Workspace Thread record exists. `ensureActivity` then accepted the new target but kept editing the message in the old chat, so the Thread stayed empty for the rest of the turn and no API error was raised. The stale bubble is now abandoned and a fresh one is created in the bound chat/thread.
- `Publish Interval Read Live`: `createTelegramProgressTailRuntime` captured `getIntervalMs()` once at construction, before `configStore.load()`, so `assistant.progressIntervalMs` and every `/telegram-settings` change were ignored until the session restarted. The interval is now resolved per schedule.
- `Unbound Activity Stays Silent`: Target adoption refuses to bind an activity whose target was deliberately cleared, keeping the fail-closed contract when an activity-mode refresh fails.

## 0.4.0: Mid-Turn Steering Parity And Self-Healing Progress Tail

- `Mid-Turn Steering Parity`: Telegram messages that arrive while a turn is running are now handed to OMP's steering queue via `sendUserMessage(content, { deliverAs: "steer" })` instead of waiting for `agent_end`, matching OMP CLI semantics. The active turn adopts the new reply anchor and source message ids, and the live progress bubble updates its prompt line. Opt out with `assistant.steering: false` to keep queue-and-drain behaviour.
- `Progress Tail Lost-Update Fix`: `publishToTelegram` now serializes every publish through one chain and renders state at send time. Previously a timer-driven edit that overlapped an incoming event cleared `dirty` on completion, stranding the newest tools/reasoning until an unrelated event arrived - the root cause of bubbles that froze mid-turn.
- `Idempotent Edits`: Identical rendered markdown is never re-sent, removing redundant `editMessageText` calls that burned rate-limit budget and produced Telegram `message is not modified` rejections.
- `Self-Healing Bubble`: After `TELEGRAM_PROGRESS_TAIL_MAX_PUBLISH_FAILURES` consecutive edit failures the dead message is abandoned and a fresh bubble is created, instead of the tail going permanently silent against an unreachable message.
- `Status Line Moved To Bottom`: The working/completed status row now renders last and no longer duplicates the model name, which stays in the context table.

## 0.3.19: Dot Continue Parity, Hidden Time Default, And Session Resume Auto-Adoption

- `Native Dot Continue Parity`: Standalone `.` messages from Telegram are now forwarded directly to OMP as pure `.` without any `[telegram]` prefix or `[time]` block, matching exact CLI continue semantics and consuming only 1 token.
- `Time Injection Defaults to Hidden`: Changed `resolveTelegramTimeConfig` default from `interval` to `hidden` to eliminate redundant `[time]` blocks from prompts, aligning with OMP's native `<system-reminder>` date context.
- `Resilient Context Store Auto-Adoption`: Enhanced `isSessionContextActive` to lazily adopt active extension context when `session_start` was bypassed on `--resume`, preventing progress tail from remaining dormant in resumed sessions.
- `Mid-Turn Thread ID Target Resolution`: Updated `progress-tail` and `routing` authority to accept and upgrade thread targets when a turn starts before follower registration completes, ensuring progress bubbles appear reliably in fresh topics.

## 0.3.18: Seamless Transport Authority Across Role Promotion And Retry Persistence

- `Resilient Authority on Transport Role Promotion`: Fixed a bug where live progress tail froze indefinitely during a turn when a follower instance was promoted to bus leader. `createTelegramAssistantOutputAuthorityRuntime` now recognizes that an active follower turn retains valid delivery authority when the instance becomes the direct leader (`deps.ownsDirect()`), preventing subsequent tool progress from being silently discarded.
- `Persistent Edit Dirty State`: Ensured `publishToTelegram` retains `dirty = true` on transient Telegram API edit rejections (such as rate limits or concurrent edit cancellations), ensuring pending progress updates are cleanly flushed on subsequent activities or idle ticks rather than lost.

## 0.3.17: Direct Bot API Backing For Interactive Ask Tool

- `Direct Bot API Backing for Ask Tool`: Fixed an issue where the `ask` tool question message failed to send to Telegram with `(runtime-unavailable)` error while CLI dialog was active. `askRuntime` now directly binds to `telegramApiRuntime.sendMessage` and `call("editMessageText")`, bypassing the fragile global delivery runtime registry and providing reliable question delivery and button interaction across leader and follower sessions.
- `Descriptive Ask Delivery Diagnostics`: Enhanced `TelegramAskDeliveryError` to include both failure reason and detailed error description from the delivery transport layer.

## 0.3.16: Multi-Turn Progress Tail Continuity, Cold Token Stamp Grace, And Eager Delivery Bind

- `Multi-Turn Progress Tail Continuity`: Fixed an issue where the live progress bubble became stale in multi-turn sessions (autonomous tasks, subagents, and sequential tool runs). `progress-tail` now maintains a single active bubble across turns with `willContinue: true`, decouples from publication reservation deadlock, and finalizes cleanly upon session settlement.
- `Cold Token Stamp Grace`: Fixed `runtime-unavailable` rejections on `ask` tool delivery caused by generation increments during initial token loading. `createTelegramTransportStampRuntime` now adopts the bot token on cold startup without bumping generation or invalidating initial transport stamps.
- `Eager Delivery Runtime Startup`: Bound delivery lifecycle runtime eagerly at extension load, ensuring `sendTelegramView` and `ask` are immediately functional even before `session_start` lifecycle events trigger.
- `Resilient Thread Target Resolution`: Enhanced `proactivePushTargetGetter` and delivery authorization to fallback to `findCurrentThreadRecord()?.target`, preventing thread ID loss when transient active turn state clears.

## 0.3.15: Dynamic Model Synchronization And Model Info In Context Table

- `Dynamic Model Synchronization`: Fixed an issue where changing models via CLI (e.g. `/model` to DeepSeek V4.1) left the Telegram progress tail displaying the previous model name. `onAgentStart` now automatically synchronizes the active model from the live session context (`ctx.model`) into the model store.
- `Dedicated Model Context Row`: Added `🤖 Model` as an explicit row inside the Context Table in the progress tail bubble, ensuring the active model name and provider are always prominently visible alongside CWD, Title, and Usage.

## 0.3.14: Flush Final Response And Freeze Progress Tail While Subagents Run

- `Final Response Projection While Subagents Run`: Fixed a bug where assistant text responses produced at the end of a turn were withheld from Telegram because OMP does not fire `agent_end` while background subagents or async tasks are still running. `onMessageEnd` now flushes the final assistant segment, and the progress tail bubble freezes upon receiving final text, preventing it from appearing hung in a working state for minutes.
- `Deduplicated Final Segment Flushing`: Added guard to prevent duplicate delivery of the final text message across streaming `done` and lifecycle `message_end` boundaries.

## 0.3.13: Dedicated Sticky Todo Table And Multi-Phase Task Parsing

- `Dedicated Sticky Todo Table`: Elevated the Todo checklist into its own prominent markdown table placed above the Tools section (`## 📋 Todo (done/total)`), keeping the user's checklist visibly tracked without being buried under tool logs.
- `Multi-Phase Task Parser`: Enhanced the todo toolResult parser in `progress-tail.ts` to support multi-phase schemas (`details.phases[].tasks[].content`) emitted by OMP's native todo tool, ensuring task states synchronize accurately with the CLI.

## 0.3.12: Live Session Context Table, Sticky Todo, And Extended Intervals

- `Rich Context Bar`: Added native markdown status table rendering session context (`📂 CWD`, `🌿 Git branch & dirty status`, `🏷️ Title`, and `📊 Usage percent & context window size`) at the top of the live progress tail bubble.
- `Sticky Todo`: Todo items now persist across turn segments and commentary boundaries within the active session, updating in-place alongside tool progress and omitted when empty.
- `Extended Cadence Options`: Added 15s (`15000ms`) and 30s (`30000ms`) update intervals to `/telegram-settings` (TUI and CLI), providing maximum API quota efficiency for long multi-tool batches.

## 0.3.11: Full Native Rich Message Markdown Migration And Paragraph Reasoning

- `Native Rich Message Migration`: Fully migrated live progress tail to Bot API 10.1 Rich Message format (`sendRichMessage` and `editMessageText` with `rich_message: { markdown }`). The progress bubble now supports native tables for tools (`| St | Tool | Arguments |`) and todo checklists (`| St | Task |`), plus native collapsible `<details>` blocks for tool result inspection.
- `Paragraph-First Reasoning & 7.5KB Budget`: Expanded safety budget from 3,500 characters to 7,500 characters (comfortably utilizing Telegram client's ~8 KiB threshold before "Show more"). The latest 2 reasoning paragraphs are always rendered open and complete without mid-word character chopping, while earlier historical thoughts fold cleanly into an expandable `<details>` block.
- `Removed Legacy Rendering Toggle`: Removed the redundant `rendering` setting from TUI, CLI, and menu keyboards since rich format is now globally authoritative and native everywhere.

## 0.3.10: Discard Deleted Ambiguous Workspace Bindings On Reconnect

- `Sync-Aware Workspace Recovery`: Do not resurrect a workspace binding whose underlying Telegram topic is already confirmed deleted or returned `TOPIC_ID_INVALID`. Ambiguous pending provisions pointing to deleted topics are now cleanly cleared so the provisioner provisions a fresh valid topic without throwing.
- `Track Workspace Binding Invalidation`: Enabled `markStaleByTarget` to record sync observations directly for historical workspace bindings.

## 0.3.9: Recover Ambiguous Topic Provisioning From Durable Workspace Bindings

- `Durable Workspace Binding Recovery`: When topic provisioning encounters transport failure or an ambiguous pending provision, the provisioner now rechecks and reuses the exact durable inactive workspace binding for that workspace if available, instead of failing repeatedly or creating duplicate topics.
- `Safe Reconnect`: Prevents `/telegram-connect` from aborting with `createForumTopic may have committed before transport failed` when an existing valid topic is already recorded in the workspace store.

## 0.3.8: Fix Ask Button Callback Enqueueing And Stalled Race

- `Fix Stale Ask Callback Enqueueing`: Added `tgask:` to `TELEGRAM_OWNED_CALLBACK_PREFIXES`. Previously, when an ask button was clicked after the CLI won the race or before the follower registry was warm, unrecognized `tgask:*` callback data fell through into the generic user prompt queue, enqueueing `[callback] tgask:...` as a new user message and stalling the session.
- `Drop Unmatched Ask Callbacks`: Late or orphaned ask callback taps are now recognized as bridge-owned and answered silently with callback ack, preventing them from interrupting active turn queues.

## 0.3.7: Rate Limit Prevention, Non-Blocking Edit Fallback, And 5s Default Interval

- `5s Default Cadence`: Raised the default progress tail update interval from 2000ms to 5000ms to safely accommodate Telegram's global 30 edits/minute per-chat throttling. Updated interval options in `/telegram-settings` to 2000ms, 3000ms, 5000ms, 7500ms, 10000ms.
- `Non-Blocking Rate Limits on Edits`: Pass `retryRateLimit: false` on progress tail `editMessageText` calls so a 429 response skips the ephemeral edit immediately instead of blocking the transport pipeline and follower bus socket for 60–180s.
- `Anti-Hang Pipe`: Fixes follower IPC timeout and delivery queue stalling when multiple rapid edits were backed up behind Telegram's 429 retry sleep.

## 0.3.6: Container Unwrapping, Smart Reasoning Truncation, And Ask Hardening

- `Smart Container Unwrapping`: Meta-tools like `fabric_exec` executing nested OMP core tools (`omp.bash`, `omp.read`, `omp.edit`) now automatically unwrap. The outer wrapper is hidden while child tools run and omitted upon completion, eliminating duplicate tool listings on Telegram while retaining standalone TS executions and errors.
- `Sentence-Aware Reasoning Tail`: Ported `hermes-progress-tail` tail truncation semantics. Truncated reasoning now slices from the tail rather than the head, preserves complete thought sentences, and avoids cutting off the beginning of words.
- `Ask Freeze Reliability`: Fixed a race condition where answer callbacks from CLI could stall progress tail freezing if the live message was delayed. Tool-end for `ask` now unconditionally finalizes and freezes the active segment.

## 0.3.5: Hierarchical Section Budgeting And Rich Integrity

- `Rich HTML Integrity`: Solved plain-text degradation where long turns stripped all HTML tags when exceeding message character limits. Sections (prompt, reasoning, tool arguments, tool results) are now budgeted at the source before rendering, and multi-tier degradation gracefully drops older tool output blockquotes and compresses historical thoughts without ever stripping HTML markup.
- `Reasoning Formatting`: Clamped reasoning slicing to whitespace boundaries to prevent mid-word cuts, keeping the latest 1-2 thoughts open while older thoughts remain neatly folded into an expandable blockquote.

## 0.3.4: User Prompt Display And Entity Parse Fail-Safe

- `User Prompt Display`: The active live progress tail bubble now displays the user's incoming message (`▰ 👤 Prompt`), keeping the exact task context visible in Telegram without needing to scroll or guess what prompt is being executed.
- `HTML Entity Safety`: Fixed an issue where truncating long reasoning or message bodies sliced across HTML tags, producing unbalanced `</blockquote>` tags that triggered Telegram API `400 can't parse entities` errors and stalled progress updates. Added automatic plain-text fallback if an entity parse is ever rejected.

## 0.3.3: Direct Reasoning Display And Configurable Progress Interval

- `Direct Reasoning Display`: The latest 1 to 2 reasoning paragraphs are now rendered directly as visible plain text beneath the Reasoning header without collapsible nesting, while earlier historical thoughts are neatly folded into an expandable blockquote.
- `Configurable Progress Interval`: Added `interval` setting to `/telegram-settings` (TUI, CLI, and autocompletions), letting operators configure the live progress tail update cadence (500ms to 60000ms) directly into profile config.

## 0.3.2: Interactive Settings TUI Fix

- `Settings TUI Input`: The `/telegram-settings` interactive root component now implements `handleInput`, delegating arrow navigation, Enter/Space value cycling, filtering, and Escape dismissal directly to `SettingsList`. Previously `new Container()` ignored terminal input, causing the interactive settings view to hang upon opening.

## 0.3.1: Progress Tail Enhancements And Settings Command

- `Ask Roll-Over`: Answering an `ask` tool now freezes the previous progress tail bubble in-place and starts a fresh live progress bubble beneath the ask message on subsequent tool or reasoning activity, so the user never has to scroll up to see ongoing progress.
- `Paragraph Reasoning`: Reasoning tail now normalizes think tags and extracts the newest 1 to 3 complete paragraphs into an expandable collapsible blockquote, preserving coherent thought units during live streaming.
- `Detailed Tool History`: Displays the 4 latest tools with generous argument limits and collapsible `<blockquote expandable>` tool results, avoiding aggressive argument truncation while keeping the live tail clean.
- `Settings Command`: Adds `/telegram-settings` with an interactive TUI menu, direct CLI argument updates (`/telegram-settings <key> <value>`), and tab autocompletions to adjust runtime options (mode, activity, drafts, rendering, voice, time, cleanup) without manual config edits.

## 0.3.0: Live Progress Tail Overhaul

- `Progress Tail`: Overhauls the multi-bubble activity projection into a single live progress bubble that updates in-place during agent work. Lazy initiation keeps simple direct text replies clean with zero progress bubbles, while turns with tools or reasoning project a single live status card updated at a rate-safe 2.0 s cadence.
- `Turn Finalization`: Completed turns freeze the progress bubble into a compact audit summary (`✅ Completed in Xs · N tools · Model`) and deliver the final answer as a separate clean chat message. Aborted turns freeze with `⏹ Cancelled` and failures freeze with `⚠️ Failed`.
- `Commentary Roll-Over`: When the assistant sends intermediate commentary, the active progress bubble freezes in-place and a fresh live bubble begins beneath the commentary on subsequent activity, keeping the chat timeline chronological.
- `Ask Tool Status`: The live progress tail shows `⏳ ask: Waiting for user decision...` while an ask tool is awaiting user input, and updates to `✓ ask: Answered via Telegram` or `✓ ask: Answered via CLI` upon completion.

## 0.2.0: Thread Names And Rename

- `Thread Names`: The default thread display mode is now `names`, so a Telegram tab reads `Atlas` rather than `A`. A profile that explicitly stored `letters` still resolves to `letters`, so an existing choice is never silently migrated. The per-slot palette widened from 130 names to 312, twelve per letter, which makes a collision across many live sessions far less likely.
- `Rename Command`: `/telegram-rename <name>` renames the current thread, `/telegram-rename` asks the host title model for a name of at most two words, and `/telegram-rename --reset` restores the automatic palette name. Both name paths clear the same validator the Telegram-side menu rename already used, and the command registers only where its ports are wired, so an instance without them is unchanged.
- `Generated Names`: The model is reached through the host's own title generator, which resolves the `tiny`, `commit` and `smol` roles before the session model, so no new configuration appears. The answer is clamped to two words locally rather than trusted to obey the prompt. When generation yields nothing usable the command says so and leaves the name untouched; substituting a palette word would discard a name the operator chose because an unrelated call failed.

## 0.1.3: Multi-Instance Ask Routing

- `Ask Routing`: An ask callback that this process has no pending question for is now left for the bridge's own routing instead of being consumed. Public update handlers run before that routing, so on the bus leader the ask bridge answered every `tgask:` callback itself — including the ones belonging to a follower that was waiting on them. With more than one OMP session live, the question reached Telegram, the buttons rendered, and the first tap answered "This question is no longer active" while the asking session kept waiting. The leader now forwards such a callback to the instance that owns the message, which is the layer that holds the ownership map.

## 0.1.2: Dismissable Local Dialog

- `Ask Race`: The local arm now drives the host's own rich dialog through `ctx.ui.askDialog` instead of delegating to the native ask tool. The native tool answers a dismissed dialog with `context.abort()`, which ends the whole turn by contract; inside a race that meant closing the terminal dialog also destroyed the live Telegram question, whose buttons then answered "This question is no longer active". Dismissing a surface now only loses the race, and the other surface stays answerable. Cancelling everything is still the turn abort. Delegation remains the fallback where no rich dialog exists.

## 0.1.1: Surface Degradation Notice

- `Ask Surface`: An interactive session that cannot reach the native ask now records a `surface-degraded` runtime event instead of quietly answering through Telegram alone. The `ctx.invokeTool` guard stays, because a headless run genuinely has no dialog to race, but `ctx.hasUI` separates that from a caller whose wrapper dropped the delegation seam. Observed through omp-fabric, whose capture wrapper built the tool context without naming the tool; fixed upstream in omp-fabric 1.18.3.

## 0.1.0: OMP Fork

- `Host`: The bridge targets OMP (oh-my-pi) directly instead of the Pi SDK, against a `>=17.4.2` peer floor and verified on 18.1.19. `lib/pi.ts` remains the only file importing the host, its host imports are type-only, and `settings` resolves through a dynamic import so loading the boundary never pulls the SDK into the module graph.
- `Ask Tool`: A tool named `ask` replaces OMP's builtin. When a Telegram destination and the TUI are both live the question is raised on both surfaces at once and raced; the first answer wins, the loser is torn down, and the result names the winning surface. It blocks with no timeout, bounded only by the turn's abort signal.
- `Ask Answers`: Single-select, multi-select with a running `Done selecting (n)` counter, and free text through `Other (type your own)`. Option labels never enter `callback_data`, which stays at most 20 bytes against Telegram's 64-byte ceiling, so a long label cannot truncate a selection.
- `Ask Fallback`: With no Telegram destination the tool delegates to the native TUI ask through `ctx.invokeTool`; with neither surface available it returns a stated error instead of blocking forever.
- `Events`: Host events OMP does not emit are remapped rather than dropped. `agent_settled` folds into `agent_end` filtered on `willContinue`, `ui_prompt_start`/`ui_prompt_end` map to `tool_approval_requested`/`tool_approval_resolved`, and `session_compact_failed` maps to `auto_compaction_end`, which keeps a failed auto-compaction from leaving the bridge busy until its 300 s fallback.
- `Thinking`: The level list gains `inherit` to match OMP's own selector, and the host's unset selector normalizes to it. The thinking menu chunks its rows from the level list, so a level can no longer be silently unreachable.
- `State Isolation`: The default agent directory is `~/.omp/agent`, `~/.pi/agent` is reserved for a legacy `pi` runtime, and global `Symbol.for` registry keys carry the `omp-telegram` identity so this fork cannot collide with pi-telegram runtime state.
- `Prompt Guidance`: OMP's `ToolDefinition` has no prompt-snippet slot, so Telegram tool guidance is injected into the system prompt suffix instead and is still stripped when Telegram is unavailable.

---

# Upstream pi-telegram history

The entries below belong to [`llblab/pi-telegram`](https://github.com/llblab/pi-telegram), from which this fork was taken at v0.45.8.

## 0.45.8: Follower Forwarding Hotfix

- `Follower Forwarding`: Message-ownership lookups now project the matching live registration's protocol identity before forwarding. Voice/message and edit retries, message-only callbacks, and reactions no longer stall on an incomplete cached owner after a rejection or re-registration. Exact generation, binding, protocol, and durable-receipt checks remain enforced.

## 0.45.7: Queue Enqueue Race Hotfix

- `Queue Enqueue`: Asynchronous voice/file preparation no longer restores consumed prompts or overwrites newer queue changes, preventing a settled phantom head from blocking accepted work. Final assembly uses current queue state and allocates order at commit; abort-history folding retains only surviving intended prompts and receipts while preserving a handed-off head until `agent_start`.

## 0.45.6: Guest Placeholder And Delivery Hotfix

- `Guest Placeholder`: The guest ACK answers with the first bold globe frame (`🌎 Working on it.`) and rotates `🌍`/`🌏` once per second with the dots growing every two seconds. Rotation now completes whole 6-frame cycles and stops only after the 20 s minimum, so a pending answer holds the cycle's final frame (`🌏 Working on it...`) instead of cutting mid-step; a 26 s safety bound stays clear of the ~28 s Telegram flood-control wall, and error backoff and pre-replacement cancellation are unchanged.
- `Guest Answer Delivery`: The guest replacement now falls back to the run's latest completed assistant text when Pi's final assistant message is empty, so an answer preserved by a companion extension's fallback turn (for example State Flow's suppressed final:true patch turn) is still edited into the guest message instead of being skipped as "no editable text".
- `Rate-Limit Visibility`: A `429` retry wait now records an `api` runtime event with the method, wait duration, attempt, and server `retry_after`, so a silent flood-control pause before the final guest replacement is visible in the runtime log instead of appearing only as a frozen frame.
- `Thread Display Hint`: The Thread display settings card no longer carries the manual `/name Name` override hint; the current-value line, the three mode descriptions, and the live chooser are unchanged.
- `Queue Empty Headings`: The default empty-queue line and every rotating refresh title drop the trailing period, so the fully bold queue headings read as headings; wording, emoji, rotation order, callbacks, and refresh behavior are unchanged.

## 0.45.5: Queue Refresh Icon Hotfix

- `Queue Refresh Icon`: The queue menu's Refresh row now uses `🔄`, the canonical refresh glyph, reserving `🌀` for the State Flow Telegram identity. The button label is the only change; queue refresh behavior, callbacks, and the rotating empty-queue notices are unchanged.

## 0.45.4: Draft Cadence Hotfix

- `Draft Cadence`: Each preview segment now holds its first frame for one full two-second interval from its first visible text, so the opening draft is an accumulated passage instead of a single streamed word. Later frames keep the trailing cadence, message/turn rollover preserves the remaining interval and reopens the window, and sealing or final publication still cancels the pending timer; first frames no longer ship immediately.

## 0.45.3: Thread Display Names Hotfix

- `Thread Display Names`: Settings again offers the dictionary naming mode as the second chooser between Letters and Directories. Names shows each Workspace's generated slot-letter palette word, such as `Anchor` for slot `A`; switching renames live tabs and fresh tabs start under the active projection. `profiles.<name>.threadDisplayMode` persists all three values, absent or invalid ones resolve to Letters, and Names works with legacy followers that predate `thread-display-mode-v1`.

## 0.45.2: Provider-Compatible Bind Schema Hotfix

- `Provider-Compatible Bind Argument`: Serializes the `telegram_bind` `argument` schema as an inline builder-made JSON-value union bounded to four container levels, with no `$ref`/`$defs` recursion or raw TypeBox marker leakage; OpenAI no longer rejects every request with "Recursive JSON schemas are not currently supported" (#273) and Gemini no longer rejects the unknown `~optional` field (#269) while the tool is registered.

## 0.45.1: Guest Mode And Channel Media Hotfixes

- `Environment-backed bot tokens`: `telegram.json` profiles may store an exact `$NAME`/`${NAME}` reference instead of a copied token. Resolution happens only at validation/activation boundaries, including pairing identity hashing; setup prefills the first supported alias, validates the resolved value, and persists the alias; literals stay compatible; unresolved references fail closed with a redacted named-variable diagnostic in setup, connect, and status.
- `Guest Mode`: Records a failed guest answer as a delivery runtime event instead of rejecting the agent-end hook, so an expired guest query no longer surfaces as a Pi extension error or skips the next queued turn; the Pi-failure notice answer is contained identically. Every guest query now receives a bold `⚙️` ACK and later replaces it through `editMessageText` with the returned `inline_message_id`; an owner-run live acceptance confirmed this update path.
- `Guest Speed`: Guest turns never emit streaming draft previews, because one guest query allows exactly one answer and cannot be patched afterward. Their prompt ends with the compact transport hint `[guest] delivery: answer quickly with one concise, self-contained reply`, aligned with the existing `[voice] delivery: …` context style.
- `Channel Media`: `telegram_message` channel delivery uploads one .jpg/.jpeg/.png/.webp photo or .mp4 video with `text` as its HTML caption, validating kind, size (photo ≤ 10 MiB, video ≤ 50 MiB), and 1024 visible caption characters; unsupported types and albums are rejected. The channel-post journal binds kind/file name/size/SHA-256 plus caption, so duplicates and lost acknowledgements never re-upload, and media edits replace captions via `editMessageCaption`. Markdown spoilers render as `<tg-spoiler>`; live image publication passed.

## 0.45.0: Durable Workspace Threads

- `Workspace Admission`: Preserves saved names over follower hints during dormant recovery and target replacement. Explicit same-directory connection skips live peer bindings and allocates the next identity without copying their targets; startup restore remains allocation-free. Regressions cover competing names and concurrent claims. No-op snapshots ignore object-key ordering and skip filesystem writes while retaining fresh disk comparison and exact-owner commits.
- `Durable Authority`: V3 custody owns acquire/start/settle, recovery, handoff, and grouped queues. Durable source IDs replace raw tokens. Workers consume settled custody; unknown/legacy-retry state quarantines. Gated v3 binds identities, rejects legacy mutation, and accepts retry-safe queued handoff; cancellation clears blocking. Tail drains behind blocked custody. Mutually capable bus peers wake one accepted source claim without copying execution. Production stays disconnected.
- `Workspace Recovery`: Dormant targets require visibility proof; cold recovery follows opening order. Cleanup retains names/slots, and followers restore exact-directory Threads without fresh allocation. Letters is the automatic default; `/name` applies a target-fenced manual display name and reset preserves recovery identity. A published unbound-command chooser completes its source, so untouched `/start` commands do not replay after restart; failed publication retains retry authority.
- `Pairing Publication`: Grants publish before authorization and preserve competing owners and later unpair/revocation. Reactions require the configured human owner; grouping follows admission. Opt-in v2 retains exclusion through replay/retry/compaction, and workers veto excluded effects. Paired-only follower v1 admission and opt-in serialization of journal-store operations are locally tested. Production stays v1/automatic first contact; migration, factory activation and confirmation UI remain gated.
- `Mobile Explanations`: Bundles the portable Show Me Skill with phone-width Markdown or HTML and distinguishes local, validated, released, and live state without inferring client behavior from source shape. `telegram_bind` now emits an explicit recursive JSON-value schema instead of an unconstrained subschema, preserving nested arguments while avoiding boolean-schema lowering that llama-server rejects. Root `index.ts` is now a thin re-export; composition lives in `lib/extension.ts`.
- `Thread UX`: Cleanup requires exact profile/binding identity, clear protection, and no competing work. One ledger separates destructive kinds; a strict work-set records permits and unknowns. **Review inactive tabs** persists candidates but deletes nothing. Retained exact identity closes absent-binding commits without re-delete; live-owner takeover fails closed. Cross-process races and binding/work-set commit faults call transport once. Settings reports redacted recovery state; production omits Clean.
- `Output UX`: Attachments precede text; Rich media comes first. Activity pairs `thinking`/`tools`. Channel sends journal verified username/numeric identity and title; listing/edit/delete tools use exact own records. Lost ACK/outcome retries across direct reconnect never resend; cross-process races grant once. Strict reads reject links, loose files, races, oversized or unknown schemas; downgrade preserves the inert file. Failures redact content, token, path, and transport detail.
- `Follower Availability`: Keeps delayed followers routable for 15 seconds, reports unregistered peers as reconnecting, and preserves the Thread while asking operators to retry. Local IPC consumes buffered acknowledgements before timeout, avoiding false peer-reset recovery while silent peers remain bounded. Thread-capability timers invalidate replaced generations before context access and catch synchronous stale-context ownership failures, preventing uncaught process exits.

## 0.44.0: Reliable Draft Previews

- `Draft Experience`: Enables previews when no current or legacy preference is configured, preserving explicit opt-outs without migration and identifying on as the default in Settings. A two-second leading/trailing throttle sends the first eligible frame immediately and then only the latest accumulated text, producing an operator-accepted rhythm on short and long answers while reducing Telegram rate-limit pressure.
- `Preview Completion`: Seals draft updates when an assistant message ends, cancels pending throttle timers, and waits only for an already-issued request. Retryable failures defer fresh frames without replaying stale bodies or delaying the final; queued, late, failed, cancelled, and replacement drafts cannot append an obsolete tail.
- `Publication Ownership`: Gives intermediate and final text one permanent publication owner, eliminating rollover duplication. Background finals capture their originating preview before admission, so delayed work cannot seal, overwrite, await, or deadlock a replacement turn. Rollover barriers remain outside Pi lifecycle hooks and release on failure or cancellation.
- `Prompt Anchors`: Preserves once-per-turn quoting across delayed text, voice, ordinary uploads, Rich media, and operational delivery. The first successfully delivered permanent response carries the originating prompt anchor; known rejection preserves it for fallback, unknown ACK avoids unsafe replay, and later responses omit the repeated quote.

## 0.43.2: Command Lifetime And Publication Order

- `All-Tab Command Expiry`: Uses the original Telegram timestamp to expire unselected Threaded Mode command choosers after 60 minutes, settle their deferred source, and reject stale buttons; replay of an expired command creates no new chooser. Active dispatch pauses expiry; failed attempts retain the original deadline, and accepted queue receipts remain protected. Excludes `/thread`, bound threads, classic mode, and invalid timestamps; storage failures retain journal authority.
- `Selected All-Tab Commands`: Settles still-deferred sources after successful local command dispatch or confirmed follower acceptance, preventing replay after chooser cleanup. Failed follower transfers retain their sources. Background menu rendering remains non-blocking, and commands admitted to the Pi queue retain receipt-governed settlement.
- `Repeated All-Tab Starts`: A newly delivered chooser for an identical unselected `/start` supersedes older sources from the same user/chat and active admission worker. Different arguments, other commands, and previously selected intents remain separate; superseded callbacks become inert. Failed chooser sends discard their in-memory attempt without settling the journal source, so retries do not exhaust chooser capacity.
- `Causal Publication Order`: Serializes bridge-owned assistant blocks, activity disclosures, active-turn finals/artifacts, and automatic compaction notices through their existing activity domain before transport routing. Compaction notices cannot overtake delayed local finals; Pi hooks do not wait for their network delivery. Captures notice/activity target and authority at admission and fences queued publications across session replacement; independent handler queues remain separate.
- `Artifact Delivery Authority`: Rechecks active-turn/session authority after voice/file preparation and recording actions. Cancellation suppresses later uploads, provider/text fallbacks, and stale Rich-message ownership writes without discarding the attachment list. Already-issued requests and in-flight synthesis are not undone; ambiguous uploads never authorize replay.
- `Final Admission`: Reserves final/error publication at the terminal message boundary and transfers it only to the originating turn before asynchronous config loading. Compaction uses the same queue instead of a separate buffer. Empty outcomes reserve no slot; replacement, preparation failure, settlement, and session reset release unused reservations. Terminal preview cleanup is background and bound to the captured draft.
- `Compaction Observation`: Fences superseded timeout callbacks and stale-context terminal hooks so they cannot clear a newer observation. The five-minute fallback remains an observer timeout, not proof of Pi completion or cancellation.
- `Activity Replacement`: Fences late config refresh, thinking acknowledgements, tool edits, failures, and settlement cleanup before state mutation or HTML fallback. Old work can no longer overwrite a replacement target/message, erase new tool arguments, or block new thinking output; loss of transport authority also suppresses fallback without requiring a session reset.

## 0.43.1: Transport And Preview Continuity

- `Conflict Stand-Down`: Stops transport after ten consecutive competing getUpdates conflicts, including ownership checks, heartbeat, monitoring, and bus teardown. Releases only the exact local lock and revokes direct authority even if release fails, while preserving accepted local queue work. A persistent terminal status and one diagnostic distinguish lost ownership from a competing external client; cancelled reconnects and stale admission cannot supersede current lifecycle work.
- `Prompt And Preview Continuity`: Treats absent/null host system prompts as empty while retaining Telegram guidance, clears completed text from preview state after successful delivery, and rejects stale session/transport completions before they can clear a replacement preview. Receipt-conflict diagnostics now include the receipt and source update ids; durable handoff verification remains fail-closed.

## 0.43.0: Native Button Blocks

- `In-Body Controls`: Renders standalone `telegram_button` fences as native button rows between paragraphs using the same singleton/mixed JSON/CML grammar and callback ownership as footer comments. Invalid/incomplete blocks register nothing, previews hide action payloads, literal examples remain inert, and HTML mode moves controls to the footer. In-body clicks acknowledge without recoloring; operator-confirmed current-client smoke passed; cross-client/follower checks remain pending.
- `Bot API Reference`: Corrects the local `sendRichMessageDraft` table against Bot API 10.3 with generation-stop parameters and draft replacement semantics, updates affected Skill indexes, and checks parity of stop-control documentation across both draft methods. Runtime generation controls are unchanged.
- `Disabled Controls`: Adds boolean JSON disabled state and the fourth CML button atom (`1`/`true` disables, `0`/`false` enables), including label-only `{Next|||1}` and blank `{|||1}` cells with no prompt or selected style. Disabled buttons stay visible without callback registration, prompt admission, or app invocation; shared keyboard types, Generative Apps, and agent Skills follow the same contract.

## 0.42.4: Thread Recovery Hotfix

- `Thread Restore`: Retains validated source and chooser identity when callback messages omit thread metadata, hides Restore in threadless/All choosers and explains how to supply a destination, rejects conflicting Restore instead of forwarding to the old target, and treats confirmed already-deleted chooser cleanup as complete without redispatch.
- `Target Safety`: Rechecks cleanup ownership before close/delete and local retirement across restore, disconnect, and provisioning paths; a rebound target is not deleted, invalidated, or reserved by obsolete cleanup. Follower restore rechecks registration generation and expected target after IPC, store-load, and persistence waits.
- `Stale Delivery`: Direct replies, menus, activity, edits, and multipart sends capture exact stale-target authority; guarded invalidation rechecks generation, profile, binding, and snapshot revision at the synchronous durable commit without replaying failed sends or redirecting accepted work.
- `State Continuity`: Snapshot reads cannot overwrite bindings or cleanup intents admitted while disk I/O was pending; equivalent persisted records retain cleanup authority regardless of property order or omitted optional fields.

## 0.42.3: Agent Diagnostics Hotfix

- `Agent Diagnostics`: Identifies `/telegram-status` as a Pi TUI command and routes agents without command access directly to the redacted diagnostic files instead of attempting a shell executable; runtime behavior and STT fallback remain unchanged.
- `Local Architecture Guidance`: Consolidates the repository-local Domain DAG Skill around canonical protocols and removes redundant self-validation configuration and a legacy recipe wrapper; the validator remains available, and this development-only Skill is not included in the npm package.

## 0.42.2: Telegram Comment Membrane

- `Transport-Private HTML Comments`: Removes every assistant-authored `<!-- … -->` block from Telegram previews, active-turn finals, connected companion projections, direct sends, and Guest Mode regardless of Markdown position or owning extension; only recognized top-level comments activate actions, unclosed tails stay hidden, comment-only text plans send nothing, and the Pi terminal transcript remains unchanged.

## 0.42.1: Prompt-Only Button Cells

- `Prompt-Only CML Buttons`: Accepts `{|prompt}` and `{|prompt|selected_style}` as canonical button cells equivalent to prompt-only JSON, so established prompt fallback supplies both visible text and queued input without a separately authored label; empty one-atom cells, prompts, styles, and voice atoms still fail closed.

## 0.42.0: Compact Action Grammar

- `Adaptive Action Grammar`: Extracts the first semantically valid JSON or positional CML payload from noisy `telegram_button` and `telegram_voice` envelopes, tolerates bounded trailing commas and unmatched matrix noise, keeps malformed named JSON on the JSON path, and retains legacy attribute parsing as undocumented compatibility.
- `Voice Action Cells`: Adds compact `{text}`, `{text|lang}`, and `{text|lang|rate}` voice actions while preserving JSON for multiline, named, and escape-heavy payloads; each voice comment remains one independent artifact and matrix-shaped voice payloads fail closed.
- `Thread-Aware Buttons`: Tags prompts created by generated-button callbacks with the same resolved Telegram Thread label as ordinary inbound turns, preserving current local labels, persisted bindings
[…585ln elided…]
trypoint`: Reframed README around the companion runtime, operating model, feature catalogue, safety boundary, extension platform, and docs.
- `Guest Mode`: Unauthorized guest queries now include the standard denied-action marker.

## 0.18.6: Threaded Mode parity hotfix

- `Follower Ownership`: Target evidence routes edits, reactions, callbacks, queue controls, and menu cleanup to the correct follower even when thread identity is absent.
- `Follower Parity`: Followers can register commands and publish bounded thread plus aggregate activity with accurate active/compacting precedence.
- `Promotion And Reload`: Snapshotted bindings and exact profile conversion preserve visible threads across election and replacement.
- `Restoration`: Reused follower targets require a visibility probe; only explicit stale evidence authorizes recreation.
- `Unbound Routing`: One current-roster chooser can replace or restore any live instance target.
- `Evidence`: Capability matrix, deterministic tests, and live Linux smoke established leader/follower parity.

## 0.18.5: Windows Threaded Mode stabilization hotfix

- `Bus Transport`: Added transport-owned endpoint, retry, timeout, reachability, event, and handler-ACK policy for Unix sockets and Windows pipes.
- `Windows IPC`: Deterministic follower endpoints and a longer prune window reduce false disconnects; debug status identifies pipes versus sockets.
- `Capability Switching`: Hot downgrade preserves the current leader as classic poller and disconnects followers only after confirmed capability loss.
- `Diagnostics`: Log reset preserves the prior session as `logs.previous.jsonl`.
- `Previews`: Native previews suppress syntax-only prefixes and removed dormant throttle/clear branches.
- `Validation`: Native Windows smoke covered classic ownership, hot upgrade, follower delivery, and hot downgrade.

## 0.18.4: Windows Threaded Mode hotfix

- `Windows IPC`: Follower registration retries transient local endpoint startup failures.
- `Queue`: A session-bound watchdog retries dispatch while Telegram work remains queued.

## 0.18.3: Threaded Mode live hotfix

- `Dispatch`: Inbound prompts request immediate and deferred dispatch so readiness gaps do not require reload.
- `Thread Lifecycle`: Reconciliation avoids cosmetic renames and refuses to auto-claim unknown threads while another live target exists.
- `Follower API`: Safe identity reads and chat-level activity are allowed while thread-scoped writes remain restricted.
- `Status And Menus`: Leader names persist in status; one-page model pagination and empty scope tabs stay hidden.

## 0.18.2: Setup pairing start hotfix

- `Setup`: Live config updates after token persistence and before polling, so first setup can receive `/start` without restarting Pi.

## 0.18.1: Windows setup transport hotfix

- `Setup Transport`: Token validation uses normal fallback-aware transport and reports retryable connectivity failures as setup notifications.
- `Terminology`: Docs consistently reserve Threaded Mode for the runtime mode, threads for the client surface, and BotFather for bot configuration.

## 0.18.0: Threaded Mode

- `Mode`: Added private-chat threads as the automatic multi-instance mode; one leader owns polling and Bot API transport, followers join explicitly, and Telegram never spawns Pi.
- `Capability And Recovery`: Evidence-driven hot switching and lifecycle recovery preserve bindings across reload, reconnect, election, disconnect, and stale cleanup.
- `Thread State`: Explicit owners, slots, names, reservations, reroute/restore, notices, and proof-before-delete reconciliation avoid duplicate or uncertain cleanup.
- `Target Runtime`: `{ chatId, threadId? }` now scopes routing, queues, models, replies, previews, media, controls, and follower API calls.
- `Delivery`: Native activity, first-block reply anchoring, asynchronous side effects, and proactive follower delivery preserve responsiveness and target identity.
- `Transport Security`: Redacted network fallback, leader secrets, private endpoints, owner checks, target allowlists, Unix sockets, and Windows pipes secure local IPC. Windows live smoke remained pending.
- `Diagnostics`: Status, state, and logs expose role, roster, capability, reconciliation, and health without becoming routing authority.

## 0.17.5: Screenshot Refresh

- `Docs`: Refreshed the package screenshot.

## 0.17.4: Native Rich Markdown Splitter Hotfix

- `Rich Markdown`: Oversized code, display-math, and wrapped inline blocks are rewrapped at transport splits so each chunk stays structurally valid.

## 0.17.3: Native Draft Preview Hotfix

- `Rich Markdown`: Multiline `$$` math normalizes to supported math fences while literal delimiters inside code remain untouched.
- `Preview`: Removed plain fallback bubbles and emits only structurally closed native Markdown prefixes; invalid intermediate frames wait for a safe boundary.
- `Validation`: Live smoke covered drafts and finals with lists, code, links, display math, and buttons.

## 0.17.2: Indented List Rich Markdown Hotfix

- `Rich Markdown`: Indented list markers are neutralized consistently across drafts, edits, and finals while top-level lists remain native.
- `Validation`: Regression fixtures preserve formatting and payload tails through splitting and send delivery.

## 0.17.1: Rich Markdown Parser Hotfix

- `Rich Markdown`: Normalized fragile blockquotes and dollar-prefixed atoms, preferred Rich reply plaintext, and kept copyability guidance generic.

## 0.17.0: Native Rich Markdown Delivery

- `Rich Markdown`: Assistant and Guest answers use Telegram Rich Message APIs for finals, drafts, edits, and guest content instead of legacy HTML conversion.
- `Preview UX`: Rich Draft lifecycle uses serialized flushes without default debounce, rendering dependency, or post-final clearing.
- `UI Boundary`: Bridge-owned UI remains HTML/plain, while companion sections may choose Markdown, HTML, or plain text.
- `Limits`: Typed Rich helpers disable entity detection and split at character/block limits, keeping replies on the first and keyboards on the last chunk.
- `Docs And Tests`: Documented and covered native delivery, guest replies, preview lifecycle, splitting, formulas, and UI compatibility.

## 0.16.6: Telegram Review Hardening Hotfix

- `Guest Pairing`: Guest updates are rejected until an owner pairs through DM.
- `Lifecycle`: Shutdown ordering, unrefed compaction fallback, retained poll abort state, and contained typing cleanup prevent leaked or reordered teardown.
- `Reply And Button Safety`: Reply dedupe is chat-scoped; button actions are one-shot and callback byte limits fail locally.
- `Diagnostics`: Callback acknowledgement failures are non-fatal and visible in runtime evidence.
- `Verification`: Focused boundary tests cover shutdown, Settings, Markdown, and outbound retry behavior.

## 0.16.5: Context-Aware Prompt Guidance Hotfix

- `Prompt Guidance`: Unconfigured sessions get no bridge suffix, local turns get direct-delivery guidance, and Telegram turns retain the full mobile contract.
- `Product Boundary`: The bridge is a companion for a live Pi session, not a terminal or process launcher; session replacement awaits a supported Pi API.

## 0.16.4: Follow-Up And Runtime Mode Hotfix

- `Runtime`: `print` and `json` modes remain passive when detectable; `tui`, `rpc`, and older Pi runtimes preserve polling behavior.
- `Queue`: Telegram prompts and unknown callbacks use explicit follow-up delivery semantics during busy Pi runs.

## 0.16.3: Ownership And Shutdown Hotfix

- `Ownership`: Only the current connect owner can proactively push non-Telegram finals; accepted Telegram turns still finish session-locally after ownership moves.
- `Shutdown`: Retry waits are abort-aware, non-critical timers are unrefed, and composed lifecycle cleanup clears direct-delivery context.
- `Status`: A configured token without username reports bot identity as `unknown`, not `not configured`.
- `Verification`: Process, lock, queue, ownership, abort, shutdown, and headless regressions protect the boundary.

## 0.16.2: Screenshot Refresh Hotfix

- `Docs`: Refreshed the package screenshot without runtime changes.

## 0.16.1: Disconnected Queue Status Hotfix

- `Status`: Local queue count remains visible after polling ownership moves to another Pi instance.

## 0.16.0: Telegram Extension Commands

- `Command API`: Added public `registerTelegramCommand()` with reserved built-ins, safe names, duplicate rejection, optional menu visibility, required emoji for visible commands, isolated handlers, and defined routing precedence.

## 0.15.1: Typing Keepalive Cadence

- `Typing Status`: Set native typing keepalive to 2.5 seconds with a 250 ms idle-drain cap.

## 0.15.0: Companion Status Lines

- `Status API`: Added synchronous, model-aware, failure-isolated `registerTelegramStatusLineProvider()` rows for companion extensions without transport ownership.
- `Docs`: Documented the provider through an abstract example and listed the concrete quota companion separately.

## 0.14.0: Direct Telegram Delivery, Queue Semantics, And Section Diagnostics

- `Prompt Guidance`: Agents use visible Markdown plus top-level button comments, avoiding standalone actions and comments inside code or nested structures.
- `Command Templates`: Synced the local portable template standard with risk labels, recipe context, short-flag detection, and trusted-executable guidance.
- `Tools`: `telegram_attach` and `telegram_message` support explicit local delivery with ownership checks; active-turn replies remain on normal final delivery.
- `Status`: Compaction reads as active; typing cleanup gives the last in-flight action a bounded drain before final delivery.
- `Queue`: Queue and replies remain per Pi instance when transport ownership moves; abort-history applies only to Telegram-owned runs.
- `Sections`: Section failures are source-scoped, recover independently, and keep Settings-level navigation.

## 0.13.2: Config Recovery And Inbound Output Bounds Hotfix

- `Config`: Invalid config is renamed to a recovery file on startup, safe defaults load, and diagnostics remain available for setup repair.
- `Inbound Bounds`: Handler, transcription, and built-in text outputs are bounded before entering prompts.
- `Diagnostics Bounds`: Event details and handler stdout/stderr are truncated with explicit evidence.

## 0.13.1: Rendering, Typing, And Continue Queue Hotfix

- `Rendering`: Markdown emphasis spanning soft line breaks now renders as Telegram HTML instead of raw markers.
- `Typing`: Preview and provider transport failures no longer break active-turn typing keepalive.
- `Continue Queue`: `/continue` enters the control lane, clears abort history, and runs before waiting prompt work.

## 0.13.0: Command Template Standard, Voice Hardening, And Domain Cleanup

- `Command Templates`: Breaking 0.x update adopted portable parallel, condition, duration, retry, fallback, flag, and failure semantics, replacing local `mode`, `critical`, and `pipe` shapes.
- `Voice Providers`: Monotonic generated ids, registry probing, and exact-instance disposers preserve provider lifecycle and re-registration.
- `Outbound Actions`: Voice markup, button planning, and delivery moved into acyclic owners while public behavior remained compatible.
- `Menus And Diagnostics`: Direct domain tests cover menu/setup contracts and status category summaries.
- `Architecture And Security`: Restored acyclic imports, centralized Pi SDK access, clarified Bot API naming, and enforced private temp and ownership modes.
- `Public Guidance`: Stable membranes now own extension examples and callback/navigation contracts; internal `/lib` imports were removed from guidance.
- `Verification`: Long-session queue, model-switch, markup, split-text, provider, menu, setup, and migration risks received focused coverage.

## 0.12.0: Public API Membranes, Telegram UX Safety, And Extension Interop

- `Breaking API`: Replaced published `./lib/*.ts` paths with stable sections, updates, inbound, outbound, voice, and keyboard membranes.
- `Interop`: Named the low-level update registry, defined stable versus id-less identities, rejected duplicate section ids, and enforced callback byte limits.
- `Architecture`: Separated updates from polling and Pi bindings from runtime domains; public API and ownership docs map the boundaries.
- `Compaction`: Manual compaction confirms first and uses native typing with settlement, timeout, and shutdown cleanup.
- `UI Standard`: Standardized toggle, tab, option, navigation, and confirmation language.
- `Config Defaults`: Hidden Time Injection removes its key, matching absent-key Voice defaults.

## 0.11.2: Queue Continuation, Compaction Safety, And Settings Polish

- `Settings`: Disabled time injection became absent-key `hidden`; legacy values remain readable and details show current state.
- `Continue Queue`: `/continue` adds one priority prompt without folding waiting prompts into hidden history.
- `Compaction Safety`: Dispatch pauses across native compaction hooks and resumes after settlement.
- `Command Templates`: Added typed/index placeholders, repeat fanout, failure/recover, unbounded default timeout, and trusted-command warnings.
- `Public Boundary`: Removed root API re-exports so `index.ts` remains default-only composition.
- `Documentation`: Split oversized architecture material and aligned operator labels and reactions.

## 0.11.1: Time Context And Settings Polish

- `Time Context`: Added optional `off`, `always`, or per-chat `interval` time context after attachments, outputs, and voice metadata.
- `Settings UI`: Proactive push, time, and voice controls gained aligned emoji labels and state text.

## 0.11.0: Voice Provider Platform

- `Provider APIs`: Added provider-owned STT/TTS registration and explicit precedence behind configured and programmatic handlers.
- `Voice Policy`: Added bridge-owned `manual`, `mirror`, and `always` reply policy with compact prompt context and explicit-action priority.
- `Settings Interop`: Built-in controls and a narrow live-config port let providers reflect policy without owning it.
- `Native Delivery`: OGG/Opus voice uses native delivery and falls back to markup-stripped text when safe.
- `Handler Matrix`: Programmatic inbound handlers joined configured commands and provider fallback in one precedence model.
- `Lifecycle`: Registries own independent globals and cleanup; session shutdown cannot erase unrelated extension registrations.
- `Docs And Tests`: Added native-format, policy, provider, fallback, prompt, and lifecycle contracts.

## 0.10.8: Compact Typing Timing Hotfix

- `Compaction`: `/compact` starts typing only after its start notice and stops on completion or failure.

## 0.10.7: Stale Context Hardening Hotfix

- `Session Reloads`: Context-sensitive paths ignore only recognized stale-context failures; unrelated errors remain visible.
- `Runtime Status`: Status failures propagate to existing safety wrappers for structured diagnostics.
- `Release`: Tag-triggered GitHub Actions verifies version parity and publishes the matching changelog section.

## 0.10.6: Native Typing Keepalive Hotfix

- `Typing`: Native typing refresh moved from 4 seconds to 2.5 seconds for better visibility during long work.
- `Queue Menu`: Empty queue refresh rotates through additional compact status phrases.

## 0.10.5: Queue Continuity And Input Resilience Hotfix

- `Compaction`: Completion and failure schedule deferred queue dispatch after Pi state settles.
- `Text Groups`: Long-text coalescing keeps a conservative start threshold but tolerates wider message-id drift across likely Telegram chunks.
- `Runtime Status`: Typing and dispatch status are best-effort with structured stale-context diagnostics.

## 0.10.4: Polling Status Resilience Hotfix

- `Polling`: Stale-context status updates cannot crash polling; failures record `phase: status-update` without changing API or config behavior.

## 0.10.3: Dependency Audit Hotfix

- `Dependencies`: Refreshed transitive development dependencies to clear current protobuf audit findings without runtime API changes.

## 0.10.2: Delete Message Port Hotfix

- `Section API`: Added `ctx.deleteMessage()` for callback-triggered cleanup, backed by Bot API deletion and error recording.
- `Docs And Demo`: Interactive confirmation examples now delete their dialog and open a follow-up result.

## 0.10.1: Navigation Abstraction Hotfix

- `ctx.open()`: New chat messages no longer receive an automatic Back row; `ctx.edit()` retains context-aware menu navigation.
- `Platform Docs`: Added interactive out-of-menu confirmation and approval patterns.

## 0.10.0: Extension Sections Platform

- `Sections API`: Added tokenized extension views and narrow callback contexts for answer, edit, open, prompt enqueue, callback creation, and diagnostics.
- `Menu Integration`: Extension rows and Settings compose before built-ins; stale tokens fail safely and unclaimed callbacks retain fallback behavior.
- `Navigation`: Context-correct Main menu and Back rows are deduplicated automatically.
- `Companion Demo`: Published a standalone example extension with Explorer, prompt enqueueing, and Settings state.
- `Operator UI`: Standardized model labels and removed redundant terminal `/telegram-settings` while retaining Telegram `/settings`.
- `Verification`: Registry, ordering, parsing, fallback, stale token, open/edit, and navigation contracts gained direct coverage.

## 0.9.9: Guest Mode HTML Rendering

- `Guest Rendering`: Guest replies use the normal Markdown-to-HTML renderer, matching DM formatting.
- `Reply Domain`: Guest Markdown delivery moved behind a replies-domain sender.
- `Guest API`: Answer titles are fixed and keyboards are omitted because inline callback routing lacks chat/message identity.

## 0.9.8: Guest Mode Context

- `Guest Context`: Prompt prefixes identify sender and source group, replies preserve author attribution, and media uses the normal attachment/output turn builder.
- `Prompt Guidance`: Added compact explanation of Guest Mode source and reply metadata.

## 0.9.7: Bot API 10.0 Alignment

- `Runtime Baseline`: Migrated Pi peers to `@earendil-works/*` and declared Node `>=22.0.0`.
- `Guest Mode`: Added authorized `guest_message` routing and Bot API 10.0 `answerGuestQuery` delivery without joining the source chat.
- `Draft API`: Drafts accept empty text, entities, parse mode, and optional thread id.
- `Presence And Tests`: Guest sentinel targets suppress typing; focused coverage protects guest and draft boundaries.

## 0.9.6: Runtime Adapter Positioning

- `Package`: Repositioned the project as a Telegram runtime adapter for Pi.
- `Telegram API`: Added configurable API base and documented native environment-proxy support; SOCKS5 remains outside zero-dependency core.
- `Dependencies`: Refreshed transitive packages to restore a clean audit.
- `README And Context`: Rebuilt the install-to-operation entrypoint and made its runtime-adapter, `/start`, and env-config rhythm durable.

## 0.9.5: Telegram Delivery Resilience Hotfix

- `Preview And Final Delivery`: Telegram transport failures are recorded and contained so cleanup, attachments, and queue dispatch continue.
- `Diagnostics`: Preview and final errors carry compact phase metadata.
- `Sections Draft`: Reserved the future Sections namespace and documented the shared Telegram-shell direction without exposing an API.
- `Docs`: Normalized Markdown shape and tightened proactive-push copy.

## 0.9.4: Temp Dir And Command Template Hotfix

- `Temp Dir`: API temporary files honor `PI_CODING_AGENT_DIR` with the standard agent-dir fallback.
- `Command Templates`: Documented portable mode, delay, repeat, placeholder, padding, and limited arithmetic semantics.
- `Queue Menu`: Refresh remains in a stable position and empty states rotate through compact headings.

## 0.9.3: External Handlers Rename

- `External Handlers`: Renamed the domain and docs from `external-update-handlers` to `external-handlers`.
- `Breaking`: Removed old module paths and aliases; consumers must use the new path and `TelegramExternalHandler*` names.

## 0.9.2: External Update Interceptors

- `Update Interceptors`: Added a validated versioned global registry for same-process extensions to observe or consume updates before default routing without another poller.
- `Queue Menu`: Non-empty queue lists retain a Refresh row below items.
- `Security`: Refreshed the lockfile to clear a transitive audit advisory.

## 0.9.1: Model Detail Hotfix

- `Model Menu`: Detail activation preserves scoped thinking and reapplies it even when selecting the already active model.
- `Proactive Push`: Removed an unused reply-target store; proactive local results send without reply anchoring.
- `Queue Reactions`: Added fire priority and wastebasket removal gestures.

## 0.9.0: Hidden Settings And Proactive Push

- `Settings`: Added hidden Telegram Settings and terminal controls for proactive push.
- `Proactive Push`: Optional successful local finals reach the paired chat only under current ownership; local prompt text is never mirrored.
- `Queue UI`: Refined empty/non-empty icons, item position, priority tabs, reaction markers, and active status after queue mutation.
- `Model Menu`: Model details provide activation and scoped/all membership controls.
- `Status And Guidance`: Compaction appears in the menu and prompt guidance targets narrow mobile layouts.

## 0.8.2: Lock-Safe Delivery

- `Lock Safety`: Active turns recheck singleton ownership before preview and final delivery, silencing displaced owners.
- `Inbound Handlers`: First composition steps receive the full configured timeout before elapsed accounting.
- `Menu UI`: Model and Thinking headings gained matching icons.

## 0.8.1: Outbound Voice Translation Hotfix

- `Outbound Voice`: The first voice pipeline step receives original hidden text on stdin, enabling translation before TTS.
- `Queue Menu`: Raw bounded prompt previews, clearer waiting icons, explicit deletion confirmation, and preserved priority emoji improve queue control.
- `Configuration Docs`: Advanced config remains agent-assisted rather than gaining premature UI.
- `Handler Docs`: Voice pipelines and the portable command-template standard now describe retry, critical failure, and default timeouts accurately.
- `Lock Docs`: Synchronized the extension-neutral lock standard.

## 0.8.0: Handler Bus

- `Inbound Bus`: Added provider-neutral text/media transformations with selector matching, stdin/placeholders, ordered fallback, and output replacement.
- `Text Attachments`: Built-in fail-open UTF-8 reading makes ordinary text files available without custom handlers.
- `Domain Names`: Renamed inbound and outbound attachment modules to match their unified responsibilities.
- `Compatibility`: Deprecated `attachmentHandlers` remains appended after canonical `inboundHandlers`.
- `Outbound Text`: Added final text transformations, including preview finalization, without changing button callback prompts.
- `Docs`: Consolidated inbound handler documentation and added translation and composed voice examples.

## 0.7.2: Split Text Coalescing Hotfix

- `Text Coalescing`: Likely near-limit Telegram chunks from one sender are short-debounced into one prompt; commands, media, captions, bots, and normal follow-ups bypass it.
- `Callback Namespaces`: Current navigation emits `menu:` while legacy `status:` remains reserved but no longer generated.
- `Runtime Tests`: Removed timing races in media-group and reaction-priority coverage.

## 0.7.1: Layered Callback Interop

- `Callback Interop`: Unowned callback namespaces fall back to Pi as `[callback] <data>` after bridge handlers decline them, enabling layered extensions without another poller.
- `Prompt Templates`: Template aliases remain in `/start` but no longer clutter Telegram’s global command menu.

## 0.7.0: Unified App Menu & Command Template Hardening

- `Commands`: Reduced visible commands while keeping compatibility shortcuts; start, help, and status share one operator surface and continue enters priority control flow.
- `Queue Controls`: Added queue inspection, item actions, reactions, refresh, and direct entry with control-safe ordering.
- `Prompt Templates`: Discovered conflict-safe aliases and expanded template files plus arguments before queueing.
- `Menu Domains`: Split queue, model, thinking, and status views into owners with consistent navigation and paging.
- `Runtime Safety`: Atomic config, first-block reply anchoring, typing diagnostics, and typed preview markup harden delivery.
- `Command Templates`: Standardized 30-second timeout and fail-open composition with optional critical abort.
- `Verification`: Focused coverage protects menus, queue mutation, continuation, templates, replies, composition, and preview markup.

## 0.6.3: Outbound Action Syntax & Prompt Guidance

- `Action Syntax`: Added label-only buttons and explicit one-line voice/button attributes; hidden bodies remain attached inside parser recovery windows.
- `Prompt Guidance`: Reorganized Telegram guidance around inbound context, visible output, and native actions with less duplication.
- `Architecture`: Named major runtime collaborators before entrypoint registration.
- `Config`: Missing config now uses an explicit existence check instead of read exceptions as normal flow.

## 0.6.2: Reload-Stale Queue Dispatch Hotfix

- `Queue Dispatch`: Deferred dispatch is session-bound and cancelled on shutdown.
- `Timer Safety`: Typing, lock watchers, and media-group timers no longer retain stale live contexts; diagnostics and controller state own late work.

## 0.6.1: Outbound Action & Command Timeout Hardening

- `Command Runtime`: Timed-out child commands escalate from `SIGTERM` to `SIGKILL`.
- `Outbound Buttons`: Button bodies are optional when prompt and label are equal.
- `Comment Parsing`: Native actions after valid closing code fences are recognized without executing code examples.
- `Template Docs`: Documented the strict `timeout` and string-array `args` contract; legacy shapes are not presented as supported.

## 0.6.0: Command Templates & Assistant-Authored Outbound Actions

- `Outbound Actions`: Hidden voice and button comments create native audio or queued prompts while visible Markdown remains the answer.
- `Outbound Semantics`: One owner plans voice, buttons, artifacts, callback prompts, reply metadata, and post-result delivery.
- `Command Templates`: Added a shell-free portable contract for strings/sequences, declarations, defaults, timeout, piping, and artifact output.
- `Domain Boundaries`: Split inbound preprocessing, outbound actions, and reusable template mechanics into mirrored owners.
- `Docs`: Replaced host-local commands with portable placeholders and consolidated template guidance.

## 0.5.2: Telegram Reply Context

- `Reply Context`: Normal prompts include bounded replied text or caption, while slash-command parsing still uses only the new message.
- `Docs And Tests`: Documented and covered truncation, queued edits, command safety, and reply forwarding.

## 0.5.1: Stop Queue Reset Hotfix

- `Queue Safety`: `/stop` clears waiting prompt/control work, model-switch and abort-history state, then aborts the active run when possible.
- `Docs And Tests`: Updated the high-risk stop and queue contract.

## 0.5.0: Command Templates, Domain Boundaries & Queue UX

- `Queue UX`: Immediate controls, settled-idle retry, specific busy labels, and local reaction priority keep text and attachment turns ordered.
- `Attachment Handlers`: Portable templates, defaults, and fallback chains support configured preprocessing without private tool registries.
- `Domain Boundaries`: Registration responsibilities moved to attachment, command, lifecycle, and prompt owners.
- `telegram_attach`: Outbound staging, limits, failure events, and tool results moved into the attachment owner.
- `Docs And Validation`: User docs, architecture, focused coverage, and repository contents aligned with the new domains.

## 0.4.0: Singleton Locks & Attachment Handlers

- `Locks`: Added shared singleton ownership with stale replacement, confirmed takeover, explicit disconnect, session suspension, and same-directory resume, separate from bot config.
- `Attachment Handlers`: Added MIME/type preprocessing with safe placeholders, compact attachment/output prompt sections, and fail-open empty results.
- `Routing`: Extracted cohesive inbound route composition from `index.ts` while preserving paired updates, controls, media, queueing, and edits.

## 0.3.0: Modular Runtime, Queue Controls, Diagnostics

- `Domain DAG`: Established one composition root over flat acyclic owners; session coordination remains in runtime instead of absorbing domain policy.
- `Queue Lifecycle`: Added typed lanes, active-turn state, readiness, abort and compaction guards, immediate controls, serialized control work, and reaction priority.
- `Controls`: Unified model, thinking, command, menu, callback, and in-flight model-switch policy; removed Telegram `/debug` in favor of local diagnostics.
- `Rendering`: Consolidated safe narrow-client HTML/Markdown rendering, splitting, tables, lists, quotes, code, previews, finals, and reply metadata.
- `Files And Setup`: Separated API retries/downloads, media grouping, attachment staging, config, pairing, authorization, and token setup.
- `Diagnostics`: Added grouped status plus a redacted runtime/API event ring across transport, dispatch, controls, typing, setup, and files.
- `Packaging`: Added package allowlists, lockfile, validation scripts, CI, broad regressions, and structural architecture guards.

## 0.2.x: Fork Genesis

- `Fork Identity`: Established the maintained package metadata and predictable saved-token, environment-token, then placeholder setup flow.
- `Domain Runtime`: Split the monolith into flat queue, replies, polling, updates, media, controls, API, setup, and status owners with mirrored tests.
- `Queue Lifecycle`: Added typed lanes, delayed admission, reactions, media groups, abort history, attachment-preserving edits, and compaction gates.
- `Polling And Updates`: Offsets follow successful handling, poisoned updates are bounded, and edits update queued turns instead of duplicating them.
- `Telegram Transport`: Added structured errors, retry/backoff, bounded streaming downloads, file-backed uploads, safe temp names, and cleanup.
- `Rendering And Controls`: Added safe narrow-client rendering, serialized previews, status/model/thinking menus, scoped models, and tool-safe switching.
- `Regression Foundation`: Established focused coverage for architecture, transport, rendering, queueing, media, previews, setup, controls, and lifecycle.
[[omp-fabric:truncated]] {"tool":"bash","partial":true,"reasons":["outputLimit"],"truncatedBy":"middle","totalLines":1108,"totalBytes":112704,"deliveredBytes":51222,"fullOutputPath":"/tmp/omp-fabric-bash-rKkBwB/bash-9839cf01-e93e-42ad-8509-89adae567045.log","continue":null,"note":"Output exceeded the host bash result budget; the complete stream is on disk at /tmp/omp-fabric-bash-rKkBwB/bash-9839cf01-e93e-42ad-8509-89adae567045.log."}
