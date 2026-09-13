# Callback Namespace Standard

Telegram `callback_data` is one bot-wide namespace. Any extension that creates inline buttons for a bot shared with `omp-telegram` must use namespaced callback data.

## Format

```text
<namespace>:<action>[:<payload>]
```

Examples:

```text
vividfish:approve:123
vividfish:deny:123
myext:page:2
```

## Rules

- Use a stable extension-owned namespace, preferably the package or extension name without scope punctuation.
- Keep the namespace lowercase ASCII: `a-z`, `0-9`, `_`, `-`.
- Do not use `omp-telegram` owned prefixes: `allmenu:`, `compact:`, `menu:`, `model:`, `queue:`, `reroute:`, `section:`, `settings:`, `status:`, `tgask:`, `tgbtn:`, `thinking:`. Current app navigation uses `menu:`; `status:` remains reserved for legacy/owned status callbacks but is not emitted by current UI. `compact:` is owned by the manual compaction confirmation dialog. `section:` is owned by the Extension Sections platform (0.10.0+), documented in [Extension Sections](./sections.md). `settings:` is owned for the built-in Settings submenu. `tgask:` is owned by the ask bridge, described below. The reroute family (`reroute:`, `rerouterestore:`, `reroutenew:`) is owned by unbound-thread recovery.
- Keep the full `callback_data` within Telegram's 64-byte limit.
- Put only opaque ids or small enum values in payloads; do not store secrets, full prompts, or large state.
- Treat callbacks as untrusted input. Validate namespace, action, and payload before executing side effects.

## Ask bridge: `tgask`

The `ask` tool this package registers in place of OMP's builtin renders each question as Telegram inline buttons. Its callbacks use a fixed-width grammar so an option index never pushes the payload near the transport limit:

```text
tgask:<requestId>:<o<index>|d|x>
```

- `requestId` is 10 hex characters taken from a `randomUUID()` with hyphens removed. It keys the in-memory pending-question registry only; nothing is persisted and the id is meaningless after the question settles.
- `o<index>` selects the zero-based option at that position. In single-select it answers immediately; in `multi` it toggles the option and re-renders the keyboard.
- `d` is **Done selecting**, emitted only for `multi` questions.
- `x` is **Other (type your own)**: it clears the keyboard and makes the ask registry consume the next non-command text message from that exact chat/thread as free-text input.

The stem `tgask:<10 chars>:` is 17 bytes, so realistic payloads land at 18–20 bytes, far inside Telegram's 64-byte limit; the shared `assertTelegramCallbackData` guard still enforces that limit. A callback whose `requestId` is unknown — a stale question, or one already answered in the CLI — is answered with *This question is no longer active.* and consumed, never forwarded to the agent.

## omp-telegram fallback

If `omp-telegram` receives callback data that is not owned by its built-in prefixes and no built-in handler consumes it, it forwards the click to OMP as:

```text
[callback] <callback_data>
```

Layered extensions may intercept that message and handle their own namespace. If no extension handles it, the assistant may see the fallback message and should tell the user the callback was not handled and the environment may be misconfigured.

## Extension sections

[Telegram Extension Sections](./sections.md) are a higher-level UI contract over this namespace rule. A section owns a canonical extension identity such as `@example/telegram-explorer`, but its Telegram `callback_data` should use the `omp-telegram` owned `section:` prefix plus a compact token, because Telegram limits callback payloads to 64 bytes.

Conceptual form:

```text
section:<token>:<action>[:<payload>]
```

The token maps back to the full section identity inside the section registry. Section authors should not hand-roll `section:` callbacks outside the section context helpers, and ordinary layered extensions should continue using their own namespace plus update handlers or the `[callback]` fallback.
