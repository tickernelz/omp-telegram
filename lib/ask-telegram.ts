/**
 * Telegram ask dialog surface
 * Zones: telegram ui, ask bridge, callback decoding
 * Owns ask keyboard construction, question message rendering, and ask callback/text decoding so the ask registry stays transport-free
 */

import { randomUUID } from "node:crypto";

import {
  assertTelegramCallbackData,
  type TelegramInlineKeyboardButton,
  type TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import {
  createTelegramPrivateTarget,
  createTelegramThreadTarget,
  type TelegramTarget,
} from "./target.ts";

export const TELEGRAM_ASK_CALLBACK_PREFIX = "tgask";
export const TELEGRAM_ASK_OTHER_LABEL = "Other (type your own)";
export const TELEGRAM_ASK_DONE_LABEL = "Done selecting";
export const TELEGRAM_ASK_RECOMMENDED_SUFFIX = " (Recommended)";
export const TELEGRAM_ASK_SUPERSEDED_LABEL = "in the CLI";

const TELEGRAM_ASK_REQUEST_ID_LENGTH = 10;
const TELEGRAM_ASK_BUTTON_TEXT_MAX_CHARS = 48;
const TELEGRAM_ASK_MESSAGE_MAX_CHARS = 3800;
const TELEGRAM_ASK_SELECTED_PREFIX = "\u2611\ufe0f ";
const TELEGRAM_ASK_UNSELECTED_PREFIX = "\u25ab\ufe0f ";
const TELEGRAM_ASK_EMPTY_LABEL = "(unlabeled option)";

export interface TelegramAskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface TelegramAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: TelegramAskOption[];
  multi: boolean;
  recommended?: number;
}

export interface TelegramAskPosition {
  index: number;
  total: number;
}

export interface TelegramAskAnswer {
  selectedOptions: string[];
  customInput?: string;
}

export type TelegramAskCallbackToken =
  | { kind: "option"; index: number }
  | { kind: "done" }
  | { kind: "other" };

export interface TelegramAskCallbackSelection {
  requestId: string;
  token: TelegramAskCallbackToken;
}

export interface TelegramAskInboundCallback {
  id?: string;
  data: string;
  target?: TelegramTarget;
  messageId?: number;
}

export interface TelegramAskInboundText {
  target: TelegramTarget;
  text: string;
  messageId?: number;
}

export function createTelegramAskRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, TELEGRAM_ASK_REQUEST_ID_LENGTH);
}

function formatTelegramAskCallbackSuffix(token: TelegramAskCallbackToken): string {
  if (token.kind === "option") return `o${token.index}`;
  return token.kind === "done" ? "d" : "x";
}

export function buildTelegramAskCallbackData(
  requestId: string,
  token: TelegramAskCallbackToken,
): string {
  return assertTelegramCallbackData(
    `${TELEGRAM_ASK_CALLBACK_PREFIX}:${requestId}:${formatTelegramAskCallbackSuffix(token)}`,
    "Telegram ask callback_data",
  );
}

export function isTelegramAskCallbackData(data: unknown): data is string {
  return (
    typeof data === "string" &&
    data.startsWith(`${TELEGRAM_ASK_CALLBACK_PREFIX}:`)
  );
}

export function decodeTelegramAskCallbackData(
  data: unknown,
): TelegramAskCallbackSelection | undefined {
  if (!isTelegramAskCallbackData(data)) return undefined;
  const parts = data.split(":");
  if (parts.length !== 3) return undefined;
  const requestId = parts[1];
  const suffix = parts[2];
  if (!requestId || !suffix) return undefined;
  if (suffix === "d") return { requestId, token: { kind: "done" } };
  if (suffix === "x") return { requestId, token: { kind: "other" } };
  if (!suffix.startsWith("o")) return undefined;
  const index = Number.parseInt(suffix.slice(1), 10);
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  return { requestId, token: { kind: "option", index } };
}

function truncateTelegramAskButtonText(label: string): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return TELEGRAM_ASK_EMPTY_LABEL;
  if (normalized.length <= TELEGRAM_ASK_BUTTON_TEXT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TELEGRAM_ASK_BUTTON_TEXT_MAX_CHARS - 1).trimEnd()}\u2026`;
}

function buildTelegramAskOptionButton(
  requestId: string,
  question: TelegramAskQuestion,
  index: number,
  selected: ReadonlySet<number>,
): TelegramInlineKeyboardButton {
  const option = question.options[index];
  const recommended =
    !question.multi && question.recommended === index
      ? TELEGRAM_ASK_RECOMMENDED_SUFFIX
      : "";
  const mark = question.multi
    ? selected.has(index)
      ? TELEGRAM_ASK_SELECTED_PREFIX
      : TELEGRAM_ASK_UNSELECTED_PREFIX
    : "";
  return {
    text: `${mark}${truncateTelegramAskButtonText(option?.label ?? "")}${recommended}`,
    callback_data: buildTelegramAskCallbackData(requestId, {
      kind: "option",
      index,
    }),
  };
}

export function buildTelegramAskKeyboard(
  requestId: string,
  question: TelegramAskQuestion,
  selected: ReadonlySet<number> = new Set<number>(),
): TelegramInlineKeyboardMarkup {
  const inlineKeyboard: TelegramInlineKeyboardButton[][] = question.options.map(
    (_option, index) => [
      buildTelegramAskOptionButton(requestId, question, index, selected),
    ],
  );
  if (question.multi) {
    inlineKeyboard.push([
      {
        text: `${TELEGRAM_ASK_DONE_LABEL} (${selected.size})`,
        callback_data: buildTelegramAskCallbackData(requestId, { kind: "done" }),
      },
    ]);
  }
  inlineKeyboard.push([
    {
      text: TELEGRAM_ASK_OTHER_LABEL,
      callback_data: buildTelegramAskCallbackData(requestId, { kind: "other" }),
    },
  ]);
  return { inline_keyboard: inlineKeyboard };
}

export function createTelegramAskClearedKeyboard(): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [] };
}

function truncateTelegramAskMessageText(text: string): string {
  if (text.length <= TELEGRAM_ASK_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, TELEGRAM_ASK_MESSAGE_MAX_CHARS - 1).trimEnd()}\u2026`;
}

