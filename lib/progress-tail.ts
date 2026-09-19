/**
 * Telegram live progress tail rendering and throttling engine
 * Zones: telegram activity, live progress tail, rich rendering
 * Owns single-bubble live progress updates, lazy triggering, roll-over on intermediate commentary, finalization summaries, and rate-limited Telegram edits
 */

import type { TelegramActivityContextInfo, TelegramActivityEvent, TelegramActivityPublicationRuntime } from "./activity.ts";

import type { TelegramTarget } from "./target.ts";
import {
  TelegramApiHttpError,
  type TelegramApiCallOptions,
  type TelegramEditMessageTextBody,
  type TelegramSendMessageBody,
  type TelegramSendRichMessageBody,
  type TelegramSentMessage,
} from "./telegram-api.ts";

export const TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS = 10_000;
export const TELEGRAM_PROGRESS_TAIL_MAX_TOOLS = 10;
export const TELEGRAM_PROGRESS_TAIL_MAX_REASONING_LINES = 14;
export const TELEGRAM_PROGRESS_TAIL_MAX_TOOL_ARG_CHARS = 200;
export const TELEGRAM_PROGRESS_TAIL_MAX_TOOL_RESULT_CHARS = 600;
export const TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_BYTES = 8_000;
export const TELEGRAM_PROGRESS_TAIL_MAX_PROMPT_CHARS = 600;
export const TELEGRAM_PROGRESS_TAIL_MAX_TODO_ROWS = 20;
export const TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS = 60_000;
export const TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS = 6_000;
export const TELEGRAM_PROGRESS_TAIL_MAX_PUBLISH_FAILURES = 3;

export type ProgressTailStatus = "working" | "completed" | "cancelled" | "failed";

export interface ProgressTailToolItem {
  id: string;
  name: string;
  args: string;
  resultSummary?: string;
  status: "running" | "completed" | "failed" | "waiting";
  askStatus?: "waiting" | "answered_telegram" | "answered_cli";
  isError?: boolean;
}

export interface ProgressTailTodoItem {
  task: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  settledAtMs?: number;
}

export type ProgressTailContextInfo = TelegramActivityContextInfo;

export interface ProgressTailState {
  status: ProgressTailStatus;
  startedAtMs: number;
  completedAtMs?: number;
  modelName?: string;
  userPrompt?: string;
  contextInfo?: ProgressTailContextInfo;
  reasoningBuffer?: string;
  reasoningLines: string[];
  tools: ProgressTailToolItem[];
  todoItems: ProgressTailTodoItem[];
  errorMessage?: string;
  nowMs?: number;
}

export interface TelegramProgressTailRuntimeDeps<TAuthority> {
  enqueue?: TelegramActivityPublicationRuntime["enqueue"];
  getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose";
  refreshActivityMode?: () => Promise<void>;
  getNowMs?: () => number;
  resolveTarget: (event: TelegramActivityEvent) => TelegramTarget | undefined;
  captureAuthority: () => TAuthority;
  isAuthorityActive: (authority: TAuthority) => boolean;
  sendMessage: (body: TelegramSendMessageBody) => Promise<TelegramSentMessage>;
  sendRichMessage?: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
  editMessageText: (
    body: TelegramEditMessageTextBody,
    options?: TelegramApiCallOptions,
  ) => Promise<"edited" | "unchanged">;
  getModelName?: () => string | undefined;
  getContextInfo?: () => ProgressTailContextInfo | undefined;
  getIntervalMs?: () => number;
  recordFailure?: (
    operation: "config-refresh" | "tail-send" | "tail-edit",
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
}

export interface TelegramProgressTailRuntime {
  accept: (event: TelegramActivityEvent) => void;
  reset: () => void;
  stop: () => void;
  waitForIdle: () => Promise<void>;
}

export function extractShortToolArgs(
  toolName: string,
  rawArgs: unknown,
  maxChars = TELEGRAM_PROGRESS_TAIL_MAX_TOOL_ARG_CHARS,
): string {
  if (rawArgs === undefined || rawArgs === null) return "";
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.replace(/\s+/g, " ").trim();
    if (!trimmed) return "";
    try {
      return extractShortToolArgs(toolName, JSON.parse(trimmed), maxChars);
    } catch {
      return trimmed.slice(0, maxChars);
    }
  }
  if (typeof rawArgs !== "object") return String(rawArgs).slice(0, maxChars);
  if (Array.isArray(rawArgs)) {
    return `[${rawArgs.length} items]`;
  }
  const args = rawArgs as Record<string, unknown>;
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    if (args.path) return String(args.path).slice(0, maxChars);
  }
  if (toolName === "glob") {
    const p = args.path ? String(args.path) : "";
    const pat = args.pattern ? String(args.pattern) : "";
    if (p && pat) return `${p} (${pat})`.slice(0, maxChars);
    if (p) return p.slice(0, maxChars);
    if (pat) return pat.slice(0, maxChars);
  }
  if (toolName === "grep") {
    const query = args.query ?? args.pattern;
    const p = args.path ? ` in ${args.path}` : "";
    if (query) return `${query}${p}`.slice(0, maxChars);
  }
  if (toolName === "bash") {
    const cmd = args.cmd ?? args.command;
    if (cmd) return String(cmd).replace(/\s+/g, " ").trim().slice(0, maxChars);
  }
  if (toolName === "fabric_exec") {
    if (typeof args.i === "string" && args.i.trim().length > 0) {
      return String(args.i).trim().slice(0, maxChars);
    }
    const display = args.display as { name?: unknown; description?: unknown } | undefined;
    if (typeof display?.name === "string" && display.name.trim().length > 0) {
      return String(display.name).trim().slice(0, maxChars);
    }
    if (typeof display?.description === "string" && display.description.trim().length > 0) {
      return String(display.description).trim().slice(0, maxChars);
    }
    if (args.code) {
      return String(args.code).replace(/\s+/g, " ").trim().slice(0, maxChars);
    }
  }
  if (toolName === "ast_grep") {
    const pat = args.pat ? String(args.pat) : "";
    const p = args.path ? ` in ${args.path}` : "";
    if (pat) return `${pat}${p}`.replace(/\s+/g, " ").trim().slice(0, maxChars);
  }
  if (toolName === "ast_edit") {
    if (args.paths) return String(args.paths).slice(0, maxChars);
  }
  if (toolName === "ask") {
    if (Array.isArray(args.questions)) return `${args.questions.length} question(s)`;
  }
  if (toolName === "todo") {
    if (args.task) return `${args.task}`.slice(0, maxChars);
    if (args.op) return `${args.op}`.slice(0, maxChars);
  }
  const candidateKeys = ["path", "cmd", "command", "query", "pattern", "task", "url", "file", "name", "id", "code"];
  for (const key of candidateKeys) {
    if (args[key] !== undefined && typeof args[key] !== "object") {
      return `${String(args[key])}`.replace(/\s+/g, " ").trim().slice(0, maxChars);
    }
  }
  const entries = Object.entries(args).filter(([, v]) => typeof v !== "object" && v !== undefined);
  if (entries.length > 0) {
    return entries.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ").slice(0, maxChars);
  }
  return "";
}

