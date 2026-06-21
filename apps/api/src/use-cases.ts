import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { UseCaseDefinition } from "@tokenlayer/core";
import type { UseCaseRepository } from "./persistence/types.js";

/** Absolute path to the repo's declarative use-case config directory. */
const USE_CASE_DIR = fileURLToPath(new URL("../../../config/use-cases", import.meta.url));

/** Reads every *.json default use case from config/use-cases. */
export function loadDefaultUseCaseDefinitions(dir: string = USE_CASE_DIR): UseCaseDefinition[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as UseCaseDefinition);
}

/** Idempotently seeds the default use cases into a repository. */
export async function seedUseCases(repo: UseCaseRepository): Promise<void> {
  for (const def of loadDefaultUseCaseDefinitions()) {
    if (!(await repo.has(def.key))) {
      await repo.create(def);
    }
  }
}
