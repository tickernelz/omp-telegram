/**
 * Regression tests for Telegram live progress tail
 * Zones: telegram progress tail, throttling, roll-over, rich rendering
 * Covers single-bubble live updates, lazy initiation, roll-over on commentary, finalization summaries, and rate-limited Telegram edits
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramProgressTailRuntime,
  cleanUserPrompt,
  renderReasoningSectionHtml,
  extractReasoningTail,
  extractShortToolArgs,
  extractToolResultSummary,
  formatProgressTailHtml,
  type ProgressTailState,
} from "../lib/progress-tail.ts";
import type { TelegramActivityEvent } from "../lib/activity.ts";
import type { TelegramEditMessageTextBody, TelegramSendMessageBody } from "../lib/telegram-api.ts";

function event(
  type: TelegramActivityEvent["type"],
  extra: Record<string, unknown> = {},
): TelegramActivityEvent {
  return {
    activityId: "session-1",
    sequence: 1,
    source: "telegram",
    target: { chatId: 42, threadId: 10 },
    timestamp: 1000,
    type,
    ...extra,
  } as TelegramActivityEvent;
}

test("extractShortToolArgs extracts concise and recognizable tool arguments", () => {
  assert.equal(extractShortToolArgs("read", { path: "src/index.ts" }), "src/index.ts");
  assert.equal(extractShortToolArgs("write", { path: "dist/app.js", text: "hello" }), "dist/app.js");
  assert.equal(extractShortToolArgs("edit", { path: "lib/ask.ts" }), "lib/ask.ts");
  assert.equal(extractShortToolArgs("bash", { cmd: "npm test --run" }), "npm test --run");
  assert.equal(extractShortToolArgs("bash", { command: "git status" }), "git status");
  assert.equal(extractShortToolArgs("glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(extractShortToolArgs("grep", { query: "export function" }), "export function");
  assert.equal(extractShortToolArgs("ast_grep", { pat: "$A && $A()" }), "$A && $A()");
  assert.equal(extractShortToolArgs("ask", { questions: [{ id: "q1" }, { id: "q2" }] }), "2 question(s)");
  assert.equal(extractShortToolArgs("todo", { op: "done", task: "Setup db" }), "Setup db");
  assert.equal(extractShortToolArgs("custom", { url: "https://example.com" }), "https://example.com");
  assert.equal(extractShortToolArgs("unknown", null), "");
  assert.equal(extractShortToolArgs("unknown", undefined), "");
});

test("formatProgressTailHtml renders Working status with tools, reasoning, and todo", () => {
  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    completedAtMs: 3500,
    modelName: "Opus 5",
    reasoningLines: ["Analyzing project dependencies...", "Checking lockfile versions."],
    tools: [
      { id: "1", name: "read", args: "package.json", status: "completed" },
      { id: "2", name: "bash", args: "npm test", status: "running" },
      { id: "3", name: "ask", args: "1 question(s)", status: "waiting", askStatus: "waiting" },
    ],
    todoItems: [
      { task: "Read config", status: "completed" },
      { task: "Run tests", status: "in_progress" },
      { task: "Deploy", status: "pending" },
    ],
  };

  const html = formatProgressTailHtml(state);
  assert.ok(html.includes("⏳ <b>Working...</b> (2.5s) · <i>Opus 5</i>"));
  assert.ok(html.includes("▰ 💭 <b>Reasoning</b>"));
  assert.ok(html.includes("Analyzing project dependencies..."));
  assert.ok(html.includes("Checking lockfile versions."));
  assert.ok(html.includes("▰ 🧰 <b>Tools</b> (1 completed, 2 running)"));
  assert.ok(html.includes("✓ <b>read</b>: <code>package.json</code>"));
  assert.ok(html.includes("⟳ <b>bash</b>: <code>npm test</code>"));
  assert.ok(html.includes("⏳ <b>ask</b>: <i>Waiting for user decision...</i>"));
  assert.ok(html.includes("▰ 📋 <b>Todo</b> (1/3)"));
  assert.ok(html.includes("[✓] Read config"));
  assert.ok(html.includes("[⟳] Run tests"));
  assert.ok(html.includes("[ ] Deploy"));
});

test("formatProgressTailHtml renders Completed, Cancelled, and Failed states with ask answers", () => {
  const completedState: ProgressTailState = {
    status: "completed",
    startedAtMs: 1000,
    completedAtMs: 6200,
    modelName: "Claude 3.5 Sonnet",
    reasoningLines: [],
    tools: [
      { id: "1", name: "ask", args: "", status: "completed", askStatus: "answered_telegram" },
      { id: "2", name: "ask", args: "", status: "completed", askStatus: "answered_cli" },
      { id: "3", name: "edit", args: "src/app.ts", status: "failed", isError: true },
    ],
    todoItems: [],
  };
  const completedHtml = formatProgressTailHtml(completedState);
  assert.ok(completedHtml.includes("✅ <b>Completed</b> in 5.2s · 3 tools · <i>Claude 3.5 Sonnet</i>"));
  assert.ok(completedHtml.includes("✓ <b>ask</b>: <i>Answered via Telegram</i>"));
  assert.ok(completedHtml.includes("✓ <b>ask</b>: <i>Answered via CLI</i>"));
  assert.ok(completedHtml.includes("✗ <b>edit</b>: <code>src/app.ts</code>"));

  const cancelledState: ProgressTailState = {
    status: "cancelled",
    startedAtMs: 1000,
    completedAtMs: 4000,
    reasoningLines: [],
    tools: [{ id: "1", name: "read", args: "test.txt", status: "completed" }],
    todoItems: [],
  };
  assert.ok(formatProgressTailHtml(cancelledState).includes("⏹ <b>Cancelled</b> after 3.0s · 1 tools"));

  const failedState: ProgressTailState = {
    status: "failed",
    startedAtMs: 1000,
    completedAtMs: 2500,
    reasoningLines: [],
    tools: [],
    todoItems: [],
    errorMessage: "Rate limit exceeded",
  };
  assert.ok(formatProgressTailHtml(failedState).includes("⚠️ <b>Failed</b> after 1.5s: Rate limit exceeded"));
});

test("Progress tail runtime: lazy trigger does not send on agent-start, sends on first activity", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 101, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
    getModelName: () => "Opus 5",
  });

  runtime.accept(event("agent-start"));
  await runtime.waitForIdle();
  assert.equal(sends.length, 0, "lazy trigger must not send message on agent-start");

  now = 10_500;
  runtime.accept(event("tool-start", { toolCallId: "call-1", toolName: "read", args: { path: "foo.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1, "first tool start must send initial live progress message");
  assert.equal(sends[0]?.chat_id, 42);
  assert.equal(sends[0]?.message_thread_id, 10);
  assert.ok(sends[0]?.text?.includes("⏳ <b>Working...</b>"));
  assert.ok(sends[0]?.text?.includes("⟳ <b>read</b>: <code>foo.ts</code>"));
});

test("Progress tail runtime: quiet mode sends no messages", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "quiet",
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 1, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText() {
      return "edited";
    },
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("reasoning-delta", { contentIndex: 0, delta: "thinking" }));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: {} }));
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "read", isError: false, result: "ok" }));
  runtime.accept(event("agent-end"));
  await runtime.waitForIdle();

  assert.equal(sends.length, 0, "quiet mode must produce zero messages");
});

test("Progress tail runtime: roll-over on intermediate commentary freezes bubble and resets for next phase", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
    getModelName: () => "Opus 5",
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "read", isError: false, result: "ok" }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "first bubble created for phase 1");

  now = 12_000;
  runtime.accept(event("assistant-segment", { placement: "intermediate", contentIndex: 0, text: "I analyzed a.ts" }));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 1, "intermediate commentary must freeze phase 1 bubble");
  assert.ok(edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));

  now = 13_000;
  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "b.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 2, "subsequent activity after commentary must start a fresh live bubble (roll-over)");
  assert.equal(sends[1]?.message_id, undefined);
  assert.ok(sends[1]?.text?.includes("⟳ <b>write</b>: <code>b.ts</code>"));

  now = 15_000;
  runtime.accept(event("tool-end", { toolCallId: "2", toolName: "write", isError: false, result: "ok" }));
  runtime.accept(event("agent-end"));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 2, "agent-end must freeze the phase 2 bubble");
  assert.ok(edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));
  assert.ok(edits.at(-1)?.text?.includes("1 tools"));
});

test("Progress tail runtime: finalization freezes the live progress bubble with summary", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 20_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 201, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
    getModelName: () => "Opus 5",
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "ast_grep", args: { pat: "$A" } }));
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "ast_grep", isError: false, result: "ok" }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1);

  now = 25_000;
  runtime.accept(event("agent-settled"));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 1, "agent-settled must freeze the live bubble with final summary");
  assert.ok(edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));
  assert.ok(edits[0]?.text?.includes("✓ <b>ast_grep</b>: <code>$A</code>"));
});

test("Progress tail runtime: ask completion freezes previous bubble and starts fresh on subsequent tools", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
    getModelName: () => "Opus 5",
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", { toolCallId: "ask-1", toolName: "ask", args: { questions: [{ id: "q1" }] } }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "initial bubble created before ask");

  now = 12_000;
  runtime.accept(event("tool-end", { toolCallId: "ask-1", toolName: "ask", isError: false, result: { details: { answeredVia: "telegram" } } }));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 1, "ask completion must freeze the top bubble");
  assert.ok(edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));
  assert.ok(edits.at(-1)?.text?.includes("✓ <b>ask</b>: <i>Answered via Telegram</i>"));

  now = 14_000;
  runtime.accept(event("tool-start", { toolCallId: "read-2", toolName: "read", args: { path: "package.json" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 2, "activity after ask must start a fresh live bubble below the ask card");
  assert.ok(sends[1]?.text?.includes("⟳ <b>read</b>: <code>package.json</code>"));

  now = 16_000;
  runtime.accept(event("tool-end", { toolCallId: "read-2", toolName: "read", isError: false, result: "ok" }));
  runtime.accept(event("agent-end"));
  await runtime.waitForIdle();

  assert.ok(edits.at(-1)?.text?.includes("✅ <b>Completed</b>"));
  assert.ok(edits.at(-1)?.text?.includes("✓ <b>read</b>: <code>package.json</code>"));
});

test("extractReasoningTail strips think tags and retains newest 1-3 paragraphs with omission notice", () => {
  const raw = ["<think>", "First paragraph of thought.", "", "Second paragraph exploring options.", "", "Third paragraph evaluating tradeoffs.", "", "Fourth paragraph settling on design.", "</think>"].join("\n");
  const tail = extractReasoningTail(raw, 3);
  assert.equal(tail.includes("First paragraph"), false, "oldest paragraph must be omitted");
  assert.ok(tail.includes("… [1 earlier paragraph(s) omitted]"));
  assert.ok(tail.includes("Second paragraph exploring options."));
  assert.ok(tail.includes("Third paragraph evaluating tradeoffs."));
  assert.ok(tail.includes("Fourth paragraph settling on design."));
  assert.equal(tail.includes("<think>"), false);
  assert.equal(tail.includes("</think>"), false);
});

test("extractToolResultSummary extracts text content and truncates safely", () => {
  const contentObj = { content: [{ type: "text", text: "Line 1 - Line 2 result" }] };
  assert.equal(extractToolResultSummary("read", contentObj), "Line 1 - Line 2 result");

  const outputObj = { output: "Command completed successfully" };
  assert.equal(extractToolResultSummary("bash", outputObj), "Command completed successfully");

  const longText = "a".repeat(800);
  const truncated = extractToolResultSummary("bash", longText, false, 600);
  assert.ok(truncated.includes("… [truncated]"));
  assert.ok(truncated.length <= 620);
});

test("formatProgressTailHtml renders tool result in expandable blockquote and limits to 4 newest tools", () => {
  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    modelName: "Opus 5",
    reasoningLines: [],
    tools: [
      { id: "1", name: "tool1", args: "arg1", status: "completed", resultSummary: "res1" },
      { id: "2", name: "tool2", args: "arg2", status: "completed", resultSummary: "res2" },
      { id: "3", name: "tool3", args: "arg3", status: "completed", resultSummary: "res3" },
      { id: "4", name: "tool4", args: "arg4", status: "completed", resultSummary: "res4" },
      { id: "5", name: "tool5", args: "arg5", status: "completed", resultSummary: "res5" },
    ],
    todoItems: [],
  };

  const html = formatProgressTailHtml(state);
  assert.ok(html.includes("… [1 earlier tools omitted]"), "must show omitted count when > 4 tools");
  assert.equal(html.includes("tool1"), false, "tool1 is the oldest and should be omitted");
  assert.ok(html.includes("tool2"));
  assert.ok(html.includes("tool5"));
  assert.ok(html.includes("<blockquote expandable>res2</blockquote>"));
  assert.ok(html.includes("<blockquote expandable>res5</blockquote>"));
});


test("renderReasoningSectionHtml displays latest 1-2 paragraphs directly, earlier in expandable blockquote", () => {
  const shortText = ["First thought.", "", "Second thought."].join("\n");
  const shortHtml = renderReasoningSectionHtml(shortText, 2);
  assert.ok(shortHtml.includes("First thought."));
  assert.ok(shortHtml.includes("Second thought."));
  assert.equal(shortHtml.includes("<blockquote expandable>"), false, "1-2 paragraphs must be directly visible without collapsible blockquote");

  const longText = ["Paragraph 1.", "", "Paragraph 2.", "", "Paragraph 3.", "", "Paragraph 4."].join("\n");
  const longHtml = renderReasoningSectionHtml(longText, 2);
  assert.ok(longHtml.includes("<blockquote expandable>"), "earlier paragraphs must be in collapsible blockquote");
  assert.ok(longHtml.includes("Paragraph 1."));
  assert.ok(longHtml.includes("Paragraph 2."));
  const bqEnd = longHtml.indexOf("</blockquote>");
  assert.ok(bqEnd > 0);
  const afterBq = longHtml.slice(bqEnd);
  assert.ok(afterBq.includes("Paragraph 3."));
  assert.ok(afterBq.includes("Paragraph 4."));
});


test("cleanUserPrompt strips [telegram] prefix and truncates cleanly", () => {
  assert.equal(cleanUserPrompt("[telegram] Halo tolong cek bug"), "Halo tolong cek bug");
  assert.equal(cleanUserPrompt("  [Telegram]   Multiple   spaces  "), "Multiple spaces");
  const long = "x".repeat(300);
  const cleaned = cleanUserPrompt(long, 50);
  assert.equal(cleaned.length, 51);
  assert.ok(cleaned.endsWith("…"));
});

test("formatProgressTailHtml includes user prompt when provided", () => {
  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    modelName: "Opus 5",
    userPrompt: "buatkan fitur login oauth",
    reasoningLines: [],
    tools: [],
    todoItems: [],
  };

  const html = formatProgressTailHtml(state);
  assert.ok(html.includes("▰ 👤 <b>Prompt</b>"));
  assert.ok(html.includes("<i>buatkan fitur login oauth</i>"));
});

test("Progress tail runtime captures and displays promptText from agent-start", async () => {
  const sends: TelegramSendMessageBody[] = [];
  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: 1, date: 1, chat: { id: 42, type: "private" } };
    },
    async editMessageText() { return "edited"; },
  });

  runtime.accept(event("agent-start", { promptText: "[telegram] bikin endpoint user profile" }));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "api.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1);
  assert.ok(sends[0]?.text?.includes("▰ 👤 <b>Prompt</b>"));
  assert.ok(sends[0]?.text?.includes("bikin endpoint user profile"));
  assert.equal(sends[0]?.text?.includes("[telegram]"), false, "[telegram] prefix must be stripped");
});


test("formatProgressTailHtml handles massive reasoning and 50 tools without dropping HTML tags or exceeding budget", () => {
  const massiveReasoning = [
    "Paragraph 1 describing initial investigation and findings.",
    "Paragraph 2 exploring multiple potential root causes in depth.",
    "Paragraph 3 detailing code paths and execution flows.",
    "Paragraph 4 discussing tradeoffs between performance and memory.",
    "Paragraph 5 concluding with the optimal architectural design.",
  ].join("\n\n");

  const tools = Array(50).fill(null).map((_, i) => ({
    id: String(i),
    name: "bash",
    args: "cd /home/zhafron/Projects/omp-telegram && sed -n '1,100p' lib/progress-tail.ts",
    status: "completed" as const,
    resultSummary: "line 1 of command output\nline 2 of command output\n" + "output data ".repeat(30),
  }));

  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    modelName: "Gemini 3.8 Flash (High) (omniroute)",
    userPrompt: "sekarang aku ingin kamu full rewrite readme.md nya dan update doc doc yang lain",
    reasoningBuffer: massiveReasoning,
    reasoningLines: massiveReasoning.split("\n"),
    tools,
    todoItems: [
      { task: "Task 1", status: "completed" },
      { task: "Task 2", status: "in_progress" },
    ],
  };

  const html = formatProgressTailHtml(state);
  assert.ok(html.length <= 3500, "HTML length must stay within safety budget, got " + html.length);
  assert.ok(html.includes("⏳ <b>Working...</b>"), "must retain bold header tag");
  assert.ok(html.includes("▰ 👤 <b>Prompt</b>"), "must retain prompt bold tag");
  assert.ok(html.includes("▰ 💭 <b>Reasoning</b>"), "must retain reasoning bold tag");
  assert.ok(html.includes("▰ 🧰 <b>Tools</b>"), "must retain tools bold tag");
  assert.ok(html.includes("<blockquote expandable>"), "must retain expandable blockquote");
  assert.ok(html.includes("</code>"), "must retain code tags");
  assert.equal(html.includes("… [truncated]"), false, "must not produce raw plain-text truncation");
});

