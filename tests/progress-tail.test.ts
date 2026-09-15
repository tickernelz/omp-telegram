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
  renderReasoningSectionRich,
  extractReasoningTail,
  extractShortToolArgs,
  extractToolResultSummary,
  formatProgressTailRich,
  type ProgressTailState,
} from "../lib/progress-tail.ts";
import type { TelegramActivityEvent } from "../lib/activity.ts";
import type { TelegramEditMessageTextBody, TelegramSendRichMessageBody } from "../lib/telegram-api.ts";

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

test("formatProgressTailRich renders Working status with tools table, reasoning, and todo table", () => {
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

  const md = formatProgressTailRich(state);
  assert.ok(md.includes("⏳ **Working...** (2.5s) · _Opus 5_"));
  assert.ok(md.includes("## 💭 Reasoning"));
  assert.ok(md.includes("Analyzing project dependencies..."));
  assert.ok(md.includes("Checking lockfile versions."));
  assert.ok(md.includes("## 📋 Todo (1/3)"));
  assert.ok(md.includes("| St | Task |"));
  assert.ok(md.includes("| ✓ | Read config |"));
  assert.ok(md.includes("| ⟳ | Run tests |"));
  assert.ok(md.includes("|   | Deploy |"));
  assert.ok(md.includes("## 🧰 Tools (1 completed, 2 running)"));
  assert.ok(md.includes("| St | Tool | Arguments |"));
  assert.ok(md.includes("| ✓ | read | package.json |"));
  assert.ok(md.includes("| ⟳ | bash | npm test |"));
  assert.ok(md.includes("| ⏳ | ask | 1 question(s) |"));
  const todoIdx = md.indexOf("## 📋 Todo");
  const toolsIdx = md.indexOf("## 🧰 Tools");
  assert.ok(todoIdx < toolsIdx, "Todo section must appear before Tools section for prominent visibility");
});

test("formatProgressTailRich renders Completed, Cancelled, and Failed states with ask answers", () => {
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
  const completedMd = formatProgressTailRich(completedState);
  assert.ok(completedMd.includes("✅ **Completed** in 5.2s · 3 tools · _Claude 3.5 Sonnet_"));
  assert.ok(completedMd.includes("| ✓ (Tele) | ask | - |"));
  assert.ok(completedMd.includes("| ✓ (CLI) | ask | - |"));
  assert.ok(completedMd.includes("| ✗ | edit | src/app.ts |"));

  const cancelledState: ProgressTailState = {
    status: "cancelled",
    startedAtMs: 1000,
    completedAtMs: 4000,
    reasoningLines: [],
    tools: [{ id: "1", name: "read", args: "test.txt", status: "completed" }],
    todoItems: [],
  };
  assert.ok(formatProgressTailRich(cancelledState).includes("⏹ **Cancelled** after 3.0s · 1 tools"));

  const failedState: ProgressTailState = {
    status: "failed",
    startedAtMs: 1000,
    completedAtMs: 2500,
    reasoningLines: [],
    tools: [],
    todoItems: [],
    errorMessage: "Rate limit exceeded",
  };
  assert.ok(formatProgressTailRich(failedState).includes("⚠️ **Failed** after 1.5s: Rate limit exceeded"));
});

test("Progress tail runtime: lazy trigger does not send on agent-start, sends on first activity with rich_message", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 101, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("sendRichMessage must be preferred");
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

  assert.equal(sends.length, 1, "first tool start must send initial live progress message via sendRichMessage");
  assert.equal(sends[0]?.chat_id, 42);
  assert.equal(sends[0]?.message_thread_id, 10);
  assert.ok(sends[0]?.rich_message?.markdown?.includes("⏳ **Working...**"));
  assert.ok(sends[0]?.rich_message?.markdown?.includes("| ⟳ | read | foo.ts |"));
});

