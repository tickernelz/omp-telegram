/**
 * Telegram plan mode toggle and status runtime
 * Zones: plan mode, composer driving, slash commands
 * Owns /plan mode state detection, composer toggles, and draft preservation
 */

import {
  TELEGRAM_TUI_KEY_CONFIRM,
  type TelegramTuiInputRuntime,
} from "./tui-input.ts";

export type TelegramPlanModeAction = "enter" | "pause" | "exit";

export function isTelegramPlanModeActive(
  systemPrompt: readonly string[] | undefined,
): boolean {
  if (!systemPrompt || !Array.isArray(systemPrompt)) return false;
  return systemPrompt.some(
    (block) => typeof block === "string" && block.includes("Plan mode active."),
  );
}

export interface TelegramPlanModeRuntimeDeps {
  isEnabled: () => boolean;
  tuiInput: TelegramTuiInputRuntime;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramPlanModeRuntime {
  run: (
    action: TelegramPlanModeAction,
    args: string,
    ctx: any,
  ) => Promise<{ ok: boolean; message: string }>;
  isActive: (ctx: any) => boolean;
}

export interface TelegramPlanModeControlBinding {
  getPlanModeOptions: (ctx: any) => { isEnabled: boolean; isActive: boolean };
  handlePlanModeAction: (
    action: TelegramPlanModeAction,
    ctx: any,
  ) => Promise<{ ok: boolean; message: string }>;
}

export function createTelegramPlanModeControlBinding(deps: {
  runtime: TelegramPlanModeRuntime;
  isEnabled: () => boolean;
}): TelegramPlanModeControlBinding {
  const { runtime, isEnabled } = deps;

  function getPlanModeOptions(ctx: any) {
    return { isEnabled: isEnabled(), isActive: runtime.isActive(ctx) };
  }

  async function handlePlanModeAction(action: TelegramPlanModeAction, ctx: any) {
    return runtime.run(action, "", ctx);
  }

  return { getPlanModeOptions, handlePlanModeAction };
}

export function createTelegramPlanModeRuntime(
  deps: TelegramPlanModeRuntimeDeps,
): TelegramPlanModeRuntime {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const record = (error: unknown, details: Record<string, unknown>): void => {
    deps.recordRuntimeEvent?.("plan-mode", error, details);
  };

  const getSystemPrompt = (ctx: any): readonly string[] | undefined => {
    try {
      return ctx?.getSystemPrompt?.();
    } catch {
      return undefined;
    }
  };

  return {
    isActive: (ctx: any): boolean => {
      return isTelegramPlanModeActive(getSystemPrompt(ctx));
    },

    run: async (
      action: TelegramPlanModeAction,
      args: string,
      ctx: any,
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        if (!deps.isEnabled()) {
          return {
            ok: false,
            message: "Plan Review dimatikan. Aktifkan dengan /telegram-settings planreview on.",
          };
        }

        if (ctx?.mode !== "tui" || ctx?.hasUI !== true) {
          return {
            ok: false,
            message: "Sesi ini tidak punya TUI, plan mode hanya bisa diubah dari CLI.",
          };
        }

        if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) {
          return {
            ok: false,
            message: "Agent masih jalan. Tunggu idle lalu ulangi.",
          };
        }

        const currentlyActive = isTelegramPlanModeActive(getSystemPrompt(ctx));

        if (action === "enter" && currentlyActive) {
          return {
            ok: false,
            message: "Plan mode sudah aktif.",
          };
        }

        if (action !== "enter" && !currentlyActive) {
          return {
            ok: false,
            message: "Plan mode tidak aktif.",
          };
        }

        let draft = "";
        try {
          draft = ctx?.ui?.getEditorText?.() ?? "";
        } catch (err) {
          record(err, { phase: "getEditorText" });
        }

        let sequences: string[] = [];
        if (action === "enter") {
          const trimmedArgs = args.trim();
          sequences = [trimmedArgs ? `/plan ${trimmedArgs}` : "/plan"];
        } else if (action === "pause") {
          sequences = ["/plan"];
        } else if (action === "exit") {
          sequences = ["/plan", "/plan"];
        }

        try {
          for (const cmd of sequences) {
            ctx?.ui?.setEditorText?.(cmd);
            deps.tuiInput.send(TELEGRAM_TUI_KEY_CONFIRM);
            await sleep(200);

            if (action === "pause" || action === "exit") {
              deps.tuiInput.send(TELEGRAM_TUI_KEY_CONFIRM);
              await sleep(200);
            }
          }
        } finally {
          try {
            ctx?.ui?.setEditorText?.(draft);
          } catch (err) {
            record(err, { phase: "restoreEditorText" });
          }
        }

        const targetActive = action === "enter";
        const maxWaitMs = 1500;
        const pollIntervalMs = 150;
        const start = deps.now ? deps.now() : Date.now();

        while (true) {
          const active = isTelegramPlanModeActive(getSystemPrompt(ctx));
          if (active === targetActive) {
            if (action === "enter") {
              return { ok: true, message: "📝 Plan mode aktif." };
            }
            if (action === "pause") {
              return { ok: true, message: "⏸ Plan mode dipause." };
            }
            return { ok: true, message: "⏹ Plan mode dimatikan." };
          }
          const currentNow = deps.now ? deps.now() : Date.now();
          if (currentNow - start >= maxWaitMs) {
            break;
          }
          await sleep(pollIntervalMs);
        }

        return {
          ok: false,
          message: "Plan mode tidak berubah — cek CLI.",
        };
      } catch (error) {
        record(error, { phase: "run" });
        return {
          ok: false,
          message: `Gagal mengubah plan mode: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
