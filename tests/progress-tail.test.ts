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
  isCommandInvocationPrompt,
  TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS,
  TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_BYTES,
  TELEGRAM_PROGRESS_TAIL_MAX_TOOLS,
  TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS,
  renderReasoningSectionRich,
  extractReasoningTail,
  extractShortToolArgs,
  extractToolResultSummary,
  formatProgressTailRich,
  type ProgressTailState,
} from "../lib/progress-tail.ts";
import type { TelegramActivityEvent } from "../lib/activity.ts";
import {
  TelegramApiHttpError,
  type TelegramEditMessageTextBody,
  type TelegramSendRichMessageBody,
} from "../lib/telegram-api.ts";

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
  assert.ok(md.includes("⏳ **Working...** (2.5s)"));
  assert.ok(md.includes("| 🤖 Model | Opus 5 |"));
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
  assert.ok(completedMd.includes("✅ **Completed** in 5.2s · 3 tools"));
  assert.ok(completedMd.includes("| 🤖 Model | Claude 3.5 Sonnet |"));
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

test("formatProgressTailRich renders tool results and keeps the newest tools within the configured cap", () => {
  const total = TELEGRAM_PROGRESS_TAIL_MAX_TOOLS + 1;
  const state: ProgressTailState = {
    status: "working",
    startedAtMs: 1000,
    modelName: "Opus 5",
    reasoningLines: [],
    tools: Array.from({ length: total }, (_unused, index) => ({
      id: String(index + 1),
      name: `tool${index + 1}`,
      args: `arg${index + 1}`,
      status: "completed" as const,
      resultSummary: `res${index + 1}`,
    })),
    todoItems: [],
  };

  const md = formatProgressTailRich(state);
  assert.ok(md.includes("… [1 earlier tools omitted]"), "must show omitted count beyond the cap");
  assert.equal(md.includes("| tool1 |"), false, "the oldest tool is dropped from the table");
  assert.ok(md.includes("| tool2 |"));
  assert.ok(md.includes(`| tool${total} |`));
  assert.ok(md.includes("<details>\n<summary>Result: tool2 · tap to expand</summary>\n\n```\nres2\n```\n\n</details>"));
  assert.ok(
    md.includes(`<details>\n<summary>Result: tool${total} · tap to expand</summary>\n\n\`\`\`\nres${total}\n\`\`\`\n\n</details>`),
  );
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
  assert.equal(cleanUserPrompt("[telegram|thread:Globe] Halo tolong cek bug"), "Halo tolong cek bug");
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

test("formatProgressTailRich handles massive reasoning and 50 tools within the Telegram byte budget", () => {
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
  assert.ok(
    Buffer.byteLength(md, "utf8") <= TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_BYTES,
    "Markdown must stay within the Telegram byte budget, got " + Buffer.byteLength(md, "utf8"),
  );
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

test("Progress tail runtime: a change during an in-flight edit still reaches Telegram", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const now = 10_000;
  let releaseFirstEdit: (() => void) | undefined;
  const firstEditStarted = Promise.withResolvers<void>();
  const throttleMs = 20;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => throttleMs,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 500, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      if (edits.length === 2) {
        firstEditStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseFirstEdit = resolve;
        });
      }
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "first.ts" } }));
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "read", isError: false, result: "ok" }));
  await runtime.waitForIdle();
  runtime.accept(event("tool-end", { toolCallId: "1b", toolName: "grep", isError: false, result: "ok" }));
  await new Promise<void>((resolve) => setTimeout(resolve, throttleMs + 10));
  await firstEditStarted.promise;

  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "second.ts" } }));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  releaseFirstEdit?.();

  await runtime.waitForIdle();

  assert.equal(sends.length, 1, "one live bubble");
  assert.ok(
    (edits.at(-1)?.rich_message?.markdown ?? "").includes("second.ts"),
    "a state change made during an in-flight edit must still reach the bubble",
  );
});

test("Progress tail runtime: unchanged state does not re-edit the bubble", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 501, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  const editsAfterFirst = edits.length;

  runtime.accept(event("reasoning-delta", { delta: "" }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1);
  assert.equal(edits.length, editsAfterFirst, "identical rendered state must not issue another edit");
});

