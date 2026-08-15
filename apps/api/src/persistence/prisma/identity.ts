/**
 * PRISMA REPOSITORIES — Identity tables — credential programmes and verification requests.
 *
 * Bucketed by `../model-domains.ts`. Its in-memory twin is `../memory/identity.ts`,
 * and `persistence-parity.test.ts` fails if the two stop implementing the same
 * set — the drift that the PARITY RULE exists to catch.
 */
import { prisma } from "./client.js";
import type { CredentialUseCaseDefinition, UseCaseTemplate } from "@tokenlayer/core";
import type { CredentialUseCaseRepository, CredentialUseCaseTemplateRepository, VerificationRequestRecord, VerificationRequestRepository, VerificationStatus } from "../types/index.js";

export function rowToCredentialUseCase(r: {
  key: string; name: string; description: string | null;
  credentialTypes: string; issuer: string; holderPolicy: string; verifier: string; ownerOrgId: string | null;
  holderAcceptance: boolean; sandbox: boolean;
}): CredentialUseCaseDefinition {
  return {
    key: r.key, name: r.name, description: r.description ?? undefined,
    credentialTypes: JSON.parse(r.credentialTypes), issuer: JSON.parse(r.issuer),
    holderPolicy: JSON.parse(r.holderPolicy), verifier: JSON.parse(r.verifier),
    ownerOrgId: r.ownerOrgId,
    ...(r.holderAcceptance ? { holderAcceptance: true } : {}),
    // Unlike holderAcceptance this is ALWAYS present: the memory repo normalises
    // an absent sandbox to false, so omitting it here when false would be the
    // exact memory/prisma divergence THE PARITY RULE forbids.
    sandbox: r.sandbox,
  };
}

export class PrismaCredentialUseCaseRepository implements CredentialUseCaseRepository {
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.create({ data: {
      key: def.key, name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null, holderAcceptance: def.holderAcceptance ?? false,
      sandbox: def.sandbox === true } });
    return rowToCredentialUseCase(r);
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const r = await prisma.credentialUseCase.findUnique({ where: { key } });
    return r ? rowToCredentialUseCase(r) : null;
  }
  async has(key: string): Promise<boolean> { return (await prisma.credentialUseCase.count({ where: { key } })) > 0; }
  async list(): Promise<CredentialUseCaseDefinition[]> {
    return (await prisma.credentialUseCase.findMany({ orderBy: { createdAt: "asc" } })).map(rowToCredentialUseCase);
  }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.update({ where: { key }, data: {
      name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null, holderAcceptance: def.holderAcceptance ?? false,
      sandbox: def.sandbox === true } });
    return rowToCredentialUseCase(r);
  }
}

function toCredentialUseCaseTemplate(r: {
  key: string; name: string; category: string; description: string | null;
  parameters: string; body: string;
}): UseCaseTemplate {
  return {
    key: r.key, name: r.name, category: r.category, description: r.description ?? undefined,
    parameters: JSON.parse(r.parameters), body: JSON.parse(r.body),
  };
}

export class PrismaCredentialUseCaseTemplateRepository implements CredentialUseCaseTemplateRepository {
  async list(): Promise<UseCaseTemplate[]> {
    return (await prisma.credentialUseCaseTemplate.findMany({ orderBy: { createdAt: "asc" } })).map(toCredentialUseCaseTemplate);
  }
  async get(key: string): Promise<UseCaseTemplate | null> {
    const r = await prisma.credentialUseCaseTemplate.findUnique({ where: { key } });
    return r ? toCredentialUseCaseTemplate(r) : null;
  }
  async create(t: UseCaseTemplate): Promise<UseCaseTemplate> {
    const r = await prisma.credentialUseCaseTemplate.create({ data: {
      key: t.key, name: t.name, category: t.category, description: t.description ?? null,
      parameters: JSON.stringify(t.parameters), body: JSON.stringify(t.body) } });
    return toCredentialUseCaseTemplate(r);
  }
}

const toVerificationRequest = (r: {
  id: string; verifierOrgId: string; holderDid: string; requestedTypes: string; purpose: string; challenge: string;
  status: string; presentationVpJwt: string | null; consentedAt: Date | null; consentedCredentialIds: string | null;
  verifierResult: string | null; verifiedAt: Date | null; createdAt: Date; expiresAt: Date;
  credentialUseCaseKey: string | null;
}): VerificationRequestRecord => ({
  id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid,
  requestedTypes: JSON.parse(r.requestedTypes) as string[], purpose: r.purpose, challenge: r.challenge,
  status: r.status as VerificationStatus, presentationVpJwt: r.presentationVpJwt,
  consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
  consentedCredentialIds: r.consentedCredentialIds ? (JSON.parse(r.consentedCredentialIds) as string[]) : null,
  verifierResult: r.verifierResult ? (JSON.parse(r.verifierResult) as Record<string, unknown>) : null,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
  credentialUseCaseKey: r.credentialUseCaseKey,
});

export class PrismaVerificationRequestRepository implements VerificationRequestRepository {
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.create({
      data: {
        verifierOrgId: input.verifierOrgId, holderDid: input.holderDid,
        requestedTypes: JSON.stringify(input.requestedTypes), purpose: input.purpose, challenge: input.challenge,
        status: input.status, presentationVpJwt: input.presentationVpJwt,
        consentedAt: input.consentedAt ? new Date(input.consentedAt) : null,
        consentedCredentialIds: input.consentedCredentialIds ? JSON.stringify(input.consentedCredentialIds) : null,
        verifierResult: input.verifierResult ? JSON.stringify(input.verifierResult) : null,
        verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null,
        expiresAt: new Date(input.expiresAt),
        credentialUseCaseKey: input.credentialUseCaseKey,
      },
    }));
  }
  async get(id: string): Promise<VerificationRequestRecord | null> {
    const r = await prisma.verificationRequest.findUnique({ where: { id } });
    return r ? toVerificationRequest(r) : null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { holderDid, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { verifierOrgId: orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async list(): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany()).map(toVerificationRequest);
  }
  async setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status: "consented", presentationVpJwt: input.vpJwt, consentedCredentialIds: JSON.stringify(input.credentialIds), consentedAt: new Date(input.at) } }));
  }
  async setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status } }));
  }
  async setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { verifierResult: JSON.stringify(input.result), verifiedAt: new Date(input.at) } }));
  }
}
