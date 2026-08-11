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
      // EN-D2. DECLARED, not merely tolerated: the component is
      // `additionalProperties: true`, so the flag always travelled — but an
      // integrator reading the reference could not see that it exists, and a
      // field nobody can find is a feature nobody can use. Optional on input
      // and always present on output (false when it was never set).
      sandbox: {
        type: "boolean",
        description:
          "Test mode. `true` makes this a SANDBOX use case: it may allow ONLY the `sandbox` chain (an always-simulated " +
          "ledger — no environment variable promotes it to a real backend), only a `tl_test_` key may act on it, its " +
          "events go only to `test` webhook endpoints, and it is excluded from analytics unless asked for by name. " +
          "SET AT CREATION AND NEVER AFTER (**409 `SANDBOX_IMMUTABLE`**) — use `POST /use-cases/{key}/clone-to-live` " +
          "to promote the configuration into a real use case. Defaults to `false`: every call that omits it creates a " +
          "live use case, exactly as before.",
      },
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
      // The identity-domain twin of `UseCase.sandbox`, and declared for the
      // same reason. There are no chains here, so the whole of the difference
      // is who may act on it and where its events go.
      sandbox: {
        type: "boolean",
        description:
          "Test mode. `true` makes this a SANDBOX credential programme: only a `tl_test_` key may act on it, nothing " +
          "issued under it is a real credential, its events reach only `test` webhook endpoints, and it stays out of " +
          "the identity dashboard's totals unless asked for by name. SET AT CREATION AND NEVER AFTER " +
          "(**409 `SANDBOX_IMMUTABLE`**) — use `POST /credential-use-cases/{key}/clone-to-live` to promote the " +
          "configuration. Defaults to `false`.",
      },
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
      // NULLABLE, and this is load-bearing rather than tidiness. Credential and
      // governance proposals genuinely have no use case, so `ProposalRecord`
      // types this `string | null` — but fast-json-stringify COERCES null to ""
      // for a non-nullable string, so the wire said "" where the row said null.
      // This codebase has been bitten twice by ""-vs-null (a binding gate
      // skipped because "" is falsy, and a member-binding check bypassed the
      // same way), and here the API was manufacturing the empty string FOR
      // consumers who then apply their own truthiness checks.
      useCaseKey: { type: "string", nullable: true },
      // Declared for the same reason: `ProposalRecord.orgId` is `string | null`.
      // It reached the wire only because `additionalProperties: true` passes
      // undeclared fields through untouched — which is exactly the accident that
      // kept it correct while its declared neighbour was being coerced.
      orgId: { type: "string", nullable: true, description: "Set for org-scoped kinds; null for token kinds." },
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
  {
    $id: "CredentialUseCaseTemplate",
    type: "object",
    additionalProperties: true,
    description:
      "A parameterised starter for a credential use case. `parameters` describes what you must supply; `body` is " +
      "the skeleton those parameters are substituted into. Instantiate it with `POST " +
      "/credential-use-case-templates/{key}/preview` (dry run) or `POST /credential-use-cases/provision` (for real).",
    properties: {
      key: { type: "string" },
      name: { type: "string" },
      category: { type: "string" },
      description: { type: "string" },
      parameters: {
        type: "array",
        description: "NOTE each parameter also carries a `default`, whose type follows `type` (string, number or boolean). It is left undeclared here rather than coerced to one of them.",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            name: { type: "string", description: "The key to use in the `params` object you send." },
            label: { type: "string" },
            type: { type: "string", description: "e.g. `string`, `number`, `boolean`, `enum`." },
            required: { type: "boolean" },
            options: { type: "array", items: { type: "string" }, description: "enum params only." },
            min: { type: "number", description: "number params only, inclusive." },
            max: { type: "number", description: "number params only, inclusive." },
            help: { type: "string" },
          },
        },
      },
      // ABSENT from the LIST route, which strips it — a listing carries the
      // metadata only. Fetch one template by key to get its body.
      body: { type: "object", additionalProperties: true, description: "The definition skeleton. Absent from the list route; present when you fetch or create a single template." },
      builtIn: { type: "boolean", description: "true for a platform catalog template, false for one saved through the API." },
    },
    required: ["key", "name", "category", "parameters"],
  },
  {
    $id: "ProposalEnvelope",
    type: "object",
    additionalProperties: true,
    description:
      "THE 202 BODY. What a gated mutation answers with instead of the thing you asked it to create. The operation " +
      "has NOT happened: a proposal is a request captured pending approval, and `proposal.id` is the id of that " +
      "request — never of the user, credential or asset named in it, which may never exist at all if a checker " +
      "rejects it. There is NO single-proposal GET: to learn the outcome, list `GET /proposals` and match on the " +
      "id, or — for a machine integration — subscribe to the `proposal.executed` event instead of polling.",
    // Spelled out rather than `$ref: "Proposal#"`, purely so the 202 body can
    // carry its own field descriptions — the two now agree on nullability, and
    // `proposal-null-usecase-key.test.ts` pins that agreement in both
    // directions. (It did NOT always: `Proposal#` declared `useCaseKey` as a
    // non-nullable string, so the read routes emitted `""` for a credential
    // proposal while this envelope emitted `null` for the very same row.)
    properties: {
      proposal: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string", description: "The PROPOSAL's id — not the id of the thing it will create. Match on it in `GET /proposals`; there is no fetch-one route." },
          kind: { type: "string", description: "What is being proposed, e.g. `onboard-user`, `issue-usecase-credential`, `revoke-credential`, `org-capability-change`." },
          useCaseKey: { type: "string", nullable: true, description: "null for proposals that belong to an org rather than a use case — credential and capability kinds." },
          orgId: { type: "string", nullable: true, description: "Set for org-scoped kinds; null for token kinds." },
          assetId: { type: "string", nullable: true },
          payload: { type: "object", additionalProperties: true, description: "The captured request, with secrets redacted." },
          proposerId: { type: "string" },
          proposerLabel: { type: "string" },
          required: { type: "integer", description: "How many approvals this needs. The proposer's own does not count toward it." },
          approvals: {
            type: "array",
            items: {
              type: "object", additionalProperties: true,
              properties: { userId: { type: "string" }, email: { type: "string" }, at: { type: "string" } },
            },
          },
          status: { type: "string", enum: ["pending", "approved", "rejected", "executed", "failed"], description: "Always `pending` in a 202. `executed` is the only state in which the operation has actually happened; `failed` means it was approved and then could not be carried out." },
          error: { type: "string", nullable: true },
          result: { type: "object", additionalProperties: true, nullable: true, description: "The executor's report once run — a batch's per-row outcomes, for instance." },
          createdAt: { type: "string" },
          decidedAt: { type: "string", nullable: true },
        },
        required: ["id", "kind", "payload", "proposerId", "proposerLabel", "required", "approvals", "status", "createdAt"],
      },
    },
    required: ["proposal"],
  },
  {
    $id: "Organization",
    type: "object",
    additionalProperties: true,
    description: "An organization — the top-level tenant. `capabilities` is its EN-A envelope; `null` means a legacy, unrestricted org.",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      orgType: { type: "string", enum: ["bank", "corporate", "msme", "government", "verifier"] },
      registrationId: { type: "string", nullable: true },
      jurisdiction: { type: "string", nullable: true },
      /** The org's own DID — the issuer identifier on every credential it issues. */
      did: { type: "string" },
      verified: { type: "boolean" },
      status: { type: "string", enum: ["pending", "active", "rejected"] },
      companyProfile: { type: "object", additionalProperties: true, nullable: true, description: "KYB profile captured at self-registration; null for a platform-created org." },
      capabilities: { type: "object", additionalProperties: true, nullable: true, description: "The EN-A capability envelope. null = legacy, unrestricted." },
      createdAt: { type: "string" },
      // Present on the two READ routes only (list/get); the capability PATCH
      // returns the bare org. Not required, so it is simply absent there.
      credentials: {
        type: "array",
        description: "Credentials this organization HOLDS (it is the subject), e.g. its OrganizationCredential. Not the ones it issued — that is `GET /orgs/:id/credentials`.",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            issuerDid: { type: "string" },
            issuedAt: { type: "string" },
            revoked: { type: "boolean" },
          },
        },
      },
    },
    required: ["id", "name", "orgType", "did", "verified", "status", "createdAt"],
  },
  {
    $id: "ApiKeyView",
    type: "object",
    additionalProperties: true,
    description:
      "An API key's public record. The SECRET is not here and is not retrievable: it appears exactly twice in the " +
      "system's whole lifetime — the 201 from create and the 200 from rotate — and nowhere else, ever.",
    properties: {
      id: { type: "string" },
      // NULLABLE, and not optimistically. `ApiKey.orgId` is `String?` in the
      // Prisma schema — null means a PLATFORM-OWNED key, bound to no tenant.
      // No route mints one today, so this is unreachable; declaring it
      // non-nullable anyway would make the first one that IS minted serialise
      // as `""` rather than `null`, because fast-json-stringify coerces to the
      // declared type instead of refusing. That exact ""-vs-null confusion is
      // already confirmed live on `Proposal#`; one instance of it is enough.
      // `required` stays: the KEY is always present, it is the VALUE that can
      // be null, and dropping it would tell clients the field may be absent.
      orgId: { type: "string", nullable: true, description: "The owning organization. null on a platform-owned key, which belongs to no tenant." },
      /** The service user this key authenticates as. Its role and use-case scope are the key's ceiling. */
      userId: { type: "string" },
      name: { type: "string" },
      /**
       * The key's public, non-secret identifier. NOT the `tl_live_` marker —
       * that is stripped (see `prefixOf` in api-keys.ts). This is the first 8
       * characters of the secret's BODY, i.e. of what follows `tl_live_`, which
       * is what makes it a usable lookup key: the marker is the same on every
       * key and would identify none of them.
       */
      prefix: { type: "string", description: "The first 8 characters of the secret's body — what follows `tl_live_`, with the marker itself stripped. Public and safe to display; it identifies a key without revealing it." },
      scopes: { type: "array", items: { type: "string" } },
      role: { type: "string", nullable: true, description: "The bound service user's role. null if that user has vanished." },
      useCaseKey: { type: "string", nullable: true },
      // DERIVED, not stored: `expired` is recomputed from expiresAt on every
      // read, so a key can move active -> expired with no write anywhere.
      status: { type: "string", enum: ["active", "expired", "revoked"] },
      lastUsedAt: { type: "string", nullable: true },
      expiresAt: { type: "string", nullable: true },
      revokedAt: { type: "string", nullable: true },
      revokedBy: { type: "string", nullable: true },
      createdBy: { type: "string" },
      createdAt: { type: "string" },
      // EN-D2 (D2-8). DECLARED, not merely projected: fast-json-stringify
      // serialises against this schema and silently strips anything it does
      // not name, so a `mode` added to `apiKeyView` and not to this list would
      // vanish between the handler and the wire — with nothing failing.
      mode: {
        type: "string", enum: ["live", "test"],
        description:
          "Which environment this key acts in. A `test` key reads `tl_test_…`, acts ONLY on sandbox use cases and is " +
          "refused **403 `WRONG_MODE`** on real ones; a `live` key is the mirror. Fixed at creation — rotation " +
          "preserves it, and there is no route that moves a key between environments.",
      },
    },
    required: ["id", "orgId", "userId", "name", "prefix", "scopes", "status", "createdBy", "createdAt", "mode"],
  },
  {
    $id: "WebhookEndpoint",
    type: "object",
    additionalProperties: true,
    description:
      "A registered delivery destination. The signing secret is NEVER in this view — it is returned once at " +
      "registration and once per rotation, and read routes cannot produce it.",
    properties: {
      id: { type: "string" },
      orgId: { type: "string", nullable: true },
      url: { type: "string" },
      description: { type: "string", nullable: true },
      eventTypes: { type: "array", items: { type: "string" }, description: "Subscribed event types, or `[\"*\"]` for everything the org is entitled to." },
      useCaseKey: { type: "string", nullable: true, description: "Narrows delivery to one use case. null = the whole org's stream." },
      status: { type: "string", enum: ["active", "disabled"] },
      disabledReason: { type: "string", nullable: true },
      disabledAt: { type: "string", nullable: true },
      consecutiveFailures: { type: "integer", description: "Consecutive failures where YOUR server answered badly or was unreachable. Only this counter can auto-disable an endpoint." },
      consecutiveGuardFailures: { type: "integer", description: "Consecutive failures where our own URL guard refused to send (DNS did not resolve, or resolved somewhere not publicly routable). Never auto-disables." },
      failingSince: { type: "string", nullable: true, description: "When the CURRENT failure run began; null whenever the endpoint is healthy." },
      deletedAt: { type: "string", nullable: true, description: "Soft delete. A deleted endpoint keeps its delivery history but receives nothing." },
      createdBy: { type: "string" },
      createdAt: { type: "string" },
      lastDeliveryAt: { type: "string", nullable: true },
      mode: {
        type: "string", enum: ["live", "test"],
        description:
          "Which stream this endpoint receives. A `test` endpoint hears ONLY sandbox events and a `live` one ONLY " +
          "real ones — the two never cross, so a sandbox event can never reach a production handler. Fixed at " +
          "registration: an endpoint cannot be moved between streams.",
      },
    },
    required: ["id", "url", "eventTypes", "status", "consecutiveFailures", "consecutiveGuardFailures", "createdBy", "createdAt", "mode"],
  },
  {
    $id: "WebhookDelivery",
    type: "object",
    additionalProperties: true,
    description:
      "One attempt chain for one (event, endpoint) pair. It carries NO event payload — read the body from " +
      "`GET /events`, which applies its own org scope.",
    properties: {
      id: { type: "string" },
      endpointId: { type: "string" },
      eventId: { type: "string" },
      eventSeq: { type: "integer" },
      status: { type: "string", enum: ["pending", "inflight", "delivered", "failed", "dead"], description: "`dead` = retries exhausted or the endpoint was gone; it will not be attempted again unless you replay it." },
      attempts: { type: "integer" },
      nextAttemptAt: { type: "string" },
      lastAttemptAt: { type: "string", nullable: true },
      responseStatus: { type: "integer", nullable: true, description: "The HTTP status YOUR endpoint answered with." },
      responseError: { type: "string", nullable: true },
      durationMs: { type: "integer", nullable: true },
      claimedAt: { type: "string", nullable: true },
      claimedBy: { type: "string", nullable: true },
      createdAt: { type: "string" },
    },
    required: ["id", "endpointId", "eventId", "eventSeq", "status", "attempts", "nextAttemptAt", "createdAt"],
  },
  {
    $id: "Event",
    type: "object",
    additionalProperties: true,
    description:
      "One durable, globally ordered platform fact — and the same object a webhook delivers. `seq` is the cursor: " +
      "pass the last one you saw as `after`, which is EXCLUSIVE, so the loop never re-reads and never skips.",
    properties: {
      seq: { type: "integer", description: "Global monotonic cursor. Gaps in YOUR stream are other tenants' events, not lost ones." },
      id: { type: "string", description: "Stable public id, also sent as the `Tokenlayer-Event-Id` delivery header." },
      type: { type: "string", description: "e.g. `asset.issued`, `credential.accepted`, `verification.completed`, `proposal.executed`." },
      orgId: { type: "string", nullable: true, description: "The owning org — the tenancy key. null = platform scope." },
      useCaseKey: { type: "string", nullable: true },
      subjectId: { type: "string", nullable: true, description: "The id of the thing the event is about (asset, credential, verification request…)." },
      data: { type: "object", additionalProperties: true, description: "Per-type payload. Its shape follows `type`; treat unknown keys as forward-compatible additions." },
      occurredAt: { type: "string" },
      mode: {
        type: "string", enum: ["live", "test"],
        description:
          "`test` if the use case that produced this fact is a sandbox one, else `live`. DERIVED from that use case " +
          "— never set by the caller — and an event with no use case is `live`. You do not need to check it to stay " +
          "safe: a `test` event is only ever delivered to a `test` endpoint. It is here so a fact is self-describing.",
      },
    },
    required: ["seq", "id", "type", "data", "occurredAt", "mode"],
  },
  {
    $id: "VerificationRequest",
    type: "object",
    additionalProperties: true,
    description:
      "A verifier's request for a presentation, and the holder's consent record for it. NOTE the verifier's own " +
      "verdict is deliberately NOT here — read it from `GET /verification-requests/:id/verify`.",
    properties: {
      id: { type: "string" },
      verifierOrgId: { type: "string", description: "May be the empty string for a use-case-scoped Verifier desk that belongs to no org." },
      holderDid: { type: "string" },
      requestedTypes: { type: "array", items: { type: "string" } },
      purpose: { type: "string" },
      status: { type: "string", enum: ["pending", "consented", "rejected", "verified", "expired"] },
      consentedCredentialIds: { type: "array", items: { type: "string" }, nullable: true },
      consentedAt: { type: "string", nullable: true },
      verifiedAt: { type: "string", nullable: true },
      createdAt: { type: "string" },
      expiresAt: { type: "string" },
      credentialUseCaseKey: { type: "string", nullable: true },
      // Added by GET /me/verification-requests only — the holder's own view,
      // which pre-computes what they could consent with. Absent elsewhere.
      eligibleCredentials: {
        type: "array",
        description: "HOLDER VIEW ONLY. The caller's own unrevoked, accepted credentials whose type this request asks for.",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            issuerDid: { type: "string" },
            issuedAt: { type: "string" },
          },
        },
      },
    },
    required: ["id", "verifierOrgId", "holderDid", "requestedTypes", "purpose", "status", "createdAt", "expiresAt"],
  },
];