test("Progress tail runtime: repeated edit failures roll over to a fresh bubble", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const failures: string[] = [];
  let editAttempts = 0;
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 600 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText() {
      editAttempts += 1;
      throw new Error("message to edit not found");
    },
    recordFailure(operation) {
      failures.push(operation);
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "first bubble created");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    now += 1_000;
    runtime.accept(
      event("tool-start", {
        toolCallId: "t" + attempt,
        toolName: "read",
        args: { path: "f" + attempt + ".ts" },
      }),
    );
    await runtime.waitForIdle();
  }

  assert.equal(editAttempts, 3, "gives up on the dead message after the failure budget");
  assert.ok(failures.every((operation) => operation === "tail-edit"));

  now += 1_000;
  runtime.accept(event("tool-start", { toolCallId: "9", toolName: "write", args: { path: "z.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 2, "an unreachable bubble is replaced instead of going silent");
});

test("Progress tail runtime: re-homes the live bubble when the delivery target moves mid-activity", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let current: { chatId: number; threadId?: number } = { chatId: 77 };
  const now = 10_000;

  const runtime = createTelegramProgressTailRuntime<{ chatId: number }>({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: () => ({ ...current }),
    captureAuthority: () => ({ chatId: current.chatId }),
    isAuthorityActive: (authority) => authority.chatId === current.chatId,
    async sendRichMessage(body) {
      sends.push(body);
      return {
        message_id: 900 + sends.length,
        date: 1,
        chat: { id: current.chatId, type: "private" },
      };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "pre.ts" } }));
  await runtime.waitForIdle();
  assert.deepEqual(sends.map((s) => s.chat_id), [77], "first bubble lands in the bound chat");

  current = { chatId: -1009999, threadId: 5 };

  runtime.accept(event("tool-start", { toolCallId: "2", toolName: "write", args: { path: "after.ts" } }));
  runtime.accept(event("tool-end", { toolCallId: "2", toolName: "write", isError: false, result: "ok" }));
  await runtime.waitForIdle();

  assert.deepEqual(
    sends.map((s) => s.chat_id),
    [77, -1009999],
    "a moved delivery target gets its own live bubble instead of silence",
  );
  assert.equal(
    sends.at(-1)?.message_thread_id,
    5,
    "the new bubble is posted into the bound thread",
  );
  assert.ok(
    edits.every((e) => e.chat_id === -1009999),
    "the abandoned bubble in the old chat is never edited again",
  );
  assert.ok(
    (sends.at(-1)?.rich_message?.markdown ?? "").includes("after.ts"),
    "the re-homed bubble carries the accumulated turn state",
  );
});

test("Progress tail runtime: honors a publish interval changed after construction", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;
  let intervalMs = 60_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => intervalMs,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 950, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1);

  intervalMs = 0;
  now += 10;
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "read", isError: false, result: "ok" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  assert.ok(
    edits.some((e) => (e.rich_message?.markdown ?? "").includes("1 completed")),
    "a live interval change must take effect without restarting the session",
  );
  await runtime.waitForIdle();
});

test("isCommandInvocationPrompt keeps slash commands out of the prompt line", () => {
  assert.equal(isCommandInvocationPrompt("/reload-plugins"), true);
  assert.equal(isCommandInvocationPrompt("  /model gpt-5.6  "), true);
  assert.equal(isCommandInvocationPrompt("[telegram] /telegram-settings"), true);
  assert.equal(isCommandInvocationPrompt("/ is a slash"), false);
  assert.equal(isCommandInvocationPrompt("tolong cek /tmp/x.log"), false);
  assert.equal(isCommandInvocationPrompt("cek path /usr/bin"), false);
});

test("Progress tail runtime: a slash command never replaces the visible prompt", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 970, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("agent-start", { promptText: "tolong rapikan dokumen rilis" }));
  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  assert.ok((sends[0]?.rich_message?.markdown ?? "").includes("tolong rapikan dokumen rilis"));

  runtime.accept(event("prompt-update", { promptText: "/reload-plugins" }));
  runtime.accept(event("tool-end", { toolCallId: "1", toolName: "read", isError: false, result: "ok" }));
  await runtime.waitForIdle();

  const latest = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.equal(latest.includes("/reload-plugins"), false, "a command invocation is not a prompt");
  assert.ok(latest.includes("tolong rapikan dokumen rilis"), "the real prompt survives the command");
});

test("Progress tail runtime: settled todos drop out of the table after the retention window", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 980, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  const todoResult = (statuses: Array<[string, string]>) =>
    JSON.stringify({
      details: {
        items: statuses.map(([task, status]) => ({ task, status })),
      },
    });

  runtime.accept(
    event("tool-end", {
      toolCallId: "todo-1",
      toolName: "todo",
      isError: false,
      result: todoResult([
        ["Diagnosa tabrakan intake", "completed"],
        ["Sapu galat log", "in_progress"],
      ]),
    }),
  );
  await runtime.waitForIdle();
  const first = sends.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(first.includes("| ✓ | Diagnosa tabrakan intake |"), "a freshly completed task stays visible");
  assert.ok(first.includes("## 📋 Todo (1/2)"), "the header counts every task, hidden or not");

  now += TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS + 1;
  runtime.accept(event("tool-start", { toolCallId: "t2", toolName: "read", args: { path: "b.ts" } }));
  await runtime.waitForIdle();

  const later = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.equal(
    later.includes("| ✓ | Diagnosa tabrakan intake |"),
    false,
    "a task settled longer than the retention window disappears",
  );
  assert.ok(later.includes("| ⟳ | Sapu galat log |"), "unfinished work stays visible");
  assert.ok(later.includes("## 📋 Todo (1/2)"), "the header still reports total progress");
});

