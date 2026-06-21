import { PolicyError } from "./errors.js";
import type { Actor, LifecycleAction, Role } from "./types.js";

/**
 * Role → permitted-action matrix. Deliberately simple and declarative so it can
 * be audited at a glance and extended as new actions arrive in later phases.
 */
const MATRIX: Record<Role, ReadonlySet<LifecycleAction>> = {
  Admin: new Set<LifecycleAction>([
    "issue",
    "mint",
    "transfer",
    "burn",
    "freeze",
    "unfreeze",
    "allow",
    "disallow",
    "read",
  ]),
  Issuer: new Set<LifecycleAction>(["issue", "mint", "allow", "disallow", "read"]),
  Operator: new Set<LifecycleAction>(["transfer", "burn", "freeze", "unfreeze", "read"]),
  Viewer: new Set<LifecycleAction>(["read"]),
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
