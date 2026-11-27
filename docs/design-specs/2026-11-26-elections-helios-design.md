# Elections: secret internal votes and Umlaufbeschlüsse on Helios

**Date:** 2026-11-26
**Status:** Draft for operator approval
**Scope:** modules/elections, a Helios service on the host, the votes and resolution records

## 1. Intent and why

Councils hold internal votes: electing finance deputies, the Vorstand or Referat members, and
**Umlaufbeschlüsse** (decisions taken outside a meeting). Today the pilot council runs
Umlaufbeschlüsse by everyone sending their vote by e-mail. Secret ballots with a visible result and a
visible list of who has taken part raise the credibility of those decisions.

This is the module where most bugs surfaced before (55 recorded problems, see section 3), so it is
also the one that needs the most testing against the running system.

Scale: about 10 votes a semester per council, sometimes more. Voters are members of the body in
Gremion, signing in through their customer's login. No external voter lists.

## 2. Goals, non-goals, anti-goals

Goals
- Secret votes for personnel elections and Umlaufbeschlüsse, run on Helios (end-to-end verifiable).
- During a vote: everyone in the body sees who has already voted and how many are missing, never how
  anyone voted. After: the result (counts, quorum met or not) and the participation list are recorded
  in Gremion's resolution record and the next minutes; the Helios proof stays linked.
- Gremion's own voting screen (operator decision), with the encryption done by Helios's own
  JavaScript library from the same pinned Helios version the server runs.
- Current upstream Helios (benadida/helios-server master, not the January 2026 pin).
- Several customers on one install, strictly separated.

Non-goals
- External voter lists, large electorates, external trustees and key ceremonies.
- Replacing the university's own statutory election service (see section 7, question 1).

Anti-goals
- A ballot our screen produces that Helios would not accept or count, discovered only in a real vote.
- One customer seeing, voting in or tallying another customer's election.
- A green test that never cast a real encrypted ballot.

## 3. Constraints and facts (read 2026-11-26)

- Full history: `.claude/pilot-2026-11-14/HELIOS-history-2026-11-26.md` (operator workspace;
  summarised here). Failure classes, most frequent first: image/build/deploy drift; sign-in handoff
  (realm, paths, return URL, cookies, issuer); the app's Helios client contract (HTML forms, not an
  API); service-account provisioning after a reseed; backup/restore/erasure; async work and e-mail;
  embedding headers; deselection and multi-customer config; ballot/tally/trustee (least exercised).
- **The existing native ballot screen cannot work:** it calls the Helios crypto with the wrong
  functions and argument order; no vote has ever been cast end to end in it, and its e2e test is off.
- **Upstream since the old pin (54 commits):** ballot and tally verification fixes, CSRF on
  state-changing views, same-site return URL checks, Django 5.2, Celery replaced by django-tasks with
  a database worker (a new worker container), a changed rule for a tied last seat (left unfilled).
  OIDC sign-in is not upstream (an open upstream PR), so our Keycloak backend stays our code.
- **Kernel today:** modules/elections is an app half plus a Helios client, HELD_OFF in
  gremion-ui/src/lib/modules/held-off.ts; its Helios URL, public URL and service account are one
  value per install; the freeze action does not check that the election belongs to the customer.
- **Binding scope rule:** docs/compliance/elections-scope.md (TASK-005) limits the module to
  internal, non-statutory polls, keeps it off for the pilot and forbids presenting it as fit for
  statutory use. This design's purpose may conflict with it (section 7, question 1).

## 4. Approaches considered

Where people cast their vote:
1. **Helios's own voting page opened from Gremion.** Upstream-tested, cannot mismatch the crypto;
   looks like Helios.
2. **Gremion's own voting screen** (chosen by the operator): keeps the Gremion experience complete.
   Its risk (mismatching the crypto) is closed by using Helios's own JavaScript library and a test
   that casts a real ballot.
