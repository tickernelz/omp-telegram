/**
 * Host settings double for the OMP SDK boundary
 * Zones: test infrastructure, omp agent sdk boundary
 * Serves the host specifiers lib/pi.ts imports lazily, so settings-backed code paths run under node type stripping.
 *
 * Two host generations are modelled:
 *  - default: OMP <18.3, settings addressed by string path (`isConfigured("x")`)
 *  - registry mode: OMP >=18.3, the typed setting registry is served from
 *    `@oh-my-pi/pi-coding-agent/config/registry` and a string path raises the
 *    issue #2 TypeError instead of resolving.
 */
import { registerHooks } from "node:module";
import { normalize } from "node:path";

const HOST_SDK_SPECIFIER = "@oh-my-pi/pi-coding-agent";
const REGISTRY_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/registry";
const HOST_SDK_STUB_URL = import.meta.url;

export interface HostSettingsWrite {
  cwd: string;
  key: string;
  value: unknown;
}

const writes: HostSettingsWrite[] = [];
const handleReads: string[] = [];
const handleWrites: HostSettingsWrite[] = [];
const flushedCwds: string[] = [];
const reloadedCwds: string[] = [];

let registryMode = false;

/** Switch the double to OMP >=18.3 semantics: string paths throw, handle API answers. */
export function enableHostRegistryMode(): void {
  registryMode = true;
}

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

  isConfigured(setting: unknown): boolean {
    if (typeof setting === "string") {
      if (registryMode) {
        // OMP >=18.3 reads `setting.segments`; a string path leaves it
        // undefined and the for-of raises `n of t` (issue #2).
        const segments = Reflect.get(Object(setting), "segments") as
          | readonly string[]
          | undefined;
        const walked: string[] = [];
        for (const segment of segments as string[]) walked.push(segment);
        return walked.includes(setting) || this.#values.has(setting);
      }
      return this.#values.has(setting);
    }
    const id = (setting as { id?: string } | null)?.id;
    if (id === undefined) return false;
    handleReads.push(id);
    return this.#values.has(id);
  }

  get(key: string): unknown {
    if (registryMode) {
      this.isConfigured(key); // a string path throws exactly like >=18.3
      return undefined;
    }
    return this.#values.get(key);
  }

  set(key: string, value: unknown): void {
    if (registryMode) {
      this.isConfigured(key); // a string path throws exactly like >=18.3
      return;
    }
    this.#values.set(key, value);
    writes.push({ cwd: this.#cwd, key, value });
  }

  rawValue(setting: unknown): unknown {
    const id = (setting as { id?: string } | null)?.id ?? "";
    handleReads.push(id);
    return this.#values.get(id);
  }

  /** Sink for `handle.set(instance, value)` in registry mode. */
  writeHandleValue(id: string, value: unknown): void {
    handleWrites.push({ cwd: this.#cwd, key: id, value });
    this.#values.set(id, value);
  }

  /** Drop persisted values so each test starts from an empty host. */
  clearValues(): void {
    this.#values.clear();
  }
}

const ENABLED_MODELS_HANDLE = {
  id: "enabledModels",
  set(scope: unknown, value: unknown): void {
    (scope as StubHostSettings).writeHandleValue(
      ENABLED_MODELS_HANDLE.id,
      value,
    );
  },
};

export const settings = new StubHostSettings(process.cwd(), new Map());

/** `config/registry` subpath export consumed by lib/pi.ts. */
export function lookup(id: string): typeof ENABLED_MODELS_HANDLE | undefined {
  if (!registryMode) return undefined;
  return id === ENABLED_MODELS_HANDLE.id ? ENABLED_MODELS_HANDLE : undefined;
}

export function readHostSettingsWrites(): HostSettingsWrite[] {
  return [...writes];
}

export function readHostHandleReads(): string[] {
  return [...handleReads];
}

export function readHostHandleWrites(): HostSettingsWrite[] {
  return [...handleWrites];
}

export function readHostSettingsFlushes(): string[] {
  return [...flushedCwds];
}

export function readHostSettingsReloads(): string[] {
  return [...reloadedCwds];
}

export function resetHostSettingsStub(): void {
  registryMode = false;
  settings.clearValues();
  writes.length = 0;
  handleReads.length = 0;
  handleWrites.length = 0;
  flushedCwds.length = 0;
  reloadedCwds.length = 0;
}

let hookInstalled = false;

/** Serve the host SDK and its settings registry from this module. */
export function installHostSdkSettingsHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier === HOST_SDK_SPECIFIER ||
        specifier === REGISTRY_SPECIFIER
      ) {
        return { url: HOST_SDK_STUB_URL, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
