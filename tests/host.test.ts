/**
 * Resident host management tests
 * Covers platform eligibility, rendered unit and wrapper contracts, step ordering, and auto-connect gating
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyTelegramHostPlan,
  commandExists,
  isTelegramHostSession,
  renderTelegramHostWrapper,
  resolveOmpExecutable,
  evaluateTelegramHostPlatform,
  getTelegramHostArgumentCompletions,
  parseTelegramHostCommand,
  planTelegramHostAction,
  readTelegramHostAnchor,
  renderTelegramHostAnchor,
  resolveTelegramHostAnchorPath,
  resolveTelegramHostSocketPath,
  resolveTelegramHostUnitPath,
  runTelegramHostAutoConnect,
  runTelegramHostCommand,
  type TelegramHostApplyDeps,
  type TelegramHostStep,
} from "../lib/host.ts";

function readSystemdAssignment(unit: string, key: string): string | undefined {
  const line = unit.split("\n").find((entry) => entry.startsWith(`${key}=`));
  if (line === undefined) return undefined;
  const value = line.slice(key.length + 1);
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function createInput(action: Parameters<typeof planTelegramHostAction>[0]["action"]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-"));
  return {
    dir,
    input: {
      action,
      agentDir: dir,
      cwd: "/tmp/host-workspace",
      ompExecutable: "/home/user/.bun/bin/omp",
      systemdUserDir: join(dir, "systemd"),
      unitName: "omp-telegram-host-test",
    } as const,
  };
}

test("host is refused off Linux or without its required binaries", () => {
  const darwin = evaluateTelegramHostPlatform({ platform: "darwin", hasSystemctl: true, hasTmux: true });
  assert.equal(darwin.eligible, false);
  assert.match(darwin.eligible === false ? darwin.reason : "", /Linux/);

  const noTmux = evaluateTelegramHostPlatform({ platform: "linux", hasSystemctl: true, hasTmux: false });
  assert.equal(noTmux.eligible, false);
  assert.match(noTmux.eligible === false ? noTmux.reason : "", /tmux/);

  const noSystemctl = evaluateTelegramHostPlatform({ platform: "linux", hasSystemctl: false, hasTmux: true });
  assert.equal(noSystemctl.eligible, false);
  assert.match(noSystemctl.eligible === false ? noSystemctl.reason : "", /systemctl/);

  const ok = evaluateTelegramHostPlatform({ platform: "linux", hasSystemctl: true, hasTmux: true });
  assert.equal(ok.eligible, true);
});

test("the unit keeps the wrapper alive and restarts it when the agent dies", () => {
  const { dir, input } = createInput("install");
  try {
    const plan = planTelegramHostAction(input);
    assert.match(plan.unit, /^\[Unit\]/m);
    assert.match(plan.unit, /^Type=simple$/m);
    assert.match(plan.unit, /^Restart=always$/m);
    assert.match(plan.unit, /^KillMode=control-group$/m);
    assert.equal(
      readSystemdAssignment(plan.unit, "ExecStart"),
      plan.wrapperPath,
      "ExecStart must name the rendered wrapper exactly",
    );
    assert.match(plan.unit, /^WorkingDirectory=\/tmp\/host-workspace$/m);
    assert.match(plan.unit, /PI_CODING_AGENT_DIR=/);
    assert.match(plan.unit, /^WantedBy=default.target$/m);
    assert.ok(!plan.unit.includes("StandardInput="));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wrapper runs a real omp session inside tmux and supervises it", () => {
  const { dir, input } = createInput("install");
  try {
    const plan = planTelegramHostAction(input);
    assert.match(plan.wrapper, /^#!\/bin\/bash$/m);
    assert.match(plan.wrapper, /new-session -d -s "\$SESSION" -x 200 -y 50 -c "\$CWD" \\$/m);
    assert.ok(plan.wrapper.includes(`'${input.ompExecutable}' --cwd "$CWD"`));
    assert.ok(
      !plan.wrapper.includes("command -v tmux"),
      "the wrapper must not depend on the unit's PATH to find tmux",
    );
    assert.match(plan.wrapper, /^TMUX='[^']+'$/m);
    assert.match(plan.wrapper, /has-session -t "\$SESSION"/);
    assert.ok(plan.wrapper.includes(`SOCKET='${plan.socketPath}'`));
    assert.ok(!plan.wrapper.includes("--mode="));
    assert.ok(plan.wrapper.includes("PI_CODING_AGENT_DIR="));
    assert.ok(plan.wrapper.includes(`export OMP_TELEGRAM_HOST='${plan.unitName}'`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install writes both artifacts before enabling the unit", () => {
  const { dir, input } = createInput("install");
  try {
    const plan = planTelegramHostAction(input);
    const kinds = plan.steps.map((step: TelegramHostStep) => step.kind);
    assert.deepEqual(kinds, ["write", "write", "write", "run", "run"]);
    const enableIndex = plan.steps.findIndex(
      (step: TelegramHostStep) => step.kind === "run" && step.command.includes("enable"),
    );
    const lastWrite = plan.steps.reduce(
      (last: number, step: TelegramHostStep, index: number) => (step.kind === "write" ? index : last),
      -1,
    );
    assert.ok(lastWrite < enableIndex, "artifacts must exist before the unit is enabled");
    assert.deepEqual(
      plan.steps.filter((step: TelegramHostStep) => step.kind === "run").map((step: TelegramHostStep) =>
        step.kind === "run" ? step.command : [],
      ),
      [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "omp-telegram-host-test"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall disables the unit before removing its artifacts and anchor", () => {
  const { dir, input } = createInput("uninstall");
  try {
    const plan = planTelegramHostAction(input);
    assert.equal(plan.steps[0].kind, "run");
    assert.equal(plan.steps[0].kind === "run" ? plan.steps[0].command.includes("disable") : false, true);
    assert.equal(
      plan.steps[0].kind === "run" ? plan.steps[0].optional : undefined,
      true,
      "an already-disabled unit must not strand the rest of the uninstall",
    );
    const removed = plan.steps
      .filter((step: TelegramHostStep) => step.kind === "remove")
      .map((step: TelegramHostStep) => (step.kind === "remove" ? step.path : ""));
    assert.ok(removed.includes(plan.unitPath));
    assert.ok(removed.includes(plan.wrapperPath));
    assert.ok(removed.includes(resolveTelegramHostAnchorPath(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status and attach command order is read-only", () => {
  const { dir, input } = createInput("status");
  try {
    const plan = planTelegramHostAction(input);
    assert.ok(plan.steps.every((step: TelegramHostStep) => step.kind === "run"));
    assert.ok(
      plan.steps.every((step: TelegramHostStep) =>
        step.kind === "run" ? step.optional === true : false,
      ),
    );
    assert.ok(plan.steps.some((step: TelegramHostStep) => step.kind === "run" && step.command.includes("is-active")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply stops at the first required failure and writes artifacts first", async () => {
  const { dir, input } = createInput("install");
  try {
    const plan = planTelegramHostAction(input);
    const calls: string[] = [];
    const written: string[] = [];
    const deps: TelegramHostApplyDeps = {
      runCommand: async (command) => {
        calls.push(command.join(" "));
        if (command.includes("enable")) return { ok: false, output: "enable failed" };
        return { ok: true, output: "" };
      },
      writeTextFile: (path) => {
        written.push(path);
      },
      ensureDir: () => {},
      removeFile: () => {},
    };
    const result = await applyTelegramHostPlan(plan, deps);
    assert.equal(result.ok, false);
    assert.match(result.message, /enable failed/);
    assert.deepEqual(written, [plan.wrapperPath, plan.unitPath, resolveTelegramHostAnchorPath(dir)]);
    assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable --now omp-telegram-host-test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply tolerates an optional command failure", async () => {
  const { dir, input } = createInput("uninstall");
  try {
    const plan = planTelegramHostAction(input);
    const removed: string[] = [];
    const result = await applyTelegramHostPlan(plan, {
      runCommand: async (command) =>
        command.includes("kill-server") || command.includes("disable")
          ? { ok: false, output: "no server" }
          : { ok: true, output: "" },
      writeTextFile: () => {},
      ensureDir: () => {},
      removeFile: (path) => {
        removed.push(path);
      },
    });
    assert.equal(result.ok, true);
    assert.ok(
      removed.includes(plan.unitPath) && removed.includes(plan.wrapperPath),
      "a unit that is already disabled must still have its artifacts removed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host steps run the resolved tmux binary instead of trusting the unit PATH", () => {
  const { dir, input } = createInput("uninstall");
  try {
    const plan = planTelegramHostAction({ ...input, tmuxExecutable: "/opt/tmux/bin/tmux" });
    assert.deepEqual(
      plan.steps
        .filter((step: TelegramHostStep) => step.kind === "run" && step.command.includes("kill-server"))
        .map((step: TelegramHostStep) => (step.kind === "run" ? step.command : [])),
      [["/opt/tmux/bin/tmux", "-S", plan.socketPath, "kill-server"]],
    );
    assert.ok(plan.wrapper.includes("TMUX='/opt/tmux/bin/tmux'"));
    const status = planTelegramHostAction({
      ...input,
      action: "status",
      tmuxExecutable: "/opt/tmux/bin/tmux",
    });
    assert.deepEqual(
      status.steps
        .filter((step: TelegramHostStep) => step.kind === "run" && step.command.includes("list-panes"))
        .map((step: TelegramHostStep) => (step.kind === "run" ? step.command[0] : "")),
      ["/opt/tmux/bin/tmux"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path settings stay literal so systemd reads them as absolute paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-unit-quote-"));
  try {
    const plan = planTelegramHostAction({
      action: "install",
      agentDir: dir,
      cwd: '/tmp/host "quoted" dir',
      ompExecutable: "/usr/local/bin/omp",
      systemdUserDir: join(dir, "systemd"),
      unitName: "omp-telegram-host-test",
    });
    assert.ok(
      plan.unit.split("\n").includes('WorkingDirectory=/tmp/host "quoted" dir'),
      "systemd parses WorkingDirectory as a literal path, so quoting it makes the path non-absolute",
    );

    const specifierPlan = planTelegramHostAction({
      action: "install",
      agentDir: dir,
      cwd: "/tmp/host 100% workspace",
      ompExecutable: "/usr/local/bin/omp",
      systemdUserDir: join(dir, "systemd"),
      unitName: "omp-telegram-host-test",
    });
    assert.ok(
      specifierPlan.unit.split("\n").includes("WorkingDirectory=/tmp/host 100%% workspace"),
      "a literal percent must be escaped so systemd does not expand it as a specifier",
    );
    assert.equal(readSystemdAssignment(plan.unit, "ExecStart"), plan.wrapperPath);

    const windowsPlan = planTelegramHostAction({
      action: "install",
      agentDir: "D:\\a\\_temp\\pi-telegram-host",
      cwd: "/tmp/host-workspace",
      ompExecutable: "/usr/local/bin/omp",
      systemdUserDir: "D:\\a\\_temp\\pi-telegram-host\\systemd",
      unitName: "omp-telegram-host-test",
    });
    assert.ok(windowsPlan.wrapperPath.includes("\\"), "the simulated host path must carry separators to escape");
    assert.equal(
      readSystemdAssignment(windowsPlan.unit, "ExecStart"),
      windowsPlan.wrapperPath,
      "an escaped separator must unquote back to the rendered wrapper",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commandExists requires an executable file rather than any file on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-command-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "plain-tool"), "not executable\n", { mode: 0o644 });
    writeFileSync(join(dir, "real-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    assert.equal(commandExists("real-tool"), true);
    if (process.platform !== "win32") {
      assert.equal(commandExists("plain-tool"), false, "a readable file is not a runnable command");
    }
    assert.equal(commandExists("absent-tool"), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that cannot spawn settles instead of leaving a timer over nothing", async () => {
  const invalid = await runTelegramHostCommand([`${process.execPath}\u0000rejected`, "hi"], {
    timeoutMs: 50,
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.output.length > 0, "a refused spawn must report why");

  const missing = await runTelegramHostCommand(
    [join(tmpdir(), "pi-telegram-host-absent-binary")],
    { timeoutMs: 2_000 },
  );
  assert.equal(missing.ok, false);

  const echoed = await runTelegramHostCommand(
    [process.execPath, "-e", "process.stdout.write('host-ok')"],
    { timeoutMs: 5_000 },
  );
  assert.equal(echoed.ok, true);
  assert.match(echoed.output, /host-ok/);
});

test("anchor round-trips the fixed host working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-anchor-"));
  try {
    assert.equal(readTelegramHostAnchor(dir), undefined);
    const path = resolveTelegramHostAnchorPath(dir);
    assert.equal(planTelegramHostAction({
      action: "install",
      agentDir: dir,
      cwd: "/tmp/workspace-a",
      ompExecutable: "omp",
      systemdUserDir: join(dir, "systemd"),
    }).steps.some((step) => step.kind === "write" && step.path === path), true);
    const anchor = renderTelegramHostAnchor({ cwd: "/tmp/workspace-a", unitName: "u" });
    assert.deepEqual(JSON.parse(anchor), { version: 1, cwd: "/tmp/workspace-a", unitName: "u" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Bun standalone binary resolves to a real executable, not its virtual path", () => {
  assert.equal(
    resolveOmpExecutable({
      argv: ["bun", "/$bunfs/root/omp-linux-x64"],
      execPath: "/home/user/.bun/bin/omp",
      exists: (path) => path === "/home/user/.bun/bin/omp",
      resolveOnPath: () => "UNREACHED",
    }),
    "/home/user/.bun/bin/omp",
  );
  assert.equal(
    resolveOmpExecutable({
      argv: ["bun", "/home/user/lib/omp.js"],
      execPath: "/usr/bin/bun",
      exists: () => true,
      resolveOnPath: () => "UNREACHED",
    }),
    "/home/user/lib/omp.js",
  );
  assert.equal(
    resolveOmpExecutable({
      argv: ["bun", "/$bunfs/root/omp"],
      execPath: "/usr/bin/bun",
      exists: (path) => path !== "/$bunfs/root/omp",
      resolveOnPath: () => "/usr/local/bin/omp",
    }),
    "/usr/local/bin/omp",
  );
  assert.equal(
    resolveOmpExecutable({
      argv: ["bun"],
      execPath: "/usr/bin/node",
      exists: () => false,
      resolveOnPath: () => undefined,
    }),
    "omp",
  );
});

test("the wrapper fails loudly when the session dies during startup", () => {
  const wrapper = renderTelegramHostWrapper({
    cwd: "/home/user/Projects",
    agentDir: "/home/user/.omp/agent",
    ompExecutable: "/home/user/.bun/bin/omp",
    tmuxExecutable: "/usr/bin/tmux",
    socketPath: "/home/user/.omp/agent/telegram-host/tmux.sock",
  });
  assert.match(wrapper, /has-session[^\n]*\n\s*then|if ! "\$TMUX"/);
  assert.ok(
    wrapper.includes("exited immediately"),
    "a session that dies at startup must name the executable instead of exiting 0",
  );
  const startupGuard = wrapper.slice(0, wrapper.indexOf("while \"$TMUX\""));
  assert.ok(
    startupGuard.includes("exit 1"),
    "the startup probe must exit non-zero so systemd records a reason",
  );
});

test("the command parser rejects unknown actions and options", () => {
  assert.deepEqual(parseTelegramHostCommand("install"), { action: "install", dryRun: false });
  assert.deepEqual(parseTelegramHostCommand("  restart  --dry-run "), { action: "restart", dryRun: true });
  assert.equal(parseTelegramHostCommand("").action, undefined);
  assert.match(parseTelegramHostCommand("explode").invalid ?? "", /Unknown action: explode/);
  assert.match(parseTelegramHostCommand("install --loud").invalid ?? "", /Unknown option: --loud/);
  assert.match(parseTelegramHostCommand("install extra").invalid ?? "", /Unknown arguments: extra/);
});

test("argument completion offers every action and then the dry-run modifier", () => {
  const actions = getTelegramHostArgumentCompletions("");
  assert.deepEqual(
    actions.map((item) => item.value),
    ["install", "uninstall", "restart", "status", "attach"],
  );
  assert.ok(actions.every((item) => (item.description ?? "").length > 0));

  assert.deepEqual(
    getTelegramHostArgumentCompletions("re").map((item) => item.value),
    ["restart"],
  );

  assert.deepEqual(
    getTelegramHostArgumentCompletions("restart ").map((item) => item.value),
    ["restart --dry-run"],
  );
  assert.deepEqual(getTelegramHostArgumentCompletions("status "), []);
  assert.deepEqual(getTelegramHostArgumentCompletions("explode "), []);

  const parsed = parseTelegramHostCommand(
    getTelegramHostArgumentCompletions("restart ")[0]?.value ?? "",
  );
  assert.deepEqual(parsed, { action: "restart", dryRun: true });
});

test("only the resident host session itself is a host session", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-session-"));
  try {
    const socketPath = resolveTelegramHostSocketPath(dir);
    const unitName = "omp-telegram-host";

    assert.equal(
      isTelegramHostSession({ socketPath, unitName, env: {} }),
      false,
      "an ordinary terminal sharing the hosted agent directory must never claim host identity",
    );
    assert.equal(
      isTelegramHostSession({
        socketPath,
        unitName,
        env: { TMUX: `${join(tmpdir(), "other.sock")},4242,0` },
      }),
      false,
      "an unrelated tmux session is not the host",
    );
    assert.equal(
      isTelegramHostSession({
        socketPath,
        unitName,
        env: { OMP_TELEGRAM_HOST: "omp-telegram-host-other" },
      }),
      false,
      "a stamp from a different unit is not this host",
    );

    assert.equal(
      isTelegramHostSession({ socketPath, unitName, env: { OMP_TELEGRAM_HOST: unitName } }),
      true,
    );
    assert.equal(
      isTelegramHostSession({ socketPath, unitName, env: { TMUX: `${socketPath},4242,0` } }),
      true,
      "a host installed before the stamp existed is still identified by its private socket",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-connect types the connect command only in an unclaimed host", async () => {
  const sent: string[] = [];
  const base = {
    hasBotToken: () => true,
    ownsLock: () => false,
    isFollowerRegistered: () => false,
    sleep: async () => {},
    stdin: {
      send: (data: string) => {
        sent.push(data);
        return true;
      },
    },
  };
  assert.equal(await runTelegramHostAutoConnect({ ...base, isEnabled: () => false }), false);
  assert.deepEqual(sent, []);

  assert.equal(await runTelegramHostAutoConnect({ ...base, isEnabled: () => true }), true);
  assert.deepEqual(sent, ["/telegram-connect", "\r"]);

  sent.length = 0;
  assert.equal(
    await runTelegramHostAutoConnect({ ...base, isEnabled: () => true, ownsLock: () => true }),
    false,
  );
  assert.deepEqual(sent, []);

  sent.length = 0;
  assert.equal(
    await runTelegramHostAutoConnect({ ...base, isEnabled: () => true, hasBotToken: () => false }),
    false,
  );
  assert.deepEqual(sent, []);

  sent.length = 0;
  assert.equal(
    await runTelegramHostAutoConnect({ ...base, isEnabled: () => true, isFollowerRegistered: () => true }),
    false,
  );
  assert.deepEqual(sent, []);
});

test("a username with a space never escapes the rendered wrapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-host-quote-"));
  try {
    const plan = planTelegramHostAction({
      action: "install",
      agentDir: dir,
      cwd: "/tmp/it's a workspace",
      ompExecutable: "/opt/my omp/bin/omp",
      systemdUserDir: join(dir, "systemd"),
      unitName: "omp-telegram-host-test",
    });
    assert.ok(plan.wrapper.includes("'/tmp/it'\\''s a workspace'"));
    assert.ok(plan.wrapper.includes("'/opt/my omp/bin/omp'"));
    assert.equal(resolveTelegramHostUnitPath("u", join(dir, "systemd")), join(dir, "systemd", "u.service"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