/** Standard error responses attached to authenticated routes. */
const errs = (...codes: number[]): Record<string, unknown> =>
  Object.fromEntries(codes.map((c) => [c, { $ref: "Error#" }]));

/**
 * EN-D1: WHICH CREDENTIAL A ROUTE ACCEPTS IS A FACT THE SERVER ALREADY KNOWS.
 *
 * `authScoped("x")` in routes.ts IS the statement "an API key may call this,
 * with scope x"; plain `...auth` is the statement "a key gets no scope-level
 * permission here, and the route may refuse it outright". These two constants
 * are the document's half of that same statement, and
 * `openapi-contract.test.ts` fails the build when the halves disagree — the
 * whole point being that until EN-D1 all 121 routes advertised `bearerAuth`
 * alone, telling every integrator that machine access did not exist while the
 * server served it happily.
 *
 * Pick by the GATE, never by intuition: `authScoped(...)` ⇒ eitherCredential,
 * anything else ⇒ humanOnly, and a genuinely public route gets no `security`
 * key at all.
 */
/** One OpenAPI security requirement: a scheme name mapped to its (here always
 * empty) scope list. Annotated explicitly because inference would otherwise
 * give `eitherCredential` a union element type with optional members, which
 * FastifySchema's index-signature form rejects. */
