import { inspect } from "node:util";

/**
 * A value that must never reach a log line, an error message, a manifest or a
 * tool transcript.
 *
 * The wrapper exists because the three ways a credential actually escapes in
 * practice are `${}` interpolation, `JSON.stringify` of a config object and
 * `console.log` of the same object. All three are closed here: the class has no
 * enumerable fields, so `JSON.stringify` sees `"[redacted]"` from `toJSON`,
 * template interpolation goes through `toString`, and `util.inspect` (which is
 * what `console.log` uses for objects) goes through the custom hook.
 *
 * Reading the real value is deliberately a verb, `reveal()`, so that every call
 * site that handles the plaintext is greppable.
 */
export class Secret {
  readonly #value: string;
  readonly #label: string;

  constructor(value: string, label: string) {
    this.#value = value;
    this.#label = label;
    registerSecret(value);
  }

  /** The only way to obtain the plaintext. Grep for `.reveal()` to audit. */
  reveal(): string {
    return this.#value;
  }

  get label(): string {
    return this.#label;
  }

  get isEmpty(): boolean {
    return this.#value.length === 0;
  }

  toString(): string {
    return `[redacted ${this.#label}]`;
  }

  toJSON(): string {
    return `[redacted ${this.#label}]`;
  }

  [inspect.custom](): string {
    return `[redacted ${this.#label}]`;
  }
}

/**
 * Literal secret values seen this process, used as a last-resort masking pass
 * over text that is about to be written somewhere durable. This is defence in
 * depth behind `Secret`, not a substitute for it: a driver or a kernel error
 * can quote a credential we never formatted ourselves.
 *
 * Very short values are not registered. Masking a two-character string would
 * corrupt unrelated text far more often than it would hide a credential.
 */
const MIN_REGISTERED_SECRET_LENGTH = 6;
const registeredSecrets = new Set<string>();

export function registerSecret(value: string): void {
  if (typeof value !== "string") return;
  if (value.length < MIN_REGISTERED_SECRET_LENGTH) return;
  registeredSecrets.add(value);
}

export function registeredSecretValues(): readonly string[] {
  // Sorted longest first so that a secret which contains another secret is
  // masked as a whole rather than being partially rewritten first.
  return [...registeredSecrets].sort((a, b) => b.length - a.length);
}

/** Test-only reset. Never call this from exporter code. */
export function clearRegisteredSecretsForTest(): void {
  registeredSecrets.clear();
}
