# Controller / processor split (Verantwortlicher / Auftragsverarbeiter)

> **Status: DRAFT — intended split, not an executed agreement.**
> This document describes how roles under the GDPR (DSGVO) are *intended* to fall for
> Gremion in its two deployment shapes. As of 2026-09-09 **no data-processing agreement
> (Auftragsverarbeitungsvertrag, AVV) has been concluded with anyone**, no pilot council
> is named, and no personal data of a real council is hosted. Sub-processors that require
> a signed AVV are marked `TBD` where that AVV is not yet in place.
> Nothing here is legal advice; the analysis must be reviewed by a lawyer or a data
> protection officer (Datenschutzbeauftragter) before the first real council is onboarded.

## 1. The two shapes

**(a) Self-hosted.** A council (Rat / Gremium / Studierendenschaft) runs the Gremion
distribution on its own or its institution's infrastructure. There is no operator in the
loop at all. See §11.

**(b) Hosted control plane.** The project operator runs one Gremion installation on a
single dedicated server rented from **netcup GmbH** (Germany) and hosts several councils
(tenants) on it. Products are reached on subdomains of the platform domain
`gremion.de`; a tenant may additionally point its own domain
(`gremien.council.example`) at the same installation. Each tenant gets its own Postgres
database, its own Keycloak realm and its own per-tenant secret material, registered in a
separate control database (`migrations-control/001_tenant_registry.sql`). Shape (b) is
what makes the operator an **Auftragsverarbeiter** and is the subject of the rest of this
document.

## 2. Roles per data category

| Data category | Where it lives | Controller (Verantwortlicher) | Operator's role |
|---|---|---|---|
| Council content: members, committees, roles, minutes, motions, finance records, files, calendar, elections | Per-tenant Postgres DB `t_<slug>`, per-tenant module stores, object storage | **The council** | **Processor** (Art. 28) |
| Authentication data: usernames, e-mail addresses, credentials, sessions, login and step-up events | Per-tenant Keycloak realm | **The council** | Processor |
| Tenant audit trail (`audit_log`, hash-chained) | Per-tenant DB | **The council** | Processor — but the operator has an own security interest in it (see §3) |
| Chat, calls and shared files delivered through Matrix/Synapse, LiveKit, Nextcloud | Shared subsystems on the same host | **The council**, with a joint-controllership risk — see §3 | Processor, contested |
| Backups of the above | Local volume; offsite target `TBD` | **The council** | Processor |
| Platform account and contact data: the council's contract and billing contacts, signup and support correspondence, ticket content | Operator's own systems, `hello@` / `signups@` mailboxes | **The operator** | Controller |
| Infrastructure logs: reverse-proxy access logs, container logs, firewall and mail transport logs | Host | **The operator**, Art. 6(1)(f) (security and operation of the service) | Controller |
| Application logs that describe a tenant's users | Host, retained per §8 | **The council** | Processor — keep these short-lived and separate from the operator's own logs |
| Platform's own outbound and inbound mail (`security@`, `abuse@`, `postmaster@`, `hello@`) | Self-hosted mail stack on the same server | **The operator** | Controller |
| Mail the platform sends *for a tenant* through the tenant's own SMTP profile | Tenant's own mail provider | **The council** | Neither — the tenant's provider is the *tenant's* processor |
| Marketing site at the apex domain, source repository, issue tracker | Operator / GitHub | **The operator** | Controller |

Rule of thumb that keeps the split honest: **the operator processes tenant data only on
documented instruction (weisungsgebunden) and never for a purpose of its own.** The moment
the operator wants cross-tenant analytics, product telemetry or cross-tenant abuse
detection, that data category leaves Art. 28 and becomes either operator-controllership
(needing its own legal basis) or joint controllership under Art. 26.

## 3. Joint-controllership risks (Art. 26)

These are the places where the operator determines means so strongly that "pure processor"
is arguable rather than obvious. Each needs a decision before the second tenant, because
every shared-subsystem defect activates at tenant #2, not tenant #1.

- **Matrix / Synapse — one homeserver, one `server_name`.** The `server_name` is a
  *platform* domain, deliberately neither a product's nor a tenant's, so that room IDs do
  not permanently embed a tenant. The consequence is that every user identifier
  (`@user:<platform domain>`) is minted in a namespace the operator owns, room IDs
  permanently embed the operator's domain, and the media store is shared. Federation is
  closed, which limits exposure but does not change who determines the identifier
  namespace. Options: accept and document a processor role with tight instructions, or
  move to one homeserver per tenant (cost) before tenant #2.
