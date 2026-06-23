import { PolicyError } from "./errors.js";
import type { Actor, LifecycleAction, Role } from "./types.js";

/**
 * Role → permitted-action matrix. Deliberately simple and declarative so it can
 * be audited at a glance and extended as new actions arrive in later phases.
 */
const FULL: readonly LifecycleAction[] = ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "read"];

const MATRIX: Record<Role, ReadonlySet<LifecycleAction>> = {
  PlatformAdmin: new Set<LifecycleAction>(FULL),
  UseCaseAdmin: new Set<LifecycleAction>(FULL),
  Issuer: new Set<LifecycleAction>(["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"]),
  Trader: new Set<LifecycleAction>(["transfer", "burn", "buy", "read"]),
  Buyer: new Set<LifecycleAction>(["read", "buy"]),
  Auditor: new Set<LifecycleAction>(["read"]),
};

export class RbacPolicy {
  can(role: Role, action: LifecycleAction): boolean {
    return MATRIX[role]?.has(action) ?? false;
  }

  /** Throws PolicyError("FORBIDDEN") when the actor's role lacks the action. */
  authorize(actor: Actor, action: LifecycleAction): void {
    if (!this.can(actor.role, action)) {
      throw new PolicyError("FORBIDDEN", `role '${actor.role}' may not perform '${action}'`, {
        role: actor.role,
        action,
      });
    }
  }
}