export function isCommandInvocationPrompt(raw: string): boolean {
  return /^\s*\/[A-Za-z0-9][\w-]*(\s|$)/.test(
    raw.trim().replace(/^\[telegram(?:\|[^\]]+)?\]\s*/i, "").trim(),
  );
}

export function cleanUserPrompt(
  raw: string,
  maxChars = TELEGRAM_PROGRESS_TAIL_MAX_PROMPT_CHARS,
): string {
  if (!raw) return "";
  let text = raw.trim().replace(/^\[telegram(?:\|[^\]]+)?\]\s*/i, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "…";
  }
  return text;
}

export function extractToolResultSummary(
  _toolName: string,
  rawResult: unknown,
  _isError = false,
  maxChars = TELEGRAM_PROGRESS_TAIL_MAX_TOOL_RESULT_CHARS,
): string {
  if (rawResult === undefined || rawResult === null) return "";
  let text = "";
  if (typeof rawResult === "string") {
    text = rawResult.trim();
  } else if (typeof rawResult === "object") {
    const obj = rawResult as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      const parts = obj.content
        .filter((c: any) => c && typeof c === "object" && typeof c.text === "string")
        .map((c: any) => c.text.trim());
      if (parts.length > 0) {
        text = parts.join("\n");
      }
    }
    if (!text && typeof obj.output === "string") {
      text = obj.output.trim();
    }
    if (!text && typeof obj.message === "string") {
      text = obj.message.trim();
    }
    if (!text && typeof obj.error === "string") {
      text = obj.error.trim();
    }
    if (!text) {
      try {
        text = JSON.stringify(obj, null, 2);
      } catch {
        text = String(rawResult);
      }
    }
  } else {
    text = String(rawResult);
  }

  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return "";

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n… [truncated]";
  }
  return text;
}

