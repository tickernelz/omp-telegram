# Voice Integration

Voice messages flow through an **inbound transcription → outbound voice reply** pipeline. This document describes the bridge's role in that pipeline; provider-specific mechanics (TTS/STT backends, voice IDs, languages) are owned by configured handler scripts or voice provider extensions. This is a first-class extension surface: one companion extension can provide STT fallbacks for inbound voice/audio files and TTS fallbacks for outbound Telegram voice replies without owning a second bot polling loop.

## Overview

1. **Inbound:** A voice message arrives via Telegram. Inbound handlers transcribe it to text.
2. **Processing:** The transcription becomes the agent prompt. The bridge tags the turn if it originated from voice.
3. **Outbound:** When automatic voice delivery is selected or the agent emits an explicit `telegram_voice` action, the agent's text is converted to voice and sent back.

The bridge owns Telegram transport, queue integration, reply-mode policy, preview suppression, fallback text delivery, and Settings UI. Provider extensions own STT/TTS calls, speech rewriting, provider-specific menus, transcript preference, and OGG/Opus conversion.

### Choose an integration path

Use the smallest path that fits the operator's available capabilities:

1. **`telegram.json` command templates:** Compose trusted local executables through `inboundHandlers` and `outboundHandlers`. This works equally well for local models and API-backed scripts, supports ordered STT fallbacks, and requires no companion extension.
2. **Companion extension:** Register programmatic STT/TTS providers when installation, provider-owned settings, lifecycle integration, or zero-config reuse justifies code.
3. **Hybrid:** Keep explicit operator command templates first and let installed providers supply progressive fallbacks.

omp-telegram does not maintain a built-in or exhaustive speech-provider catalog. Configuration agents should discover applicable Skills or trusted local executables, verify required environment variables by presence without exposing values, preserve unrelated `telegram.json` state, ensure TTS ends as OGG/Opus, and test each stage before the live Telegram path. `hidden` remains the safe and useful default: it disables only automatic voice replies, while explicit `telegram_voice` actions continue to use the configured synthesis pipeline.

### Ready-made command-template examples

