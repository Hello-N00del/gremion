# ADR: Keycloak as the authoritative identity store, accessed via a thin Admin-API proxy

**Date:** 2026-03-27
**Status:** Accepted
**Subsystem:** Identity & auth (kernel)
**Author:** Architecture session

---

## Context

The Gremion kernel needs a single, authoritative store for users, groups, and roles, plus a server-side way to administer them (create/invite members, manage group membership, assign realm roles, reset credentials, deactivate accounts). The kernel already uses Keycloak as its identity provider — OIDC/SSO for the admin shell (`gremion-ui`) and the public portal (`gremion-public`) — and ships a per-tenant realm model. All user, group, and role data therefore already lives in Keycloak.

For the kernel's vision, architecture, and the governance charter, see [`docs/about-gremion.md`](../about-gremion.md). This ADR records the operational identity decision: how the kernel reads and mutates Keycloak state.

The kernel also provisions Keycloak **groups** as the membership backbone for the governance domain: each org-unit (council, committee, working group) in the org-unit tree maps to a Keycloak group, and group membership drives the role/capability model. This provisioning must be idempotent and survive an app-DB wipe (Keycloak state outlives the application database).

### Options considered

**Option A — Server routes as a thin proxy to the Keycloak Admin API (no local user store)**
Server-side modules call the Keycloak Admin REST API using a dedicated service account (client-credentials flow). No user data is persisted in a separate database. Keycloak is the single source of truth for all user and group state.

**Option B — Local user store synchronised from Keycloak**
A separate database table mirrors user records from Keycloak. The app reads from the local store; writes go to both Keycloak and the local store.

**Option C — Embed the Keycloak Admin Console as an iframe**
The stock Keycloak Admin Console is surfaced inside the shell via an iframe with a custom theme.

---

## Decision

**Option A — a thin server-side proxy to the Keycloak Admin API, with no local user store.**

### Rationale

- Keycloak is already the authoritative identity store; duplicating data into a local store introduces synchronisation lag and a second failure domain with no benefit.
- The Keycloak Admin REST API exposes all required operations (list/create/update/deactivate users, group membership, realm-role assignment, invite email via `execute-actions-email`, credential and OTP inspection). No operation requires a local mirror.
- A thin proxy keeps the surface small and testable: the `KeycloakAdminClient` class is the only integration point, and its methods map close to 1-to-1 onto Admin API calls.
- Option B's synchronisation complexity is unjustified for the dataset size (a single governance tenant has O(100) members at most).
- Option C is rejected because it exposes Keycloak-specific terminology, cannot be styled to match the shell, and an iframe falls outside the accessibility-audit scope.

### The Admin client

`KeycloakAdminClient` (`gremion-ui/src/lib/server/keycloak-admin.ts`) is the kernel's single integration surface for the Admin API. It:

- authenticates with the **client-credentials grant** (`grant_type=client_credentials`); Auth.js cannot perform service-account flows, so this client is hand-rolled;
- caches the access token in-process and refreshes it with a 30-second safety margin before the `exp` claim to avoid clock-skew edge cases;
- exposes typed methods for users (`listUsers`, `getUser`, `createUser`, `updateUser`, `deleteUser`, `executeActionsEmail`, `hasOtpCredential`), groups (`listGroups`, `listSubGroups`, `createGroup`, `createSubgroup`, `updateGroup`, `deleteGroup`, members), and realm roles (`listRealmRoles`, `listUserRoles`, `assignRoles`).

The client is **per tenant**. `getKeycloakAdminClient(tenant)` returns a client keyed by the canonical `tenant.id` (realm names are not unique across tenants), reading the admin URL, realm, client id, and a resolved client secret from the tenant context. `evictKeycloakAdminClient(tenantId)` drops the cached client on tenant suspend/delete.

### Service authentication

The admin client authenticates with a dedicated Keycloak service client per realm. The client secret is supplied via the `KEYCLOAK_ADMIN_CLIENT_SECRET` environment variable (see `.env.example`) and resolved through the tenant secret indirection. The setup health check calls `validateCredentials()` — a bounded client-credentials probe — to surface a bad or empty secret distinctly from mere unreachability.

The service-account token is never forwarded to the browser. All Admin API calls originate from server routes (`+server.ts`) or server-only modules (`+page.server.ts`, `$lib/server/**`); the SvelteKit server boundary enforces this.

### Role guard

The role model is hierarchical: `it-admin > council-admin > member > guest` (`Role` enum and `hasRole` in `gremion-ui/src/lib/auth/index.ts`). Page-level access is composed from per-module manifests into `PAGE_ACCESS` and enforced by the `canAccess` check in `src/hooks.server.ts`. API routes carry their own per-handler auth: administrative endpoints call `hasRole(user.roles, Role.CouncilAdmin)` (or stronger) explicitly before any Admin API call, giving defence-in-depth on top of page navigation guards.

Finer-grained, group-based capability checks live in `src/lib/auth/group-helpers.ts`. Capabilities are composed from the module manifests present in the build, so a helper for a capability contributed by an absent feature module degrades to `false` (ungranted) rather than failing.

