/**
 * Tests for Telegram plan review card and overlay driving runtime
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTelegramPlanProposalDetails,
  planTelegramPlanReviewKeystrokes,
  buildTelegramPlanReviewCard,
  createTelegramPlanReviewRuntime,
  readTelegramPlanFile,
  TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX,
} from "../lib/plan-review.ts";
import { createTelegramTuiInputRuntime } from "../lib/tui-input.ts";
import type { TelegramDeliveryHandle, TelegramDeliveryResult } from "../lib/delivery.ts";

const PLAN_REVIEW_OWNER_ID = 4242;

function planCallbackUpdate(
  id: string,
  data: string,
  sender: { id?: number; is_bot?: boolean; chatType?: string } = {},
) {
  return {
    callback_query: {
      id,
      data,
      from: { id: sender.id ?? PLAN_REVIEW_OWNER_ID, is_bot: sender.is_bot ?? false },
      message: { chat: { id: -1001, type: sender.chatType ?? "private" } },
    },
  };
}

test("readTelegramPlanProposalDetails parses propose dispatch and rejects invalid formats", () => {
  const valid = readTelegramPlanProposalDetails("write", {
    details: {
      xdev: {
        tool: "propose",
        mode: "execute",
        inner: {
          planFilePath: "local://x-plan.md",
          title: "Implement auth",
          planExists: true,
        },
      },
    },
  });
  assert.deepEqual(valid, {
    planFilePath: "local://x-plan.md",
    title: "Implement auth",
    planExists: true,
  });

  const validOmp = readTelegramPlanProposalDetails("omp.write", {
    details: {
      xdev: {
        tool: "propose",
        mode: "execute",
        inner: {
          planFilePath: "local://x-plan.md",
          title: "Implement auth",
          planExists: true,
        },
      },
    },
  });
  assert.equal(validOmp?.title, "Implement auth");

  assert.equal(
    readTelegramPlanProposalDetails("edit", {
      details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "p", title: "t", planExists: true } } },
    }),
    undefined,
  );
  assert.equal(
    readTelegramPlanProposalDetails("write", {
      details: { xdev: { tool: "resolve", mode: "execute", inner: { planFilePath: "p", title: "t", planExists: true } } },
    }),
    undefined,
  );
  assert.equal(
    readTelegramPlanProposalDetails("write", {
      details: { xdev: { tool: "propose", mode: "preview", inner: { planFilePath: "p", title: "t", planExists: true } } },
    }),
    undefined,
  );
  assert.equal(
    readTelegramPlanProposalDetails("write", {
      details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "p", title: "t" } } },
    }),
    undefined,
  );
});

test("planTelegramPlanReviewKeystrokes maps choices to precise keystroke sequences", () => {
  assert.equal(planTelegramPlanReviewKeystrokes("approve-execute"), "\r");
  assert.equal(planTelegramPlanReviewKeystrokes("approve-compact"), "j\r");
  assert.equal(planTelegramPlanReviewKeystrokes("approve-keep"), "jj\r");
  assert.equal(planTelegramPlanReviewKeystrokes("refine"), "jjjjjjjj\r");
});

test("buildTelegramPlanReviewCard preserves full plan details without truncation", () => {
  const largeBody = "x".repeat(20000);
  const card = buildTelegramPlanReviewCard({
    title: "Big Plan",
    planFilePath: "local://big.md",
    planContent: largeBody,
    offerKeepContext: true,
    requestId: "req1",
  });

  assert.ok(card.text.includes(largeBody));
  assert.ok(card.text.includes("Big Plan"));
  assert.equal(card.markup.inline_keyboard.length, 4);

  const cardNoKeep = buildTelegramPlanReviewCard({
    title: "Big Plan",
    planFilePath: "local://big.md",
    planContent: "Short plan",
    offerKeepContext: false,
    requestId: "req2",
  });
  assert.equal(cardNoKeep.markup.inline_keyboard.length, 3);
  assert.ok(cardNoKeep.markup.inline_keyboard.every((row) => !row[0]?.text.includes("keep context")));
});

test("createTelegramPlanReviewRuntime drives card send, callback execution, and race handling", async () => {
  const sentKeystrokes: string[] = [];
  const tuiInput = createTelegramTuiInputRuntime({
    writeInput: (data) => sentKeystrokes.push(data),
  });

  let sentView: any = undefined;
  let editedView: any = undefined;
  const answeredCallbacks: Array<{ id: string; text?: string }> = [];

  const fakeHandle: TelegramDeliveryHandle = {
    target: { chatId: 123 },
    messageIds: [999],
    generation: "gen1",
  };

  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    answerCallbackQuery: async (id, text) => {
      answeredCallbacks.push({ id, text });
    },
    tuiInput,
    sendView: async (view) => {
      sentView = view;
      return { ok: true, value: fakeHandle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (_handle, view) => {
      editedView = view;
      return { ok: true, value: fakeHandle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
  });

  const ctx = {
    mode: "tui",
    hasUI: true,
    getContextUsage: () => ({ percent: 50 }),
    cwd: process.cwd(),
  };

  await runtime.onToolExecutionEnd(
    {
      toolName: "write",
      result: {
        details: {
          xdev: {
            tool: "propose",
            mode: "execute",
            inner: {
              planFilePath: "package.json",
              title: "Test plan",
              planExists: true,
            },
          },
        },
      },
    },
    ctx,
  );

  assert.ok(sentView, "View should have been sent");
  assert.ok(sentView.text.includes("Test plan"));
  const keyboard = sentView.replyMarkup.inline_keyboard;
  assert.equal(keyboard.length, 4);

  const approveCompactCb = keyboard[1][0].callback_data;
  assert.ok(approveCompactCb.startsWith(`${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:`));

  const verdict = await runtime.resolveFromUpdate(
    planCallbackUpdate("cb_1", approveCompactCb),
  );
  assert.equal(verdict, "consume");
  assert.deepEqual(sentKeystrokes, ["j\r"]);
  assert.ok(editedView.text.includes("✅ Approve and compact context (from Telegram)"));
  assert.equal(editedView.replyMarkup.inline_keyboard.length, 0);

  sentKeystrokes.length = 0;
  const verdict2 = await runtime.resolveFromUpdate(
    planCallbackUpdate("cb_2", approveCompactCb),
  );
  assert.equal(verdict2, "consume");
  assert.equal(sentKeystrokes.length, 0);
  assert.equal(answeredCallbacks[answeredCallbacks.length - 1]?.text, "This plan review has expired.");

  await runtime.onToolExecutionEnd(
    {
      toolName: "write",
      result: {
        details: {
          xdev: {
            tool: "propose",
            mode: "execute",
            inner: {
              planFilePath: "package.json",
              title: "Second plan",
              planExists: true,
            },
          },
        },
      },
    },
    ctx,
  );

  await runtime.onAgentStart();
  assert.ok(editedView.text.includes("↩️ Decided in CLI"));
  assert.equal(editedView.replyMarkup.inline_keyboard.length, 0);
});

test("createTelegramPlanReviewRuntime respects suppression gates", async () => {
  let sent = false;
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => false,
    getActiveTurn: () => ({ id: "turn1" }),
    tuiInput: createTelegramTuiInputRuntime(),
    sendView: async () => {
      sent = true;
      return { ok: true, value: { target: { chatId: 1 }, messageIds: [1], generation: "g1" } } as any;
    },
  });

  await runtime.onToolExecutionEnd(
    {
      toolName: "write",
      result: {
        details: {
          xdev: {
            tool: "propose",
            mode: "execute",
            inner: { planFilePath: "p", title: "t", planExists: true },
          },
        },
      },
    },
    { mode: "tui", hasUI: true },
  );
  assert.equal(sent, false, "Should not send when disabled");

  const runtime2 = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    tuiInput: createTelegramTuiInputRuntime(),
    sendView: async () => {
      sent = true;
      return { ok: true, value: { target: { chatId: 1 }, messageIds: [1], generation: "g1" } } as any;
    },
  });

  await runtime2.onToolExecutionEnd(
    {
      toolName: "write",
      result: {
        details: {
          xdev: {
            tool: "propose",
            mode: "execute",
            inner: { planFilePath: "p", title: "t", planExists: true },
          },
        },
      },
    },
    { mode: "rpc", hasUI: true },
  );
  assert.equal(sent, false, "Should not send when mode is rpc");
});

const planCtx = {
  mode: "tui",
  hasUI: true,
  getContextUsage: () => ({ percent: 50 }),
  cwd: process.cwd(),
};

function planProposalEvent(title: string) {
  return {
    toolName: "write",
    result: {
      details: {
        xdev: {
          tool: "propose",
          mode: "execute",
          inner: {
            planFilePath: "package.json",
            title,
            planExists: true,
          },
        },
      },
    },
  };
}

test("Plan review reaches the CLI overlay before it reports the decision", async () => {
  const order: string[] = [];
  let sentView: any = undefined;
  let editedView: any = undefined;
  const handle: TelegramDeliveryHandle = {
    target: { chatId: 5 },
    messageIds: [50],
    generation: "gen1",
  };
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    answerCallbackQuery: async () => {
      order.push("answer");
    },
    tuiInput: {
      send: (data: string) => {
        order.push(`send:${data}`);
        return true;
      },
    },
    sendView: async (view) => {
      sentView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (_handle, view) => {
      order.push("edit");
      editedView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
  });

  await runtime.onToolExecutionEnd(planProposalEvent("Ordered plan"), planCtx);
  const callbackData = sentView.replyMarkup.inline_keyboard[0][0].callback_data;
  await runtime.resolveFromUpdate(planCallbackUpdate("cb_order", callbackData));

  assert.deepEqual(order, ["send:\r", "answer", "edit"]);
  assert.ok(editedView.text.includes("✅ Approve and execute (from Telegram)"));
});

test("Plan review reports an overlay that refused the keystrokes", async () => {
  const events: Array<Record<string, unknown>> = [];
  const answers: Array<string | undefined> = [];
  let sentView: any = undefined;
  let editedView: any = undefined;
  const handle: TelegramDeliveryHandle = {
    target: { chatId: 5 },
    messageIds: [51],
    generation: "gen1",
  };
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    answerCallbackQuery: async (_id, text) => {
      answers.push(text);
    },
    tuiInput: { send: () => false },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    sendView: async (view) => {
      sentView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (_handle, view) => {
      editedView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
  });

  await runtime.onToolExecutionEnd(planProposalEvent("Refused plan"), planCtx);
  const callbackData = sentView.replyMarkup.inline_keyboard[0][0].callback_data;
  await runtime.resolveFromUpdate(planCallbackUpdate("cb_refused", callbackData));

  assert.deepEqual(answers, ["Could not reach the CLI overlay."]);
  assert.ok(editedView.text.includes("⚠️ Could not reach the CLI overlay"));
  assert.ok(
    events.some((detail) => detail.phase === "tui-input" && detail.choice === "approve-execute"),
    "a refused overlay must be recorded as a runtime event",
  );
});

test("Plan review rejects a choice the current card never offered", async () => {
  const answers: Array<string | undefined> = [];
  const keystrokes: string[] = [];
  let sentView: any = undefined;
  const handle: TelegramDeliveryHandle = {
    target: { chatId: 5 },
    messageIds: [52],
    generation: "gen1",
  };
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    answerCallbackQuery: async (_id, text) => {
      answers.push(text);
    },
    tuiInput: {
      send: (data: string) => {
        keystrokes.push(data);
        return true;
      },
    },
    sendView: async (view) => {
      sentView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (_handle, _view) =>
      ({ ok: true, value: handle }) as TelegramDeliveryResult<TelegramDeliveryHandle>,
  });

  await runtime.onToolExecutionEnd(
    {
      ...planProposalEvent("Tight context plan"),
    },
    { ...planCtx, getContextUsage: () => ({ percent: 95 }) },
  );
  const offered = sentView.replyMarkup.inline_keyboard.map(
    (row: any) => row[0].callback_data.split(":")[2],
  );
  assert.ok(!offered.includes("approve-keep"), "the card must not offer keeping context");

  const requestId = sentView.replyMarkup.inline_keyboard[0][0].callback_data.split(":")[1];
  const verdict = await runtime.resolveFromUpdate(
    planCallbackUpdate(
      "cb_unavailable",
      `${TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX}:${requestId}:approve-keep`,
    ),
  );

  assert.equal(verdict, "consume");
  assert.deepEqual(answers, ["That option is no longer available."]);
  assert.deepEqual(keystrokes, []);

  const accepted = await runtime.resolveFromUpdate(
    planCallbackUpdate("cb_valid", sentView.replyMarkup.inline_keyboard[0][0].callback_data),
  );
  assert.equal(accepted, "consume");
  assert.deepEqual(keystrokes, ["\r"], "the card must survive an unavailable choice");
});

test("Plan review supersedes an undecided card when a newer plan arrives", async () => {
  const edits: any[] = [];
  const handles: TelegramDeliveryHandle[] = [
    { target: { chatId: 5 }, messageIds: [60], generation: "gen1" },
    { target: { chatId: 5 }, messageIds: [61], generation: "gen1" },
  ];
  let sendCount = 0;
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    tuiInput: { send: () => true },
    sendView: async () => {
      const value = handles[sendCount]!;
      sendCount += 1;
      return { ok: true, value } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (handle, view) => {
      edits.push({ handle, view });
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
  });

  await runtime.onToolExecutionEnd(planProposalEvent("First plan"), planCtx);
  await runtime.onToolExecutionEnd(planProposalEvent("Second plan"), planCtx);

  assert.equal(edits.length, 1, "the stale card must be closed exactly once");
  assert.equal(edits[0].handle, handles[0]);
  assert.ok(edits[0].view.text.includes("⏹ Superseded by a newer plan"));
  assert.deepEqual(edits[0].view.replyMarkup, { inline_keyboard: [] });

  await runtime.cancelAll("Turn ended");
  assert.equal(edits.length, 2);
  assert.equal(edits[1].handle, handles[1], "only the newest card stays pending");
});

test("Plan review records a card edit the delivery layer refused", async () => {
  const events: Array<Record<string, unknown>> = [];
  let sentView: any = undefined;
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    tuiInput: { send: () => true },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    sendView: async (view) => {
      sentView = view;
      return {
        ok: true,
        value: { target: { chatId: 5 }, messageIds: [70], generation: "gen1" },
      } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async () =>
      ({
        ok: false,
        reason: "stale-handle",
        message: "handle belongs to an older generation",
      }) as TelegramDeliveryResult<TelegramDeliveryHandle>,
  });

  await runtime.onToolExecutionEnd(planProposalEvent("Refused edit plan"), planCtx);
  await runtime.resolveFromUpdate(
    planCallbackUpdate("cb_refused_edit", sentView.replyMarkup.inline_keyboard[0][0].callback_data),
  );

  assert.ok(
    events.some(
      (detail) => detail.phase === "edit-view" && detail.reason === "stale-handle",
    ),
    "a refused edit must be recorded as a runtime event",
  );
});

test("Plan review refuses a plan callback from a foreign Thread sender", async () => {
  const keystrokes: string[] = [];
  const answers: Array<string | undefined> = [];
  let sentView: any = undefined;
  const handle: TelegramDeliveryHandle = {
    target: { chatId: -1001, threadId: 7 },
    messageIds: [80],
    generation: "gen1",
  };
  const runtime = createTelegramPlanReviewRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ id: "turn1" }),
    getAllowedUserId: () => PLAN_REVIEW_OWNER_ID,
    answerCallbackQuery: async (_id, text) => {
      answers.push(text);
    },
    tuiInput: {
      send: (data: string) => {
        keystrokes.push(data);
        return true;
      },
    },
    sendView: async (view) => {
      sentView = view;
      return { ok: true, value: handle } as TelegramDeliveryResult<TelegramDeliveryHandle>;
    },
    editView: async (_handle, _view) =>
      ({ ok: true, value: handle }) as TelegramDeliveryResult<TelegramDeliveryHandle>,
  });

  await runtime.onToolExecutionEnd(planProposalEvent("Owned plan"), planCtx);
  const callbackData = sentView.replyMarkup.inline_keyboard[0][0].callback_data;

  assert.equal(
    await runtime.resolveFromUpdate(
      planCallbackUpdate("cb_foreign", callbackData, { id: 9999, chatType: "supergroup" }),
    ),
    "pass",
  );
  assert.equal(
    await runtime.resolveFromUpdate(
      planCallbackUpdate("cb_bot", callbackData, { is_bot: true, chatType: "supergroup" }),
    ),
    "pass",
  );
  assert.deepEqual(keystrokes, [], "a foreign sender must never drive the CLI overlay");
  assert.deepEqual(answers, []);

  assert.equal(
    await runtime.resolveFromUpdate(
      planCallbackUpdate("cb_owner", callbackData, { chatType: "supergroup" }),
    ),
    "consume",
  );
  assert.deepEqual(keystrokes, ["\r"], "the owner still decides the surviving card");
});

test("readTelegramPlanFile keeps a local plan path inside the artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-plan-local-"));
  const scheme = "local:";
  try {
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await writeFile(join(localRoot, "plan.md"), "contained plan", "utf8");
    await writeFile(join(root, "outside.md"), "secret", "utf8");
    const ctx = { localProtocolOptions: { getArtifactsDir: () => root } };

    assert.equal(await readTelegramPlanFile(`${scheme}//plan.md`, ctx), "contained plan");
    await assert.rejects(
      readTelegramPlanFile(`${scheme}//../outside.md`, ctx),
      /escapes the local artifact root/,
    );
    await assert.rejects(
      readTelegramPlanFile(`${scheme}/etc/passwd`, ctx),
      /escapes the local artifact root/,
    );
    await assert.rejects(
      readTelegramPlanFile(`${scheme}//nested/../../outside.md`, ctx),
      /escapes the local artifact root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
