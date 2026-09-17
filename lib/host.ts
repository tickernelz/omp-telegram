/**
 * Resident Telegram host management
 * Zones: systemd user units, tmux session allocation, local process supervision
 * Owns platform eligibility, unit and wrapper rendering, and host lifecycle step planning.
 */

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveAgentDir } from "./paths.ts";

export const TELEGRAM_HOST_UNIT_NAME = "omp-telegram-host";
export const TELEGRAM_HOST_SESSION_NAME = "host";
export const TELEGRAM_HOST_WATCHDOG_INTERVAL_SECONDS = 5;
export const TELEGRAM_HOST_STATE_DIR_NAME = "telegram-host";
export const TELEGRAM_HOST_ANCHOR_FILE = "host.json";
export const TELEGRAM_HOST_ACTIONS = [
  "install",
  "uninstall",
  "restart",
  "status",
  "attach",
] as const;

export type TelegramHostAction = (typeof TELEGRAM_HOST_ACTIONS)[number];

export interface TelegramHostPlatform {
  readonly platform: NodeJS.Platform;
  readonly hasSystemctl: boolean;
  readonly hasTmux: boolean;
}

export type TelegramHostStep =
  | { kind: "write"; path: string; text: string; mode: number }
  | { kind: "remove"; path: string }
  | { kind: "run"; command: readonly string[]; optional?: boolean };

export interface TelegramHostPlan {
  readonly action: TelegramHostAction;
  readonly unitName: string;
  readonly unitPath: string;
  readonly wrapperPath: string;
  readonly socketPath: string;
  readonly sessionName: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly unit: string;
  readonly wrapper: string;
  readonly steps: readonly TelegramHostStep[];
}

/** Per-agent state directory holding this host's wrapper and private tmux socket. */
export function resolveTelegramHostStateDir(agentDir = resolveAgentDir()): string {
  return join(agentDir, TELEGRAM_HOST_STATE_DIR_NAME);
}

/** Anchor file marking an agent directory as a resident host. */
export function resolveTelegramHostAnchorPath(agentDir = resolveAgentDir()): string {
  return join(agentDir, TELEGRAM_HOST_ANCHOR_FILE);
}

export function resolveTelegramHostUnitPath(
  unitName = TELEGRAM_HOST_UNIT_NAME,
  systemdUserDir = join(homedir(), ".config", "systemd", "user"),
): string {
  return join(systemdUserDir, `${unitName}.service`);
}

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** True when this platform can run a supervised resident host. */
export function evaluateTelegramHostPlatform(
  input: {
    platform?: NodeJS.Platform;
    hasSystemctl?: boolean;
    hasTmux?: boolean;
  } = {},
): { eligible: true; platform: TelegramHostPlatform } | { eligible: false; reason: string } {
  const platform: TelegramHostPlatform = {
    platform: input.platform ?? process.platform,
    hasSystemctl: input.hasSystemctl ?? false,
    hasTmux: input.hasTmux ?? false,
  };
  if (platform.platform !== "linux") {
    return {
      eligible: false,
      reason: `Resident host requires Linux with systemd; this host reports "${platform.platform}".`,
    };
  }
  if (!platform.hasSystemctl) {
    return { eligible: false, reason: "Resident host requires systemctl on PATH." };
  }
  if (!platform.hasTmux) {
    return {
      eligible: false,
      reason:
        "Resident host requires tmux so the agent keeps a real terminal and interactive features stay available.",
    };
  }
  return { eligible: true, platform };
}

/** Render the wrapper that owns the tmux session and remains the unit's main process. */
export function renderTelegramHostWrapper(input: {
  cwd: string;
  agentDir: string;
  ompExecutable: string;
  socketPath: string;
  sessionName?: string;
}): string {
  const sessionName = input.sessionName ?? TELEGRAM_HOST_SESSION_NAME;
  return `#!/bin/bash
set -u
TMUX=$(command -v tmux || echo tmux)
SOCKET=${quoteShellWord(input.socketPath)}
SESSION=${quoteShellWord(sessionName)}
CWD=${quoteShellWord(input.cwd)}
export PI_CODING_AGENT_DIR=${quoteShellWord(input.agentDir)}

"$TMUX" -S "$SOCKET" kill-session -t "$SESSION" 2>/dev/null

"$TMUX" -S "$SOCKET" new-session -d -s "$SESSION" -x 200 -y 50 -c "$CWD" \\
  ${quoteShellWord(input.ompExecutable)} --cwd "$CWD"
if [ $? -ne 0 ]; then
  echo "telegram-host: could not start the tmux session" >&2
  exit 1
fi

while "$TMUX" -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; do
  sleep ${TELEGRAM_HOST_WATCHDOG_INTERVAL_SECONDS}
done
exit 0
`;
}

