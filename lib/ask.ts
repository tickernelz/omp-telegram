/**
 * Telegram ask tool bridge
 * Zones: pi agent tool, telegram ui, blocking user input
 * Owns the ask tool registration, the pending-question registry, the CLI/Telegram surface race, and answer formatting so Telegram answers reach the agent exactly like the native ask tool
 */

import { Type } from "@sinclair/typebox";

import {
  buildTelegramAskKeyboard,
  createTelegramAskClearedKeyboard,
  createTelegramAskRequestId,
  decodeTelegramAskCallbackData,
  matchesTelegramAskTarget,
  readTelegramAskInboundCallback,
  readTelegramAskInboundText,
  renderTelegramAskAnsweredText,
  renderTelegramAskCustomInputText,
  renderTelegramAskQuestionText,
  renderTelegramAskSupersededText,
  TELEGRAM_ASK_DONE_LABEL,
  type TelegramAskAnswer,
  type TelegramAskInboundCallback,
  type TelegramAskInboundText,
  type TelegramAskPosition,
  type TelegramAskQuestion,
} from "./ask-telegram.ts";
import {
  editTelegramView,
  sendTelegramView,
  type SendTelegramViewOptions,
  type TelegramDeliveryHandle,
  type TelegramDeliveryResult,
  type TelegramDeliveryScope,
  type TelegramDeliveryView,
} from "./delivery.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { markTelegramButtonSelected } from "./outbound-buttons.ts";
import type { AgentToolResult, ExtensionAPI } from "./pi.ts";
import type { TelegramTarget } from "./target.ts";
import {
  createTelegramUpdateExecutionFenceGuard,
  type TelegramUpdateHandler,
  type TelegramUpdateHandlerVerdict,
} from "./updates.ts";

const TELEGRAM_ASK_TOOL_NAME = "ask";
const TELEGRAM_ASK_TOOL_LABEL = "Ask";
const TELEGRAM_ASK_TOOL_DESCRIPTION = [
  "Ask user for clarification/input during task execution.",
  "",
  "- `recommended: <index>` marks default (0-indexed); \" (Recommended)\" added automatically.",
  "- Use `questions` for related questions, not one at a time.",
  "- Set `multi: true` on a question to allow multiple selections.",
  "- Short option labels; explanatory tradeoffs in `description`, not labels.",
  "- Provide 2-5 concise, distinct options.",
  "",
  "Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Ask only when options have materially different tradeoffs the user must decide.",
  "Do NOT include \"Other\"; the interactive surface automatically adds \"Other (type your own)\" to every question.",
].join("\n");

const TelegramAskOptionSchema = Type.Object({
  label: Type.String({ description: "display label" }),
  description: Type.Optional(
    Type.String({
      description: "optional explanatory text displayed below the label",
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description: "optional rich preview content for interactive ask dialogs",
    }),
  ),
});

const TelegramAskQuestionSchema = Type.Object({
  id: Type.String({ description: "question id" }),
  question: Type.String({ description: "question text" }),
  header: Type.Optional(
    Type.String({
      description: "optional short display chip for rich ask dialogs",
    }),
  ),
  options: Type.Array(TelegramAskOptionSchema, {
    description: "available options",
  }),
  multi: Type.Optional(
    Type.Boolean({ description: "allow multiple selections" }),
  ),
  recommended: Type.Optional(
    Type.Number({ description: "recommended option index" }),
  ),
});

const TelegramAskParametersSchema = Type.Object({
  questions: Type.Array(TelegramAskQuestionSchema, {
    minItems: 1,
    description: "questions to ask",
  }),
});

interface TelegramAskQuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

export type TelegramAskSurface = "telegram" | "cli";

interface TelegramAskToolDetails {
  question?: string;
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
  results?: TelegramAskQuestionResult[];
  answeredVia?: TelegramAskSurface;
  chatRedirect?: boolean;
  questions?: string[];
}

export type TelegramAskSendView = (
  view: TelegramDeliveryView,
  options: SendTelegramViewOptions,
) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;

export type TelegramAskEditView = (
  handle: TelegramDeliveryHandle,
  view: TelegramDeliveryView,
) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;

