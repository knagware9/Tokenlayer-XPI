/**
 * Shared JSON-Schema components and per-route schemas for the v1 API. Fastify
 * uses these to validate requests, serialise responses, and generate the
 * OpenAPI 3 document. Components are registered once (see buildApp) and routes
 * reference them by `$ref: "<id>#"`.
 */
import type { FastifySchema } from "fastify";

const TOKEN_STANDARD = { type: "string", enum: ["ERC-20", "ERC-721", "ERC-3643"] };
const TOKEN_TYPE = { type: "string", enum: ["fungible", "nonfungible"] };

/** Reusable component schemas, each with a stable $id. */
export const components: Record<string, unknown>[] = [
  {
    $id: "Error",
    type: "object",
    description: "Uniform error envelope returned for every non-2xx response.",
    properties: {
      error: { type: "string", description: "Stable machine-readable error code." },
      message: { type: "string" },
      details: { type: "object", additionalProperties: true, nullable: true },
    },
    required: ["error", "message"],
  },
  {
    $id: "Pagination",
    type: "object",
    properties: {
      limit: { type: "integer" },
      offset: { type: "integer" },
      total: { type: "integer" },
    },
    required: ["limit", "offset", "total"],
  },
  {
    $id: "Chain",
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      family: { type: "string", enum: ["evm", "fabric", "canton", "mock"] },
      kind: { type: "string", enum: ["simulated", "evm"] },
      mode: { type: "string", enum: ["real", "simulated"] },
      // false = supported catalog chain that is not connected (no adapter); it can
      // be selected as an allowed DLT but assets cannot be issued on it yet.
      available: { type: "boolean" },
      // Whether the chain's connection config is present (EVM: rpc + key env;
      // simulated-kind chains: always true). Mirrors adapter presence.
      configured: { type: "boolean" },
      expectedChainId: { type: "integer" },
      explorerUrl: { type: "string" },
      currencySymbol: { type: "string" },
      faucetUrl: { type: "string" },
      // Hostname only — never the full RPC URL (hosted RPC URLs can embed keys).
      rpcHost: { type: "string" },
    },
    required: ["id", "label", "family", "kind", "mode", "available", "configured"],
  },
  {
    $id: "ChainStatus",
    type: "object",
    description: "On-demand liveness probe result for one chain.",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      reachable: { type: "boolean" },
      mode: { type: "string", enum: ["real", "simulated"] },
      chainId: { type: "string" },
      operator: { type: "string" },
      balance: { type: "string" },
      error: { type: "string" },
    },
    required: ["id", "reachable", "mode"],
  },
  {
    $id: "ContractCode",
    type: "object",
    description: "The contract code backing a use case on one chain: the real Solidity source (EVM) or a truthful contract model (Fabric/Canton), plus the constructor args the platform passes at deploy time.",
    additionalProperties: true,
    properties: {
      chainId: { type: "string" },
      family: { type: "string", enum: ["evm", "fabric", "canton", "mock"] },
      mode: { type: "string", enum: ["real", "simulated"] },
      language: { type: "string" },
      filename: { type: "string" },
      source: { type: "string" },
      constructorArgs: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] },
      },
      // Present only on GET /use-cases/:key/code when the contract is deployed on that chain.
      deployed: {
        type: "object",
        additionalProperties: true,
        properties: { contractRef: { type: "string" }, deployTxHash: { type: "string" } },
      },
    },
    required: ["chainId", "family", "mode", "language", "filename", "source", "constructorArgs"],
  },
  {
    $id: "PropertySchema",
    type: "object",
    additionalProperties: true,
    description: "A single metadata field's schema: type + optional validation constraints.",
    properties: {
      type: { type: "string", enum: ["string", "number", "boolean", "document"] },
      description: { type: "string" },
      enum: { type: "array", items: { type: "string" } },
      min: { type: "number" },
      max: { type: "number" },
      pattern: { type: "string" },
    },
  },
  {
    $id: "MetadataSchema",
    type: "object",
    additionalProperties: true,
    properties: {
      type: { type: "string" },
      properties: { type: "object", additionalProperties: { $ref: "PropertySchema#" } },
      required: { type: "array", items: { type: "string" } },
    },
  },
  {
    $id: "UseCase",
    type: "object",
    additionalProperties: true,
    properties: {
      key: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      tokenStandard: TOKEN_STANDARD,
      tokenType: TOKEN_TYPE,
      symbol: { type: "string" },
      allowedChainIds: { type: "array", items: { type: "string" } },
      defaultChainId: { type: "string" },
      // Server-managed: the deployed contract per chainId. Absent/empty until deployed.
      contracts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { contractRef: { type: "string" }, deployTxHash: { type: "string" } },
          required: ["contractRef", "deployTxHash"],
        },
      },
      metadataSchema: { $ref: "MetadataSchema#" },
      lifecycle: { type: "object", additionalProperties: true },
      compliance: {
        type: "object",
        additionalProperties: true,
        properties: {
          allowlist: { type: "boolean" },
          transferRestrictions: { type: "boolean" },
          maxHolders: { type: "integer" },
          lockupDays: { type: "integer" },
          allowedJurisdictions: { type: "array", items: { type: "string" } },
        },
      },
      fees: {
        type: "object",
        additionalProperties: true,
        properties: {
          marketplaceBps: { type: "integer", minimum: 0, maximum: 10000 },
          issuanceFlat: { type: "string" },
        },
      },
      saleTermsDefault: {
        type: "object",
        additionalProperties: true,
        properties: {
          unitPrice: { type: "string" },
          currency: { type: "string" },
        },
      },
      roles: { type: "array", items: { type: "string" } },
    },
    required: ["key", "name", "tokenStandard", "symbol", "allowedChainIds", "defaultChainId", "metadataSchema", "lifecycle", "compliance", "roles"],
  },
  {
    $id: "CredentialUseCase",
    type: "object",
    additionalProperties: true,
    description: "A configured credential (DID/VC) use case — the Identity-domain parallel of a tokenization UseCase.",
    properties: {
      key: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      credentialTypes: { type: "array" },
      issuer: { type: "object", additionalProperties: true },
      holderPolicy: { type: "object", additionalProperties: true },
      verifier: { type: "object", additionalProperties: true },
      ownerOrgId: { type: "string", nullable: true },
      status: { type: "string" },
    },
    required: ["key", "name", "credentialTypes", "issuer", "holderPolicy", "verifier"],
  },
  {
    $id: "Asset",
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      useCaseKey: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      chainId: { type: "string" },
      contractRef: { type: "string" },
      tokenType: TOKEN_TYPE,
      tokenStandard: TOKEN_STANDARD,
      metadata: { type: "object", additionalProperties: true },
      status: { type: "string" },
      createdBy: { type: "string" },
      createdAt: { type: "string" },
      totalSupply: { type: "string", nullable: true },
      availableSupply: { type: "string", nullable: true },
      unitPrice: { type: "string", nullable: true },
      currency: { type: "string", nullable: true },
      treasuryAccount: { type: "string", nullable: true },
    },
    required: ["id", "useCaseKey", "name", "symbol", "chainId", "contractRef", "tokenType", "tokenStandard", "status"],
  },
  {
    $id: "AssetList",
    type: "object",
    properties: {
      data: { type: "array", items: { $ref: "Asset#" } },
      pagination: { $ref: "Pagination#" },
    },
    required: ["data", "pagination"],
  },
  {
    $id: "AccountState",
    type: "object",
    properties: {
      address: { type: "string" },
      label: { type: "string" },
      balance: { type: "string" },
      frozen: { type: "boolean" },
      allowed: { type: "boolean" },
    },
    required: ["address", "label", "balance", "frozen", "allowed"],
  },
  {
    $id: "TokenInfo",
    type: "object",
    properties: {
      tokenId: { type: "string" },
      owner: { type: "string" },
      ownerLabel: { type: "string" },
      frozen: { type: "boolean" },
    },
    required: ["tokenId", "owner", "ownerLabel", "frozen"],
  },
  {
    $id: "Currency",
    type: "object",
    properties: {
      code: { type: "string" },
      label: { type: "string" },
    },
    required: ["code", "label"],
  },
  {
    $id: "AuditEntry",
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      assetId: { type: "string" },
      actorId: { type: "string" },
      action: { type: "string" },
      payload: { type: "object", additionalProperties: true },
      txHash: { type: "string" },
      chainId: { type: "string" },
      createdAt: { type: "string" },
    },
    required: ["id", "actorId", "action", "createdAt"],
  },
  {
    $id: "AuditList",
    type: "object",
    properties: {
      data: { type: "array", items: { $ref: "AuditEntry#" } },
      pagination: { $ref: "Pagination#" },
    },
    required: ["data", "pagination"],
  },
  {
    $id: "Analytics",
    type: "object",
    additionalProperties: true,
    description: "Scope-aware dashboard summary aggregated from assets + audit log + chains.",
    properties: {
      scope: { type: "string", enum: ["platform", "use-case"] },
      useCaseKey: { type: "string", nullable: true },
      totals: {
        type: "object",
        additionalProperties: true,
        properties: {
          assets: { type: "integer" },
          useCases: { type: "integer" },
          holders: { type: "integer" },
          supply: { type: "string" },
          valueByCurrency: { type: "object", additionalProperties: true },
          tradedByCurrency: { type: "object", additionalProperties: true },
          trades: { type: "integer" },
        },
        required: ["assets", "useCases", "holders", "supply", "valueByCurrency", "tradedByCurrency", "trades"],
      },
      byLedger: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            chainId: { type: "string" },
            mode: { type: "string", enum: ["real", "simulated"] },
            assets: { type: "integer" },
            supply: { type: "string" },
            holders: { type: "integer" },
          },
          required: ["chainId", "mode", "assets", "supply", "holders"],
        },
      },
      byUseCase: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            useCaseKey: { type: "string" },
            name: { type: "string" },
            symbol: { type: "string" },
            chainId: { type: "string" },
            supply: { type: "string" },
            holders: { type: "integer" },
            valueByCurrency: { type: "object", additionalProperties: true },
          },
          required: ["useCaseKey", "name", "symbol", "chainId", "supply", "holders", "valueByCurrency"],
        },
      },
      activity: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            date: { type: "string" },
            count: { type: "integer" },
            tradedByCurrency: { type: "object", additionalProperties: true },
          },
          required: ["date", "count", "tradedByCurrency"],
        },
      },
      recent: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            at: { type: "string" },
            action: { type: "string" },
            assetId: { type: "string" },
            assetName: { type: "string" },
            chainId: { type: "string" },
            summary: { type: "string" },
          },
          required: ["at", "action", "assetId", "assetName", "chainId", "summary"],
        },
      },
    },
    required: ["scope", "useCaseKey", "totals", "byLedger", "byUseCase", "activity", "recent"],
  },
  {
    $id: "Listing",
    type: "object",
    additionalProperties: true,
    description: "A secondary-market sell listing; `quantity` is the REMAINING quantity.",
    properties: {
      id: { type: "string" },
      assetId: { type: "string" },
      seller: { type: "string" },
      quantity: { type: "string" },
      unitPrice: { type: "string" },
      currency: { type: "string" },
      status: { type: "string", enum: ["open", "filled", "cancelled"] },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "assetId", "seller", "quantity", "unitPrice", "currency", "status", "createdAt"],
  },
  {
    $id: "Cashflow",
    type: "object",
    additionalProperties: true,
    description: "A materialized financial-terms cashflow. `status` is derived at read time: due/overdue flow from the due date; only scheduled/executing/executed are stored.",
    properties: {
      id: { type: "string" },
      assetId: { type: "string" },
      seq: { type: "integer" },
      kind: { type: "string", enum: ["coupon", "redemption"] },
      dueDate: { type: "string" },
      amount: { type: "string" },
      currency: { type: "string" },
      status: { type: "string", enum: ["scheduled", "due", "overdue", "executing", "executed"] },
      executedAt: { type: "string", nullable: true },
    },
    required: ["id", "assetId", "seq", "kind", "dueDate", "amount", "currency", "status"],
  },
  {
    $id: "Receipt",
    type: "object",
    additionalProperties: true,
    properties: {
      txHash: { type: "string" },
      chainId: { type: "string" },
      blockNumber: { type: "integer", nullable: true },
      timestamp: { type: "string" },
    },
    required: ["txHash", "chainId", "timestamp"],
  },
  {
    $id: "Proposal",
    type: "object",
    additionalProperties: true,
    description: "A maker-checker proposal: a gated operation captured pending approval.",
    properties: {
      id: { type: "string" },
      useCaseKey: { type: "string" },
      assetId: { type: "string", nullable: true },
      kind: { type: "string" },
      payload: { type: "object", additionalProperties: true },
      proposerId: { type: "string" },
      proposerLabel: { type: "string" },
      required: { type: "integer" },
      approvals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: { userId: { type: "string" }, email: { type: "string" }, at: { type: "string" } },
          required: ["userId", "email", "at"],
        },
      },
      status: { type: "string", enum: ["pending", "approved", "rejected", "executed", "failed"] },
      error: { type: "string", nullable: true },
      result: { type: "object", additionalProperties: true, nullable: true, description: "Optional executor report (e.g. a CSV batch's per-row outcomes)." },
      createdAt: { type: "string" },
      decidedAt: { type: "string", nullable: true },
    },
    required: ["id", "useCaseKey", "kind", "payload", "proposerId", "proposerLabel", "required", "approvals", "status", "createdAt"],
  },
];

