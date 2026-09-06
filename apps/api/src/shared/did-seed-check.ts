import type { OrganizationRepository } from "../persistence/types/index.js";
import type { Keystore } from "./keystore.js";

/**
 * Boot-time diagnostic: every org's `didSeedEncrypted` must decrypt, under
 * the LIVE DID_MASTER_KEY, back to its own stored `did`. A mismatch means
 * this org's row was written under a different key — typically a Docker
 * volume reused across deployments with a fresh/different DID_MASTER_KEY.
 * Left unchecked, that mismatch stays silent until the org's key is first
 * used to sign (deep inside proposal execution), surfacing as a bare
 * `EXECUTION_FAILED: Unsupported state or unable to authenticate data` with
 * no indication of which org or why. Never throws — boot proceeds regardless
 * (mirrors env.ts's own DID_MASTER_KEY warning); this only makes the failure
 * loud and attributable at the point it was actually introduced.
 */
export async function checkDidSeedIntegrity(organizations: OrganizationRepository, keystore: Keystore): Promise<void> {
  const orgs = await organizations.list();
  for (const org of orgs) {
    let recomputedDid: string;
    try {
      recomputedDid = keystore.keyOf(org.didSeedEncrypted).did;
    } catch (err) {
      console.error(
        `[keystore] org '${org.name}' (${org.id}) has a didSeedEncrypted that will not decrypt under the ` +
          `live DID_MASTER_KEY (${(err as Error).message}). This org's row was likely written under a ` +
          `different DID_MASTER_KEY — e.g. a Docker volume reused across deployments with a fresh key. Any ` +
          `attempt to sign as this org (member onboarding, credential issuance) will fail. Re-seed this org ` +
          `or restore the DID_MASTER_KEY it was created under.`,
      );
      continue;
    }
    if (recomputedDid !== org.did) {
      console.error(
        `[keystore] org '${org.name}' (${org.id}) has a didSeedEncrypted that decrypts to a DIFFERENT did ` +
          `(${recomputedDid}) than its stored did (${org.did}). Signing as this org is unsafe until this is ` +
          `resolved.`,
      );
    }
  }
}