### Group provisioning

Provisioning is orchestrated per org-unit through pluggable **subsystems**. In the governance kernel the only subsystem is **Keycloak** (`gremion-ui/src/lib/server/governance/provisioning/subsystems/keycloak.ts`), which treats the Keycloak group as the membership backbone:

1. `ensureResource` — adopt an existing same-name group/subgroup if present, otherwise create it (`createGroup` / `createSubgroup`). Adoption-before-create makes re-provisioning idempotent against leftover Keycloak state that survives an app-DB-only wipe (a blind create would 409).
2. `addMember` / `removeMember` / `reconcileMembers` — keep group membership in step with the desired member set.
3. `removeResource` — delete the group on deprovisioning.

Each subsystem's outcome is recorded in the provisioning ledger. If provisioning fails, the orchestrator tears down any external resources that were created and removes the application-side org-unit row, so a half-provisioned org-unit is never persisted (the create endpoint returns a structured error rather than a 201 with an orphan).

Feature modules (finance, files, messages, etc.) ship their own provisioning subsystems and live in their own repositories, one per module; they are not part of the kernel and add no provisioning steps here.

---

## Consequences

**Positive:**

- Single source of truth — no synchronisation complexity, no second failure domain.
- The thin proxy is easy to test in isolation (mock Keycloak responses in Vitest).
- The per-tenant client and the subsystem-orchestrator pattern let feature modules add provisioning targets without changing the group-creation flow.
- The setup health check can distinguish a misconfigured admin secret from an unreachable Keycloak.

**Negative / risks:**

- All Admin API calls go through the application process. If Keycloak is unreachable, user management is unavailable — acceptable, since Keycloak is a required service.
- Token caching is in-process; the cache is lost on restart, costing one extra token fetch on cold start — acceptable.
- `execute-actions-email` (used for invites/credential resets) requires Keycloak SMTP to be configured. If SMTP is unconfigured, those emails fail at the Keycloak level; the setup wizard's SMTP step and a health-check warning mitigate this.

---

## GDPR

**Personal data involved:** Yes.

### Data inventory

| Data element | Category | Stored in | Retention |
|---|---|---|---|
| Email address | Contact / identifier | Keycloak | Active users: indefinite. Deactivated users: purged per the tenant's retention policy. |
| Display name (first + last) | Contact | Keycloak | Same as above. |
| Realm role assignments | Organisational | Keycloak | Purged with the user record. |
| Group membership | Organisational | Keycloak | Purged with the user record. |
| Login / session events | Behavioural | Keycloak event store | Per Keycloak `eventsExpiration`. |
| Invite status / provisioning metadata | Operational | Keycloak attributes | Same as the user record. |

No personal data is stored in any local database, file, or in-process cache outside Keycloak as part of identity management.

### Lawful basis

**Art. 6(1)(e) GDPR — task carried out in the public interest** is the typical basis for the kernel's flagship deployment, where the operator is a public-law body and processing of member names, emails, and roles is necessary to carry out statutory governance functions (membership management, committee coordination, resolutions). The applicable lawful basis is a per-deployment determination by the operator; the kernel records this template in its compliance documentation.

### Data flows

```
Admin browser
  → app server (HTTPS, server-side only)
    → Keycloak Admin REST API (internal network)
      → Keycloak PostgreSQL DB (internal network)
```

No personal data leaves Keycloak as part of identity management; group membership is the only context passed to provisioning subsystems, and in the kernel the only subsystem is Keycloak itself.

### Data subject rights

- **Access / rectification:** an administrator can view and update a user record, which proxies to the Keycloak Admin API.
- **Erasure:** deactivation disables the account immediately; full erasure (`DELETE /users/{id}`) removes the record from Keycloak.
- **Portability:** export of a user's data is governed by the kernel's compliance documentation, not this ADR.

### Consent

No consent is required for processing under Art. 6(1)(e); data subjects are informed via the deployment's Datenschutzerklärung served by the legal-pages surface.

### Verification

- Server routes log user IDs and action types only — no IP addresses.
- Keycloak access-log IP handling is an operator configuration gate before go-live.
- `execute-actions-email` sends a user's own email back to them — no third-party disclosure.

---

## References

- [`docs/about-gremion.md`](../about-gremion.md) — kernel vision, architecture, and governance charter
- `gremion-ui/src/lib/server/keycloak-admin.ts` — `KeycloakAdminClient`, per-tenant registry
- `gremion-ui/src/lib/auth/index.ts` — `Role`, `hasRole`, `canAccess`, role hierarchy
- `gremion-ui/src/lib/auth/group-helpers.ts` — group-based capability helpers
- `gremion-ui/src/hooks.server.ts` — page-access guard
- `gremion-ui/src/lib/server/governance/provisioning/subsystems/keycloak.ts` — Keycloak provisioning subsystem
- `.env.example` — `KEYCLOAK_ADMIN_CLIENT_SECRET`
- Keycloak Admin REST API reference: https://www.keycloak.org/docs-api/26.1/rest-api/
