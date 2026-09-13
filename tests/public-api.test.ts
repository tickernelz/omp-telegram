/**
 * Regression tests for public package API exports
 * Zones: package boundary, extension interop
 * Guards stable public subpaths and the removal of deep lib wildcard exports
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function assertPackagePathNotExported(specifier: string): Promise<void> {
  await assert.rejects(
    () => import(specifier),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
}

test("Public package subpaths expose the stable extension API", async () => {
  const [
    root,
    inbound,
    outbound,
    delivery,
    activity,
    updates,
    commands,
    sections,
    status,
    voice,
    keyboard,
  ] = await Promise.all([
    import("omp-telegram"),
    import("omp-telegram/inbound"),
    import("omp-telegram/outbound"),
    import("omp-telegram/delivery"),
    import("omp-telegram/activity"),
    import("omp-telegram/updates"),
    import("omp-telegram/commands"),
    import("omp-telegram/sections"),
    import("omp-telegram/status"),
    import("omp-telegram/voice"),
    import("omp-telegram/keyboard"),
  ]);

  assert.deepEqual(Object.keys(root), ["default"]);
  assert.deepEqual(Object.keys(inbound).sort(), [
    "registerTelegramInboundHandler",
  ]);
  assert.deepEqual(Object.keys(outbound).sort(), [
    "recordTelegramRuntimeEvent",
    "registerTelegramOutboundHandler",
  ]);
  assert.deepEqual(Object.keys(delivery).sort(), [
    "deleteTelegramView",
    "editTelegramView",
    "sendTelegramChatAction",
    "sendTelegramView",
  ]);
  assert.deepEqual(Object.keys(activity).sort(), [
    "registerTelegramActivityHandler",
  ]);
  assert.deepEqual(Object.keys(updates).sort(), [
    "assertTelegramUpdateExecutionCurrent",
    "carryTelegramUpdateExecutionFence",
    "createTelegramUpdateExecutionFenceGuard",
    "getTelegramUpdateExecutionFence",
    "registerTelegramUpdateHandler",
  ]);
  assert.deepEqual(Object.keys(commands).sort(), ["registerTelegramCommand"]);
  assert.deepEqual(Object.keys(sections).sort(), [
    "getTelegramSectionDiagnostics",
    "registerTelegramSection",
  ]);
  assert.deepEqual(Object.keys(status).sort(), [
    "registerTelegramStatusLineProvider",
  ]);
  assert.deepEqual(Object.keys(voice).sort(), [
    "TELEGRAM_VOICE_REPLY_MODES",
    "computeVoicePromptContribution",
    "computeVoiceTurnFlags",
    "getTelegramVoiceReplyMode",
    "isVoiceTurn",
    "registerTelegramVoiceSynthesisProvider",
    "registerTelegramVoiceTranscriptionProvider",
    "shouldSuppressPreviewForVoice",
  ]);
  assert.deepEqual(Object.keys(keyboard), []);
});

test("Activity API declares the OMP lifecycle compatibility floor", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, string> };
  assert.equal(
    packageJson.peerDependencies?.["@oh-my-pi/pi-coding-agent"],
    ">=17.4.2",
  );
  assert.equal(
    packageJson.peerDependencies?.["@oh-my-pi/pi-agent-core"],
    ">=17.4.2",
  );
  assert.equal(
    packageJson.peerDependencies?.["@oh-my-pi/pi-ai"],
    ">=17.4.2",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
    undefined,
  );
});

test("Package-private lib implementation paths are not exported", async () => {
  await assertPackagePathNotExported("omp-telegram/lib/updates.ts");
  await assertPackagePathNotExported("omp-telegram/lib/sections.ts");
  await assertPackagePathNotExported("omp-telegram/api/updates.ts");
});