export function truncateTailText(text: string, limit: number): string {
  const value = String(text ?? "").trim();
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit <= 4) return ".".repeat(limit);

  const budget = limit - 2;
  const start = Math.max(0, value.length - budget);
  let tail = value.slice(start).trimStart();

  if (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    const firstSpace = tail.search(/\s/);
    if (firstSpace >= 0) {
      tail = tail.slice(firstSpace + 1).trimStart();
    }
  }

  const sentenceMatch = tail.slice(0, 60).match(/(?:[.\?!]\s+|\n+)([A-Z0-9"'`].*)/s);
  if (sentenceMatch && sentenceMatch.index !== undefined && sentenceMatch[1]) {
    if (sentenceMatch.index < 40 && tail.length - sentenceMatch.index > budget * 0.4) {
      tail = sentenceMatch[1].trimStart();
    }
  }

  return `… ${tail || value.slice(-budget).trimStart()}`;
}

export function renderReasoningSectionRich(
  rawText: string,
  latestParagraphsCount = 2,
  maxHistoryParagraphs = 5,
  maxChars = 4_000,
): string {
  if (!rawText) return "";
  const cleaned = rawText
    .replace(/<\/?(?:think|thinking|thought|reasoning)\b[^>]*>/gi, "")
    .replace(/<\|(?:begin|end)_of_thought\|>/gi, "")
    .replace(/◁\/?think▷/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!cleaned) return "";

  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";

  const latest = paragraphs.slice(-latestParagraphsCount);
  const earlier = paragraphs.slice(0, -latestParagraphsCount);

  const parts: string[] = [];

  if (earlier.length > 0) {
    const visibleEarlier = earlier.slice(-maxHistoryParagraphs);
    const omitted = earlier.length - visibleEarlier.length;
    const earlierLines: string[] = [];
    if (omitted > 0) {
      earlierLines.push(`… [${omitted} earlier thought(s) omitted]`);
    }
    earlierLines.push(...visibleEarlier);
    const earlierText = earlierLines.join("\n\n");
    parts.push(`<details>\n<summary>Earlier thoughts · tap to expand</summary>\n\n${earlierText}\n\n</details>`);
  }

  let latestText = latest.join("\n\n");
  if (latestText.length > maxChars) {
    latestText = truncateTailText(latestText, maxChars);
  }
  parts.push(latestText);

  return `## 💭 Reasoning\n\n${parts.join("\n\n")}`;
}

export const renderReasoningSectionHtml = renderReasoningSectionRich;

export function extractReasoningTail(
  rawText: string,
  maxParagraphs = 3,
  maxChars = 1_200,
): string {
  if (!rawText) return "";
  const cleaned = rawText
    .replace(/<\/?(?:think|thinking|thought|reasoning)\b[^>]*>/gi, "")
    .replace(/<\|(?:begin|end)_of_thought\|>/gi, "")
    .replace(/◁\/?think▷/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!cleaned) return "";

  const paragraphs = cleaned
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";

  const selected: string[] = [];
  let usedChars = 0;

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]!;
    if (selected.length >= maxParagraphs) break;
    if (selected.length > 0 && usedChars + p.length > maxChars) break;
    selected.unshift(p);
    usedChars += p.length + 2;
  }

  let result = selected.join("\n\n");
  if (result.length > maxChars) {
    result = truncateTailText(result, maxChars);
  }

  if (paragraphs.length > selected.length) {
    result = `… [${paragraphs.length - selected.length} earlier paragraph(s) omitted]\n\n${result}`;
  }

  return result;
}

