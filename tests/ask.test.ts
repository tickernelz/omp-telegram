/**
 * Regression tests for the Telegram ask surface race
 * Zones: telegram ask bridge, host delegation, runtime diagnostics
 * Covers surface selection and the degradation signal when a native ask is expected but absent
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramAskRuntime } from "../lib/ask.ts";

interface RecordedEvent {
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

function createAskHarness(options: {
  hasUI: boolean;
  invokeTool?: boolean;
  activeTurn?: unknown;
}) {
  const events: RecordedEvent[] = [];
  const sent: string[] = [];
  const runtime = createTelegramAskRuntime({
    getActiveTurn: () => options.activeTurn ?? { chatId: 77 },
    answerCallbackQuery: async () => {},
    recordRuntimeEvent: (category, error, details) => {
      events.push({
        category,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    },
    sendView: async (view) => {
      sent.push(view.text);
      return {
        ok: true,
        value: { target: { chatId: 77 }, messageIds: [1], generation: "g1" },
      };
    },
    editView: async (handle) => ({ ok: true, value: handle }),
  });

  const tools = new Map<string, { execute: Function }>();
  runtime.register({
    registerTool: (definition: { name: string; execute: Function }) => {
      tools.set(definition.name, definition);
    },
  } as never);

  const ctx: Record<string, unknown> = { hasUI: options.hasUI };
  if (options.invokeTool) {
    ctx.invokeTool = async () => ({
      content: [{ type: "text", text: "native answered" }],
      details: {},
    });
  }
  return { events, sent, tool: tools.get("ask")!, ctx };
}

const question = {
  questions: [
    { id: "q", question: "Which surface?", options: [{ label: "A" }, { label: "B" }] },
  ],
};

await test("ask reports a degraded surface when an interactive session exposes no native ask", async () => {
  const harness = createAskHarness({ hasUI: true, invokeTool: false });
  const controller = new AbortController();
  const pending = harness.tool.execute("call-1", question, controller.signal, undefined, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pending.catch(() => undefined);

  const degraded = harness.events.filter((event) => event.details?.phase === "surface-degraded");
  assert.equal(degraded.length, 1, "an interactive session losing native ask must be recorded");
  assert.equal(degraded[0]?.category, "ask");
  assert.match(degraded[0]?.message ?? "", /Telegram alone/);
});

await test("ask stays silent about a missing native surface when the session is headless", async () => {
  const harness = createAskHarness({ hasUI: false, invokeTool: false });
  const controller = new AbortController();
  const pending = harness.tool.execute("call-2", question, controller.signal, undefined, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await pending.catch(() => undefined);

  assert.deepEqual(
    harness.events.filter((event) => event.details?.phase === "surface-degraded"),
    [],
    "a headless session has no TUI to lose, so the notice would be noise",
  );
});

await test("ask stays silent when the native surface is present", async () => {
  const harness = createAskHarness({ hasUI: true, invokeTool: true });
  const result = await harness.tool.execute("call-3", question, undefined, undefined, harness.ctx);

  assert.equal(
    harness.events.some((event) => event.details?.phase === "surface-degraded"),
    false,
  );
  assert.match(String(result.content?.[0]?.text ?? ""), /native answered/);
});

await test("dismissing the local dialog leaves the Telegram question answerable", async () => {
  const events: RecordedEvent[] = [];
  let telegramSends = 0;
  let dialogDismissed = false;
  const runtime = createTelegramAskRuntime({
    getActiveTurn: () => ({ chatId: 77 }),
    recordRuntimeEvent: (category, error, details) => {
      events.push({
        category,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    },
    sendView: async () => {
      telegramSends += 1;
      return {
        ok: true,
        value: { target: { chatId: 77 }, messageIds: [1], generation: "g1" },
      };
    },
    editView: async (handle) => ({ ok: true, value: handle }),
  });
  const tools = new Map<string, { execute: Function }>();
  runtime.register({
    registerTool: (definition: { name: string; execute: Function }) => {
      tools.set(definition.name, definition);
    },
  } as never);

  let aborted = false;
  const ctx = {
    hasUI: true,
    abort: () => {
      aborted = true;
    },
    ui: {
      askDialog: async () => {
        dialogDismissed = true;
        return undefined;
      },
    },
  };

  const controller = new AbortController();
  const pending = tools.get("ask")!.execute("call-dismiss", question, controller.signal, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dialogDismissed, true, "the local dialog must have been offered");
  assert.equal(telegramSends, 1, "Telegram must still have been asked");
  assert.equal(runtime.hasPending(), true, "the Telegram question must stay answerable after a dismissed dialog");
  assert.equal(aborted, false, "dismissing one surface must never abort the turn");
  assert.deepEqual(
    events.filter((event) => event.details?.phase === "arm"),
    [],
    "a dismissed dialog is a lost race, not a failure worth recording",
  );

  controller.abort();
  await pending.catch(() => undefined);
});

await test("the local dialog answer wins and names its surface", async () => {
  const runtime = createTelegramAskRuntime({
    getActiveTurn: () => ({ chatId: 77 }),
    sendView: async () => ({
      ok: true,
      value: { target: { chatId: 77 }, messageIds: [1], generation: "g1" },
    }),
    editView: async (handle) => ({ ok: true, value: handle }),
  });
  const tools = new Map<string, { execute: Function }>();
  runtime.register({
    registerTool: (definition: { name: string; execute: Function }) => {
      tools.set(definition.name, definition);
    },
  } as never);

  const ctx = {
    hasUI: true,
    ui: {
      askDialog: async () => ({
        kind: "submit",
        results: [
          {
            id: "q",
            question: "Which surface?",
            options: ["A", "B"],
            multi: false,
            selectedOptions: ["A"],
          },
        ],
      }),
    },
  };

  const result = await tools.get("ask")!.execute("call-win", question, undefined, undefined, ctx);
  assert.match(String(result.content?.[0]?.text ?? ""), /User selected: A/);
  assert.match(String(result.content?.[0]?.text ?? ""), /Answered via CLI\./);
  assert.equal(result.details?.answeredVia, "cli");
});


await test("an ask callback this process does not own is left for bus routing", async () => {
  const runtime = createTelegramAskRuntime({
    getActiveTurn: () => ({ chatId: 77 }),
    sendView: async () => ({
      ok: true,
      value: { target: { chatId: 77 }, messageIds: [1], generation: "g1" },
    }),
    editView: async (handle) => ({ ok: true, value: handle }),
  });

  const foreign = {
    callback_query: {
      id: "cb-foreign",
      data: "tgask:deadbeef01:o0",
      message: { message_id: 9, chat: { id: 77 } },
      from: { id: 7 },
    },
  };

  assert.equal(runtime.hasPending(), false, "precondition: nothing pending here");
  assert.equal(
    await runtime.resolveFromUpdate(foreign),
    "pass",
    "consuming a foreign ask callback would stop the leader forwarding it to the instance that is waiting",
  );
});

await test("an ask callback this process owns is consumed", async () => {
  const runtime = createTelegramAskRuntime({
    getActiveTurn: () => ({ chatId: 77 }),
    answerCallbackQuery: async () => {},
    sendView: async (view) => {
      sentMarkup = view.replyMarkup;
      return {
        ok: true,
        value: { target: { chatId: 77 }, messageIds: [5], generation: "g1" },
      };
    },
    editView: async (handle) => ({ ok: true, value: handle }),
  });
  let sentMarkup: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
  const tools = new Map<string, { execute: Function }>();
  runtime.register({
    registerTool: (definition: { name: string; execute: Function }) => {
      tools.set(definition.name, definition);
    },
  } as never);

  const controller = new AbortController();
  const pending = tools.get("ask")!.execute("call-own", question, controller.signal, undefined, { hasUI: false });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const data = sentMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
  assert.ok(data?.startsWith("tgask:"), "the keyboard must carry an ask callback");
  const verdict = await runtime.resolveFromUpdate({
    callback_query: {
      id: "cb-own",
      data,
      message: { message_id: 5, chat: { id: 77 } },
      from: { id: 7 },
    },
  });
  assert.equal(verdict, "consume", "an owned ask callback must not reach default routing");
  const result = await pending;
  assert.match(String(result.content?.[0]?.text ?? ""), /Answered via Telegram\./);
  controller.abort();
});

await test("ask delivers questions directly through Telegram API runtime", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const editCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const ownership: Array<unknown> = [];
  const api = {
    async sendMessage(body: Record<string, unknown>) {
      sentBodies.push(body);
      return { message_id: 1234 };
    },
    async call(method: string, body: Record<string, unknown>) {
      editCalls.push({ method, body });
      return true;
    },
  };
  const runtime = createTelegramAskRuntime({
    api: api as never,
    recordOwnership: (record) => ownership.push(record),
    getAllowedChatId: () => 77,
    getDefaultTarget: () => ({ chatId: 77, threadId: 10 }),
    getActiveTurn: () => undefined,
    answerCallbackQuery: async () => {},
  });
  const tools = new Map<string, { execute: Function }>();
  runtime.register({
    registerTool: (definition: { name: string; execute: Function }) => {
      tools.set(definition.name, definition);
    },
  } as never);

  const controller = new AbortController();
  const pending = tools.get("ask")!.execute("call-api", question, controller.signal, undefined, { hasUI: false });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].chat_id, 77);
  assert.equal(sentBodies[0].message_thread_id, 10);
  assert.equal(ownership.length, 1);

  const markup = sentBodies[0].reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  const data = markup?.inline_keyboard?.[0]?.[0]?.callback_data;
  assert.ok(data?.startsWith("tgask:"));

  const verdict = await runtime.resolveFromUpdate({
    callback_query: {
      id: "cb-api",
      data,
      message: { message_id: 1234, chat: { id: 77 } },
      from: { id: 77 },
    },
  });
  assert.equal(verdict, "consume");
  const result = await pending;
  assert.match(String(result.content?.[0]?.text ?? ""), /Answered via Telegram\./);
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].method, "editMessageText");
  controller.abort();
});

