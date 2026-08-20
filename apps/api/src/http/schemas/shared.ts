/**
 * Schemas for the routes both products serve — sessions, organizations,
 * the roster, proposals, audit, documents, webhooks, events, chains.
 *
 * One file per product, mirroring http/routes/. `schemas-file-domains.test.ts`
 * fails if an entry here is referenced from another product's route file.
 */
import type { FastifySchema } from "fastify";
import { TOKEN_STANDARD, TOKEN_TYPE, errs, humanOnly, eitherCredential } from "./components.js";

export const sharedSchemas: Record<string, FastifySchema> = {
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
          // `additionalProperties: true` stays — the session principal carries
          // more than is named here (id, role, email, orgId, walletAddress,
          // useCaseDomain, orgCapabilities), and fast-json-stringify would
          // STRIP every undeclared field the moment it were dropped. The two
          // EN-E fields are named because the shell reads them on first paint
          // and an integrator reading this document should see them.
          user: {
            type: "object", additionalProperties: true,
            properties: {
              brandLogoDocumentId: { type: "string", nullable: true, description: "EN-E: the caller's org's logo Document id — fetch the bytes from `GET /orgs/{id}/branding/logo`. null for an org-less principal or an unbranded org." },
              brandAccent: { type: "string", nullable: true, description: "EN-E: the caller's org's lowercase `#rrggbb` accent. null for an org-less principal or an unbranded org." },
            },
          },
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
          brandLogoDocumentId: { type: "string", nullable: true, description: "EN-E: the caller's org's logo Document id. null for an org-less principal or an unbranded org." },
          brandAccent: { type: "string", nullable: true, description: "EN-E: the caller's org's lowercase `#rrggbb` accent. null for an org-less principal or an unbranded org." },
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
          subjectIdentifiers: {
            type: "string", enum: ["did", "plain"],
            description:
              "Whether the PEOPLE in this deployment carry DIDs. `did` (the default) mints a custodial DID per user; " +
              "`plain` runs users as ordinary accounts with no DID and no credentials. Organizations carry a DID either way.",
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
            description: "The signed-in principal — the same shape `POST /auth/login` returns, plus `walletAddress`, `useCaseDomain`, `orgCapabilities` and the EN-E brand fields. Accompanies `token` only.",
            // Named for the same reason as on `login`: this is the OTHER site
            // the console builds a session from, and the two must agree.
            // `additionalProperties: true` stays — dropping it would make
            // fast-json-stringify strip every field not listed here.
            properties: {
              brandLogoDocumentId: { type: "string", nullable: true, description: "EN-E: the caller's org's logo Document id. null for an org-less principal or an unbranded org." },
              brandAccent: { type: "string", nullable: true, description: "EN-E: the caller's org's lowercase `#rrggbb` accent. null for an org-less principal or an unbranded org." },
            },
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
      "and the platform-signed `OrganizationCredential` is issued.\n\n" +
      "`company.documents.cinCertificate.id` and `.gstinCertificate.id` name documents uploaded through " +
      "`POST /orgs/register/documents`; an unknown id answers **400** `DOCUMENT_NOT_FOUND`, and a document uploaded " +
      "through `POST /orgs/{id}/branding/logo` — an organization's mark, not a statutory certificate — answers " +
      "**400** `KYB_DOCUMENT_IS_BRAND_LOGO`.",
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
  updateOrgBranding: {
    tags: ["Organizations"], summary: "Set an organization's logo and accent colour", security: humanOnly,
    description:
      "Session-only, and restricted to an OrgAdmin of THIS organization or a Platform Admin. An API key is refused " +
      "with **403 `MACHINE_PRINCIPAL`**. Deliberately carries no API-key scope: branding is a console act by a " +
      "person, and a scope for it would let an unattended key rewrite an organization's identity.\n\n" +
      "An omitted field is left unchanged; an explicit `null` clears it. So `{}` is a no-op, and " +
      "`{\"brandAccent\": null}` keeps the logo while dropping the colour.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false,
      properties: {
        brandLogoDocumentId: { type: "string", nullable: true, description: "An image Document id. null clears it." },
        brandAccent: { type: "string", nullable: true, description: "#rrggbb, normalized to lowercase. null clears it." },
      },
    },
    response: { 200: { $ref: "Organization#" }, ...errs(400, 401, 403, 404) },
  },
  uploadOrgBrandLogo: {
    tags: ["Organizations"], summary: "Upload an organization's brand logo (image)", security: humanOnly,
    description:
      "Session-only, gated identically to `PATCH /orgs/:id/branding`: restricted to an OrgAdmin of THIS " +
      "organization or a Platform Admin, and an API key is refused with **403 `MACHINE_PRINCIPAL`** whatever its " +
      "scopes. A dedicated door rather than `POST /documents`, because that route gates on the `issue` capability " +
      "and an OrgAdmin does not hold it — widening it would change the authorization of a route that also serves " +
      "KYB documents, certificate artwork and asset attachments, for the sake of a logo. Images only, even though " +
      "`POST /documents` accepts a wider allowlist: this door exists so an OrgAdmin can upload a MARK. Returns the " +
      "document id, ready to hand straight to `PATCH /orgs/:id/branding` as `brandLogoDocumentId`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["contentType", "dataBase64"],
      properties: { contentType: { type: "string" }, dataBase64: { type: "string" } },
    },
    response: {
      201: {
        type: "object", additionalProperties: true,
        properties: { id: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } },
        required: ["id", "sha256", "size"],
      },
      ...errs(400, 401, 403, 404, 413, 415),
    },
  },
  getOrgBrandLogo: {
    tags: ["Organizations"], summary: "Fetch an organization's brand logo (image bytes)", security: humanOnly,
    description:
      "Session-only. An API key is refused with **403 `MACHINE_PRINCIPAL`** whatever its scopes — a key draws no " +
      "chrome, and the console shell this serves is a human surface.\n\n" +
      "**The URL carries no document id.** The route reads the organization's own `brandLogoDocumentId`, so a " +
      "member can fetch their org's mark and nothing else; it is not a second way into the document store.\n\n" +
      "Deliberately WIDER than `PATCH /orgs/:id/branding`: any authenticated member of THIS organization may read " +
      "the mark (a Platform Admin may read any), because setting the brand is an admin act while seeing it is " +
      "every member's sidebar. `GET /documents/{id}` cannot serve this — it requires the `issue` capability or the " +
      "Auditor role, so the very OrgAdmin who uploaded the logo is refused it there.\n\n" +
      "**404** covers both an unbranded organization and a brand whose document has since been removed: to a " +
      "caller drawing chrome they are the same answer.\n\n" +
      "Responds with the stored image bytes, served `nosniff` and `content-disposition: attachment`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    // No 2xx node, exactly like `getDocument`: the body is opaque image bytes,
    // and declaring a JSON shape here would be a false statement about it — not
    // a more complete one. See DOCUMENTATION_DEFERRED in openapi-contract.test.ts.
    response: { ...errs(401, 403, 404) },
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
        // A DID this holder already has, issued by a separately-deployed Identity
        // service. Accepted ONLY by a deployment that does not run the identity
        // product (400 DID_NOT_ACCEPTED otherwise, and 400 if sent with `kyc`).
        // On a split topology this is what lets the tokenization side recognise
        // the subject the Identity service will be asked about.
        did: { type: "string" },
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

};