export function formatProgressTailRich(state: ProgressTailState): string {
  const nowMs = state.nowMs ?? Date.now();
  const buildSections = (
    includeOlderToolResults: boolean,
    includeLatestToolResult: boolean,
    reasoningMaxChars: number,
    promptMaxChars: number,
  ) => {
    const sections: string[] = [];
    const endMs = state.completedAtMs ?? nowMs;
    const elapsedSec = Math.max(0.1, (endMs - state.startedAtMs) / 1000).toFixed(1);

    let statusLine = "";
    if (state.status === "working") {
      statusLine = `⏳ **Working...** (${elapsedSec}s)`;
    } else if (state.status === "completed") {
      statusLine = `✅ **Completed** in ${elapsedSec}s · ${state.tools.length} tools`;
    } else if (state.status === "cancelled") {
      statusLine = `⏹ **Cancelled** after ${elapsedSec}s · ${state.tools.length} tools`;
    } else {
      const errText = state.errorMessage ? `: ${state.errorMessage}` : "";
      statusLine = `⚠️ **Failed** after ${elapsedSec}s${errText}`;
    }

    const effectiveContextInfo = state.contextInfo ?? (state.modelName ? { modelName: state.modelName } : undefined);
    if (effectiveContextInfo) {
      const info = effectiveContextInfo;
      const contextRows: Array<[string, string]> = [];
      if (info.cwd) {
        let cwdText = "`" + info.cwd + "`";
        if (info.gitBranch) {
          cwdText += " (🌿 `" + info.gitBranch + "`" + (info.gitDirty ? " _[dirty]_" : "") + ")";
        }
        contextRows.push(["📂 CWD", cwdText]);
      }
      if (info.sessionTitle) {
        contextRows.push(["🏷️ Title", info.sessionTitle]);
      }
      const modelDisplay = info.modelName ?? state.modelName;
      if (modelDisplay) {
        contextRows.push(["🤖 Model", modelDisplay]);
      }
      if (typeof info.contextUsagePercent === "number") {
        let usageText = `${info.contextUsagePercent.toFixed(1)}%`;
        if (info.contextWindow) {
          const kTokens = info.contextWindow >= 1_000_000
            ? `${(info.contextWindow / 1_000_000).toFixed(1)}M`
            : `${Math.round(info.contextWindow / 1000)}k`;
          usageText += ` of ${kTokens} tokens`;
        }
        contextRows.push(["📊 Usage", usageText]);
      }
      if (contextRows.length > 0) {
        const lines = [
          "| Context | Detail |",
          "|:--------|:-------|",
        ];
        for (const [k, v] of contextRows) {
          lines.push(`| ${k} | ${v} |`);
        }
        sections.push(lines.join("\n"));
      }
    }

    if (state.userPrompt) {
      const promptText =
        state.userPrompt.length > promptMaxChars
          ? `${state.userPrompt.slice(0, promptMaxChars)}…`
          : state.userPrompt;
      sections.push(`## 👤 Prompt\n\n_${promptText}_`);
    }

    const rawReasoning = state.reasoningBuffer || state.reasoningLines.join("\n");
    const reasoningSection = renderReasoningSectionRich(rawReasoning, 2, 5, reasoningMaxChars);
    if (reasoningSection.length > 0) {
      sections.push(reasoningSection);
    }

    const visibleTodoItems = state.todoItems.filter(
      (item) =>
        item.settledAtMs === undefined ||
        nowMs - item.settledAtMs < TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS,
    );
    if (visibleTodoItems.length > 0) {
      const doneCount = state.todoItems.filter((t) => t.status === "completed").length;
      const header = `## 📋 Todo (${doneCount}/${state.todoItems.length})`;
      const tableLines: string[] = [
        "| St | Task |",
        "|:---|:-----|",
      ];
      const rows = visibleTodoItems.slice(-TELEGRAM_PROGRESS_TAIL_MAX_TODO_ROWS);
      for (const item of rows) {
        const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "⟳" : item.status === "cancelled" ? "-" : " ";
        const safeTask = item.task.replace(/\|/g, "\\|").replace(/\n/g, " ");
        tableLines.push(`| ${marker} | ${safeTask} |`);
      }
      let todoBlock = `${header}\n\n${tableLines.join("\n")}`;
      const hidden = state.todoItems.length - rows.length;
      if (hidden > 0) {
        const overflowed = visibleTodoItems.length - rows.length;
        todoBlock +=
          overflowed > 0
            ? `\n\n_… [${hidden} more tasks]_`
            : `\n\n_… [${hidden} settled tasks hidden]_`;
      }
      sections.push(todoBlock);
    }

    if (state.tools.length > 0) {
      const completed = state.tools.filter((t) => t.status === "completed" || t.status === "failed");
      const running = state.tools.filter((t) => t.status === "running" || t.status === "waiting");
      const header = `## 🧰 Tools (${completed.length} completed${running.length > 0 ? `, ${running.length} running` : ""})`;

      const tableRows: Array<[string, string, string]> = [];
      const visibleCompleted = completed.slice(-TELEGRAM_PROGRESS_TAIL_MAX_TOOLS);
      for (const tool of visibleCompleted) {
        let statusMarker = tool.status === "failed" ? "✗" : "✓";
        if (tool.name === "ask") {
          if (tool.askStatus === "answered_telegram") statusMarker = "✓ (Tele)";
          else if (tool.askStatus === "answered_cli") statusMarker = "✓ (CLI)";
        }
        tableRows.push([statusMarker, tool.name, tool.args || "-"]);
      }
      for (const tool of running) {
        const marker = tool.name === "ask" ? "⏳" : "⟳";
        tableRows.push([marker, tool.name, tool.args || (tool.name === "ask" ? "Waiting user" : "-")]);
      }

      const tableLines: string[] = [
        "| St | Tool | Arguments |",
        "|:---|:-----|:----------|",
      ];
      for (const [st, name, args] of tableRows) {
        const safeArgs = args.replace(/\|/g, "\\|").replace(/\n/g, " ");
        tableLines.push(`| ${st} | ${name} | ${safeArgs} |`);
      }

      const detailResults: string[] = [];
      for (let i = 0; i < visibleCompleted.length; i++) {
        const tool = visibleCompleted[i]!;
        const isNewest = i === visibleCompleted.length - 1;
        const allowResult = includeLatestToolResult && (includeOlderToolResults || isNewest);
        if (allowResult && tool.resultSummary && tool.resultSummary.trim().length > 0) {
          detailResults.push(`<details>\n<summary>Result: ${tool.name} · tap to expand</summary>\n\n\`\`\`\n${tool.resultSummary}\n\`\`\`\n\n</details>`);
        }
      }

      let toolsBlock = `${header}\n\n${tableLines.join("\n")}`;
      if (completed.length > TELEGRAM_PROGRESS_TAIL_MAX_TOOLS) {
        toolsBlock += `\n\n_… [${completed.length - TELEGRAM_PROGRESS_TAIL_MAX_TOOLS} earlier tools omitted]_`;
      }
      if (detailResults.length > 0) {
        toolsBlock += `\n\n${detailResults.join("\n\n")}`;
      }
      sections.push(toolsBlock);
    }

    if (statusLine) {
      sections.push(statusLine);
    }

    return sections.join("\n\n");
  };

  const fits = (candidate: string): boolean =>
    Buffer.byteLength(candidate, "utf8") <= TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_BYTES;
  const ladder: Array<[boolean, boolean, number, number]> = [
    [true, true, 5_000, TELEGRAM_PROGRESS_TAIL_MAX_PROMPT_CHARS],
    [true, true, 3_500, 400],
    [false, true, 2_500, 280],
    [false, false, 1_500, 200],
    [false, false, 800, 140],
  ];
  let body = buildSections(...ladder[0]!);
  for (let step = 1; step < ladder.length && !fits(body); step += 1) {
    body = buildSections(...ladder[step]!);
  }
  return body;
}