test("Progress tail runtime: quiet mode sends no messages", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "quiet",
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 1, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("✅ **Completed**"));

  now = 13_000;
  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "b.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 2, "subsequent activity after commentary must start a fresh live bubble (roll-over)");
  assert.ok(sends[1]?.rich_message?.markdown?.includes("| ⟳ | write | b.ts |"));

  now = 15_000;
  runtime.accept(event("tool-end", { toolCallId: "2", toolName: "write", isError: false, result: "ok" }));
  runtime.accept(event("agent-end"));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 2, "agent-end must freeze the phase 2 bubble");
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("✅ **Completed**"));
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("1 tools"));
});

test("Progress tail runtime: finalization freezes the live progress bubble with summary", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 20_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 201, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("✅ **Completed**"));
  assert.ok(edits[0]?.rich_message?.markdown?.includes("| ✓ | ast_grep | $A |"));
});

test("Progress tail runtime: ask completion freezes previous bubble and starts fresh on subsequent tools", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("✅ **Completed**"));
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("| ✓ (Tele) | ask |"));

  now = 14_000;
  runtime.accept(event("tool-start", { toolCallId: "read-2", toolName: "read", args: { path: "package.json" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 2, "activity after ask must start a fresh live bubble below the ask card");
  assert.ok(sends[1]?.rich_message?.markdown?.includes("| ⟳ | read | package.json |"));

  now = 16_000;
  runtime.accept(event("tool-end", { toolCallId: "read-2", toolName: "read", isError: false, result: "ok" }));
  runtime.accept(event("agent-end"));
  await runtime.waitForIdle();

  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("✅ **Completed**"));
  assert.ok(edits.at(-1)?.rich_message?.markdown?.includes("| ✓ | read | package.json |"));
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

test("formatProgressTailRich renders tool result in details block and limits table rows to 4 newest tools", () => {
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

  const md = formatProgressTailRich(state);
  assert.ok(md.includes("… [1 earlier tools omitted]"), "must show omitted count when > 4 tools");
  assert.equal(md.includes("| tool1 |"), false, "tool1 is the oldest and should be omitted from table");
  assert.ok(md.includes("| tool2 |"));
  assert.ok(md.includes("| tool5 |"));
  assert.ok(md.includes("<details>\n<summary>Result: tool2 · tap to expand</summary>\n\n```\nres2\n```\n\n</details>"));
  assert.ok(md.includes("<details>\n<summary>Result: tool5 · tap to expand</summary>\n\n```\nres5\n```\n\n</details>"));
});

test("renderReasoningSectionRich displays latest 1-2 paragraphs directly, earlier in details block", () => {
  const shortText = ["First thought.", "", "Second thought."].join("\n");
  const shortMd = renderReasoningSectionRich(shortText, 2);
  assert.ok(shortMd.includes("First thought."));
  assert.ok(shortMd.includes("Second thought."));
  assert.equal(shortMd.includes("<details>"), false, "1-2 paragraphs must be directly visible without collapsible details");

  const longText = ["Paragraph 1.", "", "Paragraph 2.", "", "Paragraph 3.", "", "Paragraph 4."].join("\n");
  const longMd = renderReasoningSectionRich(longText, 2);
  assert.ok(longMd.includes("<details>"), "earlier paragraphs must be in collapsible details");
  assert.ok(longMd.includes("<summary>Earlier thoughts · tap to expand</summary>"));
  assert.ok(longMd.includes("Paragraph 1."));
  assert.ok(longMd.includes("Paragraph 2."));
  const detailsEnd = longMd.indexOf("</details>");
  assert.ok(detailsEnd > 0);
  const afterDetails = longMd.slice(detailsEnd);
  assert.ok(afterDetails.includes("Paragraph 3."));
  assert.ok(afterDetails.includes("Paragraph 4."));
});

test("cleanUserPrompt strips [telegram] prefix and truncates cleanly", () => {
  assert.equal(cleanUserPrompt("[telegram] Halo tolong cek bug"), "Halo tolong cek bug");
  assert.equal(cleanUserPrompt("  [Telegram]   Multiple   spaces  "), "Multiple spaces");
  const long = "x".repeat(300);
  const cleaned = cleanUserPrompt(long, 50);
  assert.equal(cleaned.length, 51);
  assert.ok(cleaned.endsWith("…"));
});

test("formatProgressTailRich includes user prompt and contextInfo table when provided", () => {
  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    modelName: "Opus 5",
    userPrompt: "buatkan fitur login oauth",
    contextInfo: {
      cwd: "/home/zhafron/Projects/omp-telegram",
      gitBranch: "main",
      gitDirty: true,
      sessionTitle: "Implement sticky todo and context info",
      modelName: "DeepSeek V4.1 Flash",
      contextUsagePercent: 35.4,
      contextWindow: 1_000_000,
    },
    reasoningLines: [],
    tools: [],
    todoItems: [],
  };

  const md = formatProgressTailRich(state);
  assert.ok(md.includes("| Context | Detail |"));
  assert.ok(md.includes("| 📂 CWD | `/home/zhafron/Projects/omp-telegram` (🌿 `main` _[dirty]_) |"));
  assert.ok(md.includes("| 🏷️ Title | Implement sticky todo and context info |"));
  assert.ok(md.includes("| 🤖 Model | DeepSeek V4.1 Flash |"));
  assert.ok(md.includes("| 📊 Usage | 35.4% of 1.0M tokens |"));
  assert.ok(md.includes("## 👤 Prompt"));
  assert.ok(md.includes("_buatkan fitur login oauth_"));
});

test("Progress tail runtime captures and displays promptText from agent-start", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 1, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText() { return "edited"; },
  });

  runtime.accept(event("agent-start", { promptText: "[telegram] bikin endpoint user profile" }));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "api.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1);
  assert.ok(sends[0]?.rich_message?.markdown?.includes("## 👤 Prompt"));
  assert.ok(sends[0]?.rich_message?.markdown?.includes("bikin endpoint user profile"));
  assert.equal(sends[0]?.rich_message?.markdown?.includes("[telegram]"), false, "[telegram] prefix must be stripped");
});

