-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" TEXT,
    "assetId" TEXT,
    "credentialId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "claimedAt" DATETIME,
    "claimedBy" TEXT,
    "blockNumber" INTEGER,
    "error" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ApiKey" ("createdAt", "createdBy", "expiresAt", "id", "lastUsedAt", "name", "orgId", "prefix", "revokedAt", "revokedBy", "scopes", "secretHash", "userId") SELECT "createdAt", "createdBy", "expiresAt", "id", "lastUsedAt", "name", "orgId", "prefix", "revokedAt", "revokedBy", "scopes", "secretHash", "userId" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");
CREATE TABLE "new_UseCase" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tokenStandard" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "defaultChainId" TEXT NOT NULL,
    "allowedChainIds" TEXT NOT NULL,
    "contracts" TEXT NOT NULL DEFAULT '{}',
    "metadataSchema" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "compliance" TEXT NOT NULL,
    "fees" TEXT NOT NULL DEFAULT '{}',
    "saleTermsDefault" TEXT NOT NULL DEFAULT '{}',
    "valuation" TEXT NOT NULL DEFAULT '{}',
    "derivedFields" TEXT NOT NULL DEFAULT '{}',
    "uniqueBy" TEXT,
    "terms" TEXT NOT NULL DEFAULT '{}',
    "workflow" TEXT NOT NULL DEFAULT '{}',
    "roles" TEXT NOT NULL,
    "ownerOrgId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UseCase" ("allowedChainIds", "compliance", "contracts", "createdAt", "defaultChainId", "derivedFields", "description", "fees", "key", "lifecycle", "metadataSchema", "name", "ownerOrgId", "roles", "saleTermsDefault", "symbol", "terms", "tokenStandard", "uniqueBy", "updatedAt", "valuation", "workflow") SELECT "allowedChainIds", "compliance", "contracts", "createdAt", "defaultChainId", "derivedFields", "description", "fees", "key", "lifecycle", "metadataSchema", "name", "ownerOrgId", "roles", "saleTermsDefault", "symbol", "terms", "tokenStandard", "uniqueBy", "updatedAt", "valuation", "workflow" FROM "UseCase";
DROP TABLE "UseCase";
ALTER TABLE "new_UseCase" RENAME TO "UseCase";
CREATE TABLE "new_CredentialUseCase" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "credentialTypes" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "holderPolicy" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "ownerOrgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "holderAcceptance" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CredentialUseCase" ("createdAt", "credentialTypes", "description", "holderAcceptance", "holderPolicy", "issuer", "key", "name", "ownerOrgId", "status", "updatedAt", "verifier") SELECT "createdAt", "credentialTypes", "description", "holderAcceptance", "holderPolicy", "issuer", "key", "name", "ownerOrgId", "status", "updatedAt", "verifier" FROM "CredentialUseCase";
DROP TABLE "CredentialUseCase";
ALTER TABLE "new_CredentialUseCase" RENAME TO "CredentialUseCase";
CREATE TABLE "new_Event" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" TEXT,
    "useCaseKey" TEXT,
    "subjectId" TEXT,
    "data" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Event" ("data", "id", "occurredAt", "orgId", "seq", "subjectId", "type", "useCaseKey") SELECT "data", "id", "occurredAt", "orgId", "seq", "subjectId", "type", "useCaseKey" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_id_key" ON "Event"("id");
CREATE INDEX "Event_orgId_seq_idx" ON "Event"("orgId", "seq");
CREATE INDEX "Event_type_idx" ON "Event"("type");
CREATE TABLE "new_WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "eventTypes" TEXT NOT NULL,
    "useCaseKey" TEXT,
    "secretEncrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disabledReason" TEXT,
    "disabledAt" DATETIME,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveGuardFailures" INTEGER NOT NULL DEFAULT 0,
    "failingSince" DATETIME,
    "deletedAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveryAt" DATETIME
);
INSERT INTO "new_WebhookEndpoint" ("consecutiveFailures", "consecutiveGuardFailures", "createdAt", "createdBy", "deletedAt", "description", "disabledAt", "disabledReason", "eventTypes", "failingSince", "id", "lastDeliveryAt", "orgId", "secretEncrypted", "status", "url", "useCaseKey") SELECT "consecutiveFailures", "consecutiveGuardFailures", "createdAt", "createdBy", "deletedAt", "description", "disabledAt", "disabledReason", "eventTypes", "failingSince", "id", "lastDeliveryAt", "orgId", "secretEncrypted", "status", "url", "useCaseKey" FROM "WebhookEndpoint";
DROP TABLE "WebhookEndpoint";
ALTER TABLE "new_WebhookEndpoint" RENAME TO "WebhookEndpoint";
CREATE INDEX "WebhookEndpoint_orgId_idx" ON "WebhookEndpoint"("orgId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LedgerTransaction_status_nextAttemptAt_idx" ON "LedgerTransaction"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_assetId_idx" ON "LedgerTransaction"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_chainId_txHash_key" ON "LedgerTransaction"("chainId", "txHash");

