/**
 * Tests for Telegram plan mode toggle and status runtime
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isTelegramPlanModeActive,
  createTelegramPlanModeRuntime,
} from "../lib/plan-mode.ts";
import { createTelegramTuiInputRuntime } from "../lib/tui-input.ts";

test("isTelegramPlanModeActive identifies plan mode prompt marker accurately", () => {
  assert.equal(isTelegramPlanModeActive(["You are a helper.", "Plan mode active. Plan carefully."]), true);
  assert.equal(isTelegramPlanModeActive(["You are a helper."]), false);
  assert.equal(isTelegramPlanModeActive([]), false);
  assert.equal(isTelegramPlanModeActive(undefined), false);
});

test("createTelegramPlanModeRuntime drives enter, pause, exit with draft preservation", async () => {
  const sentKeystrokes: string[] = [];
  const tuiInput = createTelegramTuiInputRuntime({
    writeInput: (data) => sentKeystrokes.push(data),
  });

  let currentEditorText = "my draft text";
  let promptBlocks = ["Standard mode"];

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    getSystemPrompt: () => promptBlocks,
    ui: {
      getEditorText: () => currentEditorText,
      setEditorText: (t: string) => {
        currentEditorText = t;
        if (t.startsWith("/plan")) {
          if (t.startsWith("/plan fix auth")) {
            promptBlocks = ["Plan mode active."];
          } else {
            promptBlocks = ["Standard mode"];
          }
        }
      },
    },
  };

  const runtime = createTelegramPlanModeRuntime({
    isEnabled: () => true,
    tuiInput,
    sleep: async () => {}, // Instant for test
  });
  const resEnter = await runtime.run("enter", "fix auth", ctx);
  assert.equal(resEnter.ok, true);
  assert.equal(resEnter.message, "📝 Plan mode active.");
  assert.equal(currentEditorText, "my draft text", "Draft text must be restored");
  assert.deepEqual(sentKeystrokes, ["\r"]);
  sentKeystrokes.length = 0;

  const resPause = await runtime.run("pause", "", ctx);
  assert.equal(resPause.ok, true);
  assert.equal(resPause.message, "⏸ Plan mode paused.");
  assert.equal(currentEditorText, "my draft text", "Draft text must be restored");
  assert.deepEqual(sentKeystrokes, ["\r", "\r"]);
  sentKeystrokes.length = 0;
  promptBlocks = ["Plan mode active."];

  const resExit = await runtime.run("exit", "", ctx);
  assert.equal(resExit.ok, true);
  assert.equal(resExit.message, "⏹ Plan mode exited.");
  assert.equal(currentEditorText, "my draft text");
  assert.deepEqual(sentKeystrokes, ["\r", "\r", "\r", "\r"]);
});

test("createTelegramPlanModeRuntime fails fast when the CLI input surface refuses", async () => {
  const events: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  let nowCalls = 0;
  let currentEditorText = "unsent draft";
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    getSystemPrompt: () => ["Standard mode"],
    ui: {
      getEditorText: () => currentEditorText,
      setEditorText: (text: string) => {
        currentEditorText = text;
      },
    },
  };
  const runtime = createTelegramPlanModeRuntime({
    isEnabled: () => true,
    tuiInput: { send: () => false },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    now: () => {
      nowCalls += 1;
      return 0;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  const result = await runtime.run("enter", "fix auth", ctx);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Could not reach the CLI input surface.");
  assert.deepEqual(sleeps, [], "a refused surface must not wait for a state change");
  assert.equal(nowCalls, 0, "a refused surface must not poll the prompt");
  assert.equal(currentEditorText, "unsent draft", "the draft must survive a refused surface");
  assert.ok(
    events.some((detail) => detail.phase === "tui-input" && detail.action === "enter"),
    "a refused surface must be recorded as a runtime event",
  );
});

test("createTelegramPlanModeRuntime enforces idle and state gates", async () => {
  const runtime = createTelegramPlanModeRuntime({
    isEnabled: () => true,
    tuiInput: createTelegramTuiInputRuntime(),
  });
  const ctxBusy = {
    mode: "tui",
    hasUI: true,
    isIdle: () => false,
    getSystemPrompt: () => [],
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
  const resBusy = await runtime.run("enter", "", ctxBusy);
  assert.equal(resBusy.ok, false);
  assert.ok(resBusy.message.includes("Agent is still running"));
  const ctxActive = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    getSystemPrompt: () => ["Plan mode active."],
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
  const resAlready = await runtime.run("enter", "", ctxActive);
  assert.equal(resAlready.ok, false);
  assert.ok(resAlready.message.includes("Plan mode is already active"));
  const ctxInactive = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    getSystemPrompt: () => ["Standard mode"],
    ui: { getEditorText: () => "", setEditorText: () => {} },
  };
  const resNotActive = await runtime.run("pause", "", ctxInactive);
  assert.equal(resNotActive.ok, false);
  assert.ok(resNotActive.message.includes("Plan mode is not active"));
});