The public [`llblab/skills`](https://github.com/llblab/skills) repository provides three maintained Skills with standalone scripts that can be wired directly into `telegram.json`; no additional OMP extension or local inference engine is required:

- [`groq-stt`](https://github.com/llblab/skills/tree/main/groq-stt) — Groq Whisper speech-to-text through `scripts/transcribe.sh`. It outputs plain transcript text and requires `GROQ_API_KEY` in the OMP process environment.
- [`mistral-stt`](https://github.com/llblab/skills/tree/main/mistral-stt) — Mistral Voxtral speech-to-text through `scripts/transcribe.sh`. It outputs plain transcript text and requires `MISTRAL_API_KEY` in the OMP process environment.
- [`edge-tts`](https://github.com/llblab/skills/tree/main/edge-tts) — Microsoft Edge neural text-to-speech through `scripts/say.sh`. It requires internet access but no account or API key and can write MP3 output for the outbound pipeline.

The two hosted STT options avoid running a local transcription model and offer useful free-tier capacity after provider registration; provider limits and terms may change. Install or clone the Skill repository, verify the required API-key variable by presence without printing its value, and point the matching `inboundHandlers` template at the Skill's transcription script. For Edge TTS, point an `outboundHandlers` voice pipeline at `say.sh --file - --write-media {mp3}`, then convert `{mp3}` to `{ogg}` with ffmpeg as shown in [Outbound Voice Handlers](#outbound-voice-handlers), because Telegram native voice notes require OGG/Opus. Read each linked Skill's current `SKILL.md` for its exact CLI, defaults, dependencies, and optional language/model controls.

## Voice Detection

Voice messages arrive as `message.voice` in Telegram updates. The bridge's media processing detects these and sets `kind: "voice"` on the downloaded file. Regular audio files (`message.audio`) get `kind: "audio"`; `mirror` mode treats both voice notes and audio uploads as voice input for reply-policy tagging.

Inbound handlers match `kind: "voice"` or `mime: "audio/*"` to run a transcription command:

```json
{
  "inboundHandlers": [
    {
      "mime": "audio/*",
      "template": ["/path/to/stt", "--file={file}", "--mime={mime}"]
    }
  ]
}
```

The transcription output becomes the raw text of the prompt.

Voice provider extensions can also register STT backends with `registerTelegramVoiceTranscriptionProvider()` from `@tickernelz/omp-telegram/voice`. Inbound command-template handlers and programmatic inbound handlers remain the stronger generic paths and run first; if no matching handler produces output for a voice/audio file, registered transcription providers are tried as fallback in registration order. The first provider that returns non-empty text wins; providers that return `undefined` pass to the next provider, and provider failures are recorded before trying the next provider. This lets a full voice extension provide both TTS and STT without requiring `telegram.json` handler templates, while still preserving operator-configured inbound handlers as the stronger choice.

## Voice Reply Policy

The bridge decides **when** to reply with voice from `voice.replyMode` in `TelegramConfig` (stored in `telegram.json`). Missing and invalid values resolve to the `manual` default; the former `hidden` value remains a read-only compatibility alias for `manual`.

### Modes

- **`manual` (default):** no `voice.replyMode` is stored and no automatic voice context is added; explicit agent-authored `telegram_voice` actions still work.
- **`mirror`:** voice/audio input activates automatic voice delivery. Text input follows `manual` behavior.
- **`always`:** every Telegram turn activates automatic voice delivery.

**Warning:** In `always` mode, the bridge transparently intercepts ALL text replies and converts them to voice on success. Users will only receive voice messages when voice generation succeeds. If voice generation fails, the bridge falls back to sending the planned text reply.

When a message is received, the bridge resolves the active voice reply mode and tags the turn:

- `voiceReplyPreferred`: `true` when mode is `mirror` and the turn has a voice file
- `voiceReplyRequired`: `true` when mode is `always`

At `agent_end`, if the turn is voice-tagged and the agent response has no explicit `telegram_voice` markup, the bridge transparently intercepts the text reply and converts it to voice. If the agent uses multiple `telegram_voice` blocks, each becomes a separate voice message. The same reply-mode decision applies to both registered voice synthesis providers and configured outbound voice handlers.

### Preview Suppression

When a turn is voice-tagged, the bridge suppresses text preview streaming during LLM generation. This prevents draft text from appearing in Telegram before the voice message is delivered.

## Voice Provider Extension Surface

A voice extension may combine three public seams:

- `registerTelegramVoiceTranscriptionProvider()` for inbound STT fallback on voice/audio files
- `registerTelegramVoiceSynthesisProvider()` for outbound TTS/synthesis fallback to Telegram voice messages
- `registerTelegramSection()` for provider-specific Telegram UI such as voice, language, style, or provider on/off controls

The reply policy itself remains a built-in omp-telegram setting (`voice.replyMode`) rather than a provider-owned menu.

## Outbound Voice Synthesis Provider Registration

Voice synthesis provider extensions register themselves through `registerTelegramVoiceSynthesisProvider()`. The bridge only provides the registration seam and the actual delivery to Telegram. **The provider is fully responsible for**:

- Text optimisation / speech-style rewriting
- Adding speech tags (when desired)
- Running TTS + ffmpeg conversion to OGG/Opus

The bridge shows a `record_voice` action while delivering and sends the final audio with Telegram `sendVoice`.

Providers can implement `getVoicePromptContribution(view)` to inject voice-specific instructions into voice-tagged prompts (for example: "Reply only with the spoken text"). The bridge appends the first non-empty provider contribution when `mirror` or `always` mode tags the turn.

Import provider APIs from `@tickernelz/omp-telegram/voice`; see the TSDoc on `registerTelegramVoiceSynthesisProvider` and `TelegramVoiceSynthesisProviderResult` there for the exact interface.

The provider receives the raw agent text plus optional `{ lang?, rate? }`.

It must return one of:

- `string` — path to a ready `.ogg` or `.opus` file
- `undefined` — skip this text block

**Important:** Providers are fully responsible for producing a clean, TTS-optimised native voice file. The bridge may also run configured outbound voice command templates for users who prefer process-boundary handlers instead of provider extensions.

**File format:** Telegram `sendVoice` requires **OGG/Opus** to display the message as a native voice note (waveform, inline playback). MP3 and other formats are accepted by the API but render as regular audio attachments (music note icon, filename visible). **Providers and outbound voice handlers must return `.ogg` or `.opus` files.** Returning non-OGG files causes the bridge to throw and fall back to text delivery.

Registration returns a disposer function for cleanup. Stable provider registrations pass a durable `id` in options; omitted ids remain a compatibility path for older providers and receive generated session-local ids. Extensions should call disposers on shutdown or re-register safely on session start when their runtime is recreated.

## Outbound Voice Handlers

Users can also configure `outboundHandlers` with `type: "voice"` in `telegram.json`. This is the command-template path for TTS without a provider extension. Reply modes (`manual`, `mirror`, `always`) affect these handlers the same way they affect providers: explicit `telegram_voice` blocks and automatic mirror/always interception both produce a voice reply plan, then delivery tries configured outbound voice handlers first and registered synthesis providers as progressive fallbacks.

Voice handlers receive the text on stdin in composed pipelines and can use `{text}`, `{lang}`, `{rate}`, `{mp3}`, and `{ogg}` placeholders. Set `output` to `"ogg"` or another placeholder name when the template writes to a known path:

```json
{
  "voice": { "replyMode": "mirror" },
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "/path/to/tts --write-media {mp3}",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 {ogg}"
      ],
      "output": "ogg"
    }
  ]
}
```

Priority for outbound voice delivery is: configured `outboundHandlers` with `type: "voice"` in their `telegram.json` order, then programmatic `voice` outbound handlers, then registered voice synthesis providers. Provider extensions are the zero-config tail of the same pipeline: they handle voice when no explicit configured handler succeeds, but they do not override operator-configured handlers. If multiple providers are registered, only one handles a given voice reply: the first provider that returns a valid `.ogg`/`.opus` artifact wins. Providers that return `undefined` explicitly pass to the next provider; providers that throw or return invalid output are recorded and the next fallback is tried.

### Surfacing provider diagnostics

Voice provider extensions can record runtime events that appear in `/telegram-status` alongside omp-telegram's own events:

```typescript
import { recordTelegramRuntimeEvent } from "@tickernelz/omp-telegram/outbound";

recordTelegramRuntimeEvent("voice-provider", new Error("TTS failed"), {
  phase: "tts",
  text: text.slice(0, 50),
});
```

`recordTelegramRuntimeEvent` writes to the same event ring that omp-telegram uses. Events are visible via `/telegram-status` in Telegram. Calls are silently dropped if omp-telegram is not loaded.

## Voice Extension Section

Voice provider extensions can register a Voice Extension Section (settings UI) via `registerTelegramSection`. The section can expose provider-specific controls such as TTS voice, language, speech style, or STT/TTS enablement. Reply mode is a core omp-telegram setting and belongs in the built-in Settings menu.

**Note on resume:** Because the previous automatic persistent re-registration system has been removed, extensions are responsible for re-registering their Voice Extension Section on `session_start` if they want the menu to survive an `omp resume`. See `registerTelegramSection` from `@tickernelz/omp-telegram/sections`.

## Prompt Guidance

The bridge keeps voice prompt context compact, effective, and policy-owned. `manual` and text-originated `mirror` turns add no voice line. Voice/audio-originated `mirror` turns and every `always` turn add exactly `[voice] delivery: automatic voice`, describing the current delivery environment without exposing the underlying mode matrix or an instruction list. The marker is appended after `[outputs]` when handler output exists, otherwise after `[attachments]`. Voice inputs also appear in `[attachments]` with their downloaded file names, MIME data, and handler output, so agents can infer concrete voice-file context from attachment metadata.

Voice synthesis providers can supply prompt guidance through `getVoicePromptContribution(view)`, but provider text should stay optional and provider-specific. Reply-mode context belongs to omp-telegram.

## Fallback Behavior

### If voice generation fails

1. The bridge records the failure via `recordRuntimeEvent`
2. The voice sender throws an error, which the runtime catches
3. The runtime falls back to sending the planned text reply (outbound markup stripped, `replyMarkup` preserved)

### If no voice synthesis provider is registered

- The voice sender throws because no configured handler or synthesis provider can deliver the voice reply
- The runtime catches the error and falls back to text delivery

### If the provider returns a non-OGG file

- `ensureTelegramVoiceFileFormat` rejects the file (only `.ogg` and `.opus` are accepted)
- The voice sender throws and the runtime falls back to text delivery
- The provider should handle format conversion internally before returning the path

## Telegram Voice Limits

- **Duration:** Up to ~60 minutes per voice message
- **File size:** Up to 20 MB for voice uploads via `sendVoice`
- **Format:** OGG Opus is native; MP3 and other formats render as regular audio attachments
- **Splitting:** The bridge does not split long responses into multiple voice messages. Chunking is the provider's responsibility

## Configuration

### Bridge config (`telegram.json`)

```json
{
  "voice": {
    "replyMode": "mirror"
  }
}
```

Valid modes are `"hidden"`, `"mirror"`, and `"always"`; selecting `hidden` removes the key. Missing, invalid, and legacy `"manual"` values resolve to `hidden` and stay silent in prompt context.

The bridge reads `voice.replyMode` from the config when building a turn.

### Provider config

Provider-specific settings (voice ID, language, speech style, STT/TTS enablement) are owned by the voice provider extension. Reply mode is owned by omp-telegram's `voice.replyMode` and configured from the built-in omp-telegram Settings menu, not duplicated in provider UIs.