test("Progress tail runtime updates userPrompt on prompt-update steering message mid-turn", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 1, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("agent-start", { promptText: "initial user prompt" }));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "api.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1);
  assert.ok(sends[0]?.rich_message?.markdown?.includes("initial user prompt"));

  runtime.accept(event("prompt-update", { promptText: "steering: tolong ubah port ke 8080" }));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 1);
  const updatedMarkdown = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(updatedMarkdown.includes("steering: tolong ubah port ke 8080"));
  assert.equal(updatedMarkdown.includes("initial user prompt"), false, "old prompt must be replaced by new steering prompt");
});

test("formatProgressTailRich handles massive reasoning and 50 tools within 7500 chars limit", () => {
  const massiveReasoning = [
    "Paragraph 1 describing initial investigation and findings in great detail.",
    "Paragraph 2 exploring multiple potential root causes in depth across files.",
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

  const md = formatProgressTailRich(state);
  assert.ok(md.length <= 7500, "Markdown length must stay within 7500 safety budget, got " + md.length);
  assert.ok(md.includes("⏳ **Working...**"));
  assert.ok(md.includes("## 👤 Prompt"));
  assert.ok(md.includes("## 💭 Reasoning"));
  assert.ok(md.includes("## 🧰 Tools"));
  assert.ok(md.includes("<details>"));
  assert.ok(md.includes("| St | Tool | Arguments |"));
});

test("Progress tail runtime: parses multi-phase todo results from todo tool", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() { throw new Error("unexpected call"); },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", {
    toolCallId: "todo_call_1",
    toolName: "todo",
    args: { op: "init" },
  }));
  await runtime.waitForIdle();

  runtime.accept(event("tool-end", {
    toolCallId: "todo_call_1",
    toolName: "todo",
    result: {
      op: "init",
      details: {
        phases: [
          {
            name: "Implementation",
            tasks: [
              { content: "Fix bug 1", status: "completed" },
              { content: "Implement feature 2", status: "in_progress" },
              { content: "Verify changes", status: "pending" },
            ],
          },
        ],
      },
    },
    isError: false,
  }));
  await runtime.waitForIdle();

  assert.ok(edits.length >= 1);
  const text = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(text.includes("## 📋 Todo (1/3)"));
  assert.ok(text.includes("| ✓ | Fix bug 1 |"));
  assert.ok(text.includes("| ⟳ | Implement feature 2 |"));
  assert.ok(text.includes("|   | Verify changes |"));
});