/** Render the systemd user unit that keeps the wrapper alive. */
export function renderTelegramHostUnit(input: {
  wrapperPath: string;
  agentDir: string;
  cwd: string;
}): string {
  return `[Unit]
Description=OMP Telegram resident host
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.cwd}
Environment=${quoteSystemdArgument(`PI_CODING_AGENT_DIR=${input.agentDir}`)}
ExecStart=${input.wrapperPath}
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=20
MemoryMax=4G
TasksMax=512
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

/** Render the anchor that marks this agent directory as a resident host. */
export function renderTelegramHostAnchor(input: { cwd: string; unitName: string }): string {
  return `${JSON.stringify({ version: 1, cwd: input.cwd, unitName: input.unitName }, null, 2)}\n`;
}

/** Read the resident-host anchor, or undefined when this directory is not a host. */
export function readTelegramHostAnchor(
  agentDir = resolveAgentDir(),
): { cwd: string; unitName: string } | undefined {
  const path = resolveTelegramHostAnchorPath(agentDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { cwd?: unknown; unitName?: unknown };
    if (typeof parsed.cwd !== "string" || !parsed.cwd) return undefined;
    return {
      cwd: parsed.cwd,
      unitName: typeof parsed.unitName === "string" ? parsed.unitName : TELEGRAM_HOST_UNIT_NAME,
    };
  } catch {
    return undefined;
  }
}

export interface TelegramHostPlanInput {
  readonly action: TelegramHostAction;
  readonly agentDir: string;
  readonly cwd: string;
  readonly ompExecutable: string;
  readonly systemdUserDir?: string;
  readonly unitName?: string;
}

/** Render every artifact, path, and step for one host action without touching the system. */
export function planTelegramHostAction(input: TelegramHostPlanInput): TelegramHostPlan {
  const unitName = input.unitName ?? TELEGRAM_HOST_UNIT_NAME;
  const unitPath = resolveTelegramHostUnitPath(unitName, input.systemdUserDir);
  const stateDir = resolveTelegramHostStateDir(input.agentDir);
  const wrapperPath = join(stateDir, "host.sh");
  const socketPath = join(stateDir, "tmux.sock");
  const unit = renderTelegramHostUnit({
    wrapperPath,
    agentDir: input.agentDir,
    cwd: input.cwd,
  });
  const wrapper = renderTelegramHostWrapper({
    cwd: input.cwd,
    agentDir: input.agentDir,
    ompExecutable: input.ompExecutable,
    socketPath,
  });
  const systemctl = ["systemctl", "--user"] as const;
  const anchorPath = resolveTelegramHostAnchorPath(input.agentDir);
  const anchor = renderTelegramHostAnchor({ cwd: input.cwd, unitName });
  const artifacts: TelegramHostStep[] = [
    { kind: "write", path: wrapperPath, text: wrapper, mode: 0o700 },
    { kind: "write", path: unitPath, text: unit, mode: 0o644 },
    { kind: "write", path: anchorPath, text: anchor, mode: 0o644 },
  ];
  const steps: readonly TelegramHostStep[] =
    input.action === "install"
      ? [...artifacts, { kind: "run", command: [...systemctl, "daemon-reload"] }, { kind: "run", command: [...systemctl, "enable", "--now", unitName] }]
      : input.action === "uninstall"
        ? [
            { kind: "run", command: [...systemctl, "disable", "--now", unitName] },
            { kind: "remove", path: unitPath },
            { kind: "remove", path: wrapperPath },
            { kind: "remove", path: resolveTelegramHostAnchorPath(input.agentDir) },
            { kind: "run", command: ["tmux", "-S", socketPath, "kill-server"], optional: true },
            { kind: "remove", path: socketPath },
            { kind: "run", command: [...systemctl, "daemon-reload"] },
          ]
        : input.action === "restart"
          ? [
              ...artifacts,
              { kind: "run", command: [...systemctl, "daemon-reload"] },
              { kind: "run", command: [...systemctl, "restart", unitName] },
            ]
          : input.action === "status"
            ? [
                { kind: "run", command: [...systemctl, "is-active", unitName], optional: true },
                { kind: "run", command: [...systemctl, "show", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", unitName], optional: true },
                {
                  kind: "run",
                  command: ["tmux", "-S", socketPath, "list-panes", "-t", TELEGRAM_HOST_SESSION_NAME, "-F", "#{pane_pid} #{pane_current_command} #{pane_tty}"],
                  optional: true,
                },
              ]
            : [];
  return {
    action: input.action,
    unitName,
    unitPath,
    wrapperPath,
    socketPath,
    sessionName: TELEGRAM_HOST_SESSION_NAME,
    agentDir: input.agentDir,
    cwd: input.cwd,
    unit,
    wrapper,
    steps,
  };
}

export interface TelegramHostApplyDeps {
  runCommand: (command: readonly string[]) => Promise<{ ok: boolean; output: string }>;
  writeTextFile?: (path: string, text: string, mode: number) => void;
  removeFile?: (path: string) => void;
  ensureDir?: (path: string) => void;
}

export interface TelegramHostApplyResult {
  ok: boolean;
  message: string;
  outputs: readonly string[];
}

function defaultWriteTextFile(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { encoding: "utf-8", mode });
}

function defaultRemoveFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
}

/** Execute one planned host action in order, stopping at the first required failure. */
export async function applyTelegramHostPlan(
  plan: TelegramHostPlan,
  deps: TelegramHostApplyDeps,
): Promise<TelegramHostApplyResult> {
  const write = deps.writeTextFile ?? defaultWriteTextFile;
  const remove = deps.removeFile ?? defaultRemoveFile;
  const ensureDir = deps.ensureDir ?? ((path: string) => {
    mkdirSync(path, { recursive: true });
  });
  const outputs: string[] = [];
  for (const step of plan.steps) {
    if (step.kind === "write") {
      ensureDir(dirname(step.path));
      write(step.path, step.text, step.mode);
      continue;
    }
    if (step.kind === "remove") {
      remove(step.path);
      continue;
    }
    let result: { ok: boolean; output: string };
    try {
      result = await deps.runCommand(step.command);
    } catch (error) {
      result = { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
    if (result.output.trim()) outputs.push(result.output.trim());
    if (!result.ok && step.optional !== true) {
      return {
        ok: false,
        message: result.output.trim() || `${step.command.join(" ")} failed`,
        outputs,
      };
    }
  }
  if (plan.action === "uninstall") {
    try {
      rmSync(plan.socketPath, { force: true });
    } catch {
      void 0;
    }
  }
  return { ok: true, message: describeTelegramHostResult(plan), outputs };
}

function describeTelegramHostResult(plan: TelegramHostPlan): string {
  switch (plan.action) {
    case "install":
      return `Resident host installed as ${plan.unitName}.`;
    case "uninstall":
      return `Resident host ${plan.unitName} removed.`;
    case "restart":
      return `Resident host ${plan.unitName} restarted.`;
    case "status":
      return `Resident host ${plan.unitName} status.`;
    default:
      return `Attach with: tmux -S ${plan.socketPath} attach -t ${plan.sessionName}`;
  }
}

/** Parse a `/telegram-host` argument string into an action plus modifiers. */
export function parseTelegramHostCommand(args: string): {
  action: TelegramHostAction | undefined;
  dryRun: boolean;
  invalid?: string;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const dryRun = tokens.includes("--dry-run");
  const unknownFlags = tokens.filter((token) => token.startsWith("--") && token !== "--dry-run");
  if (unknownFlags.length > 0) {
    return { action: undefined, dryRun, invalid: `Unknown option: ${unknownFlags[0]}` };
  }
  const words = tokens.filter((token) => !token.startsWith("--"));
  if (words.length === 0) return { action: undefined, dryRun };
  if (words.length > 1) {
    return { action: undefined, dryRun, invalid: `Unknown arguments: ${words.slice(1).join(" ")}` };
  }
  const candidate = words[0];
  if (!(TELEGRAM_HOST_ACTIONS as readonly string[]).includes(candidate)) {
    return { action: undefined, dryRun, invalid: `Unknown action: ${candidate}` };
  }
  return { action: candidate as TelegramHostAction, dryRun };
}

export interface TelegramHostStdinRuntime {
  send: (data: string) => boolean;
}

export interface TelegramHostAutoConnectDeps {
  isEnabled: () => boolean;
  hasBotToken: () => boolean;
  ownsLock: () => boolean;
  isFollowerRegistered: () => boolean;
  stdin: TelegramHostStdinRuntime;
  sleep?: (ms: number) => Promise<void>;
  connectDelayMs?: number;
  confirmDelayMs?: number;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

/** Type the connect command into this host's own terminal, covering the cold start the auto-start path cannot. */
export async function runTelegramHostAutoConnect(
  deps: TelegramHostAutoConnectDeps,
): Promise<boolean> {
  if (!deps.isEnabled()) return false;
  if (!deps.hasBotToken()) return false;
  if (deps.ownsLock() || deps.isFollowerRegistered()) return false;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  try {
    await sleep(deps.connectDelayMs ?? 3_000);
    if (deps.ownsLock() || deps.isFollowerRegistered()) return false;
    if (!deps.stdin.send("/telegram-connect")) return false;
    await sleep(deps.confirmDelayMs ?? 1_500);
    deps.stdin.send("\r");
    return true;
  } catch (error) {
    deps.recordRuntimeEvent?.("host", error, { phase: "auto-connect" });
    return false;
  }
}

/** Absolute path of the running OMP executable, falling back to the bare command name. */
export function resolveOmpExecutable(argv: readonly string[] = process.argv): string {
  const candidate = argv[1];
  if (!candidate) return "omp";
  return resolve(candidate);
}

/** True when the executable is resolvable on PATH. */
export function commandExists(name: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue.split(":").some((entry) => entry && telegramHostPathExists(join(entry, name)));
}

/** Fixed working directory for the resident host: the anchor when installed, else this session's directory. */
export function resolveTelegramHostCwd(input: { anchorCwd?: string; ctxCwd: string }): string {
  return input.anchorCwd && input.anchorCwd.trim() ? input.anchorCwd : input.ctxCwd;
}

/** Human-readable plan summary for --dry-run, status, and the install prompt. */
export function describeTelegramHostPlan(plan: TelegramHostPlan): string {
  const lines = [
    `Resident host plan (${plan.action}):`,
    `  unit:    ${plan.unitPath}`,
    `  wrapper: ${plan.wrapperPath}`,
    `  cwd:     ${plan.cwd}`,
    `  socket:  ${plan.socketPath}`,
    "",
    `${plan.steps.length} steps:`,
    ...plan.steps.map((step) =>
      step.kind === "write"
        ? `  write ${step.path}`
        : step.kind === "remove"
          ? `  remove ${step.path}`
          : `  run ${step.command.join(" ")}${step.optional ? " (optional)" : ""}`,
    ),
  ];
  return lines.join("\n");
}

/** Command an operator runs to attach to the resident host's terminal. */
export function formatTelegramHostAttachCommand(plan: TelegramHostPlan): string {
  return `tmux -S ${plan.socketPath} attach -t ${plan.sessionName}`;
}

/** Run one host command, capturing combined output without a shell. */
export async function runTelegramHostCommand(
  command: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const [executable, ...args] = command;
  if (!executable) return { ok: false, output: "Empty command." };
  return await new Promise((settle) => {
    let settled = false;
    const finish = (value: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        void 0;
      }
      finish({ ok: false, output: `${executable} timed out.` });
    }, options.timeoutMs ?? 15_000);
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf-8");
      if (output.length > 4_000) output = output.slice(-4_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => finish({ ok: false, output: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, output }));
  });
}

/** Whether a file exists, tolerant of permission errors. */
export function telegramHostPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
