/**
 * Tests for Telegram plan review card and overlay driving runtime
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  readTelegramPlanProposalDetails,
  planTelegramPlanReviewKeystrokes,
  buildTelegramPlanReviewCard,
  createTelegramPlanReviewRuntime,
  TELEGRAM_PLAN_REVIEW_CALLBACK_PREFIX,
} from "../lib/plan-review.ts";
import { createTelegramTuiInputRuntime } from "../lib/tui-input.ts";
import type { TelegramDeliveryHandle, TelegramDeliveryResult } from "../lib/delivery.ts";

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

test("buildTelegramPlanReviewCard bounds message length and truncates gracefully", () => {
  const largeBody = "x".repeat(20000);
  const card = buildTelegramPlanReviewCard({
    title: "Big Plan",
    planFilePath: "local://big.md",
    planContent: largeBody,
    offerKeepContext: true,
    requestId: "req1",
  });

  assert.ok(card.text.length <= 3800, `Text too long: ${card.text.length}`);
  assert.ok(card.text.includes("Big Plan"));
  assert.ok(card.text.includes("[plan truncated — full text in local://big.md]"));
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

  const verdict = await runtime.resolveFromUpdate({
    callback_query: {
      id: "cb_1",
      data: approveCompactCb,
    },
  });
  assert.equal(verdict, "consume");
  assert.deepEqual(sentKeystrokes, ["j\r"]);
  assert.ok(editedView.text.includes("✅ Approve and compact context (from Telegram)"));
  assert.equal(editedView.replyMarkup.inline_keyboard.length, 0);

  sentKeystrokes.length = 0;
  const verdict2 = await runtime.resolveFromUpdate({
    callback_query: {
      id: "cb_2",
      data: approveCompactCb,
    },
  });
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
