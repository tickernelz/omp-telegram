/**
 * Telegram status menu UI helpers
 * Zones: telegram ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */

import { formatTelegramCommandEmojiPrefix } from "./commands.ts";
import {
  getTelegramSectionMainMenuRows,
  type TelegramSectionRegistry,
} from "./sections.ts";
import {
  formatStatusButtonLabel,
  type TelegramMenuMessageRuntimeDeps,
  type TelegramMenuRenderPayload,
  type TelegramModelMenuState,
  type TelegramReplyMarkup,
} from "./menu-model.ts";
import {
  getCanonicalModelId,
  type MenuModel,
  type ThinkingLevel,
} from "./model.ts";

export interface TelegramStatusMenuCallbackDeps {
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  updateSettingsMenuMessage?: () => Promise<void>;
  handlePlanModeAction?: (action: "enter" | "pause" | "exit") => Promise<{ ok: boolean; message: string }>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isVoiceReplyActive?: () => boolean;
}

export interface TelegramStatusMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  sendBusyMessage: () => Promise<void>;
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  buildStatusHtml: () => string;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  getQueueItemCount?: () => number;
  sendStatusMenu: (
    state: TelegramModelMenuState<TModel>,
    statusHtml: string,
    activeModel: TModel | undefined,
    thinkingLevel: ThinkingLevel,
    queueItemCount: number,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

function isTelegramStatusMenuCallbackAction(
  data: string | undefined,
  action: "model" | "thinking" | "settings",
): boolean {
  return data === `menu:${action}` || data === `status:${action}`;
}

function applyTelegramMenuRenderPayload(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
): TelegramMenuRenderPayload {
  state.mode = payload.nextMode;
  return payload;
}

async function editTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

function sendTelegramMenuMessage(
  state: TelegramModelMenuState,
  payload: TelegramMenuRenderPayload,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const appliedPayload = applyTelegramMenuRenderPayload(state, payload);
  return deps.sendInteractiveMessage(
    state.chatId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
    state.threadId !== undefined
      ? { target: { chatId: state.chatId, threadId: state.threadId } }
      : undefined,
  );
}

export async function openTelegramStatusMenu<
  TModel extends MenuModel = MenuModel,
>(deps: TelegramStatusMenuOpenDeps<TModel>): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendStatusMenu(
    state,
    deps.buildStatusHtml(),
    deps.getActiveModel(),
    deps.getThinkingLevel(),
    deps.getQueueItemCount?.() ?? 0,
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "status";
  deps.storeModelMenuState(state);
}

export async function handleTelegramStatusMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: TelegramStatusMenuCallbackDeps,
): Promise<boolean> {
  if (isTelegramStatusMenuCallbackAction(data, "model")) {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (isTelegramStatusMenuCallbackAction(data, "settings")) {
    if (!deps.updateSettingsMenuMessage) return false;
    await deps.updateSettingsMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "plan:enter" || data === "plan:pause" || data === "plan:exit") {
    const action = data.slice("plan:".length) as "enter" | "pause" | "exit";
    if (deps.handlePlanModeAction) {
      const res = await deps.handlePlanModeAction(action);
      await deps.answerCallbackQuery(callbackQueryId, res.message);
      return true;
    }
    return false;
  }
  if (!isTelegramStatusMenuCallbackAction(data, "thinking")) return false;
  if (deps.isVoiceReplyActive?.()) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Thinking controls are disabled during voice replies.",
    );
    return true;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function buildStatusReplyMarkup(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
  sectionRegistry?: TelegramSectionRegistry,
  isVoiceReplyActive?: boolean,
  planModeOptions?: { isEnabled: boolean; isActive: boolean },
): TelegramReplyMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([
    {
      text: formatStatusButtonLabel(
        `${formatTelegramCommandEmojiPrefix("model")}Model`,
        activeModel ? getCanonicalModelId(activeModel) : "unknown",
      ),
      callback_data: "menu:model",
    },
  ]);
  if (activeModel?.reasoning && !isVoiceReplyActive) {
    rows.push([
      {
        text: formatStatusButtonLabel(
          `${formatTelegramCommandEmojiPrefix("thinking")}Thinking`,
          currentThinkingLevel,
        ),
        callback_data: "menu:thinking",
      },
    ]);
  }
  rows.push([
    {
      text: `${queueItemCount === 0 ? "⌛" : "⏳"} Queue: ${queueItemCount}`,
      callback_data: "menu:queue",
    },
  ]);
  if (planModeOptions?.isEnabled) {
    const isPlanOn = planModeOptions.isActive;
    rows.push([
      {
        text: `${isPlanOn ? "🟢 " : ""}📝 Plan on`,
        callback_data: "plan:enter",
      },
      {
        text: "⏸ Pause",
        callback_data: "plan:pause",
      },
      {
        text: `${!isPlanOn ? "🟢 " : ""}⏹ Exit`,
        callback_data: "plan:exit",
      },
    ]);
  }
  if (sectionRegistry) {
    const sectionRows = getTelegramSectionMainMenuRows(sectionRegistry);
    for (const row of sectionRows) {
      rows.push([row]);
    }
  }
  rows.push([
    {
      text: "⚙️ Settings",
      callback_data: "menu:settings",
    },
  ]);
  return { inline_keyboard: rows };
}

export function buildTelegramStatusMenuRenderPayload(
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
  sectionRegistry?: TelegramSectionRegistry,
  isVoiceReplyActive?: boolean,
  planModeOptions?: { isEnabled: boolean; isActive: boolean },
): TelegramMenuRenderPayload {
  return {
    nextMode: "status",
    text: statusText,
    mode: "html",
    replyMarkup: buildStatusReplyMarkup(
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
      planModeOptions,
    ),
  };
}

export async function updateTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
  queueItemCount = 0,
  sectionRegistry?: TelegramSectionRegistry,
  isVoiceReplyActive?: boolean,
): Promise<void> {
  await editTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
    ),
    deps,
  );
}

export function sendTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
  queueItemCount = 0,
  sectionRegistry?: TelegramSectionRegistry,
  isVoiceReplyActive?: boolean,
): Promise<number | undefined> {
  return sendTelegramMenuMessage(
    state,
    buildTelegramStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
    ),
    deps,
  );
}
