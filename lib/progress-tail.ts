/**
 * Telegram live progress tail rendering and throttling engine
 * Zones: telegram activity, live progress tail, rich rendering
 * Owns single-bubble live progress updates, lazy triggering, roll-over on intermediate commentary, finalization summaries, and rate-limited Telegram edits
 */

import type { TelegramActivityEvent, TelegramActivityPublicationRuntime } from "./activity.ts";
import { escapeHtml } from "./rendering.ts";
import type { TelegramTarget } from "./target.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
  TelegramSentMessage,
} from "./telegram-api.ts";

export const TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS = 2_000;
export const TELEGRAM_PROGRESS_TAIL_MAX_TOOLS = 10;
export const TELEGRAM_PROGRESS_TAIL_MAX_REASONING_LINES = 8;
export const TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_CHARS = 3_900;
export const TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS = 2_400;

export type ProgressTailStatus = "working" | "completed" | "cancelled" | "failed";

export interface ProgressTailToolItem {
  id: string;
  name: string;
  args: string;
  status: "running" | "completed" | "failed" | "waiting";
  askStatus?: "waiting" | "answered_telegram" | "answered_cli";
  isError?: boolean;
}

export interface ProgressTailTodoItem {
  task: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface ProgressTailState {
  status: ProgressTailStatus;
  startedAtMs: number;
  completedAtMs?: number;
  modelName?: string;
  reasoningLines: string[];
  tools: ProgressTailToolItem[];
  todoItems: ProgressTailTodoItem[];
  errorMessage?: string;
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
  ) => Promise<"edited" | "unchanged">;
  getModelName?: () => string | undefined;
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

export function extractShortToolArgs(toolName: string, rawArgs: unknown): string {
  if (rawArgs === undefined || rawArgs === null) return "";
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.replace(/\s+/g, " ").trim();
    if (!trimmed) return "";
    try {
      return extractShortToolArgs(toolName, JSON.parse(trimmed));
    } catch {
      return trimmed.slice(0, 60);
    }
  }
  if (typeof rawArgs !== "object") return String(rawArgs).slice(0, 60);
  if (Array.isArray(rawArgs)) {
    return `[${rawArgs.length} items]`;
  }
  const args = rawArgs as Record<string, unknown>;
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    if (args.path) return String(args.path);
  }
  if (toolName === "glob") {
    if (args.path) return String(args.path);
    if (args.pattern) return String(args.pattern);
  }
  if (toolName === "grep") {
    if (args.query) return String(args.query);
    if (args.pattern) return String(args.pattern);
  }
  if (toolName === "bash") {
    const cmd = args.cmd ?? args.command;
    if (cmd) return String(cmd).replace(/\s+/g, " ").trim().slice(0, 60);
  }
  if (toolName === "ast_grep") {
    if (args.pat) return String(args.pat).replace(/\s+/g, " ").trim().slice(0, 60);
  }
  if (toolName === "ast_edit") {
    if (args.paths) return String(args.paths).slice(0, 60);
  }
  if (toolName === "ask") {
    if (Array.isArray(args.questions)) return `${args.questions.length} question(s)`;
  }
  if (toolName === "todo") {
    if (args.task) return `${args.task}`;
    if (args.op) return `${args.op}`;
  }
  const candidateKeys = ["path", "cmd", "command", "query", "pattern", "task", "url", "file", "name", "id"];
  for (const key of candidateKeys) {
    if (args[key] !== undefined && typeof args[key] !== "object") {
      return `${String(args[key])}`.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }
  const entries = Object.entries(args).filter(([, v]) => typeof v !== "object" && v !== undefined);
  if (entries.length > 0) {
    return entries.slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(", ").slice(0, 60);
  }
  return "";
}

