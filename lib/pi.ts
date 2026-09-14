/**
 * OMP SDK adapter boundary
 * Zones: omp agent sdk boundary, shared adapters
 * Owns direct OMP SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import {
  basename as basenameFilesystemPath,
  normalize as normalizeFilesystemPath,
} from "node:path";
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

export type TelegramThreadNameTitleGenerator = (
  firstMessage: string,
  registry: ExtensionContext["modelRegistry"],
  settings: Settings,
  sessionId?: string,
  currentModel?: ExtensionContext["model"],
  metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
  signal?: AbortSignal,
  customSystemPrompt?: string,
  credentialSourceSessionId?: string,
) => Promise<string | null>;

export interface TelegramThreadNameGenerationInput {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  generateTitle?: TelegramThreadNameTitleGenerator;
}

const TELEGRAM_THREAD_NAME_SYSTEM_PROMPT = [
  "You label chat tabs.",
  "Reply with a name of at most two words and nothing else.",
  "No punctuation, no quotes, no explanation, no sentence.",
  "Use plain ASCII letters and digits only.",
].join(" ");

const TELEGRAM_THREAD_NAME_MAX_LENGTH = 96;

/** Keeps a model answer usable as a thread label: ASCII words only, at most two of them. */
export function clampTelegramThreadName(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const quoted = /["'`]([^"'`]+)["'`]/.exec(value)?.[1];
  const name = (quoted ?? value)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .join(" ");
  if (name.length === 0) return undefined;
  return name.length > TELEGRAM_THREAD_NAME_MAX_LENGTH ? undefined : name;
}

function buildTelegramThreadNamePrompt(cwd: string): string {
  const project = basenameFilesystemPath(normalizeFilesystemPath(cwd));
  return `Name the chat tab for a coding session working in the project folder "${project || cwd}".`;
}

async function loadTelegramThreadNameTitleGenerator(): Promise<
  TelegramThreadNameTitleGenerator | undefined
> {
  try {
    const { generateTitleOnline } = await import(
      "@oh-my-pi/pi-coding-agent/utils/title-generator"
    );
    return typeof generateTitleOnline === "function"
      ? generateTitleOnline
      : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the host title model for a two-word thread name; resolves undefined instead of throwing. */
export async function generateTelegramThreadName(
  input: TelegramThreadNameGenerationInput,
): Promise<string | undefined> {
  try {
    const registry = input.ctx?.modelRegistry;
    if (!registry) return undefined;
    const generateTitle =
      input.generateTitle ?? (await loadTelegramThreadNameTitleGenerator());
    if (!generateTitle) return undefined;
    const cwd = getExtensionContextCwd(input.ctx);
    return clampTelegramThreadName(
      await generateTitle(
        buildTelegramThreadNamePrompt(cwd),
        registry,
        await resolveSettingsForCwd(cwd),
        undefined,
        getExtensionContextModel(input.ctx),
        undefined,
        input.signal,
        TELEGRAM_THREAD_NAME_SYSTEM_PROMPT,
      ),
    );
  } catch {
    return undefined;
  }
}
