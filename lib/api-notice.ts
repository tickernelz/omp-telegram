/**
 * Telegram outbound API failure notices
 * Zones: telegram api, operator diagnostics, chat notices
 * Owns classification of outbound Bot API failures, per-class notice coalescing, notice rendering, and fail-soft notice delivery so transport errors become visible without becoming noise
 */

import { escapeHtml } from "./rendering.ts";
import {
  isTelegramStaleTargetHttpError,
  TelegramApiHttpError,
  type TelegramApiCallOptions,
  type TelegramApiClient,
  type TelegramBridgeApiRuntime,
} from "./telegram-api.ts";

export type TelegramApiNoticeClass =
  | "rate-limit"
  | "server-error"
  | "api-error"
  | "transport-down"
  | "commit-unknown";

export interface TelegramApiFailure {
  kind: TelegramApiNoticeClass;
  method: string;
  detail: string;
  retryAfterSeconds?: number;
  status?: number;
}

export const TELEGRAM_API_NOTICE_CLASS_COOLDOWN_MS = 60_000;
export const TELEGRAM_API_NOTICE_MIN_INTERVAL_MS = 15_000;

const TELEGRAM_API_NOTICE_CLASS_EMOJI: Record<TelegramApiNoticeClass, string> = {
  "rate-limit": "⏳",
  "server-error": "📡",
  "api-error": "⚠️",
  "transport-down": "📡",
  "commit-unknown": "⚠️",
};

const TELEGRAM_API_NOTICE_CLASS_LABEL: Record<TelegramApiNoticeClass, string> = {
  "rate-limit": "Telegram rate limit",
  "server-error": "Telegram server error",
  "api-error": "Telegram API error",
  "transport-down": "Telegram transport is down",
  "commit-unknown": "Telegram delivery is unconfirmed",
};

const TELEGRAM_API_METHOD_FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHttpStatus(error: unknown): number | undefined {
  if (error instanceof TelegramApiHttpError) return error.status;
  const status = isRecord(error) ? error.status : undefined;
  return typeof status === "number" ? status : undefined;
}

function readRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof TelegramApiHttpError) return error.retryAfterSeconds;
  const retryAfter = isRecord(error) ? error.retryAfterSeconds : undefined;
  return typeof retryAfter === "number" ? retryAfter : undefined;
}

function isTelegramTransportDownError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/is not registered|not registered with the leader/i.test(error.message)) {
    return true;
  }
  if (/^Telegram bus API call (did not return|failed)/i.test(error.message)) {
    return true;
  }
  const code = isRecord(error) ? error.code : undefined;
  return (
    typeof code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)$/.test(code)
  );
}

export function isTelegramApiCommitUnknownFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TelegramApiCommitUnknownError" ||
    error.message.includes("may have committed")
  );
}

const TELEGRAM_BENIGN_FAILURE_PATTERN =
  /message is not modified|query is too old|message to edit not found|message can't be edited|message to delete not found/i;

export function classifyTelegramApiFailure(
  method: string,
  error: unknown,
): TelegramApiFailure | undefined {
  if (!TELEGRAM_API_METHOD_FIELD_PATTERN.test(method)) return undefined;
  if (!(error instanceof Error)) return undefined;
  if (error.name === "AbortError") return undefined;
  if (TELEGRAM_BENIGN_FAILURE_PATTERN.test(error.message)) return undefined;
  if (isTelegramApiCommitUnknownFailure(error)) {
    return {
      kind: "commit-unknown",
      method,
      detail: "the request may have committed before the transport failed",
    };
  }
  if (isTelegramTransportDownError(error)) {
    return { kind: "transport-down", method, detail: "the bridge transport is unavailable" };
  }
  const status = readHttpStatus(error);
  if (status === 429) {
    const retryAfterSeconds = readRetryAfterSeconds(error);
    return {
      kind: "rate-limit",
      method,
      detail: "too many requests",
      status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "server-error", method, detail: "Telegram reported a server failure", status };
  }
  if (status !== undefined && status >= 400) {
    if (isTelegramStaleTargetHttpError(error)) return undefined;
    const description = error.message.replace(/^Telegram API \w+ failed: /, "").trim();
    return {
      kind: "api-error",
      method,
      detail: description.length > 0 ? description : "the request was rejected",
      status,
    };
  }
  return undefined;
}

export function formatTelegramApiFailureNotice(failure: TelegramApiFailure): string {
  const emoji = TELEGRAM_API_NOTICE_CLASS_EMOJI[failure.kind];
  const label = TELEGRAM_API_NOTICE_CLASS_LABEL[failure.kind];
  const status =
    failure.status !== undefined ? ` ${failure.status}` : "";
  const retry =
    failure.kind === "rate-limit" && failure.retryAfterSeconds !== undefined
      ? `, retrying in ${failure.retryAfterSeconds}s.`
      : ".";
  return `<b>${escapeHtml(emoji)} ${escapeHtml(label)}${status} while ` +
    `${escapeHtml(failure.method)}: ${escapeHtml(failure.detail)}${retry}</b>`;
}

export interface TelegramApiNoticeTarget {
  chatId: number;
  threadId?: number;
}