export function formatProgressTailHtml(state: ProgressTailState): string {
  const sections: string[] = [];
  const endMs = state.completedAtMs ?? Date.now();
  const elapsedSec = Math.max(0.1, (endMs - state.startedAtMs) / 1000).toFixed(1);
  const modelPart = state.modelName ? ` · <i>${escapeHtml(state.modelName)}</i>` : "";

  if (state.status === "working") {
    sections.push(`⏳ <b>Working...</b> (${elapsedSec}s)${modelPart}`);
  } else if (state.status === "completed") {
    sections.push(`✅ <b>Completed</b> in ${elapsedSec}s · ${state.tools.length} tools${modelPart}`);
  } else if (state.status === "cancelled") {
    sections.push(`⏹ <b>Cancelled</b> after ${elapsedSec}s · ${state.tools.length} tools${modelPart}`);
  } else {
    const errText = state.errorMessage ? `: ${escapeHtml(state.errorMessage)}` : "";
    sections.push(`⚠️ <b>Failed</b> after ${elapsedSec}s${errText}`);
  }

  const reasoningFiltered = state.reasoningLines.filter((line) => line.trim().length > 0);
  if (reasoningFiltered.length > 0) {
    const visibleLines = reasoningFiltered.slice(-TELEGRAM_PROGRESS_TAIL_MAX_REASONING_LINES);
    const text = escapeHtml(visibleLines.join("\n"));
    sections.push(`▰ 💭 <b>Reasoning</b>\n<blockquote expandable>${text}</blockquote>`);
  }

  if (state.tools.length > 0) {
    const completed = state.tools.filter((t) => t.status === "completed" || t.status === "failed");
    const running = state.tools.filter((t) => t.status === "running" || t.status === "waiting");
    const header = `▰ 🧰 <b>Tools</b> (${completed.length} completed${running.length > 0 ? `, ${running.length} running` : ""})`;
    const toolLines: string[] = [];
    if (completed.length > TELEGRAM_PROGRESS_TAIL_MAX_TOOLS) {
      toolLines.push(`… [${completed.length - TELEGRAM_PROGRESS_TAIL_MAX_TOOLS} earlier tools omitted]`);
    }
    const visibleCompleted = completed.slice(-TELEGRAM_PROGRESS_TAIL_MAX_TOOLS);
    for (const tool of visibleCompleted) {
      if (tool.name === "ask") {
        if (tool.askStatus === "answered_telegram") {
          toolLines.push("✓ <b>ask</b>: <i>Answered via Telegram</i>");
        } else if (tool.askStatus === "answered_cli") {
          toolLines.push("✓ <b>ask</b>: <i>Answered via CLI</i>");
        } else {
          toolLines.push(`✓ <b>ask</b>${tool.args ? `: <code>${escapeHtml(tool.args)}</code>` : ""}`);
        }
      } else if (tool.status === "failed") {
        toolLines.push(`✗ <b>${escapeHtml(tool.name)}</b>${tool.args ? `: <code>${escapeHtml(tool.args)}</code>` : ""}`);
      } else {
        toolLines.push(`✓ <b>${escapeHtml(tool.name)}</b>${tool.args ? `: <code>${escapeHtml(tool.args)}</code>` : ""}`);
      }
    }
    for (const tool of running) {
      if (tool.name === "ask") {
        toolLines.push("⏳ <b>ask</b>: <i>Waiting for user decision...</i>");
      } else {
        toolLines.push(`⟳ <b>${escapeHtml(tool.name)}</b>${tool.args ? `: <code>${escapeHtml(tool.args)}</code>` : ""}`);
      }
    }
    sections.push(`${header}\n${toolLines.join("\n")}`);
  }

  if (state.todoItems.length > 0) {
    const doneCount = state.todoItems.filter((t) => t.status === "completed").length;
    const header = `▰ 📋 <b>Todo</b> (${doneCount}/${state.todoItems.length})`;
    const todoLines = state.todoItems.slice(0, 6).map((item) => {
      const marker = item.status === "completed" ? "[✓]" : item.status === "in_progress" ? "[⟳]" : item.status === "cancelled" ? "[-]" : "[ ]";
      return `${marker} ${escapeHtml(item.task)}`;
    });
    if (state.todoItems.length > 6) {
      todoLines.push(`… [${state.todoItems.length - 6} more tasks]`);
    }
    sections.push(`${header}\n${todoLines.join("\n")}`);
  }

  let body = sections.join("\n\n");
  if (body.length > TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_CHARS) {
    body = body.slice(0, TELEGRAM_PROGRESS_TAIL_MAX_MESSAGE_CHARS - 20) + "\n… [truncated]";
  }
  return body;
}