- **LiveKit.** Shared SFU. Media is transient, but room names, participant identities and
  call metadata pass through operator-determined infrastructure and identity tokens.
- **Nextcloud.** A single instance with per-tenant group folders, a shared user table and
  a shared OIDC mapping. This is also the reason tenant erasure has a manual residual (§7).
- **Cross-tenant audit and security logging.** Tenant `audit_log` content serves the
  council's compliance purpose *and* the operator's security purpose. If the operator reads
  it for its own security purposes, say so and give that a legal basis; do not present it
  as processing on instruction only.

Where joint controllership is the honest label, Art. 26 requires a written arrangement
(Vereinbarung) allocating the duties and publication of its essence to data subjects. None
exists today.

## 4. Art. 28 AVV checklist (what the agreement must contain)

Not a draft contract — the checklist the eventual AVV is measured against.

1. Subject matter, duration, nature and purpose of the processing.
2. Categories of personal data and of data subjects (§2 above and the Art. 30(2) record).
3. Processing **only on documented instruction** of the controller, including the rule for
   third-country instructions.
4. Confidentiality obligation for everyone with access (Verpflichtung auf Vertraulichkeit)
   — today the operator is a single person; the obligation still has to be recorded, and
   key-person risk is explicitly out of scope of the technical plan and must be handled
   organisationally.
5. **Art. 32 TOMs** as an annex (§4a).
6. Sub-processors: general written authorisation plus a change-notification period
   (`TBD`, typically 30 days) and a right to object; current list in §5.
7. Assistance with data-subject rights (Art. 12–22) — export, correction, erasure,
   restriction — and with the Art. 32–36 duties.
8. Deletion or return at the end of the contract, with a stated deadline and the backup
   carve-out written out (§7).
9. Audit and evidence rights, and what evidence the operator will supply.
10. Breach notification to the controller without undue delay (§9).
11. Declaration that processing takes place in the EU/EEA (§6).
12. Contact points on both sides; supervisory authority (Aufsichtsbehörde) of each.

### 4a. TOMs annex (Art. 32) — current state

| Measure | State today |
|---|---|
| Tenant isolation | Per-tenant Postgres database, per-tenant Keycloak realm, per-tenant secret files; the control plane holds configuration and secret *references* only |
| Encryption in transit | TLS terminated at the reverse proxy with Let's Encrypt certificates; internal traffic on private container networks |
| Backup encryption / crypto-shred | Per-tenant backup key under an "exactly one physical copy" rule, so destroying it voids every backup of that tenant |
| Encryption at rest (disk) | `TBD` — depends on the netcup product |
| Access control | Keycloak with enforced 2FA / step-up for elevated actions; route-level access policy |
| Tamper-evident audit trail | `audit_log` hash chain with a periodic verifier; **detection only** — a broken chain does not halt the app |
| Pseudonymisation | IP pseudonymisation with daily key rotation in the log pipeline |
| Deployment integrity | Digest-pinned images, push-based deploy from CI over SSH, no standing registry credential on the host, no builds on the production host |
| Availability | **Single host, no high availability, no failover.** State this plainly in the AVV; do not imply resilience the setup does not have |
| Backup and restore | Deferred by decision until there is data worth protecting; the gate is *the first real name entered*, and one proven restore is required at that gate. **Open at time of writing.** |
| Mail-path hardening | Self-hosted stack on its own data volume and network, submission ports restricted, SMTP AUTH required for every submission including the platform's own, SPF/DKIM/DMARC/MTA-STS |
| Physical security | netcup's data centre; the operator inherits it and must reference netcup's own TOMs |

## 5. Sub-processors (Unterauftragsverarbeiter)

| Party | Function | Status |
|---|---|---|
| **netcup GmbH** (Germany) | Server hosting, physical infrastructure | Sub-processor. AVV offered by netcup; **not concluded — `TBD` before the first real council** |
| **INWX** (Germany) | Registrar and authoritative DNS | Infrastructure supplier. Processes the operator's own domain-contact data and DNS query metadata, not tenant content. No API credential exists, by decision |
| **Let's Encrypt / ISRG** (US) | Certificate issuance | Not a processor of tenant content. Note that every tenant hostname becomes public in Certificate Transparency logs, which discloses that a given council uses the platform — disclose this at onboarding |
| **Mail relay** | — | **None, by decision.** Outbound mail leaves the platform's own host directly; there is no relay provider and therefore no mail sub-processor |
| **Tenant's own SMTP provider** | Sending on behalf of a council | The *tenant's* processor, contracted by the tenant. Councils keep their own mail; the platform never gives a tenant a mailbox and receives no tenant mail |
| **Offsite backup target** | Off-site copies | **`TBD`.** Whatever is chosen becomes a sub-processor and must be listed and covered by an AVV before the first real council's data exists |
| **GitHub (Microsoft)** | Source, container registry, CI, deploy trigger | Not intended to process council personal data. Operational rule: **no council personal data in issues, logs or CI artefacts** |