3. Helios page first, native screen later. Not chosen.

How customers are separated:
1. **One Helios per install**, separated by per-customer sign-in clients and by tying every election
   to its customer in Gremion and in Helios (my proposal: at this scale a second server per customer
   is not worth it, provided the cross-customer tests pass).
2. One Helios per customer. The fallback if separation cannot be proven.

Trustee: the Helios server itself (no external key holders) for these internal votes.

## 5. Design

### 5.1 Helios service

- Built from a pinned upstream master commit plus our overlay (Keycloak sign-in backend,
  framing/redirect middlewares, service-account bootstrap), re-derived against the new upstream
  files rather than overwriting them; runs as a compose service with its database worker.
- One sign-in client per customer realm; Helios stores which customer an election belongs to; every
  Gremion call names the customer and Helios refuses another customer's election.
- Per-customer public URL handed to pages by the load function (no process-wide public URL in pages).
- The service account is provisioned on every start and checked by a gate, not by hand.

### 5.2 Votes in Gremion

- **Personnel election:** candidates, number of seats, voting members of the body at start.
- **Umlaufbeschluss:** a motion as yes / no / abstain, a deadline; started by the body's chair or
  Vorstand (default; adjustable to the body's rules); voters are the body's voting members (`member`
  role, not `helper`) at the moment it starts.
- While open: participation list (names of who has voted) and missing count, live; reminders to
  those who have not voted.
- Closes at the deadline or when everyone has voted; Helios tallies; Gremion records counts, quorum,
  participation and the link to the Helios proof in the resolution record and the next minutes.

### 5.3 Voting screen

- Gremion's own screen; ballot encryption and proofs come from Helios's JavaScript library served
  from the same pinned Helios build (no re-implementation in our code).
- A contract test casts real encrypted ballots against a real Helios at that pin and checks they are
  accepted and counted; it runs in CI and against the test environment, so an upstream change that
  breaks the screen fails before release.

## 6. Testing (each failure class gets a check against the running system)

- Build/deploy: the running Helios container's settings, overlay files and source commit match the
  repo (hash comparison), the worker runs, debug is off, the user is not root.
- Sign-in: a voter signs in through the customer realm and lands back in Gremion; the disabled
  sign-in backends and the password-reset path answer 404; a foreign return URL is refused; cookies
  carry the expected flags on the real host.
- Client contract: create (including a duplicate name), voter upload, freeze, open, close, tally, a
  transient Helios outage, no orphaned elections.
- Service account: delete it, restart Helios, creating an election still works.
- Lifecycle: backup holds the Helios database, a restore into a scratch database has the same counts.
- Multi-customer: customer A cannot list, open, vote in, freeze or tally B's election (by id or name);
  a voter of realm A cannot sign in to B's election.
- Ballot end to end on the test environment: an Umlaufbeschluss and a personnel election with several
  test members, real encrypted ballots from the Gremion screen, tally equals the cast intent,
  participation list correct, result recorded in the minutes.

## 7. Open questions only the operator can answer

1. **Scope rule conflict.** docs/compliance/elections-scope.md allows only internal, non-statutory
   polls, keeps the module off for the pilot and forbids presenting it as fit for statutory use.
   Electing a Vorstand or finance deputies and binding Umlaufbeschlüsse may be statutory acts under
   the council's own rules. Does the rule change (and who confirms that legally), or are these votes
   explicitly advisory with the council's own formal record elsewhere?
2. **Tie on the last seat:** upstream now leaves it unfilled. Acceptable for the council's rules, or
   does Gremion need its own tie rule (for example a run-off)?
3. **Who may start an Umlaufbeschluss and what quorum applies** by default, before a council sets its own?

## 8. Left to the builder

The pin commit, the overlay re-derivation, how Gremion drives Helios (forms with CSRF tokens or a
small API added in the overlay), the worker setup, the screen design, and the order of the tests.