test("Progress tail runtime: the todo section disappears once every task has aged out", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 990, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(
    event("tool-end", {
      toolCallId: "todo-1",
      toolName: "todo",
      isError: false,
      result: JSON.stringify({
        details: { items: [{ task: "Rilis versi baru", status: "completed" }] },
      }),
    }),
  );
  await runtime.waitForIdle();
  assert.ok((sends.at(-1)?.rich_message?.markdown ?? "").includes("| ✓ | Rilis versi baru |"));

  now += TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS + 1;
  runtime.accept(event("tool-start", { toolCallId: "t2", toolName: "read", args: { path: "b.ts" } }));
  await runtime.waitForIdle();

  const later = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.equal(later.includes("## 📋 Todo"), false, "an all-settled todo list stops occupying the bubble");
});

test("TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS is 10000ms", () => {
  assert.equal(TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS, 10_000);
});

test("Progress tail runtime: 429 rate limits do not discard liveMessage and back off by retryAfterSeconds", async () => {
  const sends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  let now = 10_000;
  let throwRateLimit = false;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getNowMs: () => now,
    getIntervalMs: () => 1_000,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage(body) {
      sends.push(body);
      return { message_id: 1000 + sends.length, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      if (throwRateLimit) {
        throw new TelegramApiHttpError("Too Many Requests: retry after 8", 429, 8);
      }
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  assert.equal(sends.length, 1, "first bubble created");

  throwRateLimit = true;
  for (let i = 0; i < 5; i += 1) {
    now += 500;
    runtime.accept(event("tool-start", { toolCallId: "t" + i, toolName: "read", args: { path: "f" + i + ".ts" } }));
    await runtime.waitForIdle();
  }

  assert.equal(
    sends.length,
    1,
    "429 rate limits must not discard liveMessage or spam new bubbles",
  );

  throwRateLimit = false;
  now += 8_000;
  runtime.accept(event("tool-start", { toolCallId: "after-limit", toolName: "write", args: { path: "resumed.ts" } }));
  await runtime.waitForIdle();

  assert.equal(sends.length, 1, "continues editing the same bubble after rate limit clears");
  assert.ok(
    (edits.at(-1)?.rich_message?.markdown ?? "").includes("resumed.ts"),
    "updated content reaches the existing bubble",
  );
});

test("Progress tail runtime: releasing old tool results keeps every visible result intact", async () => {
  const edits: TelegramEditMessageTextBody[] = [];
  const extra = 3;
  const total = TELEGRAM_PROGRESS_TAIL_MAX_TOOLS + extra;

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage() {
      return { message_id: 900, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  for (let index = 1; index <= total; index += 1) {
    runtime.accept(
      event("tool-start", { toolCallId: String(index), toolName: `tool${index}`, args: {} }),
    );
    runtime.accept(
      event("tool-end", {
        toolCallId: String(index),
        toolName: `tool${index}`,
        isError: false,
        result: `payload-${index}`,
      }),
    );
    await runtime.waitForIdle();
  }

  const markdown = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(markdown.includes(`… [${extra} earlier tools omitted]`));
  const oldestVisible = extra + 1;
  assert.ok(
    markdown.includes(`Result: tool${oldestVisible} · tap to expand`),
    "the oldest visible tool must keep its result",
  );
  assert.ok(markdown.includes(`payload-${oldestVisible}`));
  assert.ok(markdown.includes(`payload-${total}`));
  assert.equal(
    markdown.includes(`Result: tool${extra} · tap to expand`),
    false,
    "released results stay out of the rendered card",
  );
});

test("Progress tail runtime: streamed reasoning deltas still render as lines", async () => {
  const edits: TelegramEditMessageTextBody[] = [];

  const runtime = createTelegramProgressTailRuntime({
    getActivityMode: () => "verbose",
    getIntervalMs: () => 0,
    resolveTarget: (e) => e.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendRichMessage() {
      return { message_id: 901, date: 1, chat: { id: 42, type: "private" } };
    },
    async sendMessage() {
      throw new Error("unexpected call");
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });

  runtime.accept(event("tool-start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }));
  await runtime.waitForIdle();
  for (const delta of ["Checking ", "the parser.", "\n\n", "Then the ", "renderer."]) {
    runtime.accept(event("reasoning-delta", { contentIndex: 0, delta }));
    await runtime.waitForIdle();
  }

  const markdown = edits.at(-1)?.rich_message?.markdown ?? "";
  assert.ok(markdown.includes("Checking the parser."));
  assert.ok(markdown.includes("Then the renderer."));
});