export interface TelegramAskRuntimeDeps {
  getActiveTurn: () => unknown;
  getDefaultTarget?: () => TelegramTarget | undefined;
  sendView?: TelegramAskSendView;
  editView?: TelegramAskEditView;
  answerCallbackQuery?: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramAskRuntime {
  register: (pi: ExtensionAPI) => void;
  resolveFromUpdate: TelegramUpdateHandler;
  hasPending: () => boolean;
  cancelAll: (reason: string) => void;
}

interface TelegramAskPendingRequest {
  id: string;
  question: TelegramAskQuestion;
  position: TelegramAskPosition;
  handle: TelegramDeliveryHandle;
  markup: TelegramInlineKeyboardMarkup;
  selected: Set<number>;
  awaitingCustomInput: boolean;
  settled: boolean;
  resolvedCallbackData?: string;
  resolve: (answer: TelegramAskAnswer) => void;
  reject: (error: Error) => void;
}

class TelegramAskCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

class TelegramAskDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAskDeliveryError";
  }
}

const TELEGRAM_ASK_SOURCE_NOTES: Record<TelegramAskSurface, string> = {
  telegram: "Answered via Telegram.",
  cli: "Answered via CLI.",
};

interface TelegramAskArm {
  surface: TelegramAskSurface;
  run: (signal: AbortSignal) => Promise<AgentToolResult<TelegramAskToolDetails>>;
}

function isTelegramAskAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function markTelegramAskAnswerSource(
  result: AgentToolResult<TelegramAskToolDetails>,
  surface: TelegramAskSurface,
): AgentToolResult<TelegramAskToolDetails> {
  const note = TELEGRAM_ASK_SOURCE_NOTES[surface];
  const content = [...result.content];
  const last = content.at(-1);
  if (last && last.type === "text") {
    content[content.length - 1] = { ...last, text: `${last.text}\n${note}` };
  } else {
    content.push({ type: "text" as const, text: note });
  }
  return {
    ...result,
    content,
    details: { ...(result.details ?? {}), answeredVia: surface },
  };
}

type TelegramAskNativeDelegate = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<AgentToolResult<unknown>>;

function getTelegramAskNativeDelegate(
  ctx: unknown,
): TelegramAskNativeDelegate | undefined {
  const host = ctx as { invokeTool?: unknown } | undefined;
  if (!host || typeof host.invokeTool !== "function") return undefined;
  return (host.invokeTool as TelegramAskNativeDelegate).bind(host);
}

/** True when the host claims a local interactive surface, so a missing native ask is a degradation rather than headless operation. */
function hasInteractiveSurface(ctx: unknown): boolean {
  const host = ctx as { hasUI?: unknown } | undefined;
  return host?.hasUI === true;
}

