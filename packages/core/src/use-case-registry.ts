import { PolicyError } from "./errors.js";
import { tokenTypeForStandard, type UseCaseDefinition } from "./types.js";
import { validateUseCaseDefinition } from "./validation.js";

/** Validates and fills derived fields (tokenType) on a raw definition. */
export function normalizeUseCaseDefinition(def: unknown): UseCaseDefinition {
  validateUseCaseDefinition(def);
  return { ...def, tokenType: tokenTypeForStandard(def.tokenStandard) };
}

/**
 * Holds the set of configured use cases. Definitions are validated and
 * normalised on construction, so an invalid config fails fast at startup rather
 * than at request time.
 */
export class UseCaseRegistry {
  private readonly byKey = new Map<string, UseCaseDefinition>();

  constructor(definitions: readonly unknown[]) {
    for (const raw of definitions) {
      const def = normalizeUseCaseDefinition(raw);
      if (this.byKey.has(def.key)) {
        throw new PolicyError("INVALID_USECASE", `duplicate use case key '${def.key}'`, { key: def.key });
      }
      this.byKey.set(def.key, def);
    }
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): UseCaseDefinition {
    const def = this.byKey.get(key);
    if (!def) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    return def;
  }

  list(): UseCaseDefinition[] {
    return [...this.byKey.values()];
  }
}