export const formatProgressTailHtml = formatProgressTailRich;

export function createTelegramProgressTailRuntime<TAuthority>(
  deps: TelegramProgressTailRuntimeDeps<TAuthority>,
): TelegramProgressTailRuntime {
  let active = true;
  let generation = 0;
  let tail = Promise.resolve();
  const getNowMs = deps.getNowMs ?? Date.now;
  const resolveIntervalMs = (): number => {
    const configured = deps.getIntervalMs?.();
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS;
  };

  let activityId: string | undefined;
  let authority: TAuthority | undefined;
  let target: TelegramTarget | undefined;

  let liveMessage: { messageId: number; target: TelegramTarget } | undefined;
  let startedAtMs = 0;
  let completedAtMs: number | undefined;
  let userPrompt: string | undefined;
  let activeContextInfo: ProgressTailContextInfo | undefined;
  let status: ProgressTailStatus = "working";
  let reasoningBuffer = "";
  const runningTools = new Map<string, ProgressTailToolItem>();
  const completedTools: ProgressTailToolItem[] = [];
  const todoItems: ProgressTailTodoItem[] = [];
  const activeContainers = new Map<string, { id: string; name: string; childToolCount: number }>();

  let timer: NodeJS.Timeout | undefined;
  let todoExpiryTimer: NodeJS.Timeout | undefined;
  let lastPublishMs = 0;
  let dirty = false;
  let lastPublishedMarkdown: string | undefined;
  let consecutivePublishFailures = 0;
  let publishChain: Promise<void> = Promise.resolve();

  const hasAuthority = (): boolean =>
    authority !== undefined && deps.isAuthorityActive(authority);

  const isCurrent = (acceptedGeneration: number, admittedAuthority: TAuthority | undefined): boolean =>
    active && generation === acceptedGeneration && admittedAuthority !== undefined && deps.isAuthorityActive(admittedAuthority);

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const clearTodoExpiryTimer = (): void => {
    if (todoExpiryTimer !== undefined) {
      clearTimeout(todoExpiryTimer);
      todoExpiryTimer = undefined;
    }
  };

  const scheduleTodoExpiryRefresh = (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
  ): void => {
    clearTodoExpiryTimer();
    const now = getNowMs();
    const pending = todoItems
      .map((item) => item.settledAtMs)
      .filter(
        (settledAtMs): settledAtMs is number =>
          typeof settledAtMs === "number" &&
          now - settledAtMs < TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS,
      );
    if (pending.length === 0) return;
    const delay = Math.max(
      1,
      Math.min(...pending) + TELEGRAM_PROGRESS_TAIL_TODO_RETENTION_MS - now,
    );
    todoExpiryTimer = setTimeout(() => {
      todoExpiryTimer = undefined;
      if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
      void enqueuePublish(acceptedGeneration, admittedAuthority);
      scheduleTodoExpiryRefresh(acceptedGeneration, admittedAuthority);
    }, delay);
    todoExpiryTimer?.unref?.();
  };

  const clearSegment = (): void => {
    clearTimer();
    clearTodoExpiryTimer();
    liveMessage = undefined;
    startedAtMs = getNowMs();
    completedAtMs = undefined;
    status = "working";
    reasoningBuffer = "";
    runningTools.clear();
    completedTools.length = 0;
    activeContainers.clear();
    lastPublishMs = 0;
    dirty = false;
    lastPublishedMarkdown = undefined;
    consecutivePublishFailures = 0;
  };

  const clearAll = (): void => {
    clearSegment();
    activityId = undefined;
    authority = undefined;
    target = undefined;
    userPrompt = undefined;
    activeContextInfo = undefined;
  };

  const shouldAdoptTarget = (
    current: TelegramTarget | undefined,
    next: TelegramTarget | undefined,
  ): boolean => {
    if (!next) return false;
    if (!current) return false;
    if (current.chatId !== next.chatId) return true;
    if (next.threadId === undefined) return false;
    return current.threadId !== next.threadId;
  };

  const ensureActivity = (
    event: TelegramActivityEvent,
    admittedTarget: TelegramTarget | undefined,
    admittedAuthority: TAuthority,
  ): boolean => {
    if (deps.getActivityMode() === "quiet") return false;
    if (activityId === event.activityId) {
      if (shouldAdoptTarget(target, admittedTarget) && admittedTarget) {
        const staleBubble =
          liveMessage !== undefined &&
          (liveMessage.target.chatId !== admittedTarget.chatId ||
            liveMessage.target.threadId !== admittedTarget.threadId);
        target = admittedTarget;
        authority = admittedAuthority;
        if (staleBubble) {
          clearTimer();
          liveMessage = undefined;
          lastPublishedMarkdown = undefined;
          consecutivePublishFailures = 0;
          lastPublishMs = 0;
          dirty = true;
        }
      }
      return hasAuthority();
    }
    clearAll();
    if (!admittedTarget) return false;
    activityId = event.activityId;
    target = admittedTarget;
    authority = admittedAuthority;
    startedAtMs = getNowMs();
    return hasAuthority();
  };

  const deriveReasoningLines = (): string[] =>
    reasoningBuffer.length === 0
      ? []
      : reasoningBuffer.split("\n").filter((line) => line.trim().length > 0);

  const buildCurrentState = (): ProgressTailState => {
    const visibleRunning: ProgressTailToolItem[] = [];
    for (const tool of runningTools.values()) {
      const container = activeContainers.get(tool.id);
      if (container && container.childToolCount > 0) {
        continue;
      }
      visibleRunning.push(tool);
    }
    const allTools = [...completedTools, ...visibleRunning];
    const effectiveContextInfo = deps.getContextInfo?.() ?? activeContextInfo;
    const effectiveModelName = effectiveContextInfo?.modelName ?? deps.getModelName?.();
    return {
      status,
      startedAtMs,
      completedAtMs,
      modelName: effectiveModelName,
      userPrompt,
      contextInfo: effectiveContextInfo,
      reasoningBuffer,
      reasoningLines: deriveReasoningLines(),
      tools: allTools,
      todoItems,
      nowMs: getNowMs(),
    };
  };

  const hasRealActivity = (): boolean =>
    runningTools.size > 0 ||
    completedTools.length > 0 ||
    reasoningBuffer.trim().length > 0 ||
    todoItems.length > 0;

  const canPublish = (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
  ): boolean =>
    isCurrent(acceptedGeneration, admittedAuthority) &&
    target !== undefined &&
    deps.getActivityMode() !== "quiet" &&
    (hasRealActivity() || liveMessage !== undefined);

  const deliverCurrentState = async (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
  ): Promise<void> => {
    if (!canPublish(acceptedGeneration, admittedAuthority) || !target) return;
    const markdown = formatProgressTailRich(buildCurrentState());
    if (liveMessage !== undefined && markdown === lastPublishedMarkdown) {
      dirty = false;
      return;
    }
    const creating = liveMessage === undefined;
    dirty = false;
    try {
      if (creating) {
        let sent: TelegramSentMessage;
        if (deps.sendRichMessage) {
          sent = await deps.sendRichMessage({
            chat_id: target.chatId,
            ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
            rich_message: { markdown },
          });
        } else {
          sent = await deps.sendMessage({
            chat_id: target.chatId,
            ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
            text: markdown,
            link_preview_options: { is_disabled: true },
          });
        }
        if (!isCurrent(acceptedGeneration, admittedAuthority) || !target) return;
        liveMessage = { messageId: sent.message_id, target: { ...target } };
      } else if (liveMessage) {
        await deps.editMessageText({
          chat_id: liveMessage.target.chatId,
          message_id: liveMessage.messageId,
          rich_message: { markdown },
        }, { retryRateLimit: false });
      }
      lastPublishedMarkdown = markdown;
      lastPublishMs = getNowMs();
      consecutivePublishFailures = 0;
    } catch (error) {
      const isRateLimit =
        error instanceof TelegramApiHttpError && error.status === 429;
      const retryAfterSeconds =
        (error as { retryAfterSeconds?: number })?.retryAfterSeconds;
      if (
        isRateLimit &&
        typeof retryAfterSeconds === "number" &&
        retryAfterSeconds > 0
      ) {
        lastPublishMs =
          getNowMs() + retryAfterSeconds * 1_000 - resolveIntervalMs();
      } else {
        lastPublishMs = getNowMs();
      }
      if (!isRateLimit) {
        consecutivePublishFailures += 1;
      }
      dirty = true;
      deps.recordFailure?.(
        creating ? "tail-send" : "tail-edit",
        { type: creating ? "tool-start" : "tool-end" } as TelegramActivityEvent,
        error,
      );
      if (consecutivePublishFailures >= TELEGRAM_PROGRESS_TAIL_MAX_PUBLISH_FAILURES) {
        consecutivePublishFailures = 0;
        lastPublishedMarkdown = undefined;
        if (creating) {
          dirty = false;
        } else {
          liveMessage = undefined;
        }
      }
    }
  };

  const scheduleDeferredPublish = (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
    delay: number,
  ): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!dirty || !isCurrent(acceptedGeneration, admittedAuthority)) return;
      void enqueuePublish(acceptedGeneration, admittedAuthority);
    }, delay);
    timer?.unref?.();
  };

  const enqueuePublish = (
    acceptedGeneration: number,
    admittedAuthority: TAuthority | undefined,
  ): Promise<void> => {
    publishChain = publishChain
      .then(() => deliverCurrentState(acceptedGeneration, admittedAuthority))
      .then(() => {
        if (!dirty || !isCurrent(acceptedGeneration, admittedAuthority)) return;
        scheduleDeferredPublish(
          acceptedGeneration,
          admittedAuthority,
          Math.max(0, resolveIntervalMs() - (getNowMs() - lastPublishMs)),
        );
      })
      .catch(() => undefined);
    return publishChain;
  };

  const publishToTelegram = async (
    acceptedGeneration: number,
    forceImmediate = false,
  ): Promise<void> => {
    const admittedAuthority = authority;
    if (!canPublish(acceptedGeneration, admittedAuthority)) return;
    dirty = true;
    if (forceImmediate) {
      clearTimer();
      await enqueuePublish(acceptedGeneration, admittedAuthority);
      return;
    }
    if (timer !== undefined) return;
    const delay = Math.max(0, resolveIntervalMs() - (getNowMs() - lastPublishMs));
    if (delay <= 0) {
      await enqueuePublish(acceptedGeneration, admittedAuthority);
      return;
    }
    scheduleDeferredPublish(acceptedGeneration, admittedAuthority, delay);
  };

  const process = async (
    event: TelegramActivityEvent,
    acceptedGeneration: number,
    admittedTarget: TelegramTarget | undefined,
    admittedAuthority: TAuthority,
  ) => {
    if (event.type === "agent-start" && deps.refreshActivityMode) {
      try {
        await deps.refreshActivityMode();
      } catch (error) {
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        clearAll();
        activityId = event.activityId;
        deps.recordFailure?.("config-refresh", event, error);
        return;
      }
    }
    if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
    if (!ensureActivity(event, admittedTarget, admittedAuthority)) {
      if (activityId === event.activityId && deps.getActivityMode() === "quiet") {
        clearAll();
      }
      return;
    }

    const mode = deps.getActivityMode();
    const showThinking = mode === "thinking" || mode === "verbose";
    const showTools = mode === "tools" || mode === "verbose";

    if (event.type === "agent-start") {
      if (status === "completed") {
        clearSegment();
      }
      if (startedAtMs === 0) {
        startedAtMs = getNowMs();
      }
      status = "working";
      if (event.promptText && !isCommandInvocationPrompt(event.promptText)) {
        userPrompt = cleanUserPrompt(event.promptText);
      }
      if (event.contextInfo) {
        activeContextInfo = event.contextInfo;
      }
      return;
    }

    if (event.type === "prompt-update") {
      if (event.promptText && !isCommandInvocationPrompt(event.promptText)) {
        userPrompt = cleanUserPrompt(event.promptText);
        await publishToTelegram(acceptedGeneration, false);
      }
      return;
    }

    if (event.type === "reasoning-delta") {
      if (!showThinking) return;
      reasoningBuffer = `${reasoningBuffer}${event.delta}`.slice(-TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS);
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "reasoning-end") {
      if (!showThinking) return;
      if (event.text && reasoningBuffer.length === 0) {
        reasoningBuffer = event.text.slice(-TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS);
      }
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "tool-start") {
      if (!showTools) return;
      const isAsk = event.toolName === "ask";
      const isContainer = event.toolName === "fabric_exec";

      if (isContainer) {
        activeContainers.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          childToolCount: 0,
        });
      } else if (activeContainers.size > 0) {
        for (const container of activeContainers.values()) {
          container.childToolCount++;
        }
      }

      runningTools.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: extractShortToolArgs(event.toolName, event.args),
        status: isAsk ? "waiting" : "running",
        askStatus: isAsk ? "waiting" : undefined,
      });
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "tool-update") {
      if (!showTools) return;
      const existing = runningTools.get(event.toolCallId);
      if (existing && existing.name === "ask") {
        const updateStr = JSON.stringify(event.update ?? "");
        if (updateStr.includes("telegram")) {
          existing.askStatus = "answered_telegram";
        } else if (updateStr.includes("cli")) {
          existing.askStatus = "answered_cli";
        }
      }
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "tool-end") {
      if (!showTools) return;
      const existing = runningTools.get(event.toolCallId);
      runningTools.delete(event.toolCallId);

      const container = activeContainers.get(event.toolCallId);
      if (container !== undefined) {
        activeContainers.delete(event.toolCallId);
        if (container.childToolCount > 0 && !event.isError) {
          await publishToTelegram(acceptedGeneration, false);
          return;
        }
      }
      let askStatus = existing?.askStatus;
      if (event.toolName === "ask") {
        const resStr = JSON.stringify(event.result ?? "");
        if (resStr.includes('"answeredVia":"telegram"') || resStr.includes("Answered via Telegram")) {
          askStatus = "answered_telegram";
        } else if (resStr.includes('"answeredVia":"cli"') || resStr.includes("Answered via CLI")) {
          askStatus = "answered_cli";
        }
      }
      if (event.toolName === "todo") {
        try {
          const resObj = typeof event.result === "string" ? JSON.parse(event.result) : event.result;
          const details = (resObj?.details ?? resObj) as Record<string, unknown> | undefined;
          const parsed: ProgressTailTodoItem[] = [];

          if (Array.isArray(details?.phases)) {
            for (const phase of details.phases as Array<{ tasks?: Array<{ content?: string; task?: string; status?: string }> }>) {
              if (Array.isArray(phase?.tasks)) {
                for (const t of phase.tasks) {
                  const taskName = t?.content ?? t?.task;
                  if (taskName) {
                    parsed.push({
                      task: String(taskName),
                      status: (t.status as ProgressTailTodoItem["status"]) ?? "pending",
                    });
                  }
                }
              }
            }
          } else if (Array.isArray(details?.items)) {
            for (const item of details.items as Array<{ task?: string; content?: string; status?: string }>) {
              const taskName = item?.task ?? item?.content;
              if (taskName) {
                parsed.push({
                  task: String(taskName),
                  status: (item.status as ProgressTailTodoItem["status"]) ?? "pending",
                });
              }
            }
          }

          if (parsed.length > 0) {
            const settledBefore = new Map(
              todoItems
                .filter((item) => item.settledAtMs !== undefined)
                .map((item) => [`${item.task}\u0000${item.status}`, item.settledAtMs!]),
            );
            const settledNow = getNowMs();
            for (const item of parsed) {
              if (item.status !== "completed" && item.status !== "cancelled") continue;
              item.settledAtMs =
                settledBefore.get(`${item.task}\u0000${item.status}`) ?? settledNow;
            }
            todoItems.length = 0;
            todoItems.push(...parsed);
            scheduleTodoExpiryRefresh(acceptedGeneration, admittedAuthority);
          }
        } catch {
          void 0;
        }
      }
      const resultSummary = extractToolResultSummary(event.toolName, event.result, event.isError);
      completedTools.push({
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args ?? extractShortToolArgs(event.toolName, undefined),
        resultSummary,
        status: event.isError ? "failed" : "completed",
        askStatus,
        isError: event.isError,
      });
      const evictedTool =
        completedTools[completedTools.length - 1 - TELEGRAM_PROGRESS_TAIL_MAX_TOOLS];
      if (evictedTool) evictedTool.resultSummary = undefined;
      if (event.toolName === "ask") {
        status = "completed";
        completedAtMs = getNowMs();
        await publishToTelegram(acceptedGeneration, true);
        clearSegment();
        return;
      }
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "assistant-segment") {
      if (event.placement === "intermediate" && liveMessage !== undefined) {
        status = "completed";
        completedAtMs = getNowMs();
        await publishToTelegram(acceptedGeneration, true);
        clearSegment();
      }
      return;
    }

    if (event.type === "agent-end" || event.type === "agent-settled") {
      if (event.type === "agent-end" && event.willContinue) {
        if (liveMessage !== undefined && dirty) {
          await publishToTelegram(acceptedGeneration, true);
        }
        return;
      }
      if (liveMessage !== undefined) {
        status = "completed";
        completedAtMs = getNowMs();
        await publishToTelegram(acceptedGeneration, true);
      }
      clearAll();
      return;
    }
  };

  return {
    accept(event) {
      if (!active) return;
      const acceptedGeneration = generation;
      const resolvedTarget = deps.resolveTarget(event);
      const admittedTarget = resolvedTarget ? { ...resolvedTarget } : undefined;
      const admittedAuthority = deps.captureAuthority();
      const enqueue = deps.enqueue ?? ((task: () => Promise<void>) => tail.then(task));
      tail = enqueue(async () => {
        if (!active || generation !== acceptedGeneration || !deps.isAuthorityActive(admittedAuthority)) return;
        await process(event, acceptedGeneration, admittedTarget, admittedAuthority);
      }).catch((error) => {
        deps.recordFailure?.("tail-send", event, error);
      });
    },
    reset() {
      generation += 1;
      clearAll();
      tail = Promise.resolve();
    },
    stop() {
      active = false;
      generation += 1;
      clearAll();
      tail = Promise.resolve();
    },
    async waitForIdle() {
      await tail;
      clearTimer();
      if (dirty && active) {
        await publishToTelegram(generation, true);
      }
      await publishChain;
      await tail;
    },
  };
}