export interface TelegramApiNoticeRuntimeDeps {
  getTarget: () => TelegramApiNoticeTarget | undefined;
  getAllowedChatId?: () => number | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  classCooldownMs?: number;
  minIntervalMs?: number;
}

export interface TelegramApiNoticeRuntime {
  report: (method: string, error: unknown) => void;
  reset: () => void;
  bindSender: (runtime: Pick<TelegramBridgeApiRuntime, "sendMessage">) => void;
  decorateClient: (client: TelegramApiClient) => TelegramApiClient;
  followerApiCall: (
    call: (method: string, args: unknown[]) => Promise<unknown>,
  ) => (method: string, args: unknown[]) => Promise<unknown>;
}

export function createTelegramApiNoticeClient(
  client: TelegramApiClient,
  report: (method: string, error: unknown) => void,
): TelegramApiClient {
  return {
    call: <TResponse>(
      method: string,
      body: Record<string, unknown>,
      options?: TelegramApiCallOptions,
    ) =>
      client.call<TResponse>(method, body, options).catch((error: unknown) => {
        report(method, error);
        throw error;
      }),
    callMultipart: <TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
      options?: TelegramApiCallOptions,
    ) =>
      client
        .callMultipart<TResponse>(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          options,
        )
        .catch((error: unknown) => {
          report(method, error);
          throw error;
        }),
    downloadFile: client.downloadFile,
    answerCallbackQuery: client.answerCallbackQuery,
    ...(client.answerGuestQuery
      ? { answerGuestQuery: client.answerGuestQuery }
      : {}),
  };
}

interface TelegramApiNoticeSenderBinding {
  runtime: Pick<TelegramBridgeApiRuntime, "sendMessage"> | undefined;
}

async function sendTelegramApiNotice(
  binding: TelegramApiNoticeSenderBinding,
  text: string,
  target: TelegramApiNoticeTarget,
): Promise<void> {
  const runtime = binding.runtime;
  if (!runtime) {
    throw new Error("Telegram notice transport is not bound.");
  }
  await runtime.sendMessage({
    chat_id: target.chatId,
    text,
    parse_mode: "HTML",
    ...(target.threadId !== undefined
      ? { message_thread_id: target.threadId }
      : {}),
  });
}

function readTelegramFollowerCallMethod(
  method: string,
  args: unknown[],
): string {
  return method === "call" && typeof args[0] === "string" ? args[0] : method;
}

export function createTelegramApiNoticeRuntime(
  deps: TelegramApiNoticeRuntimeDeps,
): TelegramApiNoticeRuntime {
  const getNowMs = deps.getNowMs ?? Date.now;
  const classCooldownMs =
    deps.classCooldownMs ?? TELEGRAM_API_NOTICE_CLASS_COOLDOWN_MS;
  const minIntervalMs =
    deps.minIntervalMs ?? TELEGRAM_API_NOTICE_MIN_INTERVAL_MS;
  const lastSentAtByClass = new Map<TelegramApiNoticeClass, number>();
  let lastSentAtMs: number | undefined;
  const senderBinding: TelegramApiNoticeSenderBinding = { runtime: undefined };
  const record = (error: unknown, details: Record<string, unknown>): void => {
    try {
      deps.recordRuntimeEvent?.("api-notice", error, details);
    } catch {
      return;
    }
  };
  const report = (method: string, error: unknown): void => {
    const failure = classifyTelegramApiFailure(method, error);
    if (!failure) return;
    if (failure.kind === "transport-down") {
      record(
        new Error("Telegram outbound transport is unavailable"),
        { phase: "notice-suppressed", method, kind: failure.kind },
      );
      return;
    }
    const nowMs = getNowMs();
    const lastForClass = lastSentAtByClass.get(failure.kind);
    if (lastForClass !== undefined && nowMs - lastForClass < classCooldownMs) return;
    if (lastSentAtMs !== undefined && nowMs - lastSentAtMs < minIntervalMs) return;
    const target = deps.getTarget();
    if (!target) return;
    const allowedChatId = deps.getAllowedChatId?.();
    if (allowedChatId !== undefined && target.chatId !== allowedChatId) return;
    lastSentAtByClass.set(failure.kind, nowMs);
    lastSentAtMs = nowMs;
    const text = formatTelegramApiFailureNotice(failure);
    void sendTelegramApiNotice(senderBinding, text, target).catch(
      (sendError) => {
        record(sendError, {
          phase: "notice-send",
          method,
          kind: failure.kind,
        });
      },
    );
    record(
      new Error(["Telegram", failure.kind, "notice sent"].join(" ")),
      { phase: "notice-sent", method, kind: failure.kind, status: failure.status },
    );
  };
  return {
    report,
    bindSender(runtime) {
      senderBinding.runtime = runtime;
    },
    decorateClient: (client) => createTelegramApiNoticeClient(client, report),
    followerApiCall:
      (call) =>
      (method, args) =>
        call(method, args).catch((error: unknown) => {
          report(readTelegramFollowerCallMethod(method, args), error);
          throw error;
        }),
    reset() {
      lastSentAtByClass.clear();
      lastSentAtMs = undefined;
    },
  };
}
