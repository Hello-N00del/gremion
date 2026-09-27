// Minimal shim for invoking a SvelteKit `+server.ts` route handler in tests.
//
// Single responsibility: take a finance route descriptor (path + HTTP method),
// dynamically import the corresponding handler, and call it with a synthetic
// `locals` shape so the test can assert the status code.
//
// Used by `api-role-gate.integration.test.ts` (G-001). Not a general-purpose
// fixture library — keep additions strictly to what that test needs.

import type { Role } from '$lib/auth/types'

export interface CallHandlerRoute {
  /** Path relative to `src/routes/api/finance/`, e.g. `budget/[id]/approve`. */
  path: string
  /** HTTP method exported by the route's `+server.ts` (GET / POST / etc.). */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Synthetic params object (defaults to `{}`). */
  params?: Record<string, string>
  /** Optional JSON body for POST/PATCH. */
  body?: unknown
  /** Optional search params (e.g. `{ format: 'xlsx' }`). */
  search?: Record<string, string>
}

export interface CallHandlerLocals {
  /** Synthetic authenticated user, or `null` for anonymous. */
  user: { id: string; roles: Role[] } | null
  /** Optional accessToken — supplied to `locals.auth()` for routes that still need it. */
  accessToken?: string
}

/**
 * Dynamically import the route's `+server.ts` and invoke the requested
 * handler with a synthetic locals/params/request shape.
 *
 * Returns the `Response` produced by the handler (the test inspects `.status`).
 */
export async function callHandler(
  route: CallHandlerRoute,
  locals: CallHandlerLocals,
): Promise<Response> {
  // Dynamic import resolved relative to this file:
  //   src/lib/test/handler-helpers.ts -> src/routes/api/finance/<path>/+server.ts
  const mod = await import(
    /* @vite-ignore */ `../../routes/api/finance/${route.path}/+server.ts`
  )

  const handler = mod[route.method] as
    | ((event: unknown) => Promise<Response>)
    | undefined
  if (typeof handler !== 'function') {
    throw new Error(
      `route ${route.path} has no exported ${route.method} handler`,
    )
  }

  const event = {
    locals: {
      user: locals.user,
      // G-006: routes read accessToken from locals (populated by authGuard).
      // Mirror that here for tests; only present when the synthetic user is
      // logged in so anonymous tests still see a null token.
      accessToken: locals.user ? (locals.accessToken ?? null) : null,
      auth: async () =>
        locals.user ? { user: locals.user, accessToken: locals.accessToken } : null,
    },
    params: route.params ?? {},
    request: new Request('http://localhost/test', {
      method: route.method,
      headers: { 'content-type': 'application/json' },
      body:
        route.method === 'GET' || route.body === undefined
          ? undefined
          : JSON.stringify(route.body),
    }),
    url: new URL(
      `http://localhost/test?${new URLSearchParams(route.search ?? {}).toString()}`,
    ),
    // SvelteKit's context-aware event.fetch. Some handlers destructure it
    // (e.g. `async ({ fetch }) => ...`) instead of using globalThis.fetch,
    // so a vi.stubGlobal won't intercept it. Provide a benign stub here.
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }

  return handler(event)
}
