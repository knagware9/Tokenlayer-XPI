/**
 * Schemas for the identity product — credential use cases and templates,
 * issuance and revocation, the presentation exchange, DIDs and the registry.
 *
 * One file per product, mirroring http/routes/. `schemas-file-domains.test.ts`
 * fails if an entry here is referenced from another product's route file.
 */
import type { FastifySchema } from "fastify";
import { TOKEN_STANDARD, TOKEN_TYPE, errs, humanOnly, eitherCredential, REQUESTED_FIELDS_BODY_SCHEMA, DISCLOSURES_BODY_SCHEMA } from "./components.js";

export const identitySchemas: Record<string, FastifySchema> = {
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
      "An Org Admin cannot use this route at all — `POST /credential-use-cases/provision` is theirs. Neither a " +
      "credential type's `certificate.background` nor its `certificate.logoDocumentId` may name a document " +
      "uploaded through `POST /orgs/{id}/branding/logo` — that organization's mark is not certificate artwork, " +
      "and it is already used automatically as the logo fallback when a type names none of its own — answering " +
      "**400** `BACKGROUND_IS_BRAND_LOGO` or `CERTIFICATE_LOGO_IS_BRAND_LOGO` respectively.",
    body: { type: "object", additionalProperties: true, required: ["key", "name", "credentialTypes", "issuer", "holderPolicy", "verifier"] },
    response: { 201: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 409) },
  },
  updateCredentialUseCase: {
    tags: ["Credential Use Cases"], summary: "Update a credential use case (PlatformAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope. Patches a credential use case's configuration: its credential " +
      "types, holder policy, and verifier. Same `certificate.background`/`certificate.logoDocumentId` restriction " +
      "as `POST /credential-use-cases`: naming an organization's brand-logo document answers **400** " +
      "`BACKGROUND_IS_BRAND_LOGO` or `CERTIFICATE_LOGO_IS_BRAND_LOGO`.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404) },
  },
  addCredentialType: {
    tags: ["Credential Use Cases"], summary: "Add a credential type to an existing use case (that use case's UseCaseAdmin)", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** the UseCaseAdmin scoped to this exact use case (`claims.useCaseKey === key`) " +
      "— a narrower, additive counterpart to `PATCH /credential-use-cases/{key}`, which is PlatformAdmin-only and replaces the " +
      "whole definition. This route only APPENDS one new named credential type; every other field of the definition — issuer, " +
      "holder policy, verifier, and the existing credential types — is read from storage and left untouched. The body is a full " +
      "`CredentialTypeSpec` (`name`, `title`, `validityDays`, `requiredApprovals`, `claimSchema`, optional `certificate`). Answers " +
      "**409** `TYPE_EXISTS` when the name is already taken on this use case, and the same `INVALID_CREDENTIAL_USECASE` / " +
      "`BACKGROUND_IS_BRAND_LOGO` / `CERTIFICATE_LOGO_IS_BRAND_LOGO` 400s as the two routes above.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: { type: "object", additionalProperties: true, required: ["name", "title", "validityDays", "claimSchema"] },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404, 409) },
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
      "authoring input and confers nothing until it is instantiated. A credential type's `certificate.background` " +
      "is silently stripped before storage — " +
      "artwork does not travel with a template — but `certificate.logoDocumentId` does, and naming an " +
      "organization's brand-logo document (one uploaded through `POST /orgs/{id}/branding/logo`) is refused rather " +
      "than stripped: **400** `CERTIFICATE_LOGO_IS_BRAND_LOGO`.",
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
      "and without the stamp it would be a certificate generator for made-up facts. A `background` naming an " +
      "organization's brand-logo document answers **400** `BACKGROUND_IS_BRAND_LOGO` — that is not artwork, even " +
      "in a draft.",
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
  previewStoredCertificate: {
    tags: ["Credential Use Cases"], summary: "Render an already-saved credential type's certificate design as a sample PDF", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** either a Platform/Org Admin or a desk operator (UseCaseAdmin " +
      "or Issuer) scoped to this exact use case. The stored-config counterpart to `POST " +
      "/credential-use-cases/preview-certificate`: no `credentialType` is posted — the type is read from the saved " +
      "use case by `key` and `name`, so its background artwork id is never caller-supplied and there is no " +
      "ownership check to get wrong. Same **SAMPLE — NOT A CREDENTIAL** stamp and the same fabricated `cred_sample` " +
      "id whose status route answers 404.",
    params: { type: "object", required: ["key", "name"], properties: { key: { type: "string" }, name: { type: "string" } } },
    // Opaque PDF bytes — same documentation deferral as previewCertificate above.
    response: { ...errs(401, 403, 404) },
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
      "`BACKGROUND_DOCUMENT_MISMATCH`, `BACKGROUND_NOT_AN_IMAGE`, `BACKGROUND_IS_BRAND_LOGO` (a document uploaded " +
      "through `POST /orgs/{id}/branding/logo` is an organization's mark, not artwork — upload it again through the " +
      "artwork door) or `INVALID_CERTIFICATE_PLACEMENT` (which names the " +
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
      "in **this response only** and are never retrievable again. If the template's `certificate.logoDocumentId` " +
      "names an organization's brand-logo document (checked again here, not just at template-save time, so a " +
      "template saved before that check existed cannot smuggle one through), the call answers **400** " +
      "`CERTIFICATE_LOGO_IS_BRAND_LOGO` before anything is created.",
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

  identityDashboard: {
    tags: ["Identity"], summary: "Scoped identity operations dashboard (credential lifecycle + verification aggregates)", security: eitherCredential,
    description:
      "Requires the `credentials:read` scope. Aggregates the credential lifecycle and verification activity already " +
      "inside the caller's scope.",
    // Loose 200: the nested fold output would be silently stripped by
    // fast-json-stringify under a typed schema (the standing lesson).
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
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
      "on-chain proof must require `source === \"chain\"` rather than merely reading `revoked`.",
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
          source: { type: "string", enum: ["chain", "database"], description: "Where `revoked` came from. `database` also covers an on-chain read that failed." },
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
  credentialQr: {
    tags: ["Credentials"], summary: "Public: a scannable QR encoding this credential's verification link",
    description:
      "Public — same posture as `/credentials/{id}/status`: the unguessable credential id is the token, and a " +
      "verifier's phone camera must be able to resolve this with no account. Encodes " +
      "`{publicWebUrl}/verify?id={id}` — the public verification portal's own URL shape, the same one the " +
      "\"Copy verification link\" action in the wallet builds — never the credential's claims, which stay behind " +
      "the holder's consent.",
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
            // DECLARED, not just returned: fast-json-stringify drops any field
            // the schema does not name, so an addition made only in the handler
            // is an addition that never leaves the process.
            credentialUseCaseKey: { type: "string", nullable: true, description: "The credential use case this was issued under — the programme it belongs to. null for a platform-catalog credential (e.g. KycCredential at onboarding)." },
            acceptance: { type: "string", description: "accepted | pending | rejected | changes_requested. Issued is not the same as in force." },
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
      "that holder consents.\n\n" +
      "`requestedFields` (optional) asks for specific claim fields, per credential type — a plain value, or, for a " +
      "`number`-typed field, a threshold predicate (`gte`/`lte`/`gt`/`lt`/`eq` + `threshold`) instead of the raw " +
      "value. **This is advisory only.** The holder always has final say per field at consent time and can " +
      "disclose less than asked — or a predicate instead of a value, or vice versa — without being blocked from " +
      "consenting at all. A field named here that doesn't exist on the type, or a predicate named on a non-numeric " +
      "field, is refused with **400** `UNKNOWN_FIELD` / `INVALID_PREDICATE_FIELD` at create time. See " +
      "`POST /verification-requests/{id}/consent` for the holder's side of this exchange.",
    body: {
      type: "object", additionalProperties: false, required: ["holderDid", "requestedTypes", "purpose"],
      properties: {
        holderDid: { type: "string", minLength: 1 },
        requestedTypes: { type: "array", items: { type: "string" }, minItems: 1 },
        purpose: { type: "string", minLength: 1 },
        credentialUseCaseKey: { type: "string" },
        requestedFields: REQUESTED_FIELDS_BODY_SCHEMA,
      },
    },
    response: { 201: { $ref: "VerificationRequest#" }, ...errs(400, 401, 403) },
  },
  listVerificationRequests: { tags: ["Verification"], summary: "The caller's OUTBOUND verification requests", security: eitherCredential,
    description:
      "Requires the `verifications:read` scope. The mirror of `GET /me/verification-requests`: that one returns the " +
      "requests addressed TO you, this one the requests you RAISED — newest first, so a verifier can pick up a " +
      "pending request after leaving the page.\n\n" +
      "Scoped exactly as `GET /verification-requests/{id}` is: an organization admin sees their organization's " +
      "requests, a use-case-scoped Verifier desk sees its own use case's, a platform admin sees all. Anyone else " +
      "gets an empty array rather than a 403 — nothing exists for them to be refused.\n\n" +
      "Never carries the verifier's RESULT, which needs `verifications:verify`; and `eligibleCredentials` is the " +
      "holder view's field alone and is absent here.",
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
      "VERIFIER's side of the exchange rather than the holder's.\n\n" +
      "`disclosures` (optional) is the holder's per-field choice for each credential in `credentialIds`: share the " +
      "value, share only a threshold-predicate result (numeric fields only — the raw value is read once to " +
      "compute it and never stored or returned), or withhold it — independent of what the request's " +
      "`requestedFields` asked for. **Omitting `disclosures` entirely, or omitting a credential/field from it, " +
      "discloses that credential/field in full** — this is the pre-selective-disclosure default and never changes " +
      "for a caller that never sends it. A field named here that doesn't exist on the credential's actual claims, " +
      "or a predicate named on a non-numeric claim, is refused with **400** `UNKNOWN_FIELD` / " +
      "`INVALID_PREDICATE_FIELD`. Consent is never blocked by disclosing fewer fields than requested.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["credentialIds"],
      properties: {
        credentialIds: { type: "array", items: { type: "string" }, minItems: 1 },
        disclosures: DISCLOSURES_BODY_SCHEMA,
      },
    },
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
          valid: { type: "boolean", description: "The overall verdict: the presentation verified AND every requested type is covered by a valid credential. This says nothing about which FIELDS were disclosed — selective disclosure means `valid: true` is fully compatible with a credential's `claims` being partially or entirely withheld; read each credential's own `claims` to see what was actually shared." },
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
                claims: {
                  type: "object", additionalProperties: true, nullable: true,
                  description:
                    "The disclosed subject claims — the actual payload the holder consented to share, keyed by " +
                    "field. Each field is one of three shapes: the plain claim value (as issued — unchanged from " +
                    "before selective disclosure existed); `{ predicate: { op, threshold, result } }` when the " +
                    "holder chose to prove only a threshold check on a numeric field instead of sharing its value " +
                    "(the raw value never appears anywhere in the response); or the field is simply ABSENT when " +
                    "the holder withheld it entirely. A request consented before selective disclosure existed, or " +
                    "consented with no `disclosures` at all, falls back to every field in full, unchanged.",
                },
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

  identityAssert: {
    tags: ["Identity"], summary: "Does a subject hold a valid credential of a type? (service-to-service)",
    security: eitherCredential,
    description:
      "Requires the `identity:assert` scope, and is **machine-only** — a human session is refused with " +
      "`403 SESSION_PRINCIPAL` even for a platform admin. Scopes are a property of API keys, so a scope check " +
      "alone passes every interactive session; without the machine check this route would let any signed-in user " +
      "enumerate who is KYC'd.\n\n" +
      "This is the question a **separately-deployed Tokenization instance** must ask Identity before letting an " +
      "account receive a token from a use case with `compliance.requireVerifiedIdentity`. In a single deployment " +
      "the engine answers it in-process; the answer comes from the same predicate either way, so splitting the " +
      "deployment cannot change who may hold a token.\n\n" +
      "**It is a yes/no, never the credential.** No claims, no issuer, no credential id — those stay behind the " +
      "holder's consent in the presentation exchange (`POST /verification-requests`). An assertion that returned " +
      "contents would be a back door around consent.\n\n" +
      "A POST rather than a GET on purpose: the subject DID stays out of URLs, proxy logs and referrers. Every " +
      "call is written to the audit log — a scope this broad (any key holding it may ask about ANY subject) earns " +
      "its breadth by being visible.",
    body: {
      type: "object", additionalProperties: false, required: ["subject"],
      properties: {
        subject: { type: "string", minLength: 1, description: "Holder DID, e.g. `did:key:z6Mk…`." },
        credentialType: { type: "string", minLength: 1, description: "Credential type to test for. Defaults to `KycCredential` — what the tokenization gate means by a verified identity." },
      },
    },
    response: {
      200: {
        type: "object", additionalProperties: true,
        properties: {
          subject: { type: "string" },
          credentialType: { type: "string" },
          holds: { type: "boolean", description: "True iff the subject holds an accepted, unrevoked credential of that type." },
          checkedAt: { type: "string" },
        },
      },
      ...errs(400, 401, 403),
    },
  },

};