No CDN and no analytics provider are in the path; the previous edge provider was removed
entirely.

## 6. International transfers (Drittlandtransfer)

**Intended answer: none.** All tenant data — databases, files, chat, backups (once the
offsite target is chosen, and if it is in the EU) and mail — resides on one server in
Germany. Points to verify rather than assume:

- Certificate Transparency publication (US-operated logs) exposes hostnames, not content.
- If the offsite backup target is not in the EU/EEA, that decision creates a transfer and
  needs Art. 44 ff. cover; prefer an EU target and close the question.
- Deliverability programmes (Microsoft SNDS, Google Postmaster Tools) are planned for the
  self-hosted mail path. Confirm they receive only aggregate IP-reputation data before
  enrolment; if recipient-level data is involved, that is a transfer.

## 7. Erasure (Art. 17) and how it maps to the lifecycle

Two different paths, often confused:

**Per-user erasure inside a live tenant** is the council's own operation in its own
installation (hard user delete, removal from the subsystems, pseudonymisation of historical
role assignments). Statutory retention wins where it applies: finance records under
HGB §257 / AO §147 are *restricted* (Art. 18) rather than erased for the duration of the
retention period, per Art. 17(3)(b).

**Whole-tenant erasure** is the operator's obligation at the end of the contract and runs
`tenant-provision … delete <slug>` (`docs/runbooks/tenant-lifecycle.md`):

1. `status='deleting'` before anything destructive, so an interrupted run is visible and
   resumable.
2. **Crypto-shred first** — destroy the per-tenant backup key and the tenant's live
   credential files. This voids every backup that tenant ever wrote, in one step.
3. Drop the tenant data-plane database and role.
4. Delete the Keycloak realm.
5. Tombstone the slug (`status='deleted'`); the identifier is reserved forever, so it can
   never be re-provisioned onto residual data.