/** Standard error responses attached to authenticated routes. */
const errs = (...codes: number[]): Record<string, unknown> =>
  Object.fromEntries(codes.map((c) => [c, { $ref: "Error#" }]));

const bearer = [{ bearerAuth: [] }];

/** Per-route schemas, referenced from routes.ts. Typed as FastifySchema so the
 * framework does not over-narrow reply status codes from the literal objects. */
export const S: Record<string, FastifySchema> = {
  login: {
    tags: ["Auth"],
    summary: "Authenticate and obtain a JWT",
    body: {
      type: "object",
      required: ["email", "password"],
      properties: { email: { type: "string" }, password: { type: "string" } },
    },
    response: {
      200: {
        type: "object",
        properties: {
          token: { type: "string" },
          user: { type: "object", additionalProperties: true },
        },
      },
      ...errs(400, 401),
    },
  },
  me: { tags: ["Auth"], summary: "Current session principal", security: bearer, response: { 200: { type: "object", additionalProperties: true }, ...errs(401) } },
  config: {
    tags: ["Config"], summary: "Deployment configuration (enabled domains)", security: bearer,
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) },
  },

  enrollLoginKey: {
    tags: ["Auth"], summary: "Enrol a device login key (public did:key)", security: bearer,
    body: { type: "object", additionalProperties: false, required: ["did", "label"], properties: { did: { type: "string" }, label: { type: "string", minLength: 1 } } },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 409) },
  },
  listLoginKeys: { tags: ["Auth"], summary: "The caller's enrolled device login keys", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  removeLoginKey: { tags: ["Auth"], summary: "Revoke a device login key", security: bearer, params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 404) } },
  qrStart: { tags: ["Auth"], summary: "Begin a passwordless QR login session", response: { 200: { type: "object", additionalProperties: true } } },
  qrPoll: { tags: ["Auth"], summary: "Poll a QR login session", params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 200: { type: "object", additionalProperties: true }, ...errs(404) } },
  qrAuthenticate: {
    tags: ["Auth"], summary: "Authenticate a QR login session by signing its challenge",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["did", "signature"], properties: { did: { type: "string" }, signature: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404, 410, 429) },
  },

  chains: { tags: ["Catalog"], summary: "List configured chains/DLTs", security: bearer, response: { 200: { type: "array", items: { $ref: "Chain#" } }, ...errs(401) } },
  chainStatus: {
    tags: ["Catalog"], summary: "Probe one chain's live status (on-demand health check)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "ChainStatus#" }, ...errs(401, 404) },
  },
  currencies: { tags: ["Catalog"], summary: "List supported settlement currencies", security: bearer, response: { 200: { type: "array", items: { $ref: "Currency#" } }, ...errs(401) } },
  accounts: { tags: ["Catalog"], summary: "List demo accounts", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },

  listUseCases: { tags: ["Use Cases"], summary: "List use cases", security: bearer, response: { 200: { type: "array", items: { $ref: "UseCase#" } }, ...errs(401) } },
  getUseCase: {
    tags: ["Use Cases"], summary: "Get a use case by key", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { $ref: "UseCase#" }, ...errs(401, 404) },
  },
  createUseCase: {
    tags: ["Use Cases"], summary: "Create a use case (PlatformAdmin)", security: bearer,
    body: { $ref: "UseCase#" },
    response: { 201: { $ref: "UseCase#" }, ...errs(400, 401, 403) },
  },
  updateUseCase: {
    tags: ["Use Cases"], summary: "Update a use case (PlatformAdmin)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { $ref: "UseCase#" },
    response: { 200: { $ref: "UseCase#" }, ...errs(400, 401, 403, 404) },
  },
  deployUseCase: {
    tags: ["Use Cases"], summary: "Deploy a use case's contract on one allowed chain (PlatformAdmin)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["chainId"], properties: { chainId: { type: "string" } } },
    response: { 200: { $ref: "UseCase#" }, ...errs(400, 401, 403, 404, 502) },
  },
  useCaseCode: {
    tags: ["Use Cases"], summary: "Contract code backing a use case on one allowed chain", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: { type: "object", additionalProperties: false, required: ["chainId"], properties: { chainId: { type: "string" } } },
    response: { 200: { $ref: "ContractCode#" }, ...errs(400, 401, 404) },
  },
  previewUseCaseCode: {
    tags: ["Use Cases"], summary: "Preview the contract code for a not-yet-created use case (wizard review step)", security: bearer,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["tokenStandard", "symbol", "name", "chainId"],
      properties: {
        tokenStandard: TOKEN_STANDARD,
        symbol: { type: "string" },
        name: { type: "string" },
        allowlist: { type: "boolean" },
        chainId: { type: "string" },
      },
    },
    response: { 200: { $ref: "ContractCode#" }, ...errs(400, 401) },
  },

  credentialTemplates: { tags: ["Credential Use Cases"], summary: "Editable starter credential-type templates", security: bearer, response: { 200: { type: "object", additionalProperties: true }, ...errs(401) } },
  listCredentialUseCases: { tags: ["Credential Use Cases"], summary: "List credential use cases", security: bearer, response: { 200: { type: "array", items: { $ref: "CredentialUseCase#" } }, ...errs(401) } },
  getCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Get a credential use case by key", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(401, 404) },
  },
  createCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Create a credential use case (PlatformAdmin)", security: bearer,
    body: { type: "object", additionalProperties: true, required: ["key", "name", "credentialTypes", "issuer", "holderPolicy", "verifier"] },
    response: { 201: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 409) },
  },
  updateCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Update a credential use case (PlatformAdmin)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404) },
  },

  listUseCaseTemplates: {
    tags: ["Credential Use Cases"], summary: "List the credential-use-case template catalog (built-in + saved)", security: bearer,
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) },
  },
  getUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Get a credential-use-case template by key (built-in or saved)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  createUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Save a custom credential-use-case template (PlatformAdmin/OrgAdmin)", security: bearer,
    body: { type: "object", additionalProperties: true, required: ["key", "name", "category", "parameters", "body"] },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 409) },
  },
  previewUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Preview the CredentialUseCaseDefinition a template instantiates to, given param values", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true, properties: { params: { type: "object", additionalProperties: true } } },
    // 400 is overridden (not the shared Error# ref) so `problems` — an array of
    // human-readable per-param validation failures — survives fast-json-stringify's
    // response serialization instead of being stripped as an unlisted property.
    response: { 200: { type: "object", additionalProperties: true }, 400: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  provisionUseCase: {
    tags: ["Credential Use Cases"], summary: "One-step enterprise provisioning from a template: ensure the issuer org, instantiate the bound credential use case, and optionally create scoped desk users (PlatformAdmin; OrgAdmin scoped to their own org)", security: bearer,
    body: {
      type: "object", additionalProperties: true, required: ["templateKey", "params"],
      properties: {
        templateKey: { type: "string" },
        params: { type: "object", additionalProperties: true },
        provisioning: { type: "object", additionalProperties: true },
      },
    },
    // 201/200/400 are LOOSE (additionalProperties:true) so nested fields survive
    // fast-json-stringify — most importantly deskUsers[].password, the one-time
    // plaintext credential returned exactly once. A strict/ref response schema
    // would silently strip it (the G3 trap).
    response: {
      200: { type: "object", additionalProperties: true },
      201: { type: "object", additionalProperties: true },
      400: { type: "object", additionalProperties: true },
      ...errs(401, 403, 404, 409, 502, 503),
    },
  },

  issueAsset: {
    tags: ["Assets"], summary: "Issue (tokenize) a new asset", security: bearer,
    body: {
      type: "object",
      required: ["useCaseKey", "name", "chainId"],
      properties: {
        useCaseKey: { type: "string" },
        name: { type: "string" },
        // Optional + ignored: the symbol is inherited from the use case's contract.
        symbol: { type: "string" },
        chainId: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        treasuryAccount: { type: "string" },
        initialSupply: { type: "string" },
        sale: {
          type: "object",
          additionalProperties: false,
          required: ["unitPrice", "currency", "treasuryAccount"],
          properties: {
            unitPrice: { type: "string" },
            currency: { type: "string" },
            treasuryAccount: { type: "string" },
          },
        },
      },
    },
    response: {
      201: {
        type: "object",
        properties: {
          asset: { $ref: "Asset#" },
          txHash: { type: "string" },
          issuanceFee: { type: "object", additionalProperties: true, nullable: true },
        },
        required: ["asset"],
      },
      ...errs(400, 401, 403),
    },
  },
  listAssets: {
    tags: ["Assets"], summary: "List assets (filter + paginate)", security: bearer,
    querystring: {
      type: "object",
      properties: {
        useCaseKey: { type: "string" },
        chainId: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    },
    response: { 200: { $ref: "AssetList#" }, ...errs(401) },
  },
  getAsset: {
    tags: ["Assets"], summary: "Get an asset (with on-chain total supply)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "Asset#" }, ...errs(401, 404) },
  },
  assetAccounts: {
    tags: ["Assets"], summary: "Holders: per-account balance + compliance state", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "AccountState#" } }, ...errs(401, 404) },
  },
  assetTokens: {
    tags: ["Assets"], summary: "NFT tokens for a non-fungible asset", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "TokenInfo#" } }, ...errs(401, 404) },
  },
  assetAudit: {
    tags: ["Assets"], summary: "Paginated audit trail for an asset", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    querystring: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    },
    response: { 200: { $ref: "AuditList#" }, ...errs(401, 404) },
  },
  action: {
    tags: ["Lifecycle"], summary: "Perform a lifecycle action on an asset", security: bearer,
    params: {
      type: "object",
      required: ["id", "action"],
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "setPrice"] },
      },
    },
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string" },
        from: { type: "string" },
        amount: { type: "string" },
        tokenId: { type: "string" },
        uri: { type: "string" },
        account: { type: "string" },
        unitPrice: { type: "string" },
        currency: { type: "string" },
        treasuryAccount: { type: "string" },
      },
    },
    response: {
      200: { oneOf: [
        { type: "object", required: ["receipt"], properties: { receipt: { $ref: "Receipt#" } }, additionalProperties: true },
        { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      ] },
      ...errs(400, 401, 403, 404),
    },
  },

  analytics: {
    tags: ["Analytics"], summary: "Scope-aware dashboard summary (assets + audit + chains)", security: bearer,
    querystring: {
      type: "object",
      properties: {
        useCaseKey: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90, default: 30 },
      },
    },
    response: { 200: { $ref: "Analytics#" }, ...errs(401) },
  },

  buy: {
    tags: ["Marketplace"], summary: "Buyer-initiated DvP purchase", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["quantity"],
      properties: {
        quantity: { type: "string" },
      },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },

  createListing: {
    tags: ["Marketplace"], summary: "List tokens for sale (moves them into escrow)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["quantity", "unitPrice", "currency"],
      properties: {
        quantity: { type: "string" },
        unitPrice: { type: "string" },
        currency: { type: "string" },
      },
    },
    response: { 201: { $ref: "Listing#" }, ...errs(400, 401, 403, 404, 503) },
  },
  listListings: {
    tags: ["Marketplace"], summary: "Open sell listings for an asset (price asc)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            seller: { type: "string" },
            quantity: { type: "string" },
            unitPrice: { type: "string" },
            currency: { type: "string" },
            createdAt: { type: "string" },
          },
          required: ["id", "seller", "quantity", "unitPrice", "currency", "createdAt"],
        },
      },
      ...errs(401, 404, 503),
    },
  },
  takeListing: {
    tags: ["Marketplace"], summary: "Take (buy from) a listing — escrowed DvP with fee split", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["quantity"],
      properties: {
        quantity: { type: "string" },
      },
    },
    response: {
      200: {
        type: "object",
        additionalProperties: true,
        properties: {
          listing: { $ref: "Listing#" },
          txHash: { type: "string" },
          fee: {
            type: "object",
            additionalProperties: true,
            nullable: true,
            properties: { amount: { type: "string" }, account: { type: "string" } },
          },
        },
        required: ["listing", "txHash"],
      },
      ...errs(400, 401, 403, 404, 503),
    },
  },
  cancelListing: {
    tags: ["Marketplace"], summary: "Cancel a listing (returns remaining tokens to the seller)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 204: { type: "null" }, ...errs(400, 401, 403, 404, 503) },
  },
  assetTrades: {
    tags: ["Marketplace"], summary: "Recent trades for an asset (from the audit stream, newest first)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            at: { type: "string" },
            amount: { type: "string", nullable: true },
            unitPrice: { type: "string", nullable: true },
            currency: { type: "string", nullable: true },
            from: { type: "string", nullable: true },
            to: { type: "string", nullable: true },
            secondary: { type: "boolean" },
          },
          required: ["at", "secondary"],
        },
      },
      ...errs(401, 404, 503),
    },
  },

  listCashflows: {
    tags: ["Cashflows"], summary: "An asset's cashflow schedule with derived status + next-payout preview", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object",
        properties: {
          cashflows: { type: "array", items: { $ref: "Cashflow#" } },
          preview: {
            type: "object",
            nullable: true,
            additionalProperties: true,
            properties: {
              cashflowId: { type: "string" },
              split: {
                type: "array",
                items: {
                  type: "object",
                  properties: { address: { type: "string" }, amount: { type: "string" } },
                  required: ["address", "amount"],
                },
              },
            },
            required: ["cashflowId", "split"],
          },
        },
        required: ["cashflows"],
      },
      ...errs(401, 404),
    },
  },

  executeCashflow: {
    tags: ["Cashflows"], summary: "Execute a cashflow — pro-rata cash payout; redemption burns balances + matures the asset", security: bearer,
    params: { type: "object", required: ["id", "cfId"], properties: { id: { type: "string" }, cfId: { type: "string" } } },
    body: {
      type: "object",
      additionalProperties: false,
      properties: { from: { type: "string" } },
    },
    response: {
      200: {
        type: "object",
        additionalProperties: true,
        properties: { cashflow: { $ref: "Cashflow#" } },
        required: ["cashflow"],
      },
      ...errs(400, 401, 403, 404, 409),
    },
  },

  listProposals: {
    tags: ["Proposals"], summary: "List maker-checker proposals (use-case scoped)", security: bearer,
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string" }, useCaseKey: { type: "string" } },
    },
    response: { 200: { type: "array", items: { $ref: "Proposal#" } }, ...errs(401) },
  },
  decideProposal: {
    tags: ["Proposals"], summary: "Approve or reject a proposal (segregation of duties: never the proposer)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: {
      200: { type: "object", additionalProperties: true, properties: { proposal: { $ref: "Proposal#" } }, required: ["proposal"] },
      ...errs(401, 403, 404, 409),
    },
  },

  verifyAssetAudit: {
    tags: ["Audit"], summary: "Verify an asset's audit hash chain + on-ledger anchor", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  verifyAuditSummary: {
    tags: ["Audit"], summary: "Platform audit-integrity roll-up (per-asset chain + anchor)", security: bearer,
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) },
  },
  anchorAudit: {
    tags: ["Audit"], summary: "Anchor each in-scope asset's audit chain head on-ledger", security: bearer,
    body: { type: "object", additionalProperties: false, properties: {} },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
  },

  mePortfolio: {
    tags: ["Investor"], summary: "The caller's holdings, cash, and totals", security: bearer,
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401) },
  },
  meActivity: {
    tags: ["Investor"], summary: "The caller's personal activity feed", security: bearer,
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(400, 401) },
  },

  creditCash: {
    tags: ["Cash"], summary: "Fund an account with CBDC / cash (Issuer / admin only)", security: bearer,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["account", "currency", "amount"],
      properties: {
        account: { type: "string" },
        currency: { type: "string" },
        amount: { type: "string" },
      },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403) },
  },

  cashBalances: {
    tags: ["Cash"], summary: "Query CBDC / cash balances for an address", security: bearer,
    querystring: {
      type: "object",
      properties: {
        address: { type: "string" },
      },
    },
    response: {
      200: { type: "array", items: { type: "object", additionalProperties: true } },
      ...errs(401, 403),
    },
  },

  createOrg: {
    tags: ["Organizations"], summary: "Create an organization + parent DID (PlatformAdmin)", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["name", "orgType"],
      properties: {
        name: { type: "string", minLength: 1 },
        orgType: { type: "string", enum: ["bank", "corporate", "msme", "government", "verifier"] },
        registrationId: { type: "string" },
        jurisdiction: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 409, 502, 503) },
  },
  registerOrg: {
    tags: ["Organizations"], summary: "Public corporate self-registration (pending platform approval)",
    body: {
      type: "object", additionalProperties: false, required: ["company", "admin"],
      properties: {
        company: {
          type: "object", additionalProperties: false,
          required: ["name", "orgType", "cin", "pan", "state", "pincode", "dateOfIncorporation", "category", "companyStatus", "documents"],
          properties: {
            name: { type: "string", minLength: 1 },
            orgType: { type: "string", enum: ["bank", "corporate", "msme", "government"] },
            cin: { type: "string", minLength: 1 },
            pan: { type: "string", minLength: 1 },
            gstin: { type: "string" },
            state: { type: "string", minLength: 1 },
            pincode: { type: "string", minLength: 1 },
            dateOfIncorporation: { type: "string", minLength: 1 },
            category: { type: "string", enum: ["private-limited", "public-limited", "llp", "opc", "section-8"] },
            companyStatus: { type: "string", enum: ["active", "inactive"] },
            documents: {
              type: "object", additionalProperties: false, required: ["cinCertificate"],
              properties: {
                cinCertificate: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
                gstinCertificate: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
              },
            },
          },
        },
        admin: {
          type: "object", additionalProperties: false, required: ["name", "email", "password"],
          properties: { name: { type: "string", minLength: 1 }, email: { type: "string" }, password: { type: "string", minLength: 8 } },
        },
        // Requested capability envelope (EN-A). Loose here — the route runs
        // validateOrgCapabilities for the real (member-level) validation.
        capabilities: { type: "object", additionalProperties: true },
      },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 409, 429) },
  },
  listOrgs: { tags: ["Organizations"], summary: "List organizations in scope", security: bearer, querystring: { type: "object", properties: { status: { type: "string" } } }, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403) } },
  approveOrg: {
    tags: ["Organizations"], summary: "Approve a pending org (registers its DID on-chain, activates the admin)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409, 502) },
  },
  rejectOrg: {
    tags: ["Organizations"], summary: "Reject a pending org", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
  },
  getOrg: {
    tags: ["Organizations"], summary: "Get an organization by id", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404) },
  },
  patchOrgCapabilities: {
    tags: ["Organizations"], summary: "Set (or clear with null) an org's capability envelope (PlatformAdmin)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["capabilities"],
      // Loose object-or-null: the route runs validateOrgCapabilities for the real validation.
      properties: { capabilities: { type: ["object", "null"], additionalProperties: true } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  requestOrgCapabilities: {
    tags: ["Organizations"], summary: "Request a capability-envelope change (OrgAdmin; PlatformAdmin approval applies it)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["capabilities"],
      properties: { capabilities: { type: "object", additionalProperties: true } },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  createMember: {
    tags: ["Organizations"], summary: "Add a member (sub-DID + membership VC)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["email", "password", "role"],
      properties: {
        email: { type: "string" },
        password: { type: "string", minLength: 6 },
        // "PlatformAdmin" is deliberately allowed through validation so that
        // `canCreateOrgMember` rejects the escalation with a 403 (authorization),
        // rather than the schema masking it as a 400 (validation). Holder/Verifier
        // are org-internal roles (core ORG_INTERNAL_ROLES) — EN-A's member-add
        // envelope filter gates them, so the schema must let them through.
        role: { type: "string", enum: ["PlatformAdmin", "OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"] },
        useCaseKey: { type: "string" },
        walletAddress: { type: "string" },
        kyc: { type: "object", additionalProperties: false, properties: { legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" }, documentRef: { type: "string" } } },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  listMembers: {
    tags: ["Organizations"], summary: "List an organization's members", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },
  myCredentials: { tags: ["Identity"], summary: "Credentials held by the caller", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  identityDashboard: {
    tags: ["Identity"], summary: "Scoped identity operations dashboard (credential lifecycle + verification aggregates)", security: bearer,
    // Loose 200: the nested fold output would be silently stripped by
    // fast-json-stringify under a typed schema (the standing lesson).
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
  },
  acceptCredential: {
    tags: ["Credentials"], summary: "Holder accepts a pending credential", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404, 409) },
  },
  rejectHeldCredential: {
    tags: ["Credentials"], summary: "Holder rejects a pending credential (revokes it)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404, 409) },
  },
  requestCredentialChanges: {
    tags: ["Credentials"], summary: "Holder requests changes on a pending credential", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", minLength: 1 } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 404, 409) },
  },
  didDocument: {
    tags: ["Identity"], summary: "Resolve a did:key into a W3C DID document", security: bearer,
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401) },
  },
  didResolve: {
    tags: ["Identity"], summary: "Public: resolve a DID (W3C DID Resolution Result; did:key + on-chain registration)",
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true } },
  },

  credentialTypes: { tags: ["Credentials"], summary: "The credential-type catalog", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  requestCredential: {
    tags: ["Credentials"], summary: "Request a credential (gated by the type's approval depth)", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["type", "subjectUserId", "claims"],
      properties: {
        type: { type: "string" },
        subjectUserId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
        issuerOrgId: { type: "string" },
      },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  issueUsecaseCredential: {
    tags: ["Credentials"], summary: "Issue a configured credential type (gated by the type's approval depth)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["credentialType", "claims"],
      properties: {
        credentialType: { type: "string" },
        subjectUserId: { type: "string" },
        subjectOrgId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
      },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  issueUsecaseCredentialsBatch: {
    tags: ["Credentials"], summary: "Batch-issue a configured credential type from parsed CSV rows (one maker-checker proposal; draft-time all-or-nothing, execution-time per-row)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["credentialType", "rows"],
      properties: {
        credentialType: { type: "string" },
        rows: {
          type: "array", minItems: 1, maxItems: 200,
          items: {
            type: "object", additionalProperties: false, required: ["subjectEmail", "claims"],
            properties: {
              subjectEmail: { type: "string" },
              claims: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    response: {
      202: { type: "object", additionalProperties: true },
      // 400 is overridden (not the shared Error# ref) so `problems` — the
      // per-row draft-time validation report — survives fast-json-stringify's
      // response serialization instead of being stripped as an unlisted
      // property (the ID-G lesson).
      400: { type: "object", additionalProperties: true },
      ...errs(401, 403, 404),
    },
  },
  eligibleHolders: {
    tags: ["Credentials"], summary: "Users eligible to hold a credential of this use case", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: {
      200: { type: "array", items: { type: "object", additionalProperties: true } },
      ...errs(401, 403, 404),
    },
  },
  revokeCredential: {
    tags: ["Credentials"], summary: "Revoke a credential (gated; reason required)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  credentialStatus: {
    tags: ["Credentials"], summary: "Public revocation status of a credential (no auth — verifiers must resolve it)",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(404) },
  },
  credentialCertificate: {
    tags: ["Credentials"], summary: "Public: download a credential's PDF certificate (when its type enables one)",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { ...errs(404) },
  },
  identityRegistry: {
    tags: ["Identity"], summary: "The deployed on-chain identity registries (null when none)", security: bearer,
    response: { 200: { type: "object", nullable: true, additionalProperties: true }, ...errs(401) },
  },
  orgCredentials: {
    tags: ["Credentials"], summary: "Credentials issued by an organization", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },
  orgWallet: {
    tags: ["Identity"], summary: "Credentials held by an organization (entity wallet)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },

  createVerificationRequest: {
    tags: ["Verification"], summary: "A verifier org requests a credential presentation", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["holderDid", "requestedTypes", "purpose"],
      properties: {
        holderDid: { type: "string", minLength: 1 },
        requestedTypes: { type: "array", items: { type: "string" }, minItems: 1 },
        purpose: { type: "string", minLength: 1 },
        credentialUseCaseKey: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403) },
  },
  myVerificationRequests: { tags: ["Verification"], summary: "The caller's inbound verification requests", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  getVerificationRequest: {
    tags: ["Verification"], summary: "One verification request (holder or verifier org)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  consentVerificationRequest: {
    tags: ["Verification"], summary: "Holder consents, selecting credentials to disclose", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["credentialIds"], properties: { credentialIds: { type: "array", items: { type: "string" }, minItems: 1 } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409, 410) },
  },
  rejectVerificationRequest: {
    tags: ["Verification"], summary: "Holder declines a verification request", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
  },
  verifyVerificationRequest: {
    tags: ["Verification"], summary: "The verifier runs verification on the consented presentation", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
  },

  listUsers: { tags: ["Users"], summary: "List users in scope", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403) } },
  createUser: {
    tags: ["Users"], summary: "Create a user (scoped)", security: bearer,
    body: {
      type: "object",
      required: ["email", "password", "role"],
      properties: {
        email: { type: "string" },
        password: { type: "string", minLength: 6 },
        role: { type: "string", enum: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"] },
        useCaseKey: { type: "string" },
        walletAddress: { type: "string" },
        kyc: {
          type: "object",
          additionalProperties: false,
          properties: { legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" }, documentRef: { type: "string" } },
        },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  createUsersBatch: {
    tags: ["Users"], summary: "Batch-onboard users from parsed CSV rows (one maker-checker proposal; draft-time all-or-nothing, execution-time per-row)", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["rows"],
      properties: {
        rows: {
          type: "array", minItems: 1, maxItems: 200,
          items: {
            type: "object", additionalProperties: true, required: ["email", "password", "role"],
            properties: {
              email: { type: "string" },
              password: { type: "string", minLength: 6 },
              role: { type: "string", enum: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"] },
              useCaseKey: { type: "string" },
              walletAddress: { type: "string" },
              kyc: {
                type: "object",
                additionalProperties: false,
                properties: { legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" }, documentRef: { type: "string" } },
              },
            },
          },
        },
      },
    },
    response: {
      202: { type: "object", additionalProperties: true },
      // 400 is overridden (not the shared Error# ref) so `problems` — the
      // per-row draft-time validation report — survives fast-json-stringify's
      // response serialization instead of being stripped as an unlisted
      // property (the ID-G lesson).
      400: { type: "object", additionalProperties: true },
      ...errs(401, 403),
    },
  },
  revokeUserIdentity: {
    tags: ["Users"], summary: "Revoke a user's identity (gated; reason required)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  uploadDocument: {
    tags: ["Documents"], summary: "Upload a document (base64); returns its URL + sha256", security: bearer,
    body: {
      type: "object",
      required: ["contentType", "dataBase64"],
      properties: { contentType: { type: "string" }, dataBase64: { type: "string" } },
    },
    response: {
      201: {
        type: "object",
        properties: { id: { type: "string" }, url: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } },
        required: ["id", "url", "sha256", "size"],
      },
      ...errs(400, 401, 403, 413),
    },
  },
  uploadKybDocument: {
    tags: ["Documents"], summary: "Public: upload a KYB certificate (base64) before registering; returns id + sha256",
    body: {
      type: "object",
      required: ["contentType", "dataBase64"],
      properties: { contentType: { type: "string" }, dataBase64: { type: "string" } },
    },
    response: {
      201: {
        type: "object",
        properties: { id: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } },
        required: ["id", "sha256", "size"],
      },
      ...errs(400, 413, 415, 429),
    },
  },
  getDocument: {
    tags: ["Documents"], summary: "Fetch a document's bytes by id", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { ...errs(401, 404) },
  },
  deleteUser: { tags: ["Users"], summary: "Remove a user (scoped)", security: bearer, params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 403, 404) } },
  updateUser: {
    tags: ["Users"], summary: "Edit a user (reset password / suspend) — scoped", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      properties: { password: { type: "string", minLength: 6 }, active: { type: "boolean" }, kycStatus: { type: "string", enum: ["approved", "rejected"] } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },

  identityChallenge: {
    tags: ["Identity"], summary: "Issue a verification challenge for a user", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404) },
  },
  identityVerify: {
    tags: ["Identity"], summary: "Verify a DID/VC presentation and set KYC", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", required: ["presentation"], properties: { presentation: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  identityMint: {
    tags: ["Identity"], summary: "Dev: mint a demo VP", security: bearer,
    body: { type: "object", additionalProperties: true },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },

  importInvoices: {
    tags: ["Invoice Register"], summary: "Stage a batch of invoice rows (upload)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["rows"],
      properties: { rows: { type: "array", items: { type: "object", additionalProperties: true } } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  pullErp: {
    tags: ["Invoice Register"], summary: "Stage invoices pulled from the bundled ERP export", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  addInvoice: {
    tags: ["Invoice Register"], summary: "Stage a single manually-keyed invoice", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["metadata"],
      properties: { metadata: { type: "object", additionalProperties: true }, documentId: { type: "string" } },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  listInvoices: {
    tags: ["Invoice Register"], summary: "List staged/tokenized invoices for a use case", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["staged", "tokenized"] } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(400, 401, 403, 404) },
  },
  deleteInvoice: {
    tags: ["Invoice Register"], summary: "Delete a staged invoice (tokenized ones are guarded)", security: bearer,
    params: { type: "object", required: ["key", "id"], properties: { key: { type: "string" }, id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  tokenizeInvoices: {
    tags: ["Invoice Register"], summary: "Selectively tokenize staged invoices into assets", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["ids", "chainId", "treasuryAccount"],
      properties: {
        ids: { type: "array", items: { type: "string" } },
        chainId: { type: "string" },
        treasuryAccount: { type: "string" },
        parValue: { type: "number" },
        sale: {
          type: "object", additionalProperties: false, required: ["unitPrice", "currency"],
          properties: { unitPrice: { type: "string" }, currency: { type: "string" } },
        },
      },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
};
