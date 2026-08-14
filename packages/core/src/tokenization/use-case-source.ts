import { UseCaseRegistry } from "./use-case-registry.js";
import type { UseCaseDefinition, UseCaseSource } from "../shared/types.js";

/**
 * An in-memory UseCaseSource backed by a validated UseCaseRegistry. Used by the
 * engine's tests and anywhere use cases are fixed in code. The DB-backed
 * repository in the API is the other implementation of UseCaseSource.
 */
export class StaticUseCaseSource implements UseCaseSource {
  private readonly registry: UseCaseRegistry;

  constructor(definitions: readonly unknown[]) {
    this.registry = new UseCaseRegistry(definitions);
  }

  async has(key: string): Promise<boolean> {
    return this.registry.has(key);
  }

  async get(key: string): Promise<UseCaseDefinition> {
    return this.registry.get(key);
  }

  async list(): Promise<UseCaseDefinition[]> {
    return this.registry.list();
  }
}
