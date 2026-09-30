/**
 * Host settings double for the OMP SDK boundary
 * Zones: test infrastructure, omp agent sdk boundary
 * Serves the host specifiers lib/pi.ts imports lazily, so settings-backed code paths run under node type stripping
 */
import { registerHooks } from "node:module";
import { normalize } from "node:path";

const HOST_SDK_SPECIFIER = "@oh-my-pi/pi-coding-agent";
const HOST_SDK_REGISTRY_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/registry";
const HOST_SDK_STUB_URL = import.meta.url;

export interface HostSettingsWrite {
  cwd: string;
  key: string;
  value: unknown;
}

const writes: HostSettingsWrite[] = [];
const flushedCwds: string[] = [];
const reloadedCwds: string[] = [];

/** Registry handle double: OMP >= 18.3 addresses settings through these instead of string paths. */
class StubSettingHandle {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }
}

const HANDLES: Record<string, StubSettingHandle> = {
  enabledModels: new StubSettingHandle("enabledModels"),
};

export function lookup(id: string): StubSettingHandle | undefined {
  return HANDLES[id];
}

type StubHostSettingsFactory = (cwd: string, values: Map<string, unknown>) => StubHostSettings;

abstract class StubHostSettings {
  readonly #cwd: string;
  readonly #values: Map<string, unknown>;
  readonly #create: StubHostSettingsFactory;

  constructor(cwd: string, values: Map<string, unknown>, create: StubHostSettingsFactory) {
    this.#cwd = normalize(cwd);
    this.#values = values;
    this.#create = create;
  }

  getCwd(): string {
    return this.#cwd;
  }

  async cloneForCwd(cwd: string): Promise<StubHostSettings> {
    return this.#create(cwd, new Map(this.#values));
  }

  async reloadFromDisk(): Promise<void> {
    reloadedCwds.push(this.#cwd);
  }

  async flush(): Promise<void> {
    flushedCwds.push(this.#cwd);
  }

  protected readValue(key: string): unknown {
    return this.#values.get(key);
  }

  protected hasValue(key: string): boolean {
    return this.#values.has(key);
  }

  protected storeValue(key: string, value: unknown): void {
    this.#values.set(key, value);
    writes.push({ cwd: this.#cwd, key, value });
  }
}

/** OMP <= 18.2 settings surface: string-path `isConfigured`/`get`/`set`. */
class StubLegacyHostSettings extends StubHostSettings {
  isConfigured(key: string): boolean {
    return this.hasValue(key);
  }

  get(key: string): unknown {
    return this.readValue(key);
  }

  set(key: string, value: unknown): void {
    this.storeValue(key, value);
  }
}

/** OMP >= 18.3 settings surface: string paths removed, registry handles required. */
class StubTypedHostSettings extends StubHostSettings {
  isConfigured(setting: StubSettingHandle): boolean {
    return this.hasValue(setting.id);
  }

  rawValue(setting: StubSettingHandle): unknown {
    return this.readValue(setting.id);
  }

  writeValue(setting: StubSettingHandle, value: unknown, layer: "global" | "override"): void {
    if (layer !== "global") throw new Error(`Unexpected settings layer ${layer}.`);
    this.storeValue(setting.id, value);
  }
}

const createLegacyHostSettings: StubHostSettingsFactory = (cwd, values) =>
  new StubLegacyHostSettings(cwd, values, createLegacyHostSettings);
const createTypedHostSettings: StubHostSettingsFactory = (cwd, values) =>
  new StubTypedHostSettings(cwd, values, createTypedHostSettings);

export let settings: StubHostSettings = createLegacyHostSettings(process.cwd(), new Map());

/** Switch the served host between the pre-18.3 string-path and the 18.3+ registry-handle settings API. */
export function useHostSettingsApi(api: "legacy" | "typed"): void {
  const create = api === "typed" ? createTypedHostSettings : createLegacyHostSettings;
  settings = create(process.cwd(), new Map());
}

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

/** Serve `@oh-my-pi/pi-coding-agent` and its settings registry subpath from this module for the current process. */
export function installHostSdkSettingsHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== HOST_SDK_SPECIFIER && specifier !== HOST_SDK_REGISTRY_SPECIFIER) {
        return next(specifier, context);
      }
      return { url: HOST_SDK_STUB_URL, shortCircuit: true };
    },
  });
}
