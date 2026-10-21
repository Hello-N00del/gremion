# Open polls: the two forms, what is not claimed, and how usage is measured

> **Status: product documentation for the pilot (TASK-058).** It states the rules the
> poll copy and the usage counter have to meet. The counter table and its writer are
> built by later tasks; section 5 lists what is and is not in place today.

A council can open an **open (non-secret) poll** among its members: any member opens
it, every other member answers it and sees the result. During the pilot the platform
offers this in **two forms side by side**. Neither is a fallback for the other.

## 1. The two forms

| | Votes poll | Chat poll |
|---|---|---|
| Where it lives | The votes module's own poll (a wrapper around a Nextcloud Polls instance) | A native Matrix poll (MSC3381) in the council's chat room |
| Recorded in the register | Yes, on the terms of the register (PRD-DEC-007) | No, it is an informal sounding |
| Rendered by | The web and mobile apps' votes screens | Both clients, natively |
| Counted from | The register: per body, period and mode, with no content | The chat counter described in section 4 |

Which form members actually use is measured during the pilot; the standard form is
decided afterwards on that measurement (TRD-272, PRD-DEC-010).

## 2. What no copy may claim (TRD-264)

Neither form is anonymous and neither checks who may answer, as built. Until the votes
poll's wrapper closes both gaps, **no end-user text, screen string, portal page, offer or
demo script may describe either poll form as**

- anonymous, secret or "geheim" (a secret poll is a separate, later requirement,
  PRD-DEC-007, not a property of these forms), or
- restricted to an eligible electorate, "stimmberechtigt" or checked against a member
  list.

What may be said, in German or English: an open poll among the council's members;
answers are visible to the other members; an indicative decision, not a Beschluss; the
votes poll is recorded in the register and the chat poll is not.

The broader wording rules for elections and secret ballots stay in
[../../compliance/elections-scope.md](../../compliance/elections-scope.md); they apply
to these polls as well.

The check is by inspection: read the strings of both forms for any of the words above.

## 3. When measurement starts

Usage is measured **from go-live**, the moment the council starts using the platform for
its own business. Polls opened while the customer is being provisioned, rehearsed or
tested by the operator are not counted, and the first measurement period of a council
starts no earlier than its go-live. Nothing is estimated or back-filled for the time
before.

## 4. What is counted, and where

For each form, per body or council-wide, per period:

- the number of polls opened,
- the number of answers recorded.

Counts only. No poll question, option, answer or person is stored in a counter.

- **Votes poll:** counted from the register.
- **Chat poll:** the chat counter (`msg.poll_usage`, DB-MSG-POLL-USAGE) holds one row
  per customer, optional body, and period (`period_end` after `period_start`) with
  `polls_opened` and `answers_recorded`, and says where the number came from
  (`count_source`): `homeserver_aggregate` when the chat server can count it, or
  `operator_count` when the polls sit in end-to-end encrypted rooms that the server
  cannot read and the operator counts them by hand. A row is unique per customer, body,
  period and source; a customer-wide count has no body.

Retention: the counter is kept until the decision on the standard form is recorded, plus
a grace period (retention class `rp-msg-pollusage`).

## 5. What is in place today

| Part | State |
|---|---|
| Both poll forms offered to the pilot council | Enabled through the pilot's create request (the votes module); see TRD-046 |
| No anonymity or eligibility claim in end-user copy | Rule above; inspection |
| Chat counter table and its writer | Defined in the data model; built by a later task |
| Measurement window opening at go-live | Rule above; enforced by the writer when it is built |
| The reading of both counters at the decision | After the pilot period |

Until the writer exists, the operator's count is the source for the chat form, and it is
recorded with `count_source = operator_count`.