type SecurityRequirement = Record<string, readonly string[]>;
/** A human session only. A key may authenticate, but this route will refuse or re-gate it. */
const humanOnly: SecurityRequirement[] = [{ bearerAuth: [] }];
/** Either credential. Use for any route carrying `authScoped(...)`. */
const eitherCredential: SecurityRequirement[] = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

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
      // 403 = SERVICE_ACCOUNT: a service user's key is its only way in.
      ...errs(400, 401, 403),
    },
  },
  me: { tags: ["Auth"], summary: "Current session principal", security: humanOnly,
    description:
      "The caller's own principal, self-describing enough to drive a UI: role, use-case scope, which domain that " +
      "use case belongs to, and the org's capability envelope.\n\n" +
      "**It does NOT return the caller's email, org id or DID** — those are in the JWT you already hold, and in the " +
      "`user` object `POST /auth/login` returned. Do not expect `/me` to be a fuller record than login gave you; it " +
      "is a narrower one.",
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          useCaseKey: { type: "string", nullable: true, description: "The desk this principal is scoped to, or null for an unscoped one." },
          useCaseDomain: { type: "string", enum: ["tokenization", "identity"], nullable: true, description: "Which domain `useCaseKey` belongs to. null when there is no use case, or when the key resolves to neither." },
          orgCapabilities: { type: "object", additionalProperties: true, nullable: true, description: "The org's EN-A envelope. null both for an org-less principal AND for a legacy, unrestricted org — the two are indistinguishable here." },
        },
        required: ["id", "role"],
      },
      ...errs(401),
    } },
  config: {
    tags: ["Config"], summary: "Deployment configuration (enabled domains)", security: humanOnly,
    description: "What this DEPLOYMENT has switched on — not what the caller may do. A domain listed here can still be closed to a given org by its capability envelope.",
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          domains: {
            type: "array",
            items: { type: "string", enum: ["tokenization", "identity"] },
            description: "The product domains this deployment serves. Routes of an absent domain are not mounted.",
          },
        },
        required: ["domains"],
      },
      ...errs(401),
    },
  },

  enrollLoginKey: {
    tags: ["Auth"], summary: "Enrol a device login key (public did:key)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`**: a key has no device, and enrolling a " +
      "durable device credential is a human act.",
    body: { type: "object", additionalProperties: false, required: ["did", "label"], properties: { did: { type: "string" }, label: { type: "string", minLength: 1 } } },
    // 403 = MACHINE_PRINCIPAL: an API key has no device to enrol.
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          did: { type: "string", description: "The `did:key` you enrolled. The PRIVATE key never leaves your device and this API never sees it." },
          label: { type: "string" },
          createdAt: { type: "string" },
        },
        required: ["id", "did", "label", "createdAt"],
      },
      ...errs(400, 401, 403, 409),
    },
  },
  listLoginKeys: { tags: ["Auth"], summary: "The caller's enrolled device login keys", security: humanOnly,
    description: "The caller's OWN enrolled devices. `lastUsedAt` is how you spot a key that should be revoked.",
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            id: { type: "string" },
            did: { type: "string" },
            label: { type: "string" },
            createdAt: { type: "string" },
            lastUsedAt: { type: "string", nullable: true, description: "null for a key that has never completed a QR login." },
          },
          required: ["id", "did", "label", "createdAt"],
        },
      },
      ...errs(401),
    } },
  removeLoginKey: { tags: ["Auth"], summary: "Revoke a device login key", security: humanOnly,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 404) } },
  qrStart: { tags: ["Auth"], summary: "Begin a passwordless QR login session", 
    description: "Public. Opens a short-lived session: render `qrSvg`, have an enrolled device sign the challenge, and poll `GET /auth/qr/{id}` for the token.",
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          sessionId: { type: "string", description: "Poll `GET /auth/qr/{sessionId}` with this." },
          challenge: { type: "string", description: "The device signs `qr-login:{sessionId}:{challenge}` — not the challenge alone." },
          signUrl: { type: "string", description: "The web URL encoded in the QR code." },
          qrSvg: { type: "string", description: "The QR code itself, as an inline SVG document." },
          expiresAt: { type: "string" },
        },
        required: ["sessionId", "challenge", "signUrl", "qrSvg", "expiresAt"],
      },
    } },
  qrPoll: { tags: ["Auth"], summary: "Poll a QR login session",
    description:
      "Public. Until the device has signed, the body is `{ status }` alone. Once it has, the FIRST poll to see it " +
      "returns the JWT — **and consumes it**: a second poll of the same session no longer carries a token. Capture " +
      "it on the response that has it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          status: { type: "string", description: "`pending` until the device signs, then `authenticated`." },
          token: { type: "string", description: "The session JWT. Present on the ONE poll that consumes the authenticated session, and never again." },
          user: {
            type: "object", additionalProperties: true, nullable: true,
            description: "The signed-in principal — the same shape `POST /auth/login` returns, plus `walletAddress`, `useCaseDomain` and `orgCapabilities`. Accompanies `token` only.",
          },
        },
        required: ["status"],
      },
      ...errs(404),
    } },
  qrAuthenticate: {
    tags: ["Auth"], summary: "Authenticate a QR login session by signing its challenge",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["did", "signature"], properties: { did: { type: "string" }, signature: { type: "string" } } },
    // 403 = SERVICE_ACCOUNT: the other JWT-minting path refuses service users too.
    // A BARE ACKNOWLEDGEMENT, deliberately: the signing DEVICE is not the thing
    // logging in, so the token goes to whoever is polling the session, never
    // back on this response.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { ok: { type: "boolean", description: "Always `true`. The session's JWT is delivered to the POLLING client, not to the signing device." } },
        required: ["ok"],
      },
      ...errs(401, 403, 404, 410, 429),
    },
  },

  chains: { tags: ["Catalog"], summary: "List configured chains/DLTs", security: humanOnly,
    response: { 200: { type: "array", items: { $ref: "Chain#" } }, ...errs(401) } },
  chainStatus: {
    tags: ["Catalog"], summary: "Probe one chain's live status (on-demand health check)", security: humanOnly,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "ChainStatus#" }, ...errs(401, 404) },
  },
  currencies: { tags: ["Catalog"], summary: "List supported settlement currencies", security: humanOnly,
    response: { 200: { type: "array", items: { $ref: "Currency#" } }, ...errs(401) } },
  accounts: { tags: ["Catalog"], summary: "List demo accounts", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. The settlement accounts within the caller's scope — a Platform Admin sees " +
      "every one, anyone else sees only those linked to users of their own use case. It carries NO balances; those " +
      "come from `GET /cash/balances`.",
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            id: { type: "string", description: "The account id — what a user record's `accountId` points at." },
            address: { type: "string", description: "The on-chain address. This is what you pass as a treasury or counterparty." },
            label: { type: "string" },
          },
          required: ["id", "address", "label"],
        },
      },
      ...errs(401),
    } },

  listUseCases: { tags: ["Use Cases"], summary: "List use cases", security: humanOnly,
    response: { 200: { type: "array", items: { $ref: "UseCase#" } }, ...errs(401) } },
  getUseCase: {
    tags: ["Use Cases"], summary: "Get a use case by key", security: humanOnly,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { $ref: "UseCase#" }, ...errs(401, 404) },
  },
  createUseCase: {
    tags: ["Use Cases"], summary: "Create a use case (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Creates a tokenization use case — the contract template, the chains " +
      "it may deploy on, and the compliance and fee configuration every asset issued under it inherits. Deploying " +
      "it is a separate call. Pass `sandbox: true` (with `allowedChainIds: [\"sandbox\"]`) to create a TEST-MODE use " +
      "case; the flag is fixed at creation.",
    body: { $ref: "UseCase#" },
    response: { 201: { $ref: "UseCase#" }, ...errs(400, 401, 403) },
  },
  updateUseCase: {
    tags: ["Use Cases"], summary: "Update a use case (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Replaces a use case's configuration. Contracts already deployed are " +
      "untouched; the change governs what happens next.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { $ref: "UseCase#" },
    response: { 200: { $ref: "UseCase#" }, ...errs(400, 401, 403, 404) },
  },
  deployUseCase: {
    tags: ["Use Cases"], summary: "Deploy a use case's contract on one allowed chain (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Deploys this use case's contract on one of its allowed chains and " +
      "records the address. A chain that cannot be reached answers **502** and leaves the deployment pending — " +
      "retry is safe.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["chainId"], properties: { chainId: { type: "string" } } },
    response: { 200: { $ref: "UseCase#" }, ...errs(400, 401, 403, 404, 502) },
  },
  cloneUseCaseToLive: {
    tags: ["Use Cases"], summary: "Clone a sandbox use case into a live one (configuration only)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. THE SUPPORTED WAY OUT OF THE SANDBOX: `sandbox` cannot be changed " +
      "on an existing use case, so this copies a sandbox one's CONFIGURATION — metadata schema, lifecycle, " +
      "compliance rules, fees, sale terms, valuation, workflow, roles — into a brand-new LIVE use case and deploys " +
      "fresh contracts on the real chains you name in `allowedChainIds`. IT COPIES NO DATA: no assets, holders, " +
      "staged invoices, proposals or events come with it, and no contract address is inherited. The new key " +
      "defaults to `<source key>-live`, may be overridden with `key`, and is echoed back as `key` on both answers. " +
      "An Org Admin gets **202** and a **proposal** for a Platform Admin to approve — the same maker-checker " +
      "`POST /use-cases` applies, because this creates a live use case and renaming the act must not change how it " +
      "is governed. Cloning spans both environments, so an API key of EITHER mode is refused with " +
      "**403 `WRONG_MODE`** (a `tl_test_` key on the live use case it would create, a `tl_live_` key on the sandbox " +
      "one it must read): take this one from a human session. A source that is not sandbox answers " +
      "**400 `NOT_SANDBOX`**.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["allowedChainIds"],
      properties: {
        key: { type: "string", description: "Key for the new live use case. Defaults to `<source key>-live`. Must be free in BOTH domains." },
        allowedChainIds: {
          type: "array", items: { type: "string" }, minItems: 1,
          description: "Real chains the live clone may deploy on. The `sandbox` chain is refused here (**400 `INVALID_SANDBOX_CHAINS`**).",
        },
        defaultChainId: { type: "string", description: "Defaults to the first of `allowedChainIds`." },
        sandbox: {
          type: "boolean",
          description:
            "Only `false` is meaningful: this route creates a LIVE use case by definition. `true` answers " +
            "**400 `SANDBOX_NOT_CLONEABLE`** — it is declared here so it can be refused rather than dropped. To " +
            "create a sandbox use case, `POST /use-cases` with `sandbox: true`.",
        },
      },
    },
    response: {
      201: { $ref: "UseCase#" },
      202: {
        type: "object", additionalProperties: true,
        properties: {
          proposal: { type: "object", additionalProperties: true, description: "The pending `create-use-case` proposal — see `ProposalEnvelope`. The live use case DOES NOT EXIST YET." },
          key: { type: "string", description: "The key the clone will have once the proposal is approved." },
          clonedFrom: { type: "string", description: "The sandbox use case this was cloned from." },
        },
        required: ["proposal", "key"],
      },
      ...errs(400, 401, 403, 404, 409),
    },
  },
  useCaseCode: {
    tags: ["Use Cases"], summary: "Contract code backing a use case on one allowed chain", security: humanOnly,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: { type: "object", additionalProperties: false, required: ["chainId"], properties: { chainId: { type: "string" } } },
    response: { 200: { $ref: "ContractCode#" }, ...errs(400, 401, 404) },
  },
  previewUseCaseCode: {
    tags: ["Use Cases"], summary: "Preview the contract code for a not-yet-created use case (wizard review step)", security: humanOnly,
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

  credentialTemplates: { tags: ["Credential Use Cases"], summary: "Editable starter credential-type templates", security: humanOnly,
    description:
      "A MAP, not a list: the object is keyed by credential-type NAME (`KycCredential`, `MCACredential`, " +
      "`GSTINCredential`, …) and each value is a credential-type spec — `name`, `title`, `validityDays`, " +
      "`requiredApprovals` and a `claimSchema`. Because the keys are data rather than a fixed field set, they " +
      "cannot be enumerated as `properties` here; the value shape is the same one that appears in a credential use " +
      "case's `credentialTypes`.",
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) } },
  listCredentialUseCases: { tags: ["Credential Use Cases"], summary: "List credential use cases", security: humanOnly,
    response: { 200: { type: "array", items: { $ref: "CredentialUseCase#" } }, ...errs(401) } },
  getCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Get a credential use case by key", security: humanOnly,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(401, 404) },
  },
  createCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Create a credential use case (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope — the same scope as its tokenization counterpart, because " +
      "configuring who may issue a credential is the same kind of authority as configuring who may mint a token. " +
      "Pass `sandbox: true` for a TEST-MODE programme; the flag is fixed at creation. An Org Admin cannot use this " +
      "route at all — `POST /credential-use-cases/provision` is theirs, and it takes the same flag.",
    body: { type: "object", additionalProperties: true, required: ["key", "name", "credentialTypes", "issuer", "holderPolicy", "verifier"] },
    response: { 201: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 409) },
  },
  updateCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Update a credential use case (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Patches a credential use case's configuration: its credential " +
      "types, holder policy, and verifier.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404) },
  },
  cloneCredentialUseCaseToLive: {
    tags: ["Credential Use Cases"], summary: "Clone a sandbox credential use case into a live one (configuration only)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. The identity-domain twin of `POST /use-cases/{key}/clone-to-live`, " +
      "and Platform-Admin-only with a **201** because that is what `POST /credential-use-cases` is — cloning is " +
      "governed as the act it performs. Copies credential types, issuer binding, holder policy, verifier policy and " +
      "certificate design into a new LIVE credential use case; copies NO credentials, holders or verification " +
      "requests. There are no chains to choose here. The new key defaults to `<source key>-live`. An API key of " +
      "either mode is refused with **403 `WRONG_MODE`** (the act spans both environments); a source that is not " +
      "sandbox answers **400 `NOT_SANDBOX`**.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false,
      properties: {
        key: { type: "string", description: "Key for the new live credential use case. Defaults to `<source key>-live`. Must be free in BOTH domains." },
        sandbox: {
          type: "boolean",
          description:
            "Only `false` is meaningful: this route creates a LIVE credential use case by definition. `true` answers " +
            "**400 `SANDBOX_NOT_CLONEABLE`** — declared here so it is refused rather than dropped. To create a " +
            "sandbox one, `POST /credential-use-cases` with `sandbox: true`, or provision it with `sandbox: true`.",
        },
      },
    },
    response: { 201: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404, 409) },
  },

  listUseCaseTemplates: {
    tags: ["Credential Use Cases"], summary: "List the credential-use-case template catalog (built-in + saved)", security: humanOnly,
    description: "Built-in catalog templates and saved ones together. The `body` skeleton is STRIPPED here — fetch a template by key to get it.",
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { templates: { type: "array", items: { $ref: "CredentialUseCaseTemplate#" } } },
        required: ["templates"],
      },
      ...errs(401),
    },
  },
  getUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Get a credential-use-case template by key (built-in or saved)", security: humanOnly,
    description: "A built-in catalog template shadows a saved one of the same key. Unlike the list route, this includes the `body` skeleton.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: { 200: { $ref: "CredentialUseCaseTemplate#" }, ...errs(401, 404) },
  },
  createUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Save a custom credential-use-case template (PlatformAdmin/OrgAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Saves a reusable credential-use-case template. A template is " +
      "authoring input and confers nothing until it is instantiated. It may NOT carry `sandbox` " +
      "(**400 `SANDBOX_NOT_ON_TEMPLATE`**): the environment is chosen when the template is provisioned, so one " +
      "template serves both.",
    body: { type: "object", additionalProperties: true, required: ["key", "name", "category", "parameters", "body"] },
    // The stored template. `builtIn` comes back FALSE whatever you sent — the
    // route forces it, so a saved template can never impersonate a catalog one.
    response: { 201: { $ref: "CredentialUseCaseTemplate#" }, ...errs(400, 401, 403, 409) },
  },
  previewUseCaseTemplate: {
    tags: ["Credential Use Cases"], summary: "Preview the CredentialUseCaseDefinition a template instantiates to, given param values", security: humanOnly,
    description:
      "A DRY RUN. Nothing is created, no key is claimed, and the returned `definition` is not stored anywhere — it " +
      "is what `POST /credential-use-cases/provision` would build from the same template and params. Note the " +
      "`issuer` binding is still the template's; provisioning overwrites it with the resolved issuer org.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true, properties: { params: { type: "object", additionalProperties: true } } },
    // 400 is overridden (not the shared Error# ref) so `problems` — an array of
    // human-readable per-param validation failures — survives fast-json-stringify's
    // response serialization instead of being stripped as an unlisted property.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { definition: { $ref: "CredentialUseCase#" } },
        required: ["definition"],
      },
      400: {
        type: "object", additionalProperties: true,
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          problems: { type: "array", items: { type: "string" }, description: "Human-readable per-parameter validation failures." },
        },
      },
      ...errs(401, 404),
    },
  },
  previewCertificate: {
    tags: ["Credential Use Cases"], summary: "Render a draft certificate design as a PDF", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope: this is a configuration-authoring act, and the body is a DRAFT " +
      "credential type — you are designing before the use case is saved, so nothing is read from storage except the " +
      "background artwork it names. The rendered PDF is stamped **SAMPLE — NOT A CREDENTIAL** on the diagonal, " +
      "always: it renders arbitrary caller-supplied claims through the same code that renders real certificates, " +
      "and without the stamp it would be a certificate generator for made-up facts.",
    body: {
      type: "object", additionalProperties: false, required: ["credentialType"],
      properties: {
        credentialType: { type: "object", additionalProperties: true, description: "A full CredentialTypeSpec, `certificate` included." },
        sampleClaims: { type: "object", additionalProperties: true, description: "Values to print. Missing claims fall back to a humanized key so every placement is still visible." },
      },
    },
    // The 200 is opaque PDF bytes, so there is no field to name — the same
    // shape `credentialCertificate` already uses. `openapi-contract.test.ts`
    // records the deferral for both.
    response: { ...errs(400, 401, 403) },
  },
  updateCertificateDesign: {
    tags: ["Credential Use Cases"], summary: "Set certificate artwork and field placements on a credential use case your organization owns", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case (`ownerOrgId`). The narrow, org-facing counterpart of `PATCH /credential-use-cases/{key}`: " +
      "it writes `certificate.background` and `certificate.placements` on ONE named credential type and nothing " +
      "else — every other field of the definition is read from storage, so sending them changes nothing. Omit a " +
      "field to leave it unchanged; send `background: null` to drop the artwork (reverting to the built-in layout) " +
      "or `placements: []` to clear the layout. `background` must carry the artwork's `sha256` — the digest the " +
      "document store recorded for those exact bytes — and the document must be a PNG or JPEG: a `documentId` " +
      "alone is a guessable reference. Answers **400** `BACKGROUND_PIN_REQUIRED`, `BACKGROUND_DOCUMENT_NOT_FOUND`, " +
      "`BACKGROUND_DOCUMENT_MISMATCH`, `BACKGROUND_NOT_AN_IMAGE` or `INVALID_CERTIFICATE_PLACEMENT` (which names the " +
      "offending placement index). Upload the artwork through " +
      "`POST /credential-use-cases/{key}/certificate/artwork`, which returns the `documentId` and the `sha256` to " +
      "send here — the general document store is closed to an Org Admin.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: true, required: ["credentialType"],
      properties: {
        credentialType: { type: "string", description: "Name of the credential type within this use case." },
        background: {
          // `sha256` is REQUIRED, but by the handler and not by this schema: the
          // pin check lives in `checkBackgroundDocument(…, { requirePin: true })`
          // so a pin-less background answers the coded `BACKGROUND_PIN_REQUIRED`
          // this route's own description promises. Listing it here instead would
          // answer the generic `VALIDATION_ERROR` before the handler ever ran,
          // making that documented code unreachable and `requirePin` dead.
          type: ["object", "null"], additionalProperties: false, required: ["documentId"],
          properties: { documentId: { type: "string" }, sha256: { type: "string" } },
          description: "The stored artwork document and its digest. `sha256` is required — a bare `documentId` answers `BACKGROUND_PIN_REQUIRED`. `null` clears the artwork.",
        },
        placements: { type: "array", items: { type: "object", additionalProperties: true }, description: "Where each field prints, in 0–1 fractions of the page." },
        enabled: {
          type: "boolean",
          description:
            "Only meaningful when the credential type has NO certificate configured yet, where `true` is REQUIRED to " +
            "create one — enabling a certificate publishes a public, unauthenticated PDF of every already-issued " +
            "credential's claims, so it is confirmed rather than inferred (**400 `CERTIFICATE_NOT_ENABLED`** " +
            "otherwise). It never toggles an existing block: this route cannot switch a certificate off.",
        },
      },
    },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404) },
  },
  uploadCertificateArtwork: {
    tags: ["Credential Use Cases"], summary: "Upload certificate artwork for a credential use case your organization owns", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case. Stores an image and returns the `documentId` + `sha256` to pass to " +
      "`PATCH /credential-use-cases/{key}/certificate`. This door exists because the general document store " +
      "(`POST /documents`) is restricted to issue-capable roles, which an Org Admin is not; the capability here is " +
      "bounded by the use case you own. PNG or JPEG only — anything else answers **415** " +
      "`UNSUPPORTED_DOCUMENT_TYPE`.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["contentType", "dataBase64"],
      properties: {
        contentType: { type: "string", description: "`image/png` or `image/jpeg` — the only formats the certificate renderer can draw." },
        dataBase64: { type: "string", description: "The image bytes, base64-encoded. Max 5 MB decoded." },
      },
    },
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: { documentId: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } },
      },
      ...errs(400, 401, 403, 404, 413, 415),
    },
  },
  getCertificateArtwork: {
    tags: ["Credential Use Cases"], summary: "Fetch the certificate artwork a credential type currently uses", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case. Returns the image bytes that credential type's `certificate.background` names. It takes " +
      "no document id: the use case you own is the capability, so a stored document that no design references is " +
      "not reachable here. **404** when the type carries no artwork.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: {
      type: "object", required: ["credentialType"],
      properties: { credentialType: { type: "string", description: "Name of the credential type within this use case." } },
    },
    // The 200 is opaque image bytes, so there is no field to name — the same
    // deferral `credentialCertificate` and `previewCertificate` already record.
    //
    // 400 is declared because `credentialType` is a REQUIRED querystring param:
    // omitting it is answered by the schema layer with VALIDATION_ERROR, before
    // the handler runs. A response an integrator can actually receive belongs in
    // the contract whether or not this file's own code produces it.
    response: { ...errs(400, 401, 403, 404) },
  },
  provisionUseCase: {
    tags: ["Credential Use Cases"], summary: "One-step enterprise provisioning from a template: ensure the issuer org, instantiate the bound credential use case, and optionally create scoped desk users (PlatformAdmin; OrgAdmin scoped to their own org)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. One call ensures the issuer organization, instantiates the " +
      "template's credential use case, and optionally creates scoped desk users — whose one-time passwords appear " +
      "in **this response only** and are never retrievable again. Pass `sandbox: true` (at the TOP LEVEL, beside " +
      "`templateKey`) to stand the programme up in TEST MODE — this is the way to create a sandbox credential " +
      "programme, and the only one available to an Org Admin. The same template serves both environments, so " +
      "`sandbox` is never written into the template itself.",
    body: {
      type: "object", additionalProperties: true, required: ["templateKey", "params"],
      properties: {
        templateKey: { type: "string" },
        params: { type: "object", additionalProperties: true },
        sandbox: {
          type: "boolean",
          description:
            "Create the programme in TEST MODE — see `CredentialUseCase.sandbox`. Defaults to `false`, so every " +
            "existing caller is unaffected. Put it HERE, not inside `provisioning`: the nested spelling answers " +
            "**400 `SANDBOX_MISPLACED`** rather than being ignored, because a dropped flag would return **201** for " +
            "a LIVE programme you believed was a sandbox. Re-provisioning with the other value answers " +
            "**409 `SANDBOX_IMMUTABLE`**; omitting it on a re-provision leaves the stored environment untouched.",
        },
        provisioning: { type: "object", additionalProperties: true },
      },
    },
    // 201/200/400 are LOOSE (additionalProperties:true) so nested fields survive
    // fast-json-stringify — most importantly deskUsers[].password, the one-time
    // plaintext credential returned exactly once. A strict/ref response schema
    // would silently strip it (the G3 trap).
    response: {
      // 200 = the use case ALREADY EXISTED and was updated in place; 201 = it was
      // created. Both bodies are the same shape.
      200: {
        type: "object", additionalProperties: true,
        properties: {
          org: {
            type: "object", additionalProperties: true,
            description: "The issuer organization this use case is now bound to — found by name, or created if it did not exist.",
            properties: { id: { type: "string" }, name: { type: "string" }, did: { type: "string" } },
          },
          useCase: { $ref: "CredentialUseCase#" },
          deskUsers: {
            type: "array",
            description:
              "Desk accounts created by THIS call — empty unless `provisioning.createDeskUsers` was set, and empty " +
              "for any role whose email already existed (the route is idempotent). The PASSWORDS are one-time " +
              "plaintext returned here and NOWHERE ELSE.",
            items: {
              type: "object", additionalProperties: true,
              properties: {
                email: { type: "string" },
                password: { type: "string", description: "A one-time credential. It is not stored in plaintext and cannot be retrieved again — only reset." },
                role: { type: "string", enum: ["Issuer", "Holder", "Verifier"] },
              },
            },
          },
        },
        required: ["org", "useCase", "deskUsers"],
      },
      201: {
        type: "object", additionalProperties: true,
        properties: {
          org: {
            type: "object", additionalProperties: true,
            description: "The issuer organization this use case is now bound to — found by name, or created if it did not exist.",
            properties: { id: { type: "string" }, name: { type: "string" }, did: { type: "string" } },
          },
          useCase: { $ref: "CredentialUseCase#" },
          deskUsers: {
            type: "array",
            description:
              "Desk accounts created by THIS call — empty unless `provisioning.createDeskUsers` was set, and empty " +
              "for any role whose email already existed (the route is idempotent). The PASSWORDS are one-time " +
              "plaintext returned here and NOWHERE ELSE.",
            items: {
              type: "object", additionalProperties: true,
              properties: {
                email: { type: "string" },
                password: { type: "string", description: "A one-time credential. It is not stored in plaintext and cannot be retrieved again — only reset." },
                role: { type: "string", enum: ["Issuer", "Holder", "Verifier"] },
              },
            },
          },
        },
        required: ["org", "useCase", "deskUsers"],
      },
      400: {
        type: "object", additionalProperties: true,
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          problems: { type: "array", items: { type: "string" }, description: "Per-parameter validation failures, when the template could not be instantiated." },
        },
      },
      ...errs(401, 403, 404, 409, 502, 503),
    },
  },

  issueAsset: {
    tags: ["Assets"], summary: "Issue (tokenize) a new asset", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Mints the asset on the configured chain and returns it with the " +
      "transaction hash. This is one of two doors onto issuance; `POST /use-cases/{key}/invoices/tokenize` is the " +
      "other, and carries the same scope on purpose.",
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
    tags: ["Assets"], summary: "List assets (filter + paginate)", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Filtered and paginated. Results are already narrowed to the caller's " +
      "use-case scope — a key never sees more than the service user it is bound to.",
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
    tags: ["Assets"], summary: "Get an asset (with on-chain total supply)", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Includes total supply read live from the ledger, not from the platform's " +
      "copy.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "Asset#" }, ...errs(401, 404) },
  },
  assetAccounts: {
    tags: ["Assets"], summary: "Holders: per-account balance + compliance state", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Per-holder balances and compliance state. Holder data is exactly why reads " +
      "are scoped here at all.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "AccountState#" } }, ...errs(401, 404) },
  },
  assetTokens: {
    tags: ["Assets"], summary: "NFT tokens for a non-fungible asset", security: eitherCredential,
    description: "Requires the `assets:read` scope. The individual tokens of a non-fungible asset.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "TokenInfo#" } }, ...errs(401, 404) },
  },
  assetAudit: {
    tags: ["Assets"], summary: "Paginated audit trail for an asset", security: eitherCredential,
    description: "Requires the `assets:read` scope. The asset's append-only audit trail, paginated.",
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
    tags: ["Lifecycle"], summary: "Perform a lifecycle action on an asset", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope. Which action is actually permitted is decided by the use case's " +
      "compliance rules and the caller's role — the scope bounds a key, it never grants an action.",
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
    tags: ["Analytics"], summary: "Scope-aware dashboard summary (assets + audit + chains)", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Aggregates over exactly the assets the caller may already read, so it " +
      "discloses nothing a direct read would refuse. SANDBOX USE CASES ARE EXCLUDED BY DEFAULT — a test asset " +
      "inside a headline supply or tokenized-value total is a reporting defect — so pass `includeSandbox=true` to " +
      "see them. An API key never mixes the two: it aggregates its own environment and only its own, whatever " +
      "`includeSandbox` says.",
    querystring: {
      type: "object",
      properties: {
        useCaseKey: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90, default: 30 },
        includeSandbox: {
          type: "boolean", default: false,
          description: "Include sandbox use cases in the aggregate. Ignored for an API key, whose environment is fixed by its own mode.",
        },
      },
    },
    response: { 200: { $ref: "Analytics#" }, ...errs(401) },
  },

  buy: {
    tags: ["Marketplace"], summary: "Buyer-initiated DvP purchase", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope. Buyer-initiated delivery-versus-payment purchase; cash and tokens move " +
      "together or not at all.",
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
    tags: ["Marketplace"], summary: "List tokens for sale (moves them into escrow)", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope. The listed tokens move into escrow immediately, which is why this is a " +
      "transfer scope and not a read one: a listing is a movement, not an advertisement.",
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
    tags: ["Marketplace"], summary: "Open sell listings for an asset (price asc)", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Open sell listings, cheapest first. Reading the book needs no trading " +
      "scope; taking a listing does.",
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
    tags: ["Marketplace"], summary: "Take (buy from) a listing — escrowed DvP with fee split", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope. Escrowed delivery-versus-payment against an open listing, with the " +
      "configured fee split applied.",
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
    tags: ["Marketplace"], summary: "Cancel a listing (returns remaining tokens to the seller)", security: eitherCredential,
    description: "Requires the `assets:transfer` scope. Returns the remaining escrowed tokens to the seller.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 204: { type: "null" }, ...errs(400, 401, 403, 404, 503) },
  },
  assetTrades: {
    tags: ["Marketplace"], summary: "Recent trades for an asset (from the audit stream, newest first)", security: eitherCredential,
    description: "Requires the `assets:read` scope. Recent trades for an asset, derived from the audit stream, newest first.",
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
    tags: ["Cashflows"], summary: "An asset's cashflow schedule with derived status + next-payout preview", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. The schedule with status derived at read time: `due` and `overdue` are " +
      "computed from the due date, never stored.",
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
    tags: ["Cashflows"], summary: "Execute a cashflow — pro-rata cash payout; redemption burns balances + matures the asset", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope. Pays the scheduled cashflow pro rata to holders; a redemption " +
      "additionally burns balances and matures the asset.",
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
    tags: ["Proposals"], summary: "List maker-checker proposals (use-case scoped)", security: humanOnly,
    description:
      "Documented as session-only because a key's view is narrowed at runtime rather than by a scope: a key " +
      "principal sees only the proposals it could itself decide, and payloads are redacted for every caller. " +
      "This LIST is the only read route for proposals — there is no fetch-one — so to follow up a 202, list and " +
      "match on the `proposal.id` it returned. The listing is narrowed to your use case and organization, so an " +
      "empty `?status=pending` result means that proposal is no longer pending, not that it never existed.",
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string" }, useCaseKey: { type: "string" } },
    },
    response: { 200: { type: "array", items: { $ref: "Proposal#" } }, ...errs(401) },
  },
  decideProposal: {
    tags: ["Proposals"], summary: "Approve or reject a proposal (segregation of duties: never the proposer)", security: humanOnly,
    description:
      "Carries no static scope because the scope required is derived from the PROPOSAL'S KIND at decision time: a " +
      "key may decide only the kinds its own scopes already let it propose. Rejecting is gated exactly as approving " +
      "is — declining is a decision too.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: {
      200: { type: "object", additionalProperties: true, properties: { proposal: { $ref: "Proposal#" } }, required: ["proposal"] },
      ...errs(401, 403, 404, 409),
    },
  },

  verifyAssetAudit: {
    tags: ["Audit"], summary: "Verify an asset's audit hash chain + on-ledger anchor", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Recomputes the asset's audit hash chain and compares it against the anchor " +
      "written on-ledger.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  verifyAuditSummary: {
    tags: ["Audit"], summary: "Platform audit-integrity roll-up (per-asset chain + anchor)", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. The same integrity check as the per-asset one, rolled up across the " +
      "platform.",
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) },
  },
  anchorAudit: {
    tags: ["Audit"], summary: "Anchor each in-scope asset's audit chain head on-ledger", security: humanOnly,
    description:
      "Unscoped deliberately: it writes an integrity anchor on-chain and confers no authority over anything. It is " +
      "bounded by the caller's role and by the per-key rate limit.",
    body: { type: "object", additionalProperties: false, properties: {} },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
  },

  mePortfolio: {
    tags: ["Investor"], summary: "The caller's holdings, cash, and totals", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. The holdings, cash, and totals of the principal the credential belongs to " +
      "— for a key, that is its bound service user, not the whole organization.",
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401) },
  },
  meActivity: {
    tags: ["Investor"], summary: "The caller's personal activity feed", security: eitherCredential,
    description: "Requires the `assets:read` scope. The bound principal's own activity feed.",
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(400, 401) },
  },

  creditCash: {
    tags: ["Cash"], summary: "Fund an account with CBDC / cash (Issuer / admin only)", security: eitherCredential,
    description:
      "Requires the `assets:transfer` scope **and** an Issuer or admin role. The scope only narrows what a key may " +
      "do; it never confers the role, so a key bound to a Trader cannot fund accounts however it is scoped.",
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
    tags: ["Cash"], summary: "Query CBDC / cash balances for an address", security: eitherCredential,
    description: "Requires the `assets:read` scope. CBDC / cash balances for one address.",
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
    tags: ["Organizations"], summary: "Create an organization + parent DID (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Creates an organization and its parent DID. Note the asymmetry: a " +
      "key may create a tenant, but may never widen the capability envelope that bounds its own — `PATCH " +
      "/orgs/{id}/capabilities` refuses machine principals outright.",
    body: {
      type: "object", additionalProperties: false, required: ["name", "orgType"],
      properties: {
        name: { type: "string", minLength: 1 },
        orgType: { type: "string", enum: ["bank", "corporate", "msme", "government", "verifier"] },
        registrationId: { type: "string" },
        jurisdiction: { type: "string" },
      },
    },
    // Deliberately a NARROWER projection than `Organization`: no companyProfile,
    // no capabilities (a platform-created org starts legacy/unrestricted), no
    // createdAt. Read the full record back from GET /orgs/{id}.
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          did: { type: "string", description: "The organization's parent DID, registered on-chain before this returns." },
          orgType: { type: "string" },
          registrationId: { type: "string", nullable: true },
          jurisdiction: { type: "string", nullable: true },
          verified: { type: "boolean" },
          status: { type: "string", enum: ["pending", "active", "rejected"] },
        },
        required: ["id", "name", "did", "orgType", "verified", "status"],
      },
      ...errs(400, 401, 403, 409, 502, 503),
    },
  },
  registerOrg: {
    tags: ["Organizations"], summary: "Public corporate self-registration (pending platform approval)",
    description:
      "Public — no credential. Creates the organization in `pending` and its admin user INACTIVE, then waits for a " +
      "Platform Admin to approve or reject it.\n\n" +
      "**This 202 is NOT a maker-checker proposal** — unlike almost every other 202 in this API, no `proposal` is " +
      "created and there is nothing to poll under `/proposals`. The organization row exists immediately; what is " +
      "pending is its ADMISSION. Nobody can log in until approval, which is also when the DID is anchored on-chain " +
      "and the platform-signed `OrganizationCredential` is issued.",
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
    response: {
      202: {
        type: "object", additionalProperties: true,
        properties: {
          organizationId: { type: "string", description: "The pending organization's id. Quote it when chasing the review — it is NOT a proposal id." },
          status: { type: "string", enum: ["pending"], description: "Always `pending` here; approval is a separate platform act." },
        },
        required: ["organizationId", "status"],
      },
      ...errs(400, 409, 429),
    },
  },
  listOrgs: { tags: ["Organizations"], summary: "List organizations in scope", security: eitherCredential,
    description: "Requires the `org:read` scope. Organizations within the caller's existing scope.",
    querystring: { type: "object", properties: { status: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "Organization#" } }, ...errs(401, 403) } },
  approveOrg: {
    tags: ["Organizations"], summary: "Approve a pending org (registers its DID on-chain, activates the admin)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`**: admitting a tenant is platform " +
      "governance, not integration.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    // The ISSUANCE CEREMONY's receipt, not an Organization: approval anchors the
    // org DID on-chain, activates its admin, and has the platform issuer sign an
    // OrganizationCredential — `issuerDid`/`orgCredentialId` are that credential.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          did: { type: "string" },
          orgType: { type: "string" },
          status: { type: "string", enum: ["active"] },
          verified: { type: "boolean" },
          issuerDid: { type: "string", nullable: true, description: "The platform issuer org's DID. null when the org had no admin user to activate." },
          orgCredentialId: { type: "string", nullable: true, description: "The OrganizationCredential minted by the ceremony. null when the org had no admin user." },
        },
        required: ["id", "name", "did", "orgType", "status", "verified"],
      },
      ...errs(401, 403, 404, 409, 502),
    },
  },
  rejectOrg: {
    tags: ["Organizations"], summary: "Reject a pending org", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`**: admitting a tenant is platform " +
      "governance, not integration.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    // Two fields only. The rejection `reason` goes to the audit log, not back here.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { id: { type: "string" }, status: { type: "string", enum: ["rejected"] } },
        required: ["id", "status"],
      },
      ...errs(401, 403, 404, 409),
    },
  },
  getOrg: {
    tags: ["Organizations"], summary: "Get an organization by id", security: eitherCredential,
    description: "Requires the `org:read` scope. The projection never includes the organization's encrypted DID seed.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "Organization#" }, ...errs(401, 403, 404) },
  },
  patchOrgCapabilities: {
    tags: ["Organizations"], summary: "Set (or clear with null) an org's capability envelope (PlatformAdmin)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`** — a key may never raise the capability " +
      "envelope that bounds it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["capabilities"],
      // Loose object-or-null: the route runs validateOrgCapabilities for the real validation.
      properties: { capabilities: { type: ["object", "null"], additionalProperties: true } },
    },
    // The updated org. `credentials` is absent here — this route returns the bare
    // record, not the read routes' held-credentials view.
    response: { 200: { $ref: "Organization#" }, ...errs(400, 401, 403, 404) },
  },
  requestOrgCapabilities: {
    tags: ["Organizations"], summary: "Request a capability-envelope change (OrgAdmin; PlatformAdmin approval applies it)", security: humanOnly,
    description:
      "Drafts a capability change only. It applies through an approval that no API key may give, so a key can ask " +
      "for a wider envelope but can never grant itself one.\n\n" +
      "**202 means nothing has changed yet.** The response carries a maker-checker `proposal`; the envelope is " +
      "still whatever it was until a Platform Admin approves that proposal. `proposal.id` is the request's id, not " +
      "the organization's.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["capabilities"],
      properties: { capabilities: { type: "object", additionalProperties: true } },
    },
    response: { 202: { $ref: "ProposalEnvelope#" }, ...errs(400, 401, 403, 404) },
  },
  createMember: {
    tags: ["Organizations"], summary: "Add a member (sub-DID + membership VC)", security: eitherCredential,
    description:
      "Requires the `users:onboard` scope. Adds a member with their own sub-DID and a membership credential issued " +
      "by the organization.",
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
    // NOT a full user record: no `active`, no `kycStatus`, no `accountId`.
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          role: { type: "string" },
          useCaseKey: { type: "string", nullable: true },
          orgId: { type: "string" },
          did: { type: "string", description: "The member's own sub-DID, minted here. If minting fails the user is rolled back, so a 201 always means both exist." },
          membershipVc: { type: "boolean", description: "Always `true` — a constant confirming the org-signed membership credential was issued alongside the DID." },
        },
        required: ["id", "email", "role", "orgId", "did", "membershipVc"],
      },
      ...errs(400, 401, 403, 404),
    },
  },
  listMembers: {
    tags: ["Organizations"], summary: "List an organization's members", security: eitherCredential,
    description: "Requires the `org:read` scope. The organization's members and their roles.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    // Includes SERVICE members — the principals API keys authenticate as. They
    // are ordinary rows here; what marks one is that it backs a key in
    // GET /orgs/{id}/api-keys, and that it cannot log in interactively.
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            useCaseKey: { type: "string", nullable: true },
            did: { type: "string", nullable: true },
            active: { type: "boolean" },
            kycStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
          },
          required: ["id", "email", "role", "active", "kycStatus"],
        },
      },
      ...errs(401, 403, 404),
    },
  },

  // --- API keys (EN-B). Loose response objects throughout: the key view carries
  // nested/nullable fields a typed schema would silently strip, and the SECRET
  // must survive serialization on create/rotate — it exists nowhere else.
  createApiKey: {
    tags: ["API Keys"], summary: "Mint an org API key (secret returned once, never again)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`** — minting a key is the one path by " +
      "which a machine principal could widen itself, so only a human session may take it.\n\n" +
      "`mode` picks the ENVIRONMENT the key acts in and defaults to `live`, so a caller that has never heard of the " +
      "field mints exactly what it always did. A `test` key is returned as a `tl_test_…` secret and may act only on " +
      "sandbox use cases. If `useCaseKey` is given, the two must agree: binding a `test` key to a live use case (or " +
      "the reverse) is refused with **403 `WRONG_MODE`**, because such a key would be refused at every call it " +
      "could ever make.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["name", "role", "scopes"],
      properties: {
        name: { type: "string", minLength: 1 },
        // ENUMERATED rather than a free string. The body is
        // `additionalProperties: false`, which STRIPS an unknown field instead
        // of refusing it — so before this existed a `mode` sent by an
        // integrator was dropped and answered with a `tl_live_` secret. The
        // enum is what makes `"sandbox"` (the word the console and the errors
        // use for the environment) a 400 rather than a silent production
        // credential.
        mode: {
          type: "string", enum: ["live", "test"],
          description: "Environment for this key. Omitted = `live`. A `test` key mints a `tl_test_…` secret that acts only on sandbox use cases.",
        },
        // Same enum as createMember: an out-of-rank role is a 403 from
        // canCreateOrgMember (authorization), not a 400 (validation).
        role: { type: "string", enum: ["PlatformAdmin", "OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"] },
        useCaseKey: { type: "string" },
        // Loose: the route runs core's validateScopes for the real validation
        // (400 INVALID_SCOPES), so the vocabulary lives in exactly one place.
        scopes: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string" },
      },
    },
    response: {
      // THE ONLY TIME THE SECRET EXISTS IN A RESPONSE. It is bcrypt-hashed at
      // rest, so it cannot be re-derived; a caller that drops it must rotate.
      201: {
        type: "object", additionalProperties: true,
        properties: {
          key: { $ref: "ApiKeyView#" },
          secret: { type: "string", description: "The full credential — `tl_live_…`, or `tl_test_…` when `mode` is `test` — returned HERE AND NOWHERE ELSE. Store it before acknowledging this call." },
        },
        required: ["key", "secret"],
      },
      ...errs(400, 401, 403, 404),
    },
  },
  listApiKeys: {
    tags: ["API Keys"], summary: "List an organization's API keys (never the secret)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`**: a key may not enumerate the " +
      "organization's keys.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { $ref: "ApiKeyView#" } }, ...errs(401, 403, 404) },
  },
  rotateApiKey: {
    tags: ["API Keys"], summary: "Rotate an API key's secret (the old one dies immediately)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`** — key lifecycle is a human act. " +
      "Rotation PRESERVES the key's environment: a `test` key rotates to another `tl_test_…` secret, and there is " +
      "no way to move a key between environments.",
    params: { type: "object", required: ["id", "keyId"], properties: { id: { type: "string" }, keyId: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          key: { $ref: "ApiKeyView#" },
          secret: { type: "string", description: "The NEW credential, carrying the SAME marker the key already had. The previous one stops authenticating the moment this returns — there is no overlap window." },
        },
        required: ["key", "secret"],
      },
      ...errs(400, 401, 403, 404, 409),
    },
  },
  revokeApiKey: {
    tags: ["API Keys"], summary: "Revoke an API key (soft — the row stays as the audit trail)", security: humanOnly,
    description: "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`** — key lifecycle is a human act.",
    params: { type: "object", required: ["id", "keyId"], properties: { id: { type: "string" }, keyId: { type: "string" } } },
    // Idempotent: revoking an already-revoked key answers 200 with the same view.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { key: { $ref: "ApiKeyView#" } },
        required: ["key"],
      },
      ...errs(401, 403, 404),
    },
  },

  // ── EN-C: webhooks + the event cursor ───────────────────────────────────
  // Every 2xx here is `additionalProperties: true` ON PURPOSE. fast-json-stringify
  // SILENTLY STRIPS undeclared fields, and a projection that quietly loses
  // `status` or `disabledReason` would look like a working endpoint list while
  // hiding the one column an integrator debugs with. The response shape is
  // pinned by webhooks-routes.test.ts, which is where it belongs — a serializer
  // is not an authorization boundary, and `webhookView` (not this schema) is
  // what keeps `secretEncrypted` out of a body.
  createWebhook: {
    tags: ["Webhooks"], summary: "Register a webhook endpoint (signing secret returned once, never again)", security: eitherCredential,
    description:
      "Requires the `webhooks:write` scope. The signing secret is returned in **this response only** and is never " +
      "retrievable afterwards — store it before you acknowledge the call, or rotate to get a new one. `mode` picks " +
      "which stream the endpoint joins and defaults to `live`; a `tl_test_` key may register only `test` endpoints " +
      "and a `tl_live_` key only `live` ones (**403 `WRONG_MODE`**), while a human session may register either.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["url", "eventTypes"],
      properties: {
        url: { type: "string", minLength: 1 },
        description: { type: "string" },
        // Loose: the route runs core's validateEventTypes for the real check
        // (400 UNKNOWN_EVENT_TYPE), so the catalog lives in exactly one place.
        eventTypes: { type: "array", items: { type: "string" } },
        useCaseKey: { type: "string" },
        // Enumerated HERE, unlike eventTypes: there is no route-level validator
        // for a mode and never will be — two values, closed, and a third one is
        // a typo that must not be taken for "live".
        mode: {
          type: "string", enum: ["live", "test"],
          description: "`live` (default) or `test`. FIXED at registration — an endpoint cannot be moved between streams afterwards.",
        },
      },
    },
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: {
          endpoint: { $ref: "WebhookEndpoint#" },
          secret: { type: "string", description: "The HMAC signing secret, returned HERE AND NOWHERE ELSE. Every delivery to this endpoint is signed with it; verify `Tokenlayer-Signature` against it." },
        },
        required: ["endpoint", "secret"],
      },
      ...errs(400, 401, 403, 404),
    },
  },
  listWebhooks: {
    tags: ["Webhooks"], summary: "List an organization's webhook endpoints (never the secret)", security: eitherCredential,
    description:
      "Requires the `webhooks:read` scope. The signing secret is never returned here — it is shown once at " +
      "registration, and thereafter only a rotation produces a new one.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { endpoints: { type: "array", items: { $ref: "WebhookEndpoint#" } } },
        required: ["endpoints"],
      },
      ...errs(401, 403, 404),
    },
  },
  updateWebhook: {
    tags: ["Webhooks"], summary: "Update a webhook endpoint (re-enabling clears its failure bookkeeping)", security: eitherCredential,
    description:
      "Requires the `webhooks:write` scope. Re-enabling an endpoint clears its failure bookkeeping, so a previously " +
      "auto-disabled endpoint starts again with a clean count. Send `null` to CLEAR the description or the use-case " +
      "filter.",
    params: { type: "object", required: ["id", "whId"], properties: { id: { type: "string" }, whId: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 1 },
        // Explicitly nullable: `null` CLEARS the description / use-case filter.
        // Without nullable, fastify would 400 the one request that narrows an
        // endpoint back to "no filter".
        description: { type: "string", nullable: true },
        eventTypes: { type: "array", items: { type: "string" } },
        useCaseKey: { type: "string", nullable: true },
        status: { type: "string", enum: ["active", "disabled"] },
      },
    },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { endpoint: { $ref: "WebhookEndpoint#" } },
        required: ["endpoint"],
      },
      ...errs(400, 401, 403, 404),
    },
  },
  rotateWebhookSecret: {
    tags: ["Webhooks"], summary: "Rotate a webhook signing secret (the old one stops verifying immediately)", security: eitherCredential,
    description:
      "Requires the `webhooks:write` scope. The new secret is returned once. The old one stops verifying " +
      "immediately, so cut the receiver over deliberately rather than expecting an overlap window.",
    params: { type: "object", required: ["id", "whId"], properties: { id: { type: "string" }, whId: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          endpoint: { $ref: "WebhookEndpoint#" },
          secret: { type: "string", description: "The NEW signing secret. The old one verifies nothing from this moment on." },
        },
        required: ["endpoint", "secret"],
      },
      ...errs(401, 403, 404),
    },
  },
  deleteWebhook: {
    tags: ["Webhooks"], summary: "Delete a webhook endpoint (soft — deliveries stop immediately)", security: eitherCredential,
    description: "Requires the `webhooks:write` scope. A soft delete: deliveries stop immediately.",
    params: { type: "object", required: ["id", "whId"], properties: { id: { type: "string" }, whId: { type: "string" } } },
    // The soft-deleted row comes back, so `deletedAt`/`status` confirm the delete.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { endpoint: { $ref: "WebhookEndpoint#" } },
        required: ["endpoint"],
      },
      ...errs(401, 403, 404),
    },
  },
  testWebhook: {
    tags: ["Webhooks"], summary: "Send a synthetic ping to one endpoint", security: eitherCredential,
    description:
      "Requires the `webhooks:write` scope. Answers **202** as soon as the ping is queued, before it is delivered — " +
      "read the endpoint's deliveries to see how it went.\n\n" +
      "**This 202 is NOT a maker-checker proposal.** Almost every other 202 in this API carries a `proposal` and " +
      "means \"nothing has happened yet, pending approval\"; this one carries a `delivery` and means the ping is " +
      "queued and will be sent by the dispatcher with no approval involved. The `ping` type is deliberately absent " +
      "from the subscribable event catalog — it is a fact about this API call, not about your business — so a " +
      "delivery is enqueued for THIS endpoint alone, whatever it is subscribed to.",
    params: { type: "object", required: ["id", "whId"], properties: { id: { type: "string" }, whId: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: {} },
    response: {
      202: {
        type: "object", additionalProperties: true,
        properties: {
          delivery: { $ref: "WebhookDelivery#" },
          event: {
            type: "object", additionalProperties: true,
            description: "The outbox row the ping was written as — an abridged Event (no `data`, `orgId` or `useCaseKey`). The full row is readable from `GET /events`.",
            properties: {
              id: { type: "string" },
              seq: { type: "integer" },
              type: { type: "string", description: "Always `ping`." },
              occurredAt: { type: "string" },
            },
          },
        },
        required: ["delivery", "event"],
      },
      ...errs(401, 403, 404, 409),
    },
  },
  listWebhookDeliveries: {
    tags: ["Webhooks"], summary: "Recent delivery attempts for one endpoint", security: eitherCredential,
    description: "Requires the `webhooks:read` scope. The recent delivery attempts for one endpoint, with their outcomes.",
    params: { type: "object", required: ["id", "whId"], properties: { id: { type: "string" }, whId: { type: "string" } } },
    querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { deliveries: { type: "array", items: { $ref: "WebhookDelivery#" } } },
        required: ["deliveries"],
      },
      ...errs(401, 403, 404),
    },
  },
  replayWebhookDelivery: {
    tags: ["Webhooks"], summary: "Requeue one delivery for another attempt", security: eitherCredential,
    description:
      "Requires the `webhooks:write` scope. Replay is a write, not a read, because it causes a newly signed request " +
      "to leave the platform.",
    params: {
      type: "object", required: ["id", "whId", "dId"],
      properties: { id: { type: "string" }, whId: { type: "string" }, dId: { type: "string" } },
    },
    body: { type: "object", additionalProperties: false, properties: {} },
    // The requeued row: `status` is back to `pending` and `attempts` to 0, so a
    // replay gets the FULL retry schedule rather than dying on its next attempt.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: { delivery: { $ref: "WebhookDelivery#" } },
        required: ["delivery"],
      },
      ...errs(401, 403, 404),
    },
  },
  listEvents: {
    tags: ["Webhooks"], summary: "Cursor read of the durable event log (the catch-up path for a missed delivery)", security: eitherCredential,
    description:
      "Requires the `webhooks:read` scope. A cursor read of the durable event log — the catch-up path for a " +
      "delivery you missed, and the reason an integration can stay correct without receiving every webhook.",
    querystring: {
      type: "object", additionalProperties: false,
      properties: { after: { type: "string" }, type: { type: "string" }, limit: { type: "string" } },
    },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          events: { type: "array", items: { $ref: "Event#" } },
          nextAfter: {
            type: "integer",
            description:
              "Pass as `after` on the next call. An EMPTY page returns your own cursor back unchanged, so polling a " +
              "quiet log is idempotent and the loop `after = nextAfter` never re-reads and never skips.",
          },
        },
        required: ["events", "nextAfter"],
      },
      ...errs(401),
    },
  },

  myCredentials: { tags: ["Identity"], summary: "Credentials held by the caller", security: eitherCredential,
    description: "Requires the `credentials:read` scope. The credentials held by the principal the credential belongs to.",
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  identityDashboard: {
    tags: ["Identity"], summary: "Scoped identity operations dashboard (credential lifecycle + verification aggregates)", security: eitherCredential,
    description:
      "Requires the `credentials:read` scope. Aggregates the credential lifecycle and verification activity already " +
      "inside the caller's scope. Sandbox programmes are excluded by default, exactly as in `GET /analytics`; pass " +
      "`includeSandbox=true` for them.",
    querystring: {
      type: "object",
      properties: {
        includeSandbox: {
          type: "boolean", default: false,
          description: "Include sandbox credential use cases. Ignored for an API key, whose environment is fixed by its own mode.",
        },
      },
    },
    // Loose 200: the nested fold output would be silently stripped by
    // fast-json-stringify under a typed schema (the standing lesson).
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
  },
  // The three holder-acceptance routes each answer with a MINIMAL acknowledgement
  // — id plus the fields that just changed — never the whole credential.
  acceptCredential: {
    tags: ["Credentials"], summary: "Holder accepts a pending credential", security: humanOnly,
    description: "Session-only, and only the holder of the credential may call it. Valid from `pending` or `changes_requested`; anything else is a **409**.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          acceptance: { type: "string", enum: ["accepted"] },
          acceptanceAt: { type: "string", nullable: true },
        },
        required: ["id", "acceptance"],
      },
      ...errs(401, 404, 409),
    },
  },
  rejectHeldCredential: {
    tags: ["Credentials"], summary: "Holder rejects a pending credential (revokes it)", security: humanOnly,
    description:
      "Session-only, holder of the credential only. **Rejection REVOKES the credential** — it is not merely a " +
      "status flag, so this is irreversible and the issuer must re-issue rather than re-offer.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          acceptance: { type: "string", enum: ["rejected"] },
          revoked: { type: "boolean", description: "Always `true` — rejecting a held credential revokes it." },
        },
        required: ["id", "acceptance", "revoked"],
      },
      ...errs(401, 404, 409),
    },
  },
  requestCredentialChanges: {
    tags: ["Credentials"], summary: "Holder requests changes on a pending credential", security: humanOnly,
    description: "Session-only, holder of the credential only. Valid from `pending` ALONE — a credential already in `changes_requested` answers **409**.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", minLength: 1 } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          acceptance: { type: "string", enum: ["changes_requested"] },
          acceptanceNote: { type: "string", nullable: true, description: "The note you sent, echoed back — this is what the issuer reads." },
        },
        required: ["id", "acceptance"],
      },
      ...errs(400, 401, 404, 409),
    },
  },
  didDocument: {
    tags: ["Identity"], summary: "Resolve a did:key into a W3C DID document", security: humanOnly,
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401) },
  },
  didResolve: {
    tags: ["Identity"], summary: "Public: resolve a DID (W3C DID Resolution Result; did:key + on-chain registration)",
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true } },
  },

  credentialTypes: { tags: ["Credentials"], summary: "The credential-type catalog", security: humanOnly,
    description:
      "The PLATFORM-BUILT-IN credential types, the vocabulary `POST /credentials/requests` accepts. It is not the " +
      "list of types a credential USE CASE defines — those come from the use case itself.",
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            type: { type: "string", description: "The type name, e.g. `KycCredential`. This is what you send as `type`." },
            description: { type: "string" },
            allowedIssuerOrgTypes: { type: "array", items: { type: "string" }, description: "An org of any other type is refused with 403 ISSUER_NOT_PERMITTED." },
            requiredApprovals: { type: "integer", description: "Maker-checker depth: how many approvals the resulting proposal needs before anything is issued." },
            validityDays: { type: "integer" },
            selfIssuedOnly: { type: "boolean", description: "When true the subject must be a member of the issuing org." },
            claimSchema: { type: "object", additionalProperties: true, description: "The schema your `claims` object is validated against (400 INVALID_METADATA on a mismatch)." },
          },
          required: ["type", "allowedIssuerOrgTypes", "requiredApprovals"],
        },
      },
      ...errs(401),
    } },
  requestCredential: {
    tags: ["Credentials"], summary: "Request a credential (gated by the type's approval depth)", security: eitherCredential,
    description:
      "Requires the `credentials:issue` scope. Returns **202 with a proposal** — nothing is issued until the " +
      "credential type's approval depth is satisfied by other authorized principals. Each approver needs this same " +
      "scope.",
    body: {
      type: "object", additionalProperties: false, required: ["type", "subjectUserId", "claims"],
      properties: {
        type: { type: "string" },
        subjectUserId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
        issuerOrgId: { type: "string" },
      },
    },
    response: { 202: { $ref: "ProposalEnvelope#" }, ...errs(400, 401, 403, 404) },
  },
  issueUsecaseCredential: {
    tags: ["Credentials"], summary: "Issue a configured credential type (gated by the type's approval depth)", security: eitherCredential,
    description:
      "Requires the `credentials:issue` scope. Returns **202 with a proposal** — the credential is not issued until " +
      "a second authorized principal approves it (see Proposals). The approver needs the same scope.",
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
    response: { 202: { $ref: "ProposalEnvelope#" }, ...errs(400, 401, 403, 404) },
  },
  issueUsecaseCredentialsBatch: {
    tags: ["Credentials"], summary: "Batch-issue a configured credential type from parsed CSV rows (one maker-checker proposal; draft-time all-or-nothing, execution-time per-row)", security: eitherCredential,
    description:
      "Requires the `credentials:issue` scope. Returns **202 with one proposal for the whole batch**. Rows are " +
      "validated all-or-nothing at draft time (a **400** carries the per-row report); after approval each row " +
      "succeeds or fails on its own.",
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
      // ONE proposal for the WHOLE batch. Its `result` field, once executed,
      // carries the per-row outcomes.
      202: { $ref: "ProposalEnvelope#" },
      // 400 is overridden (not the shared Error# ref) so `problems` — the
      // per-row draft-time validation report — survives fast-json-stringify's
      // response serialization instead of being stripped as an unlisted
      // property (the ID-G lesson).
      400: {
        type: "object", additionalProperties: true,
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          problems: {
            type: "array",
            description: "Every row that failed draft-time validation. `index` is the row's position in your request.",
            items: {
              type: "object", additionalProperties: true,
              properties: { index: { type: "integer" }, error: { type: "string" } },
            },
          },
        },
      },
      ...errs(401, 403, 404),
    },
  },
  eligibleHolders: {
    tags: ["Credentials"], summary: "Users eligible to hold a credential of this use case", security: eitherCredential,
    description:
      "Requires the `users:read` scope rather than a credential scope: what it discloses is a list of people, not " +
      "of credentials.\n\n" +
      "Despite the name it returns ORGANIZATIONS as well as users — an org can hold a credential in its entity " +
      "wallet — so read `kind` rather than assuming a person.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            kind: { type: "string", enum: ["user", "org"] },
            id: { type: "string", description: "A user id or an organization id, per `kind`. Pass it as `subjectUserId` or `subjectOrgId` when issuing." },
            label: { type: "string", description: "The user's email, or the organization's name." },
            did: { type: "string", description: "The holder DID the credential would be issued to. A candidate without one is never listed." },
            subLabel: { type: "string", nullable: true, description: "For a user: their organization's name (null if none). For an org: its orgType." },
          },
          required: ["kind", "id", "label", "did"],
        },
      },
      ...errs(401, 403, 404),
    },
  },
  revokeCredential: {
    tags: ["Credentials"], summary: "Revoke a credential (gated; reason required)", security: eitherCredential,
    description:
      "Requires the `credentials:revoke` scope — deliberately separate from `credentials:issue`, so an integration " +
      "that issues cannot also un-issue. Returns **202 with a proposal**, and a `reason` is mandatory.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    response: { 202: { $ref: "ProposalEnvelope#" }, ...errs(400, 401, 403, 404, 409) },
  },
  credentialStatus: {
    tags: ["Credentials"], summary: "Public revocation status of a credential (no auth — verifiers must resolve it)",
    description:
      "Public — no credential required, because a third-party verifier must be able to resolve revocation without a " +
      "platform account.\n\n" +
      "**Read `source` before you trust `revoked`.** `chain` means the answer came from the on-chain VC registry; " +
      "`database` means it did not — either nothing is anchored, or the chain read FAILED and this fell back to our " +
      "own record. The two are indistinguishable in `source` alone, so a verifier with a hard requirement on " +
      "on-chain proof must require `source === \"chain\"` rather than merely reading `revoked`.\n\n" +
      "`sandbox` is the third value (EN-D2): the credential was issued in a SANDBOX use case, so it was never " +
      "anchored and never will be — nothing about it exists on any chain. That is a design property, not a failure, " +
      "and it is reported separately from `database` precisely so it cannot be mistaken for one.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          revoked: { type: "boolean" },
          revokedAt: { type: "string", nullable: true },
          reason: { type: "string", nullable: true },
          // Present only when acceptance is anything other than a silent, never
          // touched "accepted" — a legacy credential predating the acceptance
          // lifecycle simply omits it.
          acceptance: { type: "string", enum: ["pending", "accepted", "rejected", "changes_requested"], description: "The holder's acceptance state. ABSENT for a credential that predates the acceptance lifecycle." },
          anchored: { type: "boolean", description: "Whether this credential was found in the on-chain registry." },
          source: { type: "string", enum: ["chain", "database", "sandbox"], description: "Where `revoked` came from. `database` also covers an on-chain read that failed. `sandbox` means the credential belongs to a sandbox use case and is unanchored by design." },
          // Declared, or fast-json-stringify strips it and the honest answer
          // above silently becomes the ambiguous one.
          sandbox: { type: "boolean", description: "Present and true only for a credential issued in a SANDBOX use case: never anchored, by design (EN-D2)." },
          chainId: { type: "string", description: "Chain-source only." },
          registry: { type: "string", description: "The VC registry contract address. Chain-source only." },
          vcHash: { type: "string", description: "The anchored hash of the credential. Chain-source only." },
          anchorTxHash: { type: "string", nullable: true, description: "Chain-source only." },
          anchorChainId: { type: "string", nullable: true, description: "Chain-source only." },
          revokeTxHash: { type: "string", nullable: true, description: "Chain-source only." },
        },
        required: ["id", "revoked", "anchored", "source"],
      },
      ...errs(404),
    },
  },
  credentialCertificate: {
    tags: ["Credentials"], summary: "Public: download a credential's PDF certificate (when its type enables one)",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { ...errs(404) },
  },
  identityRegistry: {
    tags: ["Identity"], summary: "The deployed on-chain identity registries (null when none)", security: humanOnly,
    response: { 200: { type: "object", nullable: true, additionalProperties: true }, ...errs(401) },
  },
  orgCredentials: {
    tags: ["Credentials"], summary: "Credentials issued by an organization", security: eitherCredential,
    description:
      "Requires the `credentials:read` scope. Credentials this organization has ISSUED — the ones where it is the " +
      "issuer. For what it HOLDS, see `GET /orgs/{id}/wallet`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    // No `vcJwt` here: this is the issuer's register, not a wallet.
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            id: { type: "string" },
            type: { type: "string", description: "Comma-joined when the credential carries more than one type." },
            holderDid: { type: "string" },
            claims: { type: "object", additionalProperties: true, description: "The credential subject's claims, as issued." },
            issuedAt: { type: "string" },
            expiresAt: { type: "string", nullable: true },
            revoked: { type: "boolean" },
            revokedAt: { type: "string", nullable: true },
            revokedReason: { type: "string", nullable: true },
          },
          required: ["id", "type", "holderDid", "issuedAt", "revoked"],
        },
      },
      ...errs(401, 403, 404),
    },
  },
  orgWallet: {
    tags: ["Identity"], summary: "Credentials held by an organization (entity wallet)", security: eitherCredential,
    description:
      "Requires the `credentials:read` scope. Credentials the organization itself holds — its entity wallet, as " +
      "distinct from what it has issued.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },

  createVerificationRequest: {
    tags: ["Verification"], summary: "A verifier org requests a credential presentation", security: eitherCredential,
    description:
      "Requires the `verifications:request` scope. Asks a holder to present credentials; nothing is disclosed until " +
      "that holder consents.",
    body: {
      type: "object", additionalProperties: false, required: ["holderDid", "requestedTypes", "purpose"],
      properties: {
        holderDid: { type: "string", minLength: 1 },
        requestedTypes: { type: "array", items: { type: "string" }, minItems: 1 },
        purpose: { type: "string", minLength: 1 },
        credentialUseCaseKey: { type: "string" },
      },
    },
    response: { 201: { $ref: "VerificationRequest#" }, ...errs(400, 401, 403) },
  },
  myVerificationRequests: { tags: ["Verification"], summary: "The caller's inbound verification requests", security: eitherCredential,
    description:
      "Requires the `verifications:read` scope. The requests addressed to the principal the credential belongs to.\n\n" +
      "Each row is enriched with `eligibleCredentials` — the caller's own unrevoked, accepted credentials of a " +
      "requested type — which is what you pass as `credentialIds` when consenting. A caller with no DID gets an " +
      "empty array rather than an error.",
    response: { 200: { type: "array", items: { $ref: "VerificationRequest#" } }, ...errs(401) } },
  getVerificationRequest: {
    tags: ["Verification"], summary: "One verification request (holder or verifier org)", security: eitherCredential,
    description:
      "Requires the `verifications:read` scope. Readable by the holder and by the requesting verifier organization " +
      "— but never carries the verifier's RESULT, which needs `verifications:verify`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    // 404 — never 403 — for someone else's request: no existence oracle.
    response: { 200: { $ref: "VerificationRequest#" }, ...errs(401, 404) },
  },
  consentVerificationRequest: {
    tags: ["Verification"], summary: "Holder consents, selecting credentials to disclose", security: eitherCredential,
    description:
      "Requires the `credentials:present` scope — a DISCLOSURE scope of its own, not `credentials:read` and not a " +
      "verification scope. This route decrypts the holder's custodial signing key, signs a Verifiable Presentation " +
      "as them, and releases the selected credentials' contents to the verifier; the disclosure cannot be recalled. " +
      "A key that may merely read credentials must not be able to perform it, and `verifications:*` describes the " +
      "VERIFIER's side of the exchange rather than the holder's.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["credentialIds"], properties: { credentialIds: { type: "array", items: { type: "string" }, minItems: 1 } } },
    // The request, now `consented`. The signed presentation itself is NOT
    // returned — it is held for the verifier, who reads its verdict from
    // GET /verification-requests/{id}/verify.
    response: { 200: { $ref: "VerificationRequest#" }, ...errs(400, 401, 403, 404, 409, 410) },
  },
  rejectVerificationRequest: {
    tags: ["Verification"], summary: "Holder declines a verification request", security: humanOnly,
    description: "Session-only, and only the holder named in the request may decline it. Valid from `pending` alone; anything else is a **409**.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { $ref: "VerificationRequest#" }, ...errs(401, 403, 404, 409) },
  },
  verifyVerificationRequest: {
    tags: ["Verification"], summary: "The verifier runs verification on the consented presentation", security: eitherCredential,
    description:
      "Requires the `verifications:verify` scope. Runs verification over the consented presentation and returns the " +
      "result. It is separate from `verifications:read` because the result is a stronger disclosure than the " +
      "request.\n\n" +
      "**A failed verification is a 200, not an error.** `valid: false` is the answer to a well-formed question; " +
      "only a request that is not yet consented is a 409. Read `valid`, never the status code.\n\n" +
      "`valid` is stricter than the credentials it lists: it is true only if the presentation itself verifies AND " +
      "every one of the request's `requestedTypes` is covered by a credential that is itself valid. So a " +
      "presentation of three good credentials that misses one requested type is `valid: false` with no invalid " +
      "credential in the array.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          valid: { type: "boolean", description: "The overall verdict: the presentation verified AND every requested type is covered by a valid credential." },
          holderDid: { type: "string", nullable: true },
          reason: { type: "string", nullable: true, description: "Why the PRESENTATION failed, when it did. Per-credential reasons live on each entry." },
          purpose: { type: "string", description: "Echoed from the request, so the verdict is self-describing in a log." },
          verifiedAt: { type: "string" },
          credentials: {
            type: "array",
            description: "One entry per credential in the presentation, in presentation order.",
            items: {
              type: "object", additionalProperties: true,
              properties: {
                id: { type: "string", nullable: true, description: "The credential's id (its JWT `jti`). null when the presented JWT could not be decoded." },
                type: { type: "string", nullable: true, description: "From OUR record. null for a credential this platform did not issue." },
                issuer: { type: "string", nullable: true, description: "The issuer DID." },
                claims: { type: "object", additionalProperties: true, nullable: true, description: "The disclosed subject claims — the actual payload the holder consented to share." },
                reason: { type: "string", nullable: true, description: "e.g. BAD_ISSUER_SIGNATURE, UNTRUSTED_ISSUER, CREDENTIAL_EXPIRED, SUBJECT_MISMATCH." },
                valid: { type: "boolean" },
                checks: {
                  type: "object", additionalProperties: true,
                  description: "The individual verdicts behind `valid`. Note `notRevoked` is a BOOLEAN here: an unknown revocation state reads as false, so this credential fails closed.",
                  properties: {
                    signature: { type: "boolean" },
                    trusted: { type: "boolean" },
                    notExpired: { type: "boolean" },
                    subjectBound: { type: "boolean" },
                    notRevoked: { type: "boolean" },
                  },
                },
                issuerResolution: {
                  type: "object", additionalProperties: true, nullable: true,
                  description: "On-chain issuer trust, when the issuer DID resolved from a chain. null when it did not — including when there is no registry configured at all.",
                  properties: {
                    registered: { type: "boolean" },
                    active: { type: "boolean" },
                    chainId: { type: "string" },
                  },
                },
                anchorTxHash: { type: "string", nullable: true },
                anchorChainId: { type: "string", nullable: true },
                revokeTxHash: { type: "string", nullable: true },
              },
            },
          },
        },
        required: ["valid", "purpose", "credentials", "verifiedAt"],
      },
      ...errs(401, 403, 404, 409),
    },
  },

  listUsers: { tags: ["Users"], summary: "List users in scope", security: eitherCredential,
    description:
      "Requires the `users:read` scope. Users within the caller's existing scope — the scope narrows that set, it " +
      "never widens it.",
    response: {
      200: {
        type: "array",
        items: {
          type: "object", additionalProperties: true,
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            useCaseKey: { type: "string", nullable: true },
            accountId: { type: "string", nullable: true, description: "The linked settlement account, when the user has a wallet address." },
            active: { type: "boolean" },
            kycStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
            kyc: { type: "object", additionalProperties: true, nullable: true, description: "The captured KYC detail (legalName, country, id type/number, documentRef). PERSONAL DATA — `users:read` is what gates it." },
          },
          required: ["id", "email", "role", "active", "kycStatus"],
        },
      },
      ...errs(401, 403),
    } },
  createUser: {
    tags: ["Users"], summary: "Create a user (scoped)", security: eitherCredential,
    description:
      "Requires the `users:onboard` scope. Returns **201** when onboarding is direct, or **202 with a proposal** " +
      "where the organization runs maker-checker — in which case no account exists until a second authorized " +
      "principal approves it. The approver needs this same scope.\n\n" +
      "**Which one you get is decided by the CALLER, not by the body.** A caller who belongs to an organization " +
      "onboards directly (201, with the member's DID minted inline); an org-less caller — a Platform Admin, a " +
      "use-case-scoped desk operator — always drafts a proposal (202). Branch on the STATUS CODE, never on the " +
      "presence of a field.",
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
    response: {
      // 201: the user EXISTS. Note there is no `active` here and no `kyc` echo —
      // a directly onboarded member is created active with kycStatus "pending".
      201: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          role: { type: "string" },
          useCaseKey: { type: "string", nullable: true },
          accountId: { type: "string", nullable: true },
          kycStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
          orgId: { type: "string", nullable: true },
          did: { type: "string", nullable: true, description: "The member's sub-DID, minted inline. null when the caller's org could not be resolved." },
        },
        required: ["id", "email", "role", "kycStatus"],
      },
      // 202: the user DOES NOT EXIST YET.
      202: { $ref: "ProposalEnvelope#" },
      ...errs(400, 401, 403, 404),
    },
  },
  createUsersBatch: {
    tags: ["Users"], summary: "Batch-onboard users from parsed CSV rows (one maker-checker proposal; draft-time all-or-nothing, execution-time per-row)", security: eitherCredential,
    description:
      "Requires the `users:onboard` scope. Returns **202 with a single proposal covering every row**. Validation is " +
      "all-or-nothing at draft time — one bad row fails the whole request and the **400** carries the per-row " +
      "report — while execution after approval is per-row.",
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
      // ONE proposal for the WHOLE batch — not one per row. Approving it onboards
      // every row; rejecting it onboards none.
      202: { $ref: "ProposalEnvelope#" },
      // 400 is overridden (not the shared Error# ref) so `problems` — the
      // per-row draft-time validation report — survives fast-json-stringify's
      // response serialization instead of being stripped as an unlisted
      // property (the ID-G lesson).
      400: {
        type: "object", additionalProperties: true,
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          problems: {
            type: "array",
            description: "Every row that failed draft-time validation. `index` is the row's position in your request.",
            items: {
              type: "object", additionalProperties: true,
              properties: { index: { type: "integer" }, error: { type: "string" } },
            },
          },
        },
      },
      ...errs(401, 403),
    },
  },
  revokeUserIdentity: {
    tags: ["Users"], summary: "Revoke a user's identity (gated; reason required)", security: eitherCredential,
    description:
      "Requires the `users:onboard` scope. Returns **202 with a proposal** — the identity stands until a second " +
      "authorized principal approves the revocation. A `reason` is mandatory and is recorded with it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    // 409 ALREADY_PENDING when a revoke proposal for this user is already open.
    response: { 202: { $ref: "ProposalEnvelope#" }, ...errs(400, 401, 403, 404, 409) },
  },
  uploadDocument: {
    tags: ["Documents"], summary: "Upload a document (base64); returns its URL + sha256", security: humanOnly,
    description:
      "Unscoped deliberately: it stores opaque bytes and confers no authority — reading a document back needs " +
      "`assets:read`, and every act that USES one is separately scoped. It is not a storage bound: there is no " +
      "per-key quota.",
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
    tags: ["Documents"], summary: "Fetch a document's bytes by id", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Uploading a document is deliberately unscoped — the bytes are opaque and " +
      "confer nothing — but reading one back is not.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { ...errs(401, 404) },
  },
  deleteUser: { tags: ["Users"], summary: "Remove a user (scoped)", security: eitherCredential,
    description:
      "Requires the `users:onboard` scope: removing a principal is the same authority as creating one, so it is not " +
      "separately scoped.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 403, 404) } },
  updateUser: {
    tags: ["Users"], summary: "Edit a user (reset password / suspend) — scoped", security: eitherCredential,
    description: "Requires the `users:onboard` scope. Resets a password or suspends an account.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      properties: { password: { type: "string", minLength: 6 }, active: { type: "boolean" }, kycStatus: { type: "string", enum: ["approved", "rejected"] } },
    },
    // The updated user — the same projection as GET /users MINUS `kyc`.
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          role: { type: "string" },
          useCaseKey: { type: "string", nullable: true },
          accountId: { type: "string", nullable: true },
          active: { type: "boolean" },
          kycStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
        },
        required: ["id", "email", "role", "active", "kycStatus"],
      },
      ...errs(400, 401, 403, 404),
    },
  },

  identityChallenge: {
    tags: ["Identity"], summary: "Issue a verification challenge for a user", security: eitherCredential,
    description: "Requires the `users:onboard` scope. Issues the nonce the user's wallet must sign.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404) },
  },
  identityVerify: {
    tags: ["Identity"], summary: "Verify a DID/VC presentation and set KYC", security: eitherCredential,
    description: "Requires the `users:onboard` scope. Verifies the signed presentation and sets the user's KYC state.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", required: ["presentation"], properties: { presentation: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  identityMint: {
    tags: ["Identity"], summary: "Dev: mint a demo VP", security: humanOnly,
    description:
      "Development-only demo minter. Absent in production — it answers **404** unless `DEV_ISSUER_SEED` is " +
      "configured.",
    body: { type: "object", additionalProperties: true },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },

  importInvoices: {
    tags: ["Invoice Register"], summary: "Stage a batch of invoice rows (upload)", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Stages invoice rows in the register. Nothing is minted here — tokenizing " +
      "is a separate, explicitly selective call — but staging is the first half of issuance, so it is gated as " +
      "issuance.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["rows"],
      properties: { rows: { type: "array", items: { type: "object", additionalProperties: true } } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  pullErp: {
    tags: ["Invoice Register"], summary: "Stage invoices pulled from the bundled ERP export", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Stages invoices read from the bundled ERP export into the same register, " +
      "for the same later tokenize step.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  addInvoice: {
    tags: ["Invoice Register"], summary: "Stage a single manually-keyed invoice", security: eitherCredential,
    description: "Requires the `assets:issue` scope. Stages one manually-keyed invoice in the register.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["metadata"],
      properties: { metadata: { type: "object", additionalProperties: true }, documentId: { type: "string" } },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  listInvoices: {
    tags: ["Invoice Register"], summary: "List staged/tokenized invoices for a use case", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Staged and already-tokenized rows in a use case's invoice register. The " +
      "register is the record of REAL invoices, so a SANDBOX use case's rows are withheld unless you pass " +
      "`includeSandbox=true` — the answer is an empty list, not an error. An API key reads its own environment's " +
      "register regardless of the flag.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: {
      type: "object", additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["staged", "tokenized"] },
        includeSandbox: {
          type: "boolean", default: false,
          description: "Return a sandbox use case's staged rows. Ignored for an API key, whose environment is fixed by its own mode.",
        },
      },
    },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(400, 401, 403, 404) },
  },
  deleteInvoice: {
    tags: ["Invoice Register"], summary: "Delete a staged invoice (tokenized ones are guarded)", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Removes a staged row. Rows that have already been tokenized are refused — " +
      "once an asset exists, the asset is the record.",
    params: { type: "object", required: ["key", "id"], properties: { key: { type: "string" }, id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  tokenizeInvoices: {
    tags: ["Invoice Register"], summary: "Selectively tokenize staged invoices into assets", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Mints assets from the staged rows you name. It calls the same core as " +
      "`POST /assets`, so it carries the same scope: a second door onto issuance must not be a cheaper one.",
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
