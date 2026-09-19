/**
 * Telegram plan review card and overlay driving runtime
 * Zones: plan review, telegram delivery, approval overlay
 * Owns plan proposal detection, approval cards, and keystroke driving
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  editTelegramView,
  sendTelegramView,
  type SendTelegramViewOptions,
  type TelegramDeliveryHandle,
  type TelegramDeliveryResult,
  type TelegramDeliveryScope,
  type TelegramDeliveryView,
} from "./delivery.ts";
import {
  assertTelegramCallbackData,
  type TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import type { TelegramTarget } from "./target.ts";
import {
  TELEGRAM_TUI_KEY_CONFIRM,
  TELEGRAM_TUI_KEY_DOWN,
  type TelegramTuiInputRuntime,
} from "./tui-input.ts";
import type { TelegramUpdateHandlerVerdict } from "./updates.ts";

export const TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX = "tgplan";
export const TELEGRAM_PLAN_REVIEW_MESSAGE_MAX_CHARS = 3800;

export interface TelegramPlanProposalDetails {
  planFilePath: string;
  title: string;
  planExists: boolean;
}

export type TelegramPlanReviewChoice =
  | "approve-execute"
  | "approve-compact"
  | "approve-keep"
  | "refine";

export function readTelegramPlanProposalDetails(
  toolName: string,
  result: unknown,
): TelegramPlanProposalDetails | undefined {
  if (toolName !== "write" && toolName !== "omp.write") {
    return undefined;
  }
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const xdev = (details as { xdev?: unknown }).xdev;
  if (!xdev || typeof xdev !== "object") {
    return undefined;
  }
  const typedXdev = xdev as {
    tool?: unknown;
    mode?: unknown;
    inner?: unknown;
  };
  if (typedXdev.tool !== "propose" || typedXdev.mode !== "execute") {
    return undefined;
  }
  const inner = typedXdev.inner;
  if (!inner || typeof inner !== "object") {
    return undefined;
  }
  const typedInner = inner as {
    planFilePath?: unknown;
    title?: unknown;
    planExists?: unknown;
  };
  if (
    typeof typedInner.planFilePath !== "string" ||
    typeof typedInner.title !== "string" ||
    typeof typedInner.planExists !== "boolean"
  ) {
    return undefined;
  }
  return {
    planFilePath: typedInner.planFilePath,
    title: typedInner.title,
    planExists: typedInner.planExists,
  };
}

export function planTelegramPlanReviewKeystrokes(
  choice: TelegramPlanReviewChoice,
): string {
  switch (choice) {
    case "approve-execute":
      return TELEGRAM_TUI_KEY_CONFIRM;
    case "approve-compact":
      return `${TELEGRAM_TUI_KEY_DOWN}${TELEGRAM_TUI_KEY_CONFIRM}`;
    case "approve-keep":
      return `${TELEGRAM_TUI_KEY_DOWN}${TELEGRAM_TUI_KEY_DOWN}${TELEGRAM_TUI_KEY_CONFIRM}`;
    case "refine":
      return `${TELEGRAM_TUI_KEY_DOWN.repeat(8)}${TELEGRAM_TUI_KEY_CONFIRM}`;
  }
}

export function buildTelegramPlanReviewCard(input: {
  title: string;
  planFilePath: string;
  planContent: string;
  offerKeepContext: boolean;
  requestId: string;
}): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const header = `📋 Plan ready for approval\n${input.title}\n${input.planFilePath}\n\n`;
  const text = header + input.planContent;

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [
    [
      {
        text: "▶️ Approve and execute",
        callback_data: assertTelegramCallbackData(
          `${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:${input.requestId}:approve-execute`,
        ),
      },
    ],
    [
      {
        text: "🗜 Approve and compact context",
        callback_data: assertTelegramCallbackData(
          `${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:${input.requestId}:approve-compact`,
        ),
      },
    ],
  ];

  if (input.offerKeepContext) {
    buttons.push([
      {
        text: "📎 Approve and keep context",
        callback_data: assertTelegramCallbackData(
          `${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:${input.requestId}:approve-keep`,
        ),
      },
    ]);
  }

  buttons.push([
    {
      text: "✏️ Refine plan",
      callback_data: assertTelegramCallbackData(
        `${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:${input.requestId}:refine`,
      ),
    },
  ]);

  return {
    text,
    markup: {
      inline_keyboard: buttons,
    },
  };
}

export async function readTelegramPlanFile(
  planFilePath: string,
  ctx: any,
): Promise<string> {
  let resolvedPath = planFilePath;

  if (planFilePath.startsWith("local://") || planFilePath.startsWith("local:")) {
    const rest = planFilePath.startsWith("local://")
      ? planFilePath.slice("local://".length)
      : planFilePath.slice("local:".length);

    let localRoot: string | undefined;
    if (ctx?.localProtocolOptions?.getArtifactsDir) {
      const art = ctx.localProtocolOptions.getArtifactsDir();
      if (art) localRoot = join(art, "local");
    }
    if (!localRoot && ctx?.sessionManager?.getArtifactsDir && ctx?.sessionManager?.getSessionId) {
      const art = ctx.sessionManager.getArtifactsDir();
      const sid = ctx.sessionManager.getSessionId();
      if (art && sid) {
        localRoot = join(art, "local");
      }
    }
    if (!localRoot) {
      localRoot = join(process.cwd(), "local");
    }
    resolvedPath = join(localRoot, rest);
  } else if (!isAbsolute(planFilePath)) {
    const cwd = ctx?.cwd ?? process.cwd();
    resolvedPath = join(cwd, planFilePath);
  }

  return await readFile(resolvedPath, "utf8");
}

export interface TelegramPlanReviewRuntimeDeps {
  isEnabled: () => boolean;
  getActiveTurn: () => unknown;
  getDefaultTarget?: () => TelegramTarget | undefined;
  answerCallbackQuery?: (id: string, text?: string) => Promise<void>;
  tuiInput: TelegramTuiInputRuntime;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  sendView?: (
    view: TelegramDeliveryView,
    options?: SendTelegramViewOptions,
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  editView?: (
    handle: TelegramDeliveryHandle,
    view: TelegramDeliveryView,
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
}

export interface TelegramPlanReviewRuntime {
  onToolExecutionEnd: (event: any, ctx: any) => Promise<void>;
  onAgentStart: () => Promise<void>;
  resolveFromUpdate: (update: unknown) => Promise<TelegramUpdateHandlerVerdict>;
  cancelAll: (reason: string) => Promise<void>;
}

export function createTelegramPlanReviewRuntime(
  deps: TelegramPlanReviewRuntimeDeps,
): TelegramPlanReviewRuntime {
  const sendView = deps.sendView ?? sendTelegramView;
  const editView = deps.editView ?? editTelegramView;

  interface PendingReview {
    requestId: string;
    handle: TelegramDeliveryHandle;
    cardText: string;
    choices: string[];
  }

  let pending: PendingReview | undefined;

  const record = (error: unknown, details: Record<string, unknown>): void => {
    deps.recordRuntimeEvent?.("plan-review", error, details);
  };

  const resolveScope = (): TelegramDeliveryScope | undefined => {
    if (deps.getActiveTurn() !== undefined) return { kind: "active-turn" };
    const target = deps.getDefaultTarget?.();
    return target ? { kind: "target", target } : undefined;
  };

  return {
    onToolExecutionEnd: async (event: any, ctx: any): Promise<void> => {
      try {
        if (!deps.isEnabled()) return;
        if (event?.isError) return;
        if (ctx?.mode !== "tui" || ctx?.hasUI !== true) return;

        const details = readTelegramPlanProposalDetails(
          event?.toolName ?? "",
          event?.result,
        );
        if (!details || details.planExists === false) return;

        const scope = resolveScope();
        if (!scope) return;

        let planContent = "";
        try {
          planContent = await readTelegramPlanFile(details.planFilePath, ctx);
        } catch (err) {
          planContent = `(plan file unreadable: ${err instanceof Error ? err.message : String(err)})`;
        }

        const usage = ctx?.getContextUsage?.();
        const offerKeepContext =
          usage === undefined || usage.percent === undefined || usage.percent <= 90;

        const requestId = Math.random().toString(36).slice(2, 10);
        const card = buildTelegramPlanReviewCard({
          title: details.title,
          planFilePath: details.planFilePath,
          planContent,
          offerKeepContext,
          requestId,
        });

        const view: TelegramDeliveryView = {
          text: card.text,
          parseMode: "plain",
          replyMarkup: card.markup,
        };

        const result = await sendView(view, { scope });
        if (result.ok) {
          pending = {
            requestId,
            handle: result.value,
            cardText: card.text,
            choices: offerKeepContext
              ? ["approve-execute", "approve-compact", "approve-keep", "refine"]
              : ["approve-execute", "approve-compact", "refine"],
          };
        } else {
          record(new Error(result.message), { phase: "send-view", reason: result.reason });
        }
      } catch (error) {
        record(error, { phase: "onToolExecutionEnd" });
      }
    },

    onAgentStart: async (): Promise<void> => {
      if (!pending) return;
      const current = pending;
      pending = undefined;
      try {
        await editView(current.handle, {
          text: current.cardText + "\n\n↩️ Decided in CLI",
          parseMode: "plain",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch (error) {
        record(error, { phase: "onAgentStart" });
      }
    },

    resolveFromUpdate: async (update: unknown): Promise<TelegramUpdateHandlerVerdict> => {
      if (!update || typeof update !== "object") return "pass";
      const cb = (update as { callback_query?: unknown }).callback_query;
      if (!cb || typeof cb !== "object") return "pass";
      const typedCb = cb as { id?: string; data?: string };
      const data = typedCb.data;
      if (!data || typeof data !== "string") return "pass";

      if (!data.startsWith(`${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:`)) {
        return "pass";
      }

      const parts = data.split(":");
      if (parts.length < 3) return "pass";
      const [, requestId, rawChoice] = parts;

      if (!pending || pending.requestId !== requestId) {
        if (typedCb.id && deps.answerCallbackQuery) {
          try {
            await deps.answerCallbackQuery(typedCb.id, "This plan review has expired.");
          } catch (err) {
            record(err, { phase: "answer-stale-callback" });
          }
        }
        return "consume";
      }

      const choice = rawChoice as TelegramPlanReviewChoice;
      const current = pending;
      pending = undefined;

      const choiceLabels: Record<TelegramPlanReviewChoice, string> = {
        "approve-execute": "Approve and execute",
        "approve-compact": "Approve and compact context",
        "approve-keep": "Approve and keep context",
        refine: "Refine plan",
      };
      const label = choiceLabels[choice] ?? choice;

      if (typedCb.id && deps.answerCallbackQuery) {
        try {
          await deps.answerCallbackQuery(typedCb.id, `${label} — applying in CLI`);
        } catch (err) {
          record(err, { phase: "answer-callback" });
        }
      }

      try {
        await editView(current.handle, {
          text: `${current.cardText}\n\n✅ ${label} (from Telegram)`,
          parseMode: "plain",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch (err) {
        record(err, { phase: "edit-view" });
      }

      const keystrokes = planTelegramPlanReviewKeystrokes(choice);
      deps.tuiInput.send(keystrokes);

      return "consume";
    },

    cancelAll: async (reason: string): Promise<void> => {
      if (!pending) return;
      const current = pending;
      pending = undefined;
      try {
        await editView(current.handle, {
          text: `${current.cardText}\n\n⏹ ${reason}`,
          parseMode: "plain",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch (error) {
        record(error, { phase: "cancelAll" });
      }
    },
  };
}
