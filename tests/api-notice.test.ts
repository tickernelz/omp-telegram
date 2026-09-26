/**
 * Regression tests for Telegram outbound API failure notices
 * Zones: telegram api diagnostics, operator notices, chat delivery
 * Covers failure classification, per-class coalescing, target authorization, and fail-soft notice delivery
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTelegramApiFailure,
  createTelegramApiNoticeClient,
  createTelegramApiNoticeRuntime,
  formatTelegramApiFailureNotice,
} from "../lib/api-notice.ts";
import { TelegramApiHttpError } from "../lib/telegram-api.ts";

interface RecordedEvent {
  phase?: string;
  kind?: string;
  method?: string;
}

function createHarness(options?: {
  target?: { chatId: number; threadId?: number };
  allowedChatId?: number;
  sendFails?: boolean;
  now?: { value: number };
  recordThrows?: boolean;
}) {
  const sent: Array<{ text: string; target: { chatId: number; threadId?: number } }> = [];
  const events: RecordedEvent[] = [];
  const hasTarget = options !== undefined && "target" in options;
  const runtime = createTelegramApiNoticeRuntime({
    getTarget: () =>
      hasTarget ? options.target : { chatId: 191060132, threadId: 160751 },
    ...(options?.allowedChatId !== undefined
      ? { getAllowedChatId: () => options.allowedChatId! }
      : {}),
    getNowMs: () => options?.now?.value ?? 1_000,
    recordRuntimeEvent: (_category, _error, details) => {
      if (options?.recordThrows) throw new Error("recorder failed");
      events.push(details as RecordedEvent);
    },
  });
  runtime.bindSender({
    sendMessage: async (body: { text?: string; message_thread_id?: number }) => {
      if (options?.sendFails) throw new Error("notice send failed");
      sent.push({
        text: String(body.text ?? ""),
        target: {
          chatId: 191060132,
          ...(body.message_thread_id !== undefined
            ? { threadId: body.message_thread_id }
            : {}),
        },
      });
      return { message_id: 1 };
    },
  });
  return { sent, events, runtime, now: options?.now };
}

await test("a 429 failure is classified as a rate limit with its retry_after", () => {
  const failure = classifyTelegramApiFailure(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 12),
  );
  assert.equal(failure?.kind, "rate-limit");
  assert.equal(failure?.status, 429);
  assert.equal(failure?.retryAfterSeconds, 12);
  assert.equal(failure?.method, "sendMessage");
});

await test("a 5xx failure is classified as a server error", () => {
  const failure = classifyTelegramApiFailure(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 502", 502, undefined),
  );
  assert.equal(failure?.kind, "server-error");
  assert.equal(failure?.status, 502);
});

await test("a 400 API rejection keeps Telegram's own description", () => {
  const failure = classifyTelegramApiFailure(
    "sendMessage",
    new TelegramApiHttpError(
      "Telegram API sendMessage failed: HTTP 400: Bad Request: have no rights to send a message",
      400,
      undefined,
    ),
  );
  assert.equal(failure?.kind, "api-error");
  assert.equal(failure?.detail, "HTTP 400: Bad Request: have no rights to send a message");
});

await test("stale target, aborts, and routine no-ops raise no notice", () => {
  assert.equal(
    classifyTelegramApiFailure(
      "sendMessage",
      new TelegramApiHttpError(
        "Telegram API sendMessage failed: HTTP 400: Bad Request: message thread not found",
        400,
        undefined,
      ),
    ),
    undefined,
    "a stale target is handled by reconciliation, not by an operator notice",
  );
  assert.equal(
    classifyTelegramApiFailure(
      "editMessageText",
      new TelegramApiHttpError(
        "Telegram API editMessageText failed: HTTP 400: Bad Request: message is not modified",
        400,
        undefined,
      ),
    ),
    undefined,
  );
  const abort = new Error("cancelled");
  abort.name = "AbortError";
  assert.equal(classifyTelegramApiFailure("sendMessage", abort), undefined);
  assert.equal(classifyTelegramApiFailure("sendMessage", "not an error"), undefined);
});

await test("an unregistered follower is a transport outage, never a chat notice", () => {
  const harness = createHarness();
  harness.runtime.report(
    "sendMessage",
    new Error("Telegram bus follower is not registered."),
  );
  assert.deepEqual(harness.sent, [], "a notice cannot travel over a dead transport");
  assert.equal(
    harness.events.filter((event) => event.phase === "notice-suppressed").length,
    1,
    "the outage stays visible in diagnostics",
  );
});

await test("an unconfirmed commit is reported because only the operator can resolve it", () => {
  const harness = createHarness();
  const unconfirmed = new Error(
    "Telegram API sendMessage may have committed before transport failed.",
  );
  unconfirmed.name = "TelegramApiCommitUnknownError";
  harness.runtime.report("sendMessage", unconfirmed);

  assert.equal(harness.sent.length, 1, "an ambiguous outcome must not stay silent");
  assert.equal(
    harness.sent[0]!.text,
    "<b>⚠️ Telegram delivery is unconfirmed while sendMessage: the request may have committed before the transport failed.</b>",
  );
  assert.equal(
    harness.events.filter((event) => event.phase === "notice-suppressed").length,
    0,
    "only an unreachable transport is suppressed",
  );
});

await test("a rate limit produces one operator notice naming the method and retry", () => {
  const harness = createHarness();
  harness.runtime.report(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 12),
  );
  assert.equal(harness.sent.length, 1);
  const { text, target } = harness.sent[0]!;
  assert.equal(
    text,
    "<b>⏳ Telegram rate limit 429 while sendMessage: too many requests, retrying in 12s.</b>",
  );
  assert.doesNotMatch(text, /\n|<code>/, "a standalone notice is one bold line");
  assert.match(text, /^<b>[^<]+<\/b>$/, "the whole sentence sits inside the bold span");
  assert.deepEqual(target, { chatId: 191060132, threadId: 160751 });
  assert.equal(harness.events.filter((event) => event.phase === "notice-sent").length, 1);
});

await test("repeating one failure class stays quiet, a new class is announced", () => {
  const harness = createHarness({ now: { value: 1_000 } });
  const limit = () =>
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 5);
  harness.runtime.report("sendMessage", limit());
  harness.now!.value = 1_000 + 5_000;
  harness.runtime.report("sendMessage", limit());
  assert.equal(harness.sent.length, 1, "the same class inside its window must not repeat");

  harness.now!.value = 1_000 + 70_000;
  harness.runtime.report(
    "editMessageText",
    new TelegramApiHttpError("Telegram API editMessageText failed: HTTP 502", 502, undefined),
  );
  assert.equal(harness.sent.length, 2, "a different class is new information");
  assert.equal(
    harness.sent[1]!.text,
    "<b>📡 Telegram server error 502 while editMessageText: Telegram reported a server failure.</b>",
  );
});

await test("a new class cannot jump ahead of the minimum notice interval", () => {
  const harness = createHarness({ now: { value: 1_000 } });
  harness.runtime.report(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
  );
  harness.now!.value = 1_000 + 1_000;
  harness.runtime.report(
    "editMessageText",
    new TelegramApiHttpError("Telegram API editMessageText failed: HTTP 502", 502, undefined),
  );
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.text, /rate limit/);
});

await test("a notice never leaves the paired owner chat", () => {
  const harness = createHarness({ allowedChatId: 191060132 });
  harness.runtime.report(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
  );
  assert.equal(harness.sent.length, 1);

  const foreign = createHarness({
    allowedChatId: 191060132,
    target: { chatId: 42 },
  });
  foreign.runtime.report(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
  );
  assert.deepEqual(foreign.sent, [], "an unauthorized target must be refused");
});

await test("no target means no notice and no failure", () => {
  const harness = createHarness({ target: undefined });
  assert.doesNotThrow(() => {
    harness.runtime.report(
      "sendMessage",
      new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
    );
  });
  assert.deepEqual(harness.sent, []);
});

await test("a broken notice send and a broken recorder stay contained", async () => {
  const harness = createHarness({ sendFails: true, recordThrows: true });
  assert.doesNotThrow(() => {
    harness.runtime.report(
      "sendMessage",
      new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.events, []);
});

await test("reset reopens the notice window", () => {
  const harness = createHarness({ now: { value: 1_000 } });
  const limit = () =>
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1);
  harness.runtime.report("sendMessage", limit());
  harness.runtime.report("sendMessage", limit());
  assert.equal(harness.sent.length, 1);
  harness.runtime.reset();
  harness.runtime.report("sendMessage", limit());
  assert.equal(harness.sent.length, 2);
});

await test("the decorated client reports a failure and still rejects", async () => {
  const reported: Array<{ method: string; message: string }> = [];
  const failure = new TelegramApiHttpError(
    "Telegram API sendMessage failed: HTTP 429",
    429,
    1,
  );
  const client = {
    call: async () => {
      throw failure;
    },
    callMultipart: async () => {
      throw failure;
    },
    downloadFile: async () => "",
    answerCallbackQuery: async () => {},
  };
  const decorated = createTelegramApiNoticeClient(client as never, (method, error) =>
    reported.push({
      method,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

  await assert.rejects(decorated.call("sendMessage", {}), /HTTP 429/);
  await assert.rejects(
    decorated.callMultipart("sendDocument", {}, "document", "/tmp/a", "a"),
    /HTTP 429/,
  );
  assert.deepEqual(reported, [
    { method: "sendMessage", message: "Telegram API sendMessage failed: HTTP 429" },
    {
      method: "sendDocument",
      message: "Telegram API sendMessage failed: HTTP 429",
    },
  ]);
});

await test("a direct-transport rate limit reaches the notice through the client", async () => {
  const sent: string[] = [];
  const runtime = createTelegramApiNoticeRuntime({
    getTarget: () => ({ chatId: 191060132 }),
  });
  runtime.bindSender({
    sendMessage: async (body: { text?: string }) => {
      sent.push(String(body.text ?? ""));
      return { message_id: 1 };
    },
  });
  const client = {
    call: async () => {
      throw new TelegramApiHttpError(
        "Telegram API sendMessage failed: HTTP 429",
        429,
        30,
      );
    },
    callMultipart: async () => {
      throw new Error("unused");
    },
    downloadFile: async () => "",
    answerCallbackQuery: async () => {},
  };
  const decorated = runtime.decorateClient(client as never);

  await assert.rejects(decorated.call("sendMessage", {}), /HTTP 429/);
  assert.equal(sent.length, 1, "the leader's own transport must produce a notice");
  assert.equal(
    sent[0]!,
    "<b>⏳ Telegram rate limit 429 while sendMessage: too many requests, retrying in 30s.</b>",
  );
});

await test("a notice travels over whatever sender authority is bound", async () => {
  const sent: Array<{ chatId: number; method: string }> = [];
  const runtime = createTelegramApiNoticeRuntime({
    getTarget: () => ({ chatId: 191060132, threadId: 160751 }),
  });
  const busAwareSender = {
    sendMessage: async (body: { chat_id: number }) => {
      sent.push({ chatId: body.chat_id, method: "bus-aware" });
      return { message_id: 1 };
    },
  };
  runtime.bindSender(busAwareSender);
  runtime.report(
    "sendMessage",
    new TelegramApiHttpError("Telegram API sendMessage failed: HTTP 429", 429, 1),
  );

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.method,
    "bus-aware",
    "the bound sender decides who owns the transport, so a follower never sends direct",
  );
  assert.equal(sent[0]!.chatId, 191060132);
});

await test("a rendered notice escapes the text Telegram would interpret", () => {
  const rendered = formatTelegramApiFailureNotice({
    kind: "api-error",
    method: "sendMessage",
    detail: "Bad Request: <script>alert(1)</script>",
    status: 400,
  });
  assert.match(rendered, /&lt;script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
});
