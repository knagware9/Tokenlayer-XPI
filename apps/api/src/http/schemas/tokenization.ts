/**
 * Schemas for the tokenization product — use cases, assets, the invoice
 * register, the secondary market, settlement and analytics.
 *
 * One file per product, mirroring http/routes/. `schemas-file-domains.test.ts`
 * fails if an entry here is referenced from another product's route file.
 */
import type { FastifySchema } from "fastify";
import { TOKEN_STANDARD, TOKEN_TYPE, errs, humanOnly, eitherCredential } from "./components.js";

export const tokenizationSchemas: Record<string, FastifySchema> = {
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
      "it is a separate call.",
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

  issueAsset: {
    tags: ["Assets"], summary: "Issue (tokenize) a new asset", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Every new asset is created `pending_approval` and answers **202** — " +
      "due-diligence review (attach a prospectus via `POST /assets/{id}/diligence/documents`, then " +
      "`POST /assets/{id}/submit-for-review`) is now mandatory before it mints supply or takes sale terms, " +
      "regardless of the use case's `workflow.approvals.issue` setting. " +
      "**This 202 is NOT a maker-checker proposal** — unlike almost every other 202 in this API, no `proposal` is " +
      "created and there is nothing to poll under `/proposals`; the asset row exists immediately with the mint and " +
      "any requested sale terms captured on it, deferred until a UseCaseAdmin decides the review via " +
      "`POST /assets/{id}/review-decision`. This is one of two doors onto issuance; " +
      "`POST /use-cases/{key}/invoices/tokenize` is the other, and carries the same scope on purpose.",
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
        initialSupply: { type: "string" },
        sale: {
          type: "object",
          additionalProperties: false,
          required: ["unitPrice", "currency"],
          properties: {
            unitPrice: { type: "string" },
            currency: { type: "string" },
          },
        },
      },
    },
    response: {
      202: {
        type: "object", additionalProperties: true,
        properties: {
          asset: { $ref: "Asset#" },
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
  uploadAssetDiligenceDocument: {
    tags: ["Assets"],
    summary: "Attach a due-diligence document to a pending asset",
    security: eitherCredential,
    description: "Requires the `assets:issue` scope. `slot` picks which part of the diligence package this fills; `label` is required (and free-text) only for `slot: \"additional\"`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["slot", "contentType", "dataBase64"],
      properties: {
        slot: { type: "string", enum: ["prospectus", "legalOpinion", "additional"] },
        label: { type: "string" },
        contentType: { type: "string" },
        dataBase64: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, sha256: { type: "string" }, size: { type: "number" } } }, ...errs(400, 401, 403, 404, 413, 415) },
  },
  getAssetDiligenceDocument: {
    tags: ["Assets"],
    summary: "Read one of an asset's due-diligence documents",
    security: eitherCredential,
    description: "Requires the `assets:read` scope. Visible to anyone scoped to the asset's use case once it is active; visible to the asset's own issuer/use-case staff even while still pending review.",
    params: { type: "object", required: ["id", "docId"], properties: { id: { type: "string" }, docId: { type: "string" } } },
    response: { ...errs(401, 403, 404) },
  },
  submitAssetForReview: {
    tags: ["Assets"],
    summary: "Mark a pending asset's diligence package ready for review",
    security: eitherCredential,
    description: "Requires the `assets:issue` scope. Requires a prospectus to already be attached; the legal opinion and any additional documents are optional. Safe to call again after a rejection.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, status: { type: "string" } } }, ...errs(400, 401, 403, 404) },
  },
  decideAssetReview: {
    tags: ["Assets"],
    summary: "Decide a pending asset's due-diligence review — UseCaseAdmin of its own use case only",
    security: humanOnly,
    description: "A direct decision, not a maker-checker proposal: the reviewing UseCaseAdmin alone decides. No API key may ever call this. Approving requires a riskTier; rejecting requires a rejectionReason. The asset's own creator may never decide it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { type: "string", enum: ["approved", "rejected"] },
        riskTier: { type: "string", enum: ["low", "medium", "high"] },
        rejectionReason: { type: "string" },
      },
    },
    response: { 200: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, status: { type: "string" } } }, ...errs(400, 401, 403, 404, 409) },
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
      "discloses nothing a direct read would refuse.",
    querystring: {
      type: "object",
      properties: {
        useCaseKey: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90, default: 30 },
      },
    },
    response: { 200: { $ref: "Analytics#" }, ...errs(401) },
  },
  reconciliation: {
    tags: ["Audit"], summary: "Compare believed register supply against on-chain supply, per asset", security: eitherCredential,
    description:
      "Requires the `assets:read` scope, further restricted to PlatformAdmin and Auditor: this rolls up every use " +
      "case, so it is a whole-platform read rather than a scoped one. Read-only by design — a mismatch can mean a " +
      "transaction still settling (`settlement-outstanding`), a chain we could not reach (`chain-unreadable`), an " +
      "asset we hold no transaction record for at all (`no-ledger-record` — typically one issued before the ledger " +
      "table existed, where believed supply is 0 only because nothing was recorded), or a genuine discrepancy " +
      "(`supply-mismatch`), and each demands a different response, none of them automatic.",
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          checked: { type: "integer" },
          drifted: {
            type: "array",
            items: {
              type: "object", additionalProperties: true,
              properties: {
                assetId: { type: "string" },
                chainId: { type: "string" },
                believedSupply: { type: ["string", "null"] },
                chainSupply: { type: ["string", "null"] },
                outstanding: { type: "integer" },
                reason: { type: "string", enum: ["settlement-outstanding", "chain-unreadable", "no-ledger-record", "supply-mismatch"] },
              },
              required: ["assetId", "chainId", "believedSupply", "chainSupply", "outstanding", "reason"],
            },
          },
        },
        required: ["checked", "drifted"],
      },
      ...errs(401, 404),
    },
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

  verifyAssetAudit: {
    tags: ["Audit"], summary: "Verify an asset's audit hash chain + on-ledger anchor", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Recomputes the asset's audit hash chain and compares it against the anchor " +
      "written on-ledger.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
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

  importInvoices: {
    tags: ["Asset Register"], summary: "Stage a batch of asset rows (upload)", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Stages metadata rows in the use case's asset register — works for any " +
      "use case, not only the canonical invoice one. Nothing is minted here — tokenizing is a separate, explicitly " +
      "selective call — but staging is the first half of issuance, so it is gated as issuance.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["rows"],
      properties: { rows: { type: "array", items: { type: "object", additionalProperties: true } } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  pullErp: {
    tags: ["Asset Register"], summary: "Stage invoices pulled from the bundled ERP export", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Stages invoices read from the bundled ERP export into the same register, " +
      "for the same later tokenize step. The ERP export is invoice-shaped, so this route is meaningful for the " +
      "invoice use case specifically — every other use case stages via `importInvoices`/`addInvoice` instead.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  addInvoice: {
    tags: ["Asset Register"], summary: "Stage a single manually-keyed asset row", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Stages one manually-keyed row in the use case's asset register. " +
      "`documentId`, when given, must name a document this door may attach as evidence: an unknown id answers " +
      "**400** `DOCUMENT_NOT_FOUND`, and a document uploaded through `POST /orgs/{id}/branding/logo` — an " +
      "organization's brand logo, not evidence — answers **400** `INVOICE_DOCUMENT_IS_BRAND_LOGO`.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["metadata"],
      properties: { metadata: { type: "object", additionalProperties: true }, documentId: { type: "string" } },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  listInvoices: {
    tags: ["Asset Register"], summary: "List staged/tokenized rows for a use case", security: eitherCredential,
    description:
      "Requires the `assets:read` scope. Staged and already-tokenized rows in a use case's asset register.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: {
      type: "object", additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["staged", "tokenized"] },
      },
    },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(400, 401, 403, 404) },
  },
  deleteInvoice: {
    tags: ["Asset Register"], summary: "Delete a staged row (tokenized ones are guarded)", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Removes a staged row. Rows that have already been tokenized are refused — " +
      "once an asset exists, the asset is the record.",
    params: { type: "object", required: ["key", "id"], properties: { key: { type: "string" }, id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  tokenizeInvoices: {
    tags: ["Asset Register"], summary: "Selectively tokenize staged rows into assets", security: eitherCredential,
    description:
      "Requires the `assets:issue` scope. Mints assets from the staged rows you name. It calls the same core as " +
      "`POST /assets`, so it carries the same scope: a second door onto issuance must not be a cheaper one. " +
      "`initialSupply`, when given, is minted for every named row; omitted, the invoice use case fractionalizes " +
      "its own `amount` field by `parValue` (unchanged legacy behavior) and every other use case mints 1 unit per row.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", required: ["ids", "chainId"],
      properties: {
        ids: { type: "array", items: { type: "string" } },
        chainId: { type: "string" },
        parValue: { type: "number" },
        initialSupply: { type: "string" },
        sale: {
          type: "object", additionalProperties: false, required: ["unitPrice", "currency"],
          properties: { unitPrice: { type: "string" }, currency: { type: "string" } },
        },
      },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
};
