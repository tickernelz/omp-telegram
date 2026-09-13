/**
 * Host settings double for the OMP SDK boundary
 * Zones: test infrastructure, omp agent sdk boundary
 * Serves the one host specifier lib/pi.ts imports lazily, so settings-backed code paths run under node type stripping
 */
import { registerHooks } from "node:module";
import { normalize } from "node:path";

const HOST_SDK_SPECIFIER = "@oh-my-pi/pi-coding-agent";
const HOST_SDK_STUB_URL = import.meta.url;

export interface HostSettingsWrite {
  cwd: string;
  key: string;
  value: unknown;
}

const writes: HostSettingsWrite[] = [];
const flushedCwds: string[] = [];
const reloadedCwds: string[] = [];

class StubHostSettings {
  readonly #cwd: string;
  readonly #values: Map<string, unknown>;

  constructor(cwd: string, values: Map<string, unknown>) {
    this.#cwd = normalize(cwd);
    this.#values = values;
  }

  getCwd(): string {
    return this.#cwd;
  }

  async cloneForCwd(cwd: string): Promise<StubHostSettings> {
    return new StubHostSettings(cwd, new Map(this.#values));
  }

  async reloadFromDisk(): Promise<void> {
    reloadedCwds.push(this.#cwd);
  }

  async flush(): Promise<void> {
    flushedCwds.push(this.#cwd);
  }

  isConfigured(key: string): boolean {
    return this.#values.has(key);
  }

  get(key: string): unknown {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): void {
    this.#values.set(key, value);
    writes.push({ cwd: this.#cwd, key, value });
  }
}

export const settings = new StubHostSettings(process.cwd(), new Map());

export function readHostSettingsWrites(): HostSettingsWrite[] {
  return [...writes];
}

export function readHostSettingsFlushes(): string[] {
  return [...flushedCwds];
}

export function readHostSettingsReloads(): string[] {
  return [...reloadedCwds];
}

export function resetHostSettingsStub(): void {
  writes.length = 0;
  flushedCwds.length = 0;
  reloadedCwds.length = 0;
}

let hookInstalled = false;

/** Serve `@oh-my-pi/pi-coding-agent` from this module for the current process. */
export function installHostSdkSettingsHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== HOST_SDK_SPECIFIER) return next(specifier, context);
      return { url: HOST_SDK_STUB_URL, shortCircuit: true };
    },
  });
}
