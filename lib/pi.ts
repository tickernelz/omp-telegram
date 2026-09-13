/**
 * OMP SDK adapter boundary
 * Zones: omp agent sdk boundary, shared adapters
 * Owns direct OMP SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import { normalize as normalizeFilesystemPath } from "node:path";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type {
  AgentEndEvent,
  AgentStartEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  Settings,
  SlashCommandInfo,
  ToolApprovalRequestedEvent,
  ToolApprovalResolvedEvent,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";

export type {
  AgentEndEvent,
  AgentStartEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  AssistantMessageEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
  ToolApprovalRequestedEvent,
  ToolApprovalResolvedEvent,
  ToolDefinition,
};

export type AgentSettledEvent = AgentEndEvent;

export type UIPromptKind =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "custom";

export interface UIPromptStartEvent {
  type: "ui_prompt_start";
  kind: UIPromptKind;
  title?: string;
}

export interface UIPromptEndEvent {
  type: "ui_prompt_end";
}

export interface SessionCompactFailedEvent {
  type: "session_compact_failed";
  reason: "manual" | "threshold" | "overflow";
  errorMessage?: string;
  aborted: boolean;
  willRetry: boolean;
  fromExtension: boolean;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

export type PiSlashCommandInfo = SlashCommandInfo;
export type PiRunMode = "tui" | "rpc" | "json" | "print";

function isPiRunMode(value: unknown): value is PiRunMode {
  return (
    value === "tui" || value === "rpc" || value === "json" || value === "print"
  );
}

export function getExtensionContextMode(ctx: unknown): PiRunMode | undefined {
  const mode =
    typeof ctx === "object" && ctx !== null
      ? (ctx as { mode?: unknown }).mode
      : undefined;
  return isPiRunMode(mode) ? mode : undefined;
}

export function isExtensionContextPassiveRunMode(ctx: unknown): boolean {
  const mode = getExtensionContextMode(ctx);
  return mode === "print" || mode === "json";
}

export function canStartPollingInExtensionContext(ctx: unknown): boolean {
  return !isExtensionContextPassiveRunMode(ctx);
}

export function formatPollingStartBlockedByRunMode(ctx: unknown): string {
  const mode = getExtensionContextMode(ctx);
  return mode
    ? `Telegram polling is unavailable in OMP ${mode} mode. Use /telegram-connect from a long-lived OMP session.`
    : "Telegram polling is unavailable in this OMP run mode.";
}

export function getSessionCompactionReason(
  event: unknown,
): "manual" | "threshold" | "overflow" | "unknown" {
  const reason =
    event && typeof event === "object" && "reason" in event
      ? (event as { reason?: unknown }).reason
      : undefined;
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "unknown";
}

export interface PiExtensionApiRuntimePorts {
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  exec: ExtensionAPI["exec"];
  getCommands: ExtensionAPI["getCommands"];
  getThinkingLevel: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel: ExtensionAPI["setThinkingLevel"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
  setModel: ExtensionAPI["setModel"];
}

export function createExtensionApiRuntimePorts(
  api: Pick<
    ExtensionAPI,
    | "sendUserMessage"
    | "exec"
    | "getCommands"
    | "getThinkingLevel"
    | "setThinkingLevel"
    | "getActiveTools"
    | "setActiveTools"
    | "setModel"
  >,
): PiExtensionApiRuntimePorts {
  return {
    sendUserMessage: (content, options) =>
      api.sendUserMessage(content, options),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    getActiveTools: () => api.getActiveTools(),
    setActiveTools: (names) => api.setActiveTools(names),
    setModel: (model) => api.setModel(model),
  };
}

type HostSettingsManager = {
  reload?: () => void | PromiseLike<void>;
  flush?: () => void | PromiseLike<void>;
  getEnabledModels?: () => unknown;
  setEnabledModels?: (patterns: string[] | undefined) => void;
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
};

function readEnabledModels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...value];
  }
  throw new TypeError("Host settings enabledModels must be a string array or undefined.");
}

export function normalizeSettingsManager(manager: unknown): PiSettingsManager {
  if (typeof manager !== "object" || manager === null) {
    throw new TypeError("Host settings manager must be an object.");
  }
  const host = manager as HostSettingsManager;
  if (typeof host.flush !== "function") {
    throw new TypeError("Host settings manager must provide flush().");
  }
  const read = typeof host.getEnabledModels === "function"
    ? () => host.getEnabledModels!.call(host)
    : typeof host.get === "function"
      ? () => host.get!.call(host, "enabledModels")
      : undefined;
  const write = typeof host.setEnabledModels === "function"
    ? (patterns: string[] | undefined) =>
        host.setEnabledModels!.call(host, patterns)
    : typeof host.set === "function"
      ? (patterns: string[] | undefined) =>
          host.set!.call(host, "enabledModels", patterns ?? [])
      : undefined;
  if (!read || !write) {
    throw new TypeError(
      "Host settings manager must provide enabled-model read and write capabilities.",
    );
  }
  return {
    reload: async () => {
      await host.reload?.call(host);
    },
    flush: async () => {
      await host.flush!.call(host);
    },
    getEnabledModels: () => readEnabledModels(read()),
    setEnabledModels: write,
  };
}

/** Loaded on demand so importing this boundary never pulls the host SDK into the module graph. */
async function resolveSettingsForCwd(cwd: string): Promise<Settings> {
  const { settings } = await import("@oh-my-pi/pi-coding-agent");
  const scoped = normalizeFilesystemPath(cwd);
  return normalizeFilesystemPath(settings.getCwd()) === scoped
    ? settings
    : await settings.cloneForCwd(scoped);
}

function createHostSettingsAdapter(instance: Settings): HostSettingsManager {
  return {
    reload: () => instance.reloadFromDisk(),
    flush: () => instance.flush(),
    getEnabledModels: () =>
      instance.isConfigured("enabledModels")
        ? instance.get("enabledModels")
        : undefined,
    setEnabledModels: (patterns) =>
      instance.set("enabledModels", patterns ?? []),
  };
}

export async function createSettingsManager(
  cwd: string,
): Promise<PiSettingsManager> {
  return normalizeSettingsManager(
    createHostSettingsAdapter(await resolveSettingsForCwd(cwd)),
  );
}

export function createScopedModelPatternPersister(deps: {
  createSettingsManager: (
    cwd: string,
  ) => PiSettingsManager | PromiseLike<PiSettingsManager>;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void> {
  return async (patterns, ctx) => {
    const settingsManager = await deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}

export function getExtensionContextModel(
  ctx: ExtensionContext,
): ExtensionContext["model"] {
  return ctx.model;
}

export function getExtensionContextCwd(ctx: ExtensionContext): string {
  return ctx.cwd;
}

export function isExtensionContextIdle(ctx: ExtensionContext): boolean {
  return ctx.isIdle();
}

export function hasExtensionContextPendingMessages(
  ctx: ExtensionContext,
): boolean {
  return ctx.hasPendingMessages();
}

export function compactExtensionContext(
  ctx: ExtensionContext,
  callbacks: Parameters<ExtensionContext["compact"]>[0],
): ReturnType<ExtensionContext["compact"]> {
  return ctx.compact(callbacks);
}