export function createTelegramProgressTailRuntime<TAuthority>(
  deps: TelegramProgressTailRuntimeDeps<TAuthority>,
): TelegramProgressTailRuntime {
  let active = true;
  let generation = 0;
  let tail = Promise.resolve();
  const getNowMs = deps.getNowMs ?? Date.now;
  const intervalMs = deps.getIntervalMs?.() ?? TELEGRAM_PROGRESS_TAIL_DEFAULT_INTERVAL_MS;

  let activityId: string | undefined;
  let authority: TAuthority | undefined;
  let target: TelegramTarget | undefined;

  let liveMessage: { messageId: number; target: TelegramTarget } | undefined;
  let startedAtMs = 0;
  let completedAtMs: number | undefined;
  let status: ProgressTailStatus = "working";
  let reasoningBuffer = "";
  let reasoningLines: string[] = [];
  const runningTools = new Map<string, ProgressTailToolItem>();
  const completedTools: ProgressTailToolItem[] = [];
  const todoItems: ProgressTailTodoItem[] = [];

  let timer: NodeJS.Timeout | undefined;
  let lastPublishMs = 0;
  let dirty = false;
  let publishing = false;

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

  const clearSegment = (): void => {
    clearTimer();
    liveMessage = undefined;
    startedAtMs = getNowMs();
    completedAtMs = undefined;
    status = "working";
    reasoningBuffer = "";
    reasoningLines = [];
    runningTools.clear();
    completedTools.length = 0;
    lastPublishMs = 0;
    dirty = false;
    publishing = false;
  };

  const clearAll = (): void => {
    clearSegment();
    activityId = undefined;
    authority = undefined;
    target = undefined;
    todoItems.length = 0;
  };

  const ensureActivity = (
    event: TelegramActivityEvent,
    admittedTarget: TelegramTarget | undefined,
    admittedAuthority: TAuthority,
  ): boolean => {
    if (deps.getActivityMode() === "quiet") return false;
    if (activityId === event.activityId) return hasAuthority();
    clearAll();
    if (!admittedTarget) return false;
    activityId = event.activityId;
    target = admittedTarget;
    authority = admittedAuthority;
    startedAtMs = getNowMs();
    return hasAuthority();
  };

  const buildCurrentState = (): ProgressTailState => {
    const allTools = [...completedTools, ...runningTools.values()];
    return {
      status,
      startedAtMs,
      completedAtMs,
      modelName: deps.getModelName?.(),
      reasoningLines,
      tools: allTools,
      todoItems,
    };
  };

  const hasRealActivity = (): boolean =>
    runningTools.size > 0 || completedTools.length > 0 || reasoningLines.length > 0 || todoItems.length > 0;

  const publishToTelegram = async (
    acceptedGeneration: number,
    forceImmediate = false,
  ): Promise<void> => {
    const admittedAuthority = authority;
    if (!isCurrent(acceptedGeneration, admittedAuthority) || !target) return;
    if (deps.getActivityMode() === "quiet") return;
    if (!hasRealActivity() && liveMessage === undefined) return;

    const currentHtml = formatProgressTailHtml(buildCurrentState());

    if (liveMessage === undefined) {
      try {
        publishing = true;
        const sent = await deps.sendMessage({
          chat_id: target.chatId,
          ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
          text: currentHtml,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        if (!isCurrent(acceptedGeneration, admittedAuthority)) return;
        liveMessage = { messageId: sent.message_id, target: { ...target } };
        lastPublishMs = getNowMs();
        dirty = false;
      } catch (error) {
        deps.recordFailure?.("tail-send", { type: "tool-start" } as TelegramActivityEvent, error);
      } finally {
        publishing = false;
      }
      return;
    }

    if (forceImmediate) {
      clearTimer();
      try {
        publishing = true;
        await deps.editMessageText({
          chat_id: liveMessage.target.chatId,
          message_id: liveMessage.messageId,
          text: currentHtml,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        lastPublishMs = getNowMs();
        dirty = false;
      } catch (error) {
        deps.recordFailure?.("tail-edit", { type: "tool-end" } as TelegramActivityEvent, error);
      } finally {
        publishing = false;
      }
      return;
    }

    dirty = true;
    if (timer !== undefined || publishing) return;

    const elapsed = getNowMs() - lastPublishMs;
    const delay = Math.max(0, intervalMs - elapsed);
    if (delay <= 0) {
      await publishToTelegram(acceptedGeneration, true);
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      if (dirty && liveMessage && isCurrent(acceptedGeneration, admittedAuthority)) {
        void publishToTelegram(acceptedGeneration, true);
      }
    }, delay);
    timer?.unref?.();
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
      clearSegment();
      startedAtMs = getNowMs();
      return;
    }

    if (event.type === "reasoning-delta") {
      if (!showThinking) return;
      reasoningBuffer = `${reasoningBuffer}${event.delta}`.slice(-TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS);
      reasoningLines = reasoningBuffer.split("\n").filter((l) => l.trim().length > 0);
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "reasoning-end") {
      if (!showThinking) return;
      if (event.text && reasoningBuffer.length === 0) {
        reasoningBuffer = event.text.slice(-TELEGRAM_PROGRESS_TAIL_REASONING_BUFFER_MAX_CHARS);
        reasoningLines = reasoningBuffer.split("\n").filter((l) => l.trim().length > 0);
      }
      await publishToTelegram(acceptedGeneration, false);
      return;
    }

    if (event.type === "tool-start") {
      if (!showTools) return;
      const isAsk = event.toolName === "ask";
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
          const items = (resObj?.details?.items ?? resObj?.items) as Array<{ task?: string; status?: string }> | undefined;
          if (Array.isArray(items)) {
            todoItems.length = 0;
            for (const item of items) {
              if (item.task) {
                todoItems.push({
                  task: item.task,
                  status: (item.status as ProgressTailTodoItem["status"]) ?? "pending",
                });
              }
            }
          }
        } catch {
          void 0;
        }
      }
      completedTools.push({
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args ?? extractShortToolArgs(event.toolName, undefined),
        status: event.isError ? "failed" : "completed",
        askStatus,
        isError: event.isError,
      });
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
      if (liveMessage !== undefined) {
        status = "completed";
        completedAtMs = getNowMs();
        await publishToTelegram(acceptedGeneration, true);
      }
      clearAll();
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
      if (timer !== undefined) {
        clearTimer();
        if (dirty && liveMessage && active) {
          await publishToTelegram(generation, true);
        }
      }
      await tail;
    },
  };
}