function renderTelegramAskBody(
  question: TelegramAskQuestion,
  position: TelegramAskPosition,
  footer: string,
): string {
  const lines: string[] = [];
  if (position.total > 1) {
    lines.push(`Question ${position.index + 1} of ${position.total}`);
  }
  const header = question.header?.trim();
  if (header) lines.push(header);
  if (lines.length > 0) lines.push("");
  lines.push(question.question.trim() || question.id);
  if (question.options.length > 0) {
    lines.push("");
    for (const [index, option] of question.options.entries()) {
      const recommended =
        question.recommended === index ? TELEGRAM_ASK_RECOMMENDED_SUFFIX : "";
      const description = option.description?.trim();
      lines.push(`${index + 1}. ${option.label}${recommended}`);
      if (description) lines.push(`   ${description}`);
    }
  }
  if (footer) {
    lines.push("");
    lines.push(footer);
  }
  return truncateTelegramAskMessageText(lines.join("\n"));
}

export function renderTelegramAskQuestionText(
  question: TelegramAskQuestion,
  position: TelegramAskPosition,
): string {
  return renderTelegramAskBody(
    question,
    position,
    question.multi
      ? `Tap options to toggle them, then press "${TELEGRAM_ASK_DONE_LABEL}".`
      : "Tap one option to answer.",
  );
}

export function renderTelegramAskCustomInputText(
  question: TelegramAskQuestion,
  position: TelegramAskPosition,
): string {
  return renderTelegramAskBody(
    question,
    position,
    "Send your answer as the next message in this chat.",
  );
}

export function renderTelegramAskSupersededText(
  question: TelegramAskQuestion,
  position: TelegramAskPosition,
): string {
  return renderTelegramAskAnsweredText(question, position, {
    selectedOptions: [TELEGRAM_ASK_SUPERSEDED_LABEL],
  });
}

export function renderTelegramAskAnsweredText(
  question: TelegramAskQuestion,
  position: TelegramAskPosition,
  answer: TelegramAskAnswer,
): string {
  const summary =
    answer.customInput !== undefined
      ? `Answered: "${answer.customInput}"`
      : answer.selectedOptions.length > 0
        ? `Answered: ${answer.selectedOptions.join(", ")}`
        : "Answered: (no option selected)";
  return renderTelegramAskBody(question, position, summary);
}

function readTelegramAskTarget(
  message: Record<string, unknown> | undefined,
): TelegramTarget | undefined {
  const chat = message?.chat as { id?: unknown } | undefined;
  if (typeof chat?.id !== "number") return undefined;
  const threadId = (message as { message_thread_id?: unknown } | undefined)
    ?.message_thread_id;
  return typeof threadId === "number"
    ? createTelegramThreadTarget(chat.id, threadId)
    : createTelegramPrivateTarget(chat.id);
}

function readTelegramAskRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") return undefined;
  return nested as Record<string, unknown>;
}

export function readTelegramAskInboundCallback(
  update: unknown,
): TelegramAskInboundCallback | undefined {
  const query = readTelegramAskRecord(update, "callback_query");
  if (!query) return undefined;
  const data = query.data;
  if (!isTelegramAskCallbackData(data)) return undefined;
  const message = readTelegramAskRecord(query, "message");
  const messageId = message?.message_id;
  return {
    id: typeof query.id === "string" ? query.id : undefined,
    data,
    target: readTelegramAskTarget(message),
    messageId: typeof messageId === "number" ? messageId : undefined,
  };
}

export function readTelegramAskInboundText(
  update: unknown,
): TelegramAskInboundText | undefined {
  const message = readTelegramAskRecord(update, "message");
  if (!message) return undefined;
  const raw = message.text;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0 || text.startsWith("/")) return undefined;
  const target = readTelegramAskTarget(message);
  if (!target) return undefined;
  const messageId = message.message_id;
  return {
    target,
    text,
    messageId: typeof messageId === "number" ? messageId : undefined,
  };
}

export function matchesTelegramAskTarget(
  pendingTarget: TelegramTarget,
  inboundTarget: TelegramTarget,
): boolean {
  if (pendingTarget.chatId !== inboundTarget.chatId) return false;
  if (pendingTarget.threadId === undefined) return true;
  return pendingTarget.threadId === inboundTarget.threadId;
}
