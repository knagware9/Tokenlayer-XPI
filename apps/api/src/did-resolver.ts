/**
 * The platform's single DID resolution point (W3C DID Resolution shape).
 * Composes core's did:key derivation with the on-chain DidRegistry read.
 * Never throws; a failed/absent chain read yields source:"off-chain" with
 * NO registration claims — the resolver never fabricates chain state.
 */
import { publicKeyFromDidKey } from "@tokenlayer/core";
import type { IdentityRegistry } from "./registry.js";

export interface ResolvedDidDocument {
  "@context": string[];
  id: string;
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  authentication: string[];
  assertionMethod: string[];
}

export type DidDocumentMetadata =
  | { source: "chain"; registered: boolean; active: boolean; deactivated: boolean; chainId: string; registry: string }
  | { source: "off-chain" };

export interface DidResolutionResult {
  didResolutionMetadata: { contentType: "application/did+ld+json"; error?: "invalidDid" | "methodNotSupported" };
  didDocument: ResolvedDidDocument | null;
  didDocumentMetadata: DidDocumentMetadata;
}

const failure = (error: "invalidDid" | "methodNotSupported"): DidResolutionResult => ({
  didResolutionMetadata: { contentType: "application/did+ld+json", error },
  didDocument: null,
  didDocumentMetadata: { source: "off-chain" },
});

export async function resolveDid(
  did: string,
  deps: { registry?: IdentityRegistry; onChainError?: (err: unknown) => void },
): Promise<DidResolutionResult> {
  if (typeof did !== "string" || !did.startsWith("did:")) return failure("invalidDid");
  if (!did.startsWith("did:key:")) return failure("methodNotSupported");
  try {
    publicKeyFromDidKey(did);
  } catch {
    return failure("invalidDid");
  }

  const vm = `${did}#0`;
  const didDocument: ResolvedDidDocument = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [{ id: vm, type: "Ed25519VerificationKey2020", controller: did, publicKeyMultibase: did.slice("did:key:".length) }],
    authentication: [vm],
    assertionMethod: [vm],
  };

  let didDocumentMetadata: DidDocumentMetadata = { source: "off-chain" };
  if (deps.registry) {
    try {
      const r = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, did);
      didDocumentMetadata = {
        source: "chain",
        registered: r.registered,
        active: r.active,
        deactivated: r.registered && !r.active,
        chainId: deps.registry.chainId,
        registry: deps.registry.didRegistry,
      };
    } catch (err) {
      deps.onChainError?.(err);
    }
  }
  return { didResolutionMetadata: { contentType: "application/did+ld+json" }, didDocument, didDocumentMetadata };
}
