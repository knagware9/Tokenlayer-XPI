-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "useCaseKey" TEXT,
    "accountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "kycStatus" TEXT NOT NULL DEFAULT 'approved',
    "kyc" TEXT,
    "did" TEXT,
    "orgId" TEXT,
    "didSeedEncrypted" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'human',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApiKey" (
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

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "useCaseKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "contractRef" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL,
    "tokenStandard" TEXT NOT NULL DEFAULT 'ERC-20',
    "metadata" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unitPrice" TEXT,
    "currency" TEXT,
    "treasuryAccount" TEXT,
    "uniqueKey" TEXT
);

-- CreateTable
CREATE TABLE "UseCase" (
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
    "ownerOrgId" TEXT NOT NULL,
    "treasuryAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CredentialUseCase" (
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

-- CreateTable
CREATE TABLE "CredentialUseCaseTemplate" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "parameters" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ownerOrgId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "txHash" TEXT,
    "chainId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "prevHash" TEXT NOT NULL DEFAULT '',
    "hash" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "AuditAnchor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "unitPrice" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerOrgId" TEXT
);

-- CreateTable
CREATE TABLE "CashBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "currency" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" TEXT NOT NULL DEFAULT '0'
);

-- CreateTable
CREATE TABLE "Cashflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contentType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerOrgId" TEXT,
    "purpose" TEXT
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "useCaseKey" TEXT,
    "orgId" TEXT,
    "assetId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "proposerId" TEXT NOT NULL,
    "proposerLabel" TEXT NOT NULL,
    "required" INTEGER NOT NULL,
    "approvals" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "orgType" TEXT NOT NULL,
    "registrationId" TEXT,
    "jurisdiction" TEXT,
    "did" TEXT NOT NULL,
    "didSeedEncrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" DATETIME,
    "companyProfile" TEXT,
    "capabilities" TEXT,
    "brandLogoDocumentId" TEXT,
    "brandAccent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holderDid" TEXT NOT NULL,
    "issuerDid" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "vcJwt" TEXT NOT NULL,
    "subjectClaims" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "revokedBy" TEXT,
    "proposalId" TEXT,
    "credentialUseCaseKey" TEXT,
    "acceptance" TEXT NOT NULL DEFAULT 'accepted',
    "acceptanceAt" DATETIME,
    "acceptanceNote" TEXT,
    "anchorTxHash" TEXT,
    "anchorChainId" TEXT,
    "revokeTxHash" TEXT
);

-- CreateTable
CREATE TABLE "RegistryDeployment" (
    "chainId" TEXT NOT NULL PRIMARY KEY,
    "didRegistry" TEXT NOT NULL,
    "vcRegistry" TEXT NOT NULL,
    "deployTxHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VerificationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "verifierOrgId" TEXT NOT NULL,
    "holderDid" TEXT NOT NULL,
    "requestedTypes" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "credentialUseCaseKey" TEXT,
    "challenge" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "presentationVpJwt" TEXT,
    "consentedAt" DATETIME,
    "consentedCredentialIds" TEXT,
    "verifierResult" TEXT,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StagedInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "useCaseKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "invoiceHash" TEXT NOT NULL,
    "documentId" TEXT,
    "documentSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "assetId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenizedAt" DATETIME
);

-- CreateTable
CREATE TABLE "LoginKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Event" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" TEXT,
    "useCaseKey" TEXT,
    "subjectId" TEXT,
    "data" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
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

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "responseStatus" INTEGER,
    "responseError" TEXT,
    "durationMs" INTEGER,
    "claimedAt" DATETIME,
    "claimedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_useCaseKey_uniqueKey_key" ON "Asset"("useCaseKey", "uniqueKey");

-- CreateIndex
CREATE INDEX "AuditLog_assetId_idx" ON "AuditLog"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_assetId_seq_key" ON "AuditLog"("assetId", "seq");

-- CreateIndex
CREATE INDEX "AuditAnchor_assetId_idx" ON "AuditAnchor"("assetId");

-- CreateIndex
CREATE INDEX "Listing_assetId_status_idx" ON "Listing"("assetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Account_address_key" ON "Account"("address");

-- CreateIndex
CREATE UNIQUE INDEX "CashBalance_currency_address_key" ON "CashBalance"("currency", "address");

-- CreateIndex
CREATE UNIQUE INDEX "Cashflow_assetId_seq_key" ON "Cashflow"("assetId", "seq");

-- CreateIndex
CREATE INDEX "Document_ownerOrgId_purpose_idx" ON "Document"("ownerOrgId", "purpose");

-- CreateIndex
CREATE INDEX "Proposal_useCaseKey_status_idx" ON "Proposal"("useCaseKey", "status");

-- CreateIndex
CREATE INDEX "Proposal_orgId_status_idx" ON "Proposal"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_name_key" ON "Organization"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_did_key" ON "Organization"("did");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE INDEX "Credential_holderDid_idx" ON "Credential"("holderDid");

-- CreateIndex
CREATE INDEX "VerificationRequest_holderDid_status_idx" ON "VerificationRequest"("holderDid", "status");

-- CreateIndex
CREATE INDEX "VerificationRequest_verifierOrgId_status_idx" ON "VerificationRequest"("verifierOrgId", "status");

-- CreateIndex
CREATE INDEX "StagedInvoice_useCaseKey_status_idx" ON "StagedInvoice"("useCaseKey", "status");

-- CreateIndex
CREATE INDEX "StagedInvoice_useCaseKey_invoiceHash_idx" ON "StagedInvoice"("useCaseKey", "invoiceHash");

-- CreateIndex
CREATE UNIQUE INDEX "LoginKey_did_key" ON "LoginKey"("did");

-- CreateIndex
CREATE INDEX "LoginKey_userId_idx" ON "LoginKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_id_key" ON "Event"("id");

-- CreateIndex
CREATE INDEX "Event_orgId_seq_idx" ON "Event"("orgId", "seq");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_orgId_idx" ON "WebhookEndpoint"("orgId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

-- CreateIndex
CREATE INDEX "LedgerTransaction_status_nextAttemptAt_idx" ON "LedgerTransaction"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_assetId_idx" ON "LedgerTransaction"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_chainId_txHash_key" ON "LedgerTransaction"("chainId", "txHash");
