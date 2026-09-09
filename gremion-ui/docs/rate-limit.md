# Rate-limit policy (gremion-ui)

The gremion-ui API enforces per-tier in-memory rate limits to cap abuse of
state-changing endpoints. The single source of truth is
[`src/lib/server/rate-limit.ts`](../src/lib/server/rate-limit.ts) — this
document describes the policy, not the implementation.

Closes gap **G-010** (Wave 3a, task T3.1).

## Policy

| Tier              | Limit | Window | Applies to                                       | Key            | Where enforced                                              |
|-------------------|------:|--------|--------------------------------------------------|----------------|-------------------------------------------------------------|
| Setup config      |   5   | 1 hour | `/api/setup/config`, `/api/setup/admins`         | Client IP      | Inside each handler, **before** setup-token validation      |
| Public unsubscribe|  10   | 1 hour | `/api/newsletter/unsubscribe`                    | Client IP      | Inside the handler, **before** token lookup                 |
| Newsletter send-now |  3 | 1 hour | `/api/newsletter/[id]/send-now`                  | User id        | Inside the handler, after the role gate                     |

> **gremion#22 finding 3:** the Finance-mutation tier (`requireFinanceRateLimit`
> + a `financeRateLimitGuard` hook in `hooks.server.ts`) documented here in an
> earlier revision was carve residue: finance is a leaf microservice, not part
> of this kernel, so there was never an `/api/finance/**` route in
> `gremion-ui/src/routes` for that hook to guard, and no such hook exists in
> `hooks.server.ts`. The helper and its tier were removed from `rate-limit.ts`
> rather than left as dead code describing a gate that doesn't run. A finance
> vertical re-attaching that surface should add its own rate limit at the leaf
> (or reintroduce a tier here scoped to the route it actually owns).

All tiers respond with `429 Too Many Requests`, a JSON envelope
(`{ success: false, error: 'Rate limit exceeded' }`), and a fixed
`Retry-After: 60` header when exhausted.

## Why these limits

- **Setup (5/hour, IP):** the setup token is bearer-style and only present
  during initial install. The IP-keyed cap blunts brute-force guessing of
  the token without locking out a legitimate operator working through the
  wizard. Limit runs **before** token validation so wrong-token attempts
  still count.
- **Unsubscribe (10/hour, IP):** the endpoint is unauthenticated by design
  (one-click email links). IP is the only stable identity available; the
  ceiling is high enough that an entire office sharing an egress IP can
  still unsubscribe in a normal session.
- **Newsletter send-now (3/hour, user):** even with admin role, runaway
  send-now triggers can flood subscribers. The 3/hour cap forces a
  deliberate sending rhythm.

## Enforcement points

Every current tier uses the same pattern: a **per-handler
`require*RateLimit(key)` call** — setup, unsubscribe, and newsletter
send-now. Each helper returns either a 429 `Response` (to short-circuit) or
`null`. The handler keeps full control over where the check sits relative to
other validation.

(A hook-level guard variant — pattern-matching a route prefix + HTTP method
in `hooks.server.ts` before the handler runs, to avoid replicating the same
check across many route files — was used for finance mutations before that
surface was carved out into its own leaf service. See the finding-3 note
above.)

## Operational notes

- **In-memory only.** Buckets are stored in a process-local `Map` (see
  `rate-limit.ts`). A horizontally scaled deployment will undercount
  cross-instance — for gremion-ui's single-instance Node deployment this is
  intentional. If we ever scale out, the limiter must move behind Redis.
- **Fixed-window, not rolling.** Each key gets a single bucket whose
  `resetAt` ticks `windowMs` into the future on the first request after
  expiry. This is fine for the current tiers; a burst at the window
  boundary can issue `2*limit` in a short interval, which is well within
  what these limits are designed to cap.
- **`__resetRateLimits()`** in `rate-limit.ts` is a test-only escape
  hatch; production code must not import it.

## Tests

- Route integration:
  [`src/lib/server/rate-limit-routes.integration.test.ts`](../src/lib/server/rate-limit-routes.integration.test.ts)
  — one positive + one 429 case per tier.
