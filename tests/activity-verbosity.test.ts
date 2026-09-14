/**
 * Telegram activity verbosity projection regressions
 * Covers four activity modes, single-bubble progress tail, tool & reasoning isolation, and authority fencing
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramActivityVerbosityBinding,
  createTelegramActivityVerbosityRuntime,
  renderTelegramThinkingActivityHtml,
  renderTelegramToolActivityHtml,
  renderTelegramToolActivityRichMessage,
} from "../lib/activity-verbosity.ts";
import type {
  TelegramActivityEvent,
  TelegramActivityPayload,
} from "../lib/activity.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
} from "../lib/telegram-api.ts";

test("Activity verbosity binding safely delegates after late composition", async () => {
  const calls: string[] = [];
  const binding = createTelegramActivityVerbosityBinding();
  binding.reset();
  await binding.waitForIdle();
  binding.bind({
    accept: () => calls.push("accept"),
    reset: () => calls.push("reset"),
    stop: () => calls.push("stop"),
    waitForIdle: async () => {
      calls.push("idle");
    },
  });
  binding.accept({} as TelegramActivityEvent);
  binding.reset();
  binding.stop();
  await binding.waitForIdle();
  assert.deepEqual(calls, ["accept", "reset", "stop", "idle"]);
});

function event(
  sequence: number,
  payload: TelegramActivityPayload,
): TelegramActivityEvent {
  return {
    ...payload,
    activityId: "session:1",
    sequence,
    source: "telegram",
    target: { chatId: 42, threadId: 7 },
    timestamp: sequence,
  } as TelegramActivityEvent;
}

type ActivityMode = "quiet" | "thinking" | "tools" | "verbose";

function createHarness(
  options: {
    mode?: ActivityMode;
    refreshedMode?: ActivityMode;
    refreshError?: Error;
    richSendError?: Error;
  } = {},
) {
  let mode = options.mode ?? "verbose";
  let authority = 1;
  let nowMs = 0;
  const sends: TelegramSendMessageBody[] = [];
  const richSends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const runtime = createTelegramActivityVerbosityRuntime({
    getActivityMode: () => mode,
    refreshActivityMode: async () => {
      if (options.refreshError) throw options.refreshError;
      if (options.refreshedMode) mode = options.refreshedMode;
    },
    getNowMs: () => nowMs,
    resolveTarget: (activity) => activity.target,
    captureAuthority: () => authority,
    isAuthorityActive: (captured) => captured === authority,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length };
    },
    async sendRichMessage(body) {
      if (options.richSendError) throw options.richSendError;
      richSends.push(body);
      return { message_id: 200 + richSends.length };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });
  return {
    runtime,
    sends,
    richSends,
    edits,
    setMode(value: ActivityMode) {
      mode = value;
    },
    advanceNow(ms: number) {
      nowMs += ms;
    },
    replaceAuthority() {
      authority += 1;
    },
  };
}

test("Activity captures authority at admission rather than after queue delay", async () => {
  const harness = createHarness({ mode: "tools" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(event(2, { type: "tool-end", toolCallId: "read-1", toolName: "read", result: "old output", isError: false }));
  harness.replaceAuthority();
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
  assert.deepEqual(harness.richSends, []);
  assert.deepEqual(harness.edits, []);
});

test("quiet activity emits no reasoning or tool messages", async () => {
  const harness = createHarness({ mode: "quiet" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "secret thoughts",
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "output",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
  assert.deepEqual(harness.richSends, []);
  assert.deepEqual(harness.edits, []);
});

test("tool Rich activity separates arguments, updates, and result details", () => {
  const rich = renderTelegramToolActivityRichMessage([
    {
      id: "tool-1",
      name: "bash",
      args: '{\n  "cmd": "npm test"\n}',
      updates: ['"running suite"'],
      droppedUpdates: 0,
      result: '{\n  "code": 0\n}',
      isError: false,
      complete: true,
    },
  ]);
  assert.equal(rich.skip_entity_detection, true);
  assert.ok(rich.blocks);
  assert.equal(rich.blocks.length, 1);
  const detail = rich.blocks[0] as {
    type: "details";
    summary: unknown;
    blocks: Array<{ type: string; text?: string; language?: string; summary?: unknown }>;
  };
  assert.equal(detail.type, "details");
  assert.deepEqual(detail.summary, [
    { type: "bold", text: "Bash:" },
    " ",
    { type: "code", text: "done" },
  ]);
  assert.equal(detail.blocks.length, 3);
  assert.deepEqual(detail.blocks[0], {
    type: "details",
    summary: { type: "code", text: "arguments" },
    blocks: [{ type: "pre", text: '{\n  "cmd": "npm test"\n}', language: "json" }],
    is_open: true,
  });
  assert.deepEqual(detail.blocks[1], {
    type: "details",
    summary: { type: "code", text: "update 1" },
    blocks: [{ type: "pre", text: '"running suite"', language: "json" }],
  });
  assert.deepEqual(detail.blocks[2], {
    type: "details",
    summary: { type: "code", text: "result" },
    blocks: [{ type: "pre", text: '{\n  "code": 0\n}', language: "json" }],
  });
});

test("tool root labels humanize snake case and preserve repeated prefixes", () => {
  const rich = renderTelegramToolActivityRichMessage([
    {
      id: "tool-1",
      name: "ffgrep_tool",
      args: "{}",
      updates: [],
      droppedUpdates: 0,
      complete: true,
    },
  ]);
  assert.ok(rich.blocks);
  const summary = (rich.blocks[0] as { summary: Array<{ text?: string }> }).summary;
  assert.equal(summary[0]?.text, "FFgrep Tool:");
});

test("tool evidence renders as ordinary expandable HTML fallback", () => {
  const html = renderTelegramToolActivityHtml([
    {
      id: "tool-1",
      name: "read_file",
      args: '{\n  "path": "test.txt"\n}',
      updates: ['"chunk 1"'],
      droppedUpdates: 2,
      result: '"done"',
      isError: true,
      complete: true,
    },
  ]);
  assert.ok(html.includes("<b>Read File:</b> <code>failed</code>"));
  assert.ok(html.includes("<blockquote expandable>"));
  assert.ok(html.includes('"arguments": {\n  "path": "test.txt"\n}'));
  assert.ok(html.includes("… [2 earlier updates omitted]"));
  assert.ok(html.includes('"update 3": "chunk 1"'));
  assert.ok(html.includes('"error": "done"'));
});

test("reasoning evidence renders inline HTML inside an expandable quote", () => {
  const html = renderTelegramThinkingActivityHtml(
    "**Reviewing data models**\na < b\n<https://example.com>",
  );
  assert.ok(html.startsWith("<blockquote expandable>"));
  assert.ok(html.includes("<blockquote expandable><b>Reviewing data models</b>\na &lt; b"));
  assert.equal(html.includes("https://\u200bexample.com"), true);
  assert.doesNotMatch(html, /<a |rich_message/);
});

test("tool Rich details keep compact arrays of objects", () => {
  const rich = renderTelegramToolActivityRichMessage([
    {
      id: "tool-1",
      name: "exec",
      args: '{\n  "items": [{\n    "id": 1\n  }]\n}',
      updates: [],
      droppedUpdates: 0,
      complete: true,
    },
  ]);
  assert.ok(rich.blocks);
  const detail = rich.blocks[0] as {
    blocks: Array<{ blocks: Array<{ text?: string }> }>;
  };
  const text = detail.blocks[0]?.blocks[0]?.text ?? "";
  assert.match(text, /"items":/);
});

test("agent start refreshes file-backed mode before activity isolation", async () => {
  const harness = createHarness({ mode: "verbose", refreshedMode: "thinking" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-end",
      contentIndex: 0,
      text: "private thought",
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1);
  const text = harness.sends[0]?.text ?? "";
  assert.ok(text.includes("<blockquote expandable>"));
  assert.equal(text.includes("<b>read</b>"), false);
});

test("activity fails closed when file-backed mode refresh fails", async () => {
  const harness = createHarness({
    mode: "verbose",
    refreshError: new Error("config unavailable"),
  });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
});

test("thinking and tools modes isolate their activity classes in progress tail", async () => {
  for (const mode of ["thinking", "tools"] as const) {
    const harness = createHarness({ mode });
    harness.runtime.accept(event(1, { type: "agent-start" }));
    harness.runtime.accept(
      event(2, {
        type: "reasoning-end",
        contentIndex: 0,
        text: "private thought",
      }),
    );
    harness.runtime.accept(
      event(3, {
        type: "tool-end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "done",
        isError: false,
      }),
    );
    await harness.runtime.waitForIdle();
    assert.equal(harness.sends.length, 1);
    const text = harness.sends[0]?.text ?? "";
    assert.equal(text.includes("▰ 💭 <b>Reasoning</b>"), mode === "thinking");
    assert.equal(text.includes("<b>read</b>"), mode === "tools");
  }
});

test("single live progress bubble is created on first activity and edited on updates", async () => {
  const harness = createHarness({ mode: "verbose" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 0, "lazy trigger: no message before activity");

  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "src/main.ts" },
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1, "first tool creates the live bubble");
  assert.ok(harness.sends[0]?.text?.includes("⏳ <b>Working...</b>"));
  assert.ok(harness.sends[0]?.text?.includes("⟳ <b>read</b>: <code>src/main.ts</code>"));

  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "ok",
      isError: false,
    }),
  );
  harness.runtime.accept(
    event(4, {
      type: "tool-start",
      toolCallId: "tool-2",
      toolName: "bash",
      args: { cmd: "npm test" },
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1, "no second bubble sent; updates edit the existing one");
  assert.ok(harness.edits.length >= 1, "edits must update the live progress bubble");
  const latestEdit = harness.edits.at(-1)?.text ?? "";
  assert.ok(latestEdit.includes("✓ <b>read</b>: <code>src/main.ts</code>"));
  assert.ok(latestEdit.includes("⟳ <b>bash</b>: <code>npm test</code>"));

  harness.runtime.accept(event(5, { type: "agent-end" }));
  await harness.runtime.waitForIdle();
  assert.ok(harness.edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));
});

test("roll-over on intermediate commentary freezes bubble and starts fresh on next activity", async () => {
  const harness = createHarness({ mode: "verbose" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "phase1.ts" },
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "ok",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1);

  harness.runtime.accept(
    event(4, {
      type: "assistant-segment",
      contentIndex: 0,
      placement: "intermediate",
      text: "Phase 1 complete.",
    }),
  );
  await harness.runtime.waitForIdle();
  assert.ok(harness.edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));

  harness.runtime.accept(
    event(5, {
      type: "tool-start",
      toolCallId: "tool-2",
      toolName: "write",
      args: { path: "phase2.ts" },
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 2, "subsequent activity opens a fresh bubble under commentary");
});

test("reset drops accepted events that have not started processing", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.reset();
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
  assert.deepEqual(harness.edits, []);
});

test("authority replacement fences unadmitted events", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  await harness.runtime.waitForIdle();
  harness.replaceAuthority();
  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "tool-stale",
      toolName: "read",
      args: { path: "stale.ts" },
    }),
  );
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
});