**Known defects that must be fixed before this can be relied on for a real Art. 17
request** (tracked as the netcup plan's task **T15**, "make tenant erasure fail closed"):

- The per-module shreds are **silently skipped** when the module database URLs are not
  present in the process that runs the delete — which is the live configuration. The run
  still tombstones the tenant and reports success.
- **Finance, board and vault are not covered by the delete path at all**, and finance and
  vault hold the most sensitive per-tenant data.
- Because the tombstone is terminal and slug reuse is forbidden, a fail-open leaves no
  supported path that ever revisits the leftover data.
- A skipped shred is currently recorded nowhere.

T15's acceptance is that the delete **exits non-zero and leaves the tenant at `deleting`**
rather than reporting completion. Until it lands, an erasure claim to a council would be
untrue.

**Residual by design:** the shared Nextcloud and Matrix subsystems cannot be torn down by
the delete path; it flags them in the provisioning ledger and the operator must remove the
group folder and its storage, and deactivate rooms and purge media, by hand. These are not
covered by the crypto-shred and are therefore a separate erasure-completion step.

**Backups carve-out to write into the AVV:** an individual erasure request propagates into
backups only on the backup's own rotation cycle. Tenant-level erasure is immediate through
the crypto-shred; per-user erasure is not.

## 8. Retention (Art. 5(1)(e))

Enforced in code and clamped so a careless configuration change cannot lengthen it
(`docs/compliance.md`):

| Category | Default | Hard cap | Basis |
|---|---|---|---|
| Access logs | 14 d | 30 d | BayLDA recommendation |
| Application logs | 30 d | 90 d | Art. 5(1)(e), Art. 6(1)(f) |
| Security logs (`audit_log`) | 90 d | 180 d | BSI Mindeststandard Protokollierung v2.1 |
| Security logs without PII | 90 d | 365 d | as above, PII-free exception |
| Newsletter send tokens | expiry at 7 d, bulk sweep at 90 d | — | Art. 5(1)(e) |
| Backup retention | floor of 7 d | — | availability |

A German-language **Löschkonzept** is generated on demand from the live configuration, so
it cannot drift from the windows actually enforced. It is fed by the `compliance.*`
configuration fields (`controller_name`, `controller_address`, `dpo_name`, `dpo_email`,
`purpose_description`), which every installation — hosted tenant or self-hoster — must
fill in.

## 9. Breach flow (Art. 33 / 34)

1. **Intake:** GitHub private vulnerability reporting and `security@gremion.de`. A
   vulnerability report is not automatically a personal-data breach
   (Datenschutzverletzung); triage decides.
2. **Assessment:** which tenants, which data categories, likelihood and severity of risk.
3. **As processor:** notify each affected council **without undue delay** (unverzüglich,
   Art. 33(2)) — target 24 hours from awareness — with what is known, what is unknown, and
   the measures taken. The council, as controller, decides on the 72-hour notification to
   its supervisory authority.
4. **As controller** (platform accounts, logs, platform mail): the operator notifies its
   own supervisory authority within 72 hours where the risk threshold is met.
5. **Art. 34:** communication to affected data subjects is the controller's duty; the
   operator supports the council with facts and wording.
6. **Register:** every incident goes into an internal breach register regardless of whether
   it was notifiable.

## 10. Art. 30 records (Verzeichnis von Verarbeitungstätigkeiten, VVT) — skeleton

**Art. 30(1) — operator as controller.** One entry per processing activity: name and
contact of the controller (and of the DPO, if one is required); purpose; categories of data
subjects; categories of personal data; categories of recipients; third-country transfers
(none intended); erasure deadlines; general description of the TOMs. Activities to record:
platform accounts and contract administration; the marketing site; the platform's own mail;
infrastructure and security logging; support correspondence; source-repository and CI
operations.

**Art. 30(2) — operator as processor.** One entry per controller (per council): name and
contact of the operator and of each controller it acts for; the categories of processing
performed on that controller's behalf; third-country transfers (none intended); general
description of the TOMs; plus, for the operator's own file, the sub-processors used for
that controller.

Both records are empty today because there is neither a council nor real data.

## 11. The self-hoster's obligations

A council that runs Gremion itself is the **sole controller** and has no processor in the
Gremion project. Concretely it must:

- Fill in the `compliance.*` configuration (controller name and address, DPO if any,
  purpose description) — these feed the generated Löschkonzept and the legal pages.
- Set retention windows within the enforced caps and check that its own log rotation
  matches.
- Conclude its own AVV with **its** hoster, and with any third party it configures (its
  SMTP provider, an external Nextcloud, an external Helios instance).
- Assess whether it must appoint a data protection officer (in Germany, §38 BDSG: from 20
  persons constantly engaged in automated processing, and irrespective of headcount for
  processing requiring a DPIA).
- Assess whether a data protection impact assessment (Datenschutz-Folgenabschätzung,
  Art. 35) is required — electronic voting and personnel-adjacent records are the likely
  triggers.
- Run the erasure path *including* the manual Nextcloud and Matrix residual, and take note
  of the T15 defect above: on current code the whole-tenant delete can report success while
  module data survives.
- Note that the software is provided under AGPL-3.0-only **without warranty**. Neither the
  licence nor this document is a compliance guarantee, and the AGPL §13 source offer is a
  licence duty, not a data-protection one.

## 12. Open questions — to be closed once the pilot council is named

- The operator's legal form, legal name and address for the AVV signature block.
- Whether the council is a public body (öffentliche Stelle) — if so, the Land's own data
  protection act and supervisory authority apply and the AVV must mirror the Land's
  requirements — and **who can sign** (the student body itself, or the university).
- Whether either side has, or needs, a DPO.
- Whether a DPIA is required for the pilot's scope (elections in particular).
- The offsite backup target, and a proven restore — the gate is the first real name
  entered, not go-live.
- Whether the pilot runs alongside the demo tenant, which is what activates every
  shared-subsystem question in §3 for real.
- The Matrix decision from §3: shared homeserver with a platform `server_name`, or one
  homeserver per tenant.
- The tenant's own SMTP profile and the per-tenant legal texts (Impressum,
  Datenschutzerklärung).
- Deletion deadline after contract end, and the evidence the operator supplies for it.

## 13. Honest limits of this document

- This repository is the **kernel**. The hosted service is operated separately, and some of
  the code paths this document depends on — notably the per-module erasure endpoints — live
  outside the kernel. The kernel is behind the product in this area.
- The kernel does not contain the full product schema (22 migrations here against 58 in the
  product), and the reference web shells shipped here are non-normative.
- The erasure guarantee described in §7 is **not currently met**; the defect is named, not
  hidden.
- No AVV, no Art. 26 arrangement, no Art. 30 record and no TOM annex exists yet. This
  document exists so that the eventual ones are written against a stated position rather
  than improvised.
