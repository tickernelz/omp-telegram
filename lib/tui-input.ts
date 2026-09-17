/**
 * Synthetic TUI input keystroke dispatch runtime
 * Zones: tui, keystroke dispatch, terminal input
 * Owns synthetic keystroke emission for terminal overlays and prompts
 */

export const TELEGRAM_TUI_KEY_DOWN = "j";
export const TELEGRAM_TUI_KEY_CONFIRM = "\r";
export const TELEGRAM_TUI_KEY_CONFIRM_ALT = "\n";

export interface TelegramTuiInputDeps {
	writeInput?: (data: string) => void;
	recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}

export interface TelegramTuiInputRuntime {
	send: (data: string) => boolean;
}

export function createTelegramTuiInputRuntime(deps: TelegramTuiInputDeps = {}): TelegramTuiInputRuntime {
	return {
		send: (data: string): boolean => {
			try {
				if (deps.writeInput) {
					deps.writeInput(data);
					return true;
				}
				process.stdin.emit("data", Buffer.from(data, "utf8"));
				return true;
			} catch (error) {
				deps.recordRuntimeEvent?.("tui-input", error, { phase: "write" });
				return false;
			}
		},
	};
}
