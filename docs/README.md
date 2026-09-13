# Documentation Index

Living index of project documentation in `/docs`.

`@tickernelz/omp-telegram` is a hard fork of `@llblab/pi-telegram` `0.45.8` (itself a fork of `badlogic/pi-telegram`) re-targeted onto OMP. Release numbers quoted throughout these documents name upstream `pi-telegram` releases; this package versions independently from `0.1.0`.

`public-api.md` is the canonical entrypoint for stable extension surfaces. Focused documents exist only when a surface has enough runtime rules to need a dedicated standard.

## Documents

- [architecture.md](./architecture.md) — Overview of the Telegram bridge runtime, optional profile isolation, queueing model and Priority/Normal plus Keep/Skip reaction policy, native Rich Markdown delivery, UI/compat rendering, and interactive controls
- [public-api.md](./public-api.md) — Stable public API map: package entrypoints, commands, config, assistant markup, extension APIs, smoke examples, and compatibility boundaries
- [delivery.md](./delivery.md) — Target-aware companion delivery contract for operational views, logical message handles, target scopes, lifecycle fencing, and leader/follower transport
- [activity.md](./activity.md) — Normalized OMP lifecycle API for extension-owned reasoning, intermediate prose, tool activity, source identity, delivery contexts, and consumer policy examples
- [../.agents/skills/telegram-bot/SKILL.md](../.agents/skills/telegram-bot/SKILL.md) — Agent-facing Telegram Bot API lookup skill backed by a local full Bot API reference
- [../.agents/skills/domain-dag/SKILL.md](../.agents/skills/domain-dag/SKILL.md) — Project-local Domain DAG architecture skill and validator guidance
- [../skills/show-me/SKILL.md](../skills/show-me/SKILL.md) — Portable visual-explanation skill with Telegram phone-width Markdown and self-contained browser-artifact guidance
- [command-templates.md](./command-templates.md) — Portable command-template standard core
- [inbound.md](./inbound.md) — Local `omp-telegram` inbound text/media handler bus, programmatic inbound handlers, registered STT provider fallbacks, legacy `attachmentHandlers` compatibility, placeholders, and fallbacks
- [outbound.md](./outbound.md) — Local `omp-telegram` outbound-handler config, text/voice/button behavior, single-artifact Rich results, voice synthesis provider fallback priority, artifact outputs, and callback routing
- [compact-matrix-literal.md](./compact-matrix-literal.md) — Adaptive Button Literal / CML v4 standard for strict JSON objects, positional cells with disabled state, optional element commas, mixed bounded-depth matrices, atomic parsing, and renderer-owned width policy
- [generative-apps.md](./generative-apps.md) — Generative Apps runtime and wire contract for managed `.mjs` identity, inference-bypass bindings, persistent state timelines, bounded adapters, replacement, and lifecycle; agent operation lives in the bundled `generative-apps` Skill
- [callback-namespaces.md](./callback-namespaces.md) — Shared Telegram `callback_data` namespace standard for layered extensions
- [updates.md](./updates.md) — Update classification and runtime handler registry that lets layered extensions observe and consume Telegram updates without owning their own polling connection
- [multi-instance-bus.md](./multi-instance-bus.md) — Optional multi-instance Telegram bus architecture: profile-scoped transport, leader/follower routing, thread targets, instance slots, manual follower registration, and recovery semantics
- [sections.md](./sections.md) — Telegram Extension Sections Standard: registration contract, context ports, callback routing, navigation hierarchy, and demo reference for OMP extensions that want Telegram UI surfaces
- [voice.md](./voice.md) — Voice integration guide: detection, reply policy, STT/TTS provider registration, provider-owned conversion, and transparent interception
- [ui-style.md](./ui-style.md) — Inline UI style guide for buttons, toggles, tabs, option lists, cards, and dialogs