interface TelegramAskDialogResultItem {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

type TelegramAskDialogResult =
  | { kind: "submit"; results: TelegramAskDialogResultItem[] }
  | { kind: "chat" };

type TelegramAskDialogSurface = (
  questions: unknown[],
  dialogOptions?: { signal?: AbortSignal },
) => Promise<TelegramAskDialogResult | undefined>;

/** The host's own rich ask dialog. Driving it directly keeps a dismissed dialog from aborting the turn, which the native ask tool does by contract. */
function getTelegramAskDialogSurface(
  ctx: unknown,
): TelegramAskDialogSurface | undefined {
  const ui = (ctx as { ui?: { askDialog?: unknown } } | undefined)?.ui;
  if (!ui || typeof ui.askDialog !== "function") return undefined;
  return (ui.askDialog as TelegramAskDialogSurface).bind(ui);
}

class TelegramAskDeclinedError extends Error {
  constructor() {
    super("The local ask dialog was dismissed without an answer.");
    this.name = "AbortError";
  }
}

async function runTelegramAskDialog(
  askDialog: TelegramAskDialogSurface,
  questions: readonly { question: string }[],
  signal: AbortSignal,
): Promise<AgentToolResult<TelegramAskToolDetails>> {
  const outcome = await askDialog([...questions], { signal });
  if (!outcome) throw new TelegramAskDeclinedError();
  if (outcome.kind === "chat") {
    return {
      content: [
        {
          type: "text" as const,
          text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questions
            .map((entry) => entry.question)
            .join("\n")}`,
        },
      ],
      details: {
        chatRedirect: true,
        questions: questions.map((entry) => entry.question),
      },
    };
  }
  return buildTelegramAskToolResult(
    outcome.results.map((result) => ({
      id: result.id,
      question: result.question,
      options: result.options,
      multi: result.multi,
      selectedOptions: result.selectedOptions,
      ...(result.customInput !== undefined
        ? { customInput: result.customInput }
        : {}),
    })),
  );
}

function normalizeTelegramAskQuestion(question: {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multi?: boolean;
  recommended?: number;
}): TelegramAskQuestion {
  const options = question.options.map((option) => ({
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.preview ? { preview: option.preview } : {}),
  }));
  const recommended =
    typeof question.recommended === "number" &&
    Number.isSafeInteger(question.recommended) &&
    question.recommended >= 0 &&
    question.recommended < options.length
      ? question.recommended
      : undefined;
  const header = question.header?.trim();
  return {
    id: question.id,
    question: question.question,
    ...(header ? { header } : {}),
    options,
    multi: question.multi === true,
    ...(recommended !== undefined ? { recommended } : {}),
  };
}

function formatTelegramAskQuestionResult(
  result: TelegramAskQuestionResult,
): string {
  if (result.customInput !== undefined) {
    return `${result.id}: "${result.customInput}"`;
  }
  if (result.selectedOptions.length > 0) {
    return result.multi
      ? `${result.id}: [${result.selectedOptions.join(", ")}]`
      : `${result.id}: ${result.selectedOptions[0]}`;
  }
  return result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`;
}

function formatTelegramAskSingleResponse(result: {
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}): string {
  const responseParts: string[] = [];
  if (result.selectedOptions.length > 0) {
    responseParts.push(
      result.multi
        ? `User selected: ${result.selectedOptions.join(", ")}`
        : `User selected: ${result.selectedOptions[0]}`,
    );
  }
  if (result.customInput !== undefined) {
    responseParts.push(
      result.customInput.includes("\n")
        ? `User provided custom input:\n${result.customInput
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`
        : `User provided custom input: ${result.customInput}`,
    );
  }
  if (responseParts.length > 0) return responseParts.join("\n");
  return result.multi
    ? "User did not select any options"
    : "User cancelled the selection";
}

function buildTelegramAskToolResult(
  results: TelegramAskQuestionResult[],
): AgentToolResult<TelegramAskToolDetails> {
  const single = results.length === 1 ? results[0] : undefined;
  if (single) {
    return {
      content: [
        { type: "text" as const, text: formatTelegramAskSingleResponse(single) },
      ],
      details: {
        question: single.question,
        options: single.options,
        multi: single.multi,
        selectedOptions: single.selectedOptions,
        ...(single.customInput !== undefined
          ? { customInput: single.customInput }
          : {}),
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `User answers:\n${results
          .map(formatTelegramAskQuestionResult)
          .join("\n")}`,
      },
    ],
    details: { results },
  };
}

function buildTelegramAskUnavailableResult(
  reason: string,
  results: TelegramAskQuestionResult[] = [],
): AgentToolResult<TelegramAskToolDetails> {
  const lines = [
    `Ask could not reach the user: ${reason}`,
    "No interactive surface is attached to this session, so the questions cannot be answered. Choose the most conservative reasonable default, proceed, and state the assumption.",
  ];
  if (results.length > 0) {
    lines.push("");
    lines.push("Answers collected before the failure:");
    lines.push(...results.map(formatTelegramAskQuestionResult));
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    isError: true,
    ...(results.length > 0 ? { details: { results } } : {}),
  };
}

export function createTelegramAskRuntime(
  deps: TelegramAskRuntimeDeps,
): TelegramAskRuntime {
  const pendingRequests = new Map<string, TelegramAskPendingRequest>();
  const sendView = deps.sendView ?? sendTelegramView;
  const editView = deps.editView ?? editTelegramView;

  const record = (error: unknown, details: Record<string, unknown>): void => {
    deps.recordRuntimeEvent?.("ask", error, details);
  };

  const resolveScope = (): TelegramDeliveryScope | undefined => {
    if (deps.getActiveTurn() !== undefined) return { kind: "active-turn" };
    const target = deps.getDefaultTarget?.();
    return target ? { kind: "target", target } : undefined;
  };

  const answerCallback = async (
    callbackQueryId: string | undefined,
    text?: string,
  ): Promise<void> => {
    if (!callbackQueryId || !deps.answerCallbackQuery) return;
    try {
      await deps.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      record(error, { phase: "answer-callback" });
    }
  };

  const applyView = async (
    pending: TelegramAskPendingRequest,
    text: string,
    assertCurrent?: () => void,
  ): Promise<void> => {
    try {
      assertCurrent?.();
      const edited = await editView(pending.handle, {
        text,
        parseMode: "plain",
        replyMarkup: pending.markup,
      });
      if (!edited.ok) record(edited.message, { phase: "edit", id: pending.id });
    } catch (error) {
      record(error, { phase: "edit", id: pending.id });
    }
  };

  const collectSelectedLabels = (
    pending: TelegramAskPendingRequest,
  ): string[] =>
    [...pending.selected]
      .sort((left, right) => left - right)
      .map((index) => pending.question.options[index]?.label)
      .filter((label): label is string => typeof label === "string");

  const settle = (
    pending: TelegramAskPendingRequest,
    answer: TelegramAskAnswer,
  ): void => {
    if (pending.settled) return;
    pending.settled = true;
    pendingRequests.delete(pending.id);
    pending.resolve(answer);
  };

  const finalize = async (
    pending: TelegramAskPendingRequest,
    answer: TelegramAskAnswer,
  ): Promise<void> => {
    if (pending.resolvedCallbackData) {
      pending.markup =
        markTelegramButtonSelected(
          pending.markup,
          pending.resolvedCallbackData,
          "primary",
        ) ?? pending.markup;
    }
    await applyView(
      pending,
      renderTelegramAskAnsweredText(pending.question, pending.position, answer),
    );
  };

  const supersede = async (
    pending: TelegramAskPendingRequest,
  ): Promise<void> => {
    pending.awaitingCustomInput = false;
    pending.markup = createTelegramAskClearedKeyboard();
    await applyView(
      pending,
      renderTelegramAskSupersededText(pending.question, pending.position),
    );
  };

  const askQuestion = async (
    question: TelegramAskQuestion,
    position: TelegramAskPosition,
    scope: TelegramDeliveryScope,
    signal: AbortSignal | undefined,
  ): Promise<TelegramAskAnswer> => {
    if (signal?.aborted) {
      throw new TelegramAskCancelledError("Ask input was cancelled");
    }
    const id = createTelegramAskRequestId();
    const selected = new Set<number>();
    const markup = buildTelegramAskKeyboard(id, question, selected);
    const sent = await sendView(
      {
        text: renderTelegramAskQuestionText(question, position),
        parseMode: "plain",
        replyMarkup: markup,
      },
      { scope },
    );
    if (!sent.ok) {
      throw new TelegramAskDeliveryError(
        `Telegram rejected the question message (${sent.reason}).`,
      );
    }
    let pending: TelegramAskPendingRequest | undefined;
    let detachAbort = (): void => {};
    let cancelledBySignal = false;
    const waitForAnswer = new Promise<TelegramAskAnswer>((resolve, reject) => {
      const request: TelegramAskPendingRequest = {
        id,
        question,
        position,
        handle: sent.value,
        markup,
        selected,
        awaitingCustomInput: false,
        settled: false,
        resolve,
        reject,
      };
      pending = request;
      pendingRequests.set(id, request);
      if (!signal) return;
      const onAbort = (): void => {
        if (request.settled) return;
        request.settled = true;
        cancelledBySignal = true;
        pendingRequests.delete(id);
        reject(new TelegramAskCancelledError("Ask input was cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = (): void => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      const answer = await waitForAnswer;
      if (pending) await finalize(pending, answer);
      return answer;
    } catch (error) {
      if (pending && cancelledBySignal) await supersede(pending);
      throw error;
    } finally {
      detachAbort();
      pendingRequests.delete(id);
    }
  };

  const runTelegramAsk = async (
    questions: TelegramAskQuestion[],
    scope: TelegramDeliveryScope,
    results: TelegramAskQuestionResult[],
    signal: AbortSignal,
  ): Promise<AgentToolResult<TelegramAskToolDetails>> => {
    for (const [index, question] of questions.entries()) {
      const answer = await askQuestion(
        question,
        { index, total: questions.length },
        scope,
        signal,
      );
      results.push({
        id: question.id,
        question: question.question,
        options: question.options.map((option) => option.label),
        multi: question.multi,
        selectedOptions: answer.selectedOptions,
        ...(answer.customInput !== undefined
          ? { customInput: answer.customInput }
          : {}),
      });
    }
    return buildTelegramAskToolResult(results);
  };

  const raceAskArms = async (
    arms: TelegramAskArm[],
    outer: AbortSignal | undefined,
  ): Promise<AgentToolResult<TelegramAskToolDetails>> => {
    if (outer?.aborted) {
      throw new TelegramAskCancelledError("Ask input was cancelled");
    }
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    let settled = false;
    try {
      return await new Promise<AgentToolResult<TelegramAskToolDetails>>(
        (resolve, reject) => {
          let running = arms.length;
          let failure: unknown;
          for (const arm of arms) {
            void arm.run(controller.signal).then(
              (result) => {
                running -= 1;
                if (settled) return;
                settled = true;
                resolve(markTelegramAskAnswerSource(result, arm.surface));
              },
              (error: unknown) => {
                running -= 1;
                if (!isTelegramAskAbortError(error)) {
                  record(error, { phase: "arm", surface: arm.surface });
                }
                if (settled) return;
                if (failure === undefined || isTelegramAskAbortError(failure)) {
                  failure = error;
                }
                if (running > 0) return;
                settled = true;
                reject(
                  outer?.aborted
                    ? new TelegramAskCancelledError("Ask input was cancelled")
                    : failure,
                );
              },
            );
          }
        },
      );
    } finally {
      settled = true;
      controller.abort();
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };

  const handleCallback = async (
    callback: TelegramAskInboundCallback,
    update: unknown,
  ): Promise<TelegramUpdateHandlerVerdict> => {
    const selection = decodeTelegramAskCallbackData(callback.data);
    const pending = selection
      ? pendingRequests.get(selection.requestId)
      : undefined;
    if (!selection || !pending) {
      return "pass";
    }
    const assertCurrent = createTelegramUpdateExecutionFenceGuard(update);
    const { token } = selection;
    if (token.kind === "other") {
      pending.awaitingCustomInput = true;
      pending.markup = createTelegramAskClearedKeyboard();
      await answerCallback(callback.id, "Send your answer as a message.");
      await applyView(
        pending,
        renderTelegramAskCustomInputText(pending.question, pending.position),
        assertCurrent,
      );
      return "consume";
    }
    if (token.kind === "done") {
      if (!pending.question.multi) {
        await answerCallback(callback.id, "This question takes one answer.");
        return "consume";
      }
      pending.resolvedCallbackData = callback.data;
      settle(pending, { selectedOptions: collectSelectedLabels(pending) });
      await answerCallback(callback.id, "Answer recorded.");
      return "consume";
    }
    const option = pending.question.options[token.index];
    if (!option) {
      await answerCallback(callback.id, "That option is no longer available.");
      return "consume";
    }
    if (!pending.question.multi) {
      pending.resolvedCallbackData = callback.data;
      settle(pending, { selectedOptions: [option.label] });
      await answerCallback(callback.id, "Answer recorded.");
      return "consume";
    }
    if (pending.selected.has(token.index)) pending.selected.delete(token.index);
    else pending.selected.add(token.index);
    pending.markup = buildTelegramAskKeyboard(
      pending.id,
      pending.question,
      pending.selected,
    );
    await answerCallback(
      callback.id,
      pending.selected.size === 0
        ? `Nothing selected yet. Press "${TELEGRAM_ASK_DONE_LABEL}" when ready.`
        : `${pending.selected.size} selected.`,
    );
    await applyView(
      pending,
      renderTelegramAskQuestionText(pending.question, pending.position),
      assertCurrent,
    );
    return "consume";
  };

  const handleText = (
    inbound: TelegramAskInboundText,
  ): TelegramUpdateHandlerVerdict => {
    for (const pending of pendingRequests.values()) {
      if (!pending.awaitingCustomInput) continue;
      if (!matchesTelegramAskTarget(pending.handle.target, inbound.target)) {
        continue;
      }
      settle(pending, { selectedOptions: [], customInput: inbound.text });
      return "consume";
    }
    return "pass";
  };

  const resolveFromUpdate: TelegramUpdateHandler = async (update) => {
    const callback = readTelegramAskInboundCallback(update);
    if (callback) {
      try {
        return await handleCallback(callback, update);
      } catch (error) {
        record(error, { phase: "resolve-callback" });
        return "consume";
      }
    }
    if (pendingRequests.size === 0) return "pass";
    try {
      const inbound = readTelegramAskInboundText(update);
      if (inbound) return handleText(inbound);
    } catch (error) {
      record(error, { phase: "resolve-text" });
    }
    return "pass";
  };

  const register = (pi: ExtensionAPI): void => {
    pi.registerTool({
      name: TELEGRAM_ASK_TOOL_NAME,
      label: TELEGRAM_ASK_TOOL_LABEL,
      description: TELEGRAM_ASK_TOOL_DESCRIPTION,
      approval: "read",
      strict: true,
      parameters: TelegramAskParametersSchema,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const askDialog = getTelegramAskDialogSurface(ctx);
        const nativeDelegate = askDialog
          ? undefined
          : getTelegramAskNativeDelegate(ctx);
        const scope = resolveScope();
        if (!askDialog && !nativeDelegate && !scope) {
          return buildTelegramAskUnavailableResult(
            "no Telegram turn is active and this session exposes no native ask surface.",
          );
        }
        const delegateParams = params as unknown as Record<string, unknown>;
        if (!askDialog && !nativeDelegate && scope && hasInteractiveSurface(ctx)) {
          deps.recordRuntimeEvent?.(
            "ask",
            new Error(
              "Native ask delegation is unavailable although this session reports an interactive surface; answering falls back to Telegram alone.",
            ),
            { phase: "surface-degraded", questions: params.questions.length },
          );
        }
        const arms: TelegramAskArm[] = [];
        if (askDialog) {
          arms.push({
            surface: "cli",
            run: (armSignal) =>
              runTelegramAskDialog(askDialog, params.questions, armSignal),
          });
        } else if (nativeDelegate) {
          arms.push({
            surface: "cli",
            run: (armSignal) =>
              nativeDelegate(delegateParams, {
                signal: armSignal,
              }) as Promise<AgentToolResult<TelegramAskToolDetails>>,
          });
        }
        const results: TelegramAskQuestionResult[] = [];
        if (scope) {
          const questions = params.questions.map(normalizeTelegramAskQuestion);
          arms.push({
            surface: "telegram",
            run: (armSignal) =>
              runTelegramAsk(questions, scope, results, armSignal),
          });
        }
        try {
          return await raceAskArms(arms, signal);
        } catch (error) {
          if (!(error instanceof TelegramAskDeliveryError)) throw error;
          return buildTelegramAskUnavailableResult(error.message, results);
        }
      },
    });
  };

  return {
    register,
    resolveFromUpdate,
    hasPending: () => pendingRequests.size > 0,
    cancelAll: (reason: string) => {
      const pendings = [...pendingRequests.values()];
      pendingRequests.clear();
      for (const pending of pendings) {
        if (pending.settled) continue;
        pending.settled = true;
        pending.reject(new TelegramAskCancelledError(reason));
      }
    },
  };
}