test("Progress tail runtime: container unwrapping suppresses outer fabric_exec when inner tools execute", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", {
    toolCallId: "call_outer_1",
    toolName: "fabric_exec",
    args: { i: "Inspecting files", code: "await omp.bash({cmd: 'ls'})" },
  }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1);
  assert.ok(sends[0]?.rich_message?.markdown?.includes("| ⟳ | fabric_exec | Inspecting files |"));

  now = 10_500;
  runtime.accept(event("tool-start", {
    toolCallId: "fabric_child_1",
    toolName: "bash",
    args: { cmd: "ls" },
  }));
  await runtime.waitForIdle();
  assert.ok(edits.length >= 1);
  const latestEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(latestEdit.includes("| ⟳ | bash | ls |"));
  assert.equal(latestEdit.includes("fabric_exec"), false, "outer running fabric_exec must be hidden while child runs");

  now = 11_000;
  runtime.accept(event("tool-end", {
    toolCallId: "fabric_child_1",
    toolName: "bash",
    result: { output: "file1.txt\nfile2.txt" },
    isError: false,
  }));
  runtime.accept(event("tool-end", {
    toolCallId: "call_outer_1",
    toolName: "fabric_exec",
    result: { output: "file1.txt\nfile2.txt" },
    isError: false,
  }));
  await runtime.waitForIdle();

  const finalEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(finalEdit.includes("| ✓ | bash | ls |"));
  assert.equal(finalEdit.includes("fabric_exec"), false, "outer fabric_exec must be unwrapped and omitted when child ran");

  now = 12_000;
  runtime.accept(event("tool-start", {
    toolCallId: "call_outer_2",
    toolName: "fabric_exec",
    args: { i: "Pure computation", code: "const x = 1 + 1;" },
  }));
  runtime.accept(event("tool-end", {
    toolCallId: "call_outer_2",
    toolName: "fabric_exec",
    result: 2,
    isError: false,
  }));
  await runtime.waitForIdle();

  const pureEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(pureEdit.includes("| ✓ | fabric_exec | Pure computation |"), "standalone fabric_exec without children must be retained");
});

test("Progress tail runtime: multi-turn continuation with willContinue keeps same live message across turns", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  assert.equal(sends.length, 1, "first bubble created for turn 1");

  now = 12_000;
  runtime.accept(event("agent-end", { willContinue: true }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "no new message created on multi-turn continuation");

  now = 13_000;
  runtime.accept(event("agent-start"));
  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "b.ts" } }));
  runtime.accept(event("tool-end", { toolCallId: "2", toolName: "write", isError: false, result: "ok" }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "must NOT send a new message; must continue editing the same live message");

  const latestEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(latestEdit.includes("b.ts"), "must update existing bubble with turn 2 tools");

  now = 15_000;
  runtime.accept(event("agent-settled"));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "only 1 message sent across the entire multi-turn session");
  const completedEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(completedEdit.includes("✅ **Completed**"), "final settlement marks the bubble completed");
});

test("Progress tail runtime: refreshes authority across transport role promotion without dropping events", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;
  let role: "follower" | "leader" = "follower";

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    resolveTarget: (e) => e.target,
    captureAuthority: () => ({ role }),
    isAuthorityActive: (a: { role: string }) => a.role === "follower" ? (role === "follower" || role === "leader") : a.role === role,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 100 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
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
  assert.equal(sends.length, 1);

  role = "leader";
  now = 12_000;
  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "b.ts" } }));
  runtime.accept(event("tool-end", { toolCallId: "2", toolName: "write", isError: false, result: "ok" }));
  await runtime.waitForIdle();

  const latestEdit = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(latestEdit.includes("b.ts"), "must update live bubble after role promotion");
});
