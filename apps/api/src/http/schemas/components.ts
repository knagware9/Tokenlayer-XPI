/**
 * The reusable `$id` component schemas, and the small vocabulary every route
 * schema is written in: `errs(...)`, `humanOnly`, `eitherCredential`.
 *
 * These are SHARED BY CONSTRUCTION — a component is referenced as `$ref: "X#"`
 * from whichever product needs it, and both do. Splitting them by product would
 * mean deciding which one owns `Error#`, which is not a real question.
 */
/**
 * Registered once (see buildApp); routes reference them by `$ref`. Fastify
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
      settlement: { type: "string", enum: ["active", "pending", "failed"] },
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
      brandLogoDocumentId: { type: "string", nullable: true, description: "EN-E: an image Document id used as this organization's mark. null = unbranded." },
      brandAccent: { type: "string", nullable: true, description: "EN-E: lowercase `#rrggbb` accent colour. null = the platform palette." },
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

export { TOKEN_STANDARD, TOKEN_TYPE, errs, humanOnly, eitherCredential };
export type { SecurityRequirement };
