/**
 * Regression tests for the pi SDK adapter boundary
 * Covers narrow bridge-facing helpers over concrete pi context contracts
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  canStartPollingInExtensionContext,
  compactExtensionContext,
  createExtensionApiRuntimePorts,
  createScopedModelPatternPersister,
  createSettingsManager,
  type ExtensionContext,
  getExtensionContextCwd,
  formatPollingStartBlockedByRunMode,
  getExtensionContextMode,
  getExtensionContextModel,
  hasExtensionContextPendingMessages,
  isExtensionContextIdle,
  isExtensionContextPassiveRunMode,
  normalizeSettingsManager,
} from "../lib/pi.ts";
import {
  installHostSdkSettingsHook,
  readHostSettingsFlushes,
  readHostSettingsWrites,
  resetHostSettingsStub,
  settings as hostSettings,
} from "./fixtures/host-settings.ts";

installHostSdkSettingsHook();

type PiRuntimeApiHarness = Parameters<
  typeof createExtensionApiRuntimePorts
>[0] & {
  events: string[];
};

type PiRuntimeModel = Parameters<PiRuntimeApiHarness["setModel"]>[0];

type PiRuntimeThinkingLevel = NonNullable<
  ReturnType<PiRuntimeApiHarness["getThinkingLevel"]>
>;

function createHarnessModel(id: string): PiRuntimeModel {
  return { id } as PiRuntimeModel;
}

function getHarnessModelId(model: PiRuntimeModel): string {
  return String(Reflect.get(Object(model), "id"));
}

test("OMP context mode helpers feature-detect passive run modes", () => {
  assert.equal(getExtensionContextMode({ mode: "print" }), "print");
  assert.equal(getExtensionContextMode({ mode: "bogus" }), undefined);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "print" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "json" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "rpc" }), false);
  assert.equal(isExtensionContextPassiveRunMode({}), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "tui" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "rpc" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "json" }), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "print" }), false);
  assert.equal(canStartPollingInExtensionContext({}), true);
  assert.equal(
    formatPollingStartBlockedByRunMode({ mode: "json" }),
    "Telegram polling is unavailable in OMP json mode. Use /telegram-connect from a long-lived OMP session.",
  );
});

test("OMP API runtime ports bind methods without losing receiver context", async () => {
  const api: PiRuntimeApiHarness = {
    events: [],
    sendUserMessage(content, options) {
      this.events.push(
        `send:${String(content)}:${options?.deliverAs ?? "default"}`,
      );
    },
    async exec(command, args) {
      this.events.push(`exec:${command}:${args.join(",")}`);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    getCommands() {
      this.events.push("commands");
      return [];
    },
    getThinkingLevel() {
      this.events.push("get-thinking");
      return "high" as PiRuntimeThinkingLevel;
    },
    setThinkingLevel(level) {
      this.events.push(`thinking:${String(level)}`);
    },
    getActiveTools() {
      this.events.push("get-tools");
      return ["read"];
    },
    async setActiveTools(names) {
      this.events.push(`set-tools:${names.join(",")}`);
    },
    async setModel(model) {
      this.events.push(`model:${getHarnessModelId(model)}`);
      return true;
    },
  };
  const runtime = createExtensionApiRuntimePorts(api);
  runtime.sendUserMessage("hello", { deliverAs: "followUp" });
  assert.deepEqual(await runtime.exec("cmd", ["arg"]), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(runtime.getCommands(), []);
  assert.equal(runtime.getThinkingLevel(), "high");
  runtime.setThinkingLevel("low" as PiRuntimeThinkingLevel);
  assert.deepEqual(runtime.getActiveTools(), ["read"]);
  runtime.setActiveTools(["read", "telegram_attach"]);
  assert.equal(await runtime.setModel(createHarnessModel("gpt-5")), true);
  assert.deepEqual(api.events, [
    "send:hello:followUp",
    "exec:cmd:arg",
    "commands",
    "get-thinking",
    "thinking:low",
    "get-tools",
    "set-tools:read,telegram_attach",
    "model:gpt-5",
  ]);
});

test("OMP settings adapter preserves legacy and generic host capabilities", async () => {
  const legacyEvents: string[] = [];
  const legacy = normalizeSettingsManager({
    reload: async () => legacyEvents.push("reload"),
    flush: async () => legacyEvents.push("flush"),
    getEnabledModels: () => ["openai/gpt-5"],
    setEnabledModels: (patterns: string[] | undefined) =>
      legacyEvents.push(`set:${patterns?.join(",") ?? "all"}`),
  });
  await legacy.reload();
  assert.deepEqual(legacy.getEnabledModels(), ["openai/gpt-5"]);
  legacy.setEnabledModels(undefined);
  await legacy.flush();
  assert.deepEqual(legacyEvents, ["reload", "set:all", "flush"]);

  const genericEvents: string[] = [];
  let enabledModels = ["anthropic/claude-sonnet-4"];
  const generic = normalizeSettingsManager({
    get: (key: string) => {
      genericEvents.push(`get:${key}`);
      return enabledModels;
    },
    set: (key: string, value: unknown) => {
      genericEvents.push(`set:${key}:${JSON.stringify(value)}`);
      enabledModels = value as string[];
    },
    flush: async () => genericEvents.push("flush"),
  });
  await generic.reload();
  assert.deepEqual(generic.getEnabledModels(), ["anthropic/claude-sonnet-4"]);
  generic.setEnabledModels(undefined);
  await generic.flush();
  assert.deepEqual(genericEvents, [
    "get:enabledModels",
    "set:enabledModels:[]",
    "flush",
  ]);
});

test("OMP scoped model persister invalidates cached inputs without clearing live menus", async () => {
  const events: string[] = [];
  const persist = createScopedModelPatternPersister({
    createSettingsManager: async (cwd) => ({
      reload: async () => {},
      flush: async () => {
        events.push("flush");
      },
      getEnabledModels: () => undefined,
      setEnabledModels: (patterns) => {
        events.push(`set:${cwd}:${patterns?.join(",") ?? "all"}`);
      },
    }),
    clearCachedModelMenuInputs: () => {
      events.push("clear-cache");
    },
  });
  await persist(["openai/gpt-5"], { cwd: "/tmp/project" } as ExtensionContext);
  assert.deepEqual(events, [
    "set:/tmp/project:openai/gpt-5",
    "flush",
    "clear-cache",
  ]);
});

test("OMP settings manager adapts the host instance and clones it per cwd", async () => {
  resetHostSettingsStub();
  const ambientCwd = hostSettings.getCwd();
  const ambient = await createSettingsManager(ambientCwd);
  assert.equal(ambient.getEnabledModels(), undefined);
  ambient.setEnabledModels(["openai/gpt-5"]);
  assert.deepEqual(ambient.getEnabledModels(), ["openai/gpt-5"]);
  ambient.setEnabledModels(undefined);
  assert.deepEqual(ambient.getEnabledModels(), []);
  await ambient.reload();
  await ambient.flush();

  const scoped = await createSettingsManager(join(ambientCwd, "scoped-project"));
  scoped.setEnabledModels(["anthropic/claude-sonnet-4"]);
  await scoped.flush();
  assert.deepEqual(scoped.getEnabledModels(), ["anthropic/claude-sonnet-4"]);
  assert.deepEqual(ambient.getEnabledModels(), []);

  assert.deepEqual(readHostSettingsWrites(), [
    { cwd: ambientCwd, key: "enabledModels", value: ["openai/gpt-5"] },
    { cwd: ambientCwd, key: "enabledModels", value: [] },
    {
      cwd: join(ambientCwd, "scoped-project"),
      key: "enabledModels",
      value: ["anthropic/claude-sonnet-4"],
    },
  ]);
  assert.deepEqual(readHostSettingsFlushes(), [
    ambientCwd,
    join(ambientCwd, "scoped-project"),
  ]);
});

test("OMP context helpers expose model, idle, pending-message, and compact adapters", () => {
  const model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
  const events: string[] = [];
  const ctx = {
    model,
    isIdle: () => true,
    hasPendingMessages: () => false,
    cwd: "/tmp/project",
    compact: (callbacks: { onComplete: () => void }) => {
      events.push("compact");
      callbacks.onComplete();
    },
  } as unknown as ExtensionContext;
  compactExtensionContext(ctx, {
    onComplete: () => {
      events.push("complete");
    },
    onError: () => {
      events.push("error");
    },
  });
  assert.equal(getExtensionContextModel(ctx), model);
  assert.equal(getExtensionContextCwd(ctx), "/tmp/project");
  assert.equal(isExtensionContextIdle(ctx), true);
  assert.equal(hasExtensionContextPendingMessages(ctx), false);
  assert.deepEqual(events, ["compact", "complete"]);
});
