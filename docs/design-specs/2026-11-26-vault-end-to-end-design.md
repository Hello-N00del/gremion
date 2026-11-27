# Vault: an end-to-end encrypted vault for councils and their units

**Date:** 2026-11-26
**Status:** Draft for operator approval
**Scope:** modules/vault (rewrite of the data and key model), gremion-ui pages, the host

## 1. Intent and why

Councils keep shared passwords today in a shared Vaultwarden: passwords for the whole council and
passwords that belong to one Referat ("referatsspezifisch"). Gremion's own vault replaces it so the
council has full control and access follows the council's real structure. It starts with passwords
and grows to secure notes and encrypted files, such as the bank PIN.

The server operator (us) must never be able to read an entry: the server holds ciphertext only.

## 2. Goals, non-goals, anti-goals

Goals
- Entries (passwords first; secure notes and files next) per unit: the council itself or any unit below it.
- Access follows Gremion unit membership, granted with the cryptographic step in section 5.3.
- End-to-end encryption: encryption and decryption happen in the browser; the server stores and
  returns ciphertext and wrapped keys only.
- Nothing is lost when a unit's members all rotate out: recovery flows up the unit tree to the
  council, and the council has an out-of-system recovery key.
- Import from a Vaultwarden export.
- Revealing an entry needs a fresh second login and is logged; every key grant is logged.

Non-goals
- Being a Bitwarden-compatible server, browser extensions or mobile autofill (later, if at all).
- Recovery by the operator. There is none by design.
- Keeping the Vaultwarden launcher (`/vault-extern`).

Anti-goals
- Any key, passphrase or plaintext reaching the server, a log or a backup in readable form.
- Access granted by a membership change alone without a key holder's cryptographic grant (that
  would mean the server can decrypt).
- One customer's ciphertext or metadata reachable from another customer.

## 3. Constraints and facts (read 2026-11-26)

- Today's modules/vault: a leaf service with ONE database for all customers (VAULT_PG_URL), ONE
  server-side AES-256-GCM key, items looked up by id alone, the list keyed by org unit id only
  (audit 2026-11-26, vault section). It is in modules/disabled.json and has no compose service.
  The step-up-before-reveal and the access log exist and are kept as behaviour.
- Unit tree: customers have one top-level body (the council) with units below it, at any depth
  (gremion kernel `org_units.parent_id`).
- The member import and the app already know who belongs to which unit; that is the access policy.

## 4. Approaches considered

1. **Server-side encryption (today's module).** Rejected by the operator: whoever runs the host
   could decrypt.
2. **Run Vaultwarden per customer and integrate it.** Rejected: less control, access does not follow
   Gremion units, a second account model.
3. **Native end-to-end vault with personal keys and unit keys** (chosen). Full control, access
   follows units, server sees ciphertext only.

Recovery for an emptied unit, considered: a paper key per unit, a split key among several board
members, no recovery, or recovery up the unit tree to the council (chosen), plus one out-of-system
recovery key for the council itself (chosen).

## 5. Design

### 5.1 Keys

- **Personal key pair** per user per customer, created in the browser on first vault use. Its
  private half is stored on the server only encrypted under a key derived from the user's **vault
  passphrase** (a slow key derivation such as Argon2id) or protected by a **passkey** where the
  browser supports the needed extension. The vault passphrase is separate from the Gremion login.
- **Unit key** (symmetric) per unit, created in the browser when the unit's vault is first used.
  The server stores it only **wrapped**: once per member with access (under that member's public
  key) and once under the **parent unit's key**. The council's key is the root.
- **Entries** are encrypted in the browser under their unit's key (an authenticated cipher); the
  server stores ciphertext plus the minimum metadata needed to list (see open question 3).

### 5.2 Recovery

- Up the tree: any holder of a parent unit's key can unwrap a child unit's key, so the council can
  always recover every unit below it.
- **Council recovery key:** created in the browser when the council vault is set up, shown once as
  a 24-word list and as a one-page printout with the same key as a QR code, never sent to the
  server. The council key is additionally wrapped under it. It restores the council key when the
  whole council has rotated out. A "replace recovery key" action re-wraps under a new one and
  invalidates the old wrap.

### 5.3 Granting access

- Membership in Gremion makes a person **eligible**; access needs a **grant**: a current key holder
  of the unit (or of any ancestor unit) has their browser wrap the unit key for the newcomer's
  public key. The app shows pending grants to key holders and the newcomer sees "waiting for a
  grant".
- Leaving a unit removes the person's wrapped copy. Entries they could read stay readable to them
  only if they copied them; the design offers a **rotate unit key** action that re-encrypts the
  unit's entries under a new key and re-wraps for the current members (recommended after a term ends).
- Every grant, revocation, rotation, reveal and recovery use is written to the access log (who, for
  whom, which unit, when), never with key material.

### 5.4 Data plane

- One database per customer (`t_<hex>__vault`, the platform's per-customer pattern), not a shared table.
- Items are addressed by customer and id; a foreign id answers 404, not 403.
- The leaf runs as a compose service; it never sees plaintext or unwrapped keys.

### 5.5 Import

- Upload a Vaultwarden (Bitwarden JSON) export in the browser, choose the target unit per folder or
  collection, encrypt in the browser, then send ciphertext. The export file never reaches the server.

## 6. Testing

- A server-side probe over the database and the logs finds no plaintext, no unwrapped key, no
  passphrase (seeded canary values).
- Two customers: no cross-customer read of any item, list or log, by id or token.
- Grant flow: newcomer cannot decrypt before the grant, can after; a removed member cannot fetch
  their wrap; rotation makes the old key useless.
- Recovery: empty a unit, recover it as a council member; empty the council, recover with the
  printed key and with the word list; replace the recovery key and prove the old one fails.
- Step-up before reveal and the access log, as today.
- Import of a Vaultwarden export with folders and special characters.

## 7. Open questions only the operator can answer

1. **Vault passphrase or passkey first?** A passphrase works everywhere; passkeys are smoother but
   the needed browser support is not universal. My call: passphrase first, passkey as an option.
2. **Who holds the printed recovery key** by default (the office safe, the finance officer, the
   Vorstand)? The design only records that one exists and when it was last replaced.
3. **Entry titles and URLs:** encrypt them too (the list then decrypts in the browser) or keep them
   readable on the server for search? My call: encrypt them; units are small enough.

## 8. Left to the builder

Concrete algorithms and libraries (WebCrypto and/or libsodium), the key derivation parameters,
the wrapping formats and their versioning, the migration path from today's vault tables (none hold
real data), and the page design.
