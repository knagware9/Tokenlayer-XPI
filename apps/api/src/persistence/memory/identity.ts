/**
 * IN-MEMORY REPOSITORIES — Identity tables — credential programmes and verification requests.
 *
 * Bucketed by `../model-domains.ts`. Its Prisma twin is `../prisma/identity.ts`,
 * and `persistence-parity.test.ts` fails if the two stop implementing the same
 * set — the drift that the PARITY RULE exists to catch.
 */
import { id, now } from "./common.js";
import type { CredentialUseCaseDefinition, UseCaseTemplate } from "@tokenlayer/core";
import type { CredentialUseCaseRepository, CredentialUseCaseTemplateRepository, VerificationRequestRecord, VerificationRequestRepository, VerificationStatus } from "../types/index.js";
import type { ResolvedDisclosure } from "../../identity/selective-disclosure.js";

export class MemoryCredentialUseCaseRepository implements CredentialUseCaseRepository {
  private store = new Map<string, CredentialUseCaseDefinition>();
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const rec = { ...def };
    this.store.set(rec.key, rec); return { ...rec };
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const d = this.store.get(key); return d ? { ...d } : null;
  }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async list(): Promise<CredentialUseCaseDefinition[]> { return [...this.store.values()].map((d) => ({ ...d })); }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const rec = { ...def };
    this.store.set(key, rec); return { ...rec };
  }
}

export class MemoryCredentialUseCaseTemplateRepository implements CredentialUseCaseTemplateRepository {
  private store = new Map<string, UseCaseTemplate>();
  async list(): Promise<UseCaseTemplate[]> { return [...this.store.values()].map((t) => ({ ...t })); }
  async get(key: string): Promise<UseCaseTemplate | null> {
    const t = this.store.get(key); return t ? { ...t } : null;
  }
  async create(t: UseCaseTemplate): Promise<UseCaseTemplate> {
    this.store.set(t.key, { ...t }); return { ...t };
  }
}

export class MemoryVerificationRequestRepository implements VerificationRequestRepository {
  private readonly byId = new Map<string, VerificationRequestRecord>();
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    const rec: VerificationRequestRecord = { ...input, id: id("vreq"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(reqId: string): Promise<VerificationRequestRecord | null> {
    return this.byId.get(reqId) ?? null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.holderDid === holderDid && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.verifierOrgId === orgId && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async list(): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()];
  }
  async setConsented(reqId: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = "consented"; rec.presentationVpJwt = input.vpJwt; rec.consentedCredentialIds = input.credentialIds; rec.consentedAt = input.at;
    rec.consentedDisclosures = input.disclosures;
    return rec;
  }
  async setStatus(reqId: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = status;
    return rec;
  }
  async setVerifierResult(reqId: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.verifierResult = input.result; rec.verifiedAt = input.at;
    return rec;
  }
}
