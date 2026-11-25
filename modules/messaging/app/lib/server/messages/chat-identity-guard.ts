// Conditions under which chat may run in MATRIX_IDENTITY=namespaced mode.
//
// In namespaced mode the app is the only party that decides which Matrix account a login is: it
// checks whose token it holds and mints the Matrix token through the Synapse admin API. That only
// holds while no other login path exists, so chat is refused (503, German) while
//
//   - the homeserver still offers a JWT or a single sign-on login (GET /_matrix/client/v3/login
//     lists a flow of type org.matrix.login.jwt or m.login.sso), or the list cannot be read, or
//   - messages run in the held service mode (MESSAGES_BACKEND=service), whose leaf still logs in by JWT.
//
// The reason goes to the server log, the user gets a neutral sentence.
import { error } from '@sveltejs/kit'
import { matrixIdentityMode } from './matrix-namespace'

const UNAVAILABLE = 'Der Chat ist derzeit nicht verfügbar. Bitte die Administration informieren.'

/** Login flow types that would give a second way to name a Matrix account. */
const FOREIGN_FLOWS = ['org.matrix.login.jwt', 'm.login.sso'] as const

/** How long a clean answer of the homeserver is trusted. A refusal is never remembered. */
const PROBE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 4_000

const okUntil = new Map<string, number>()
const probing = new Map<string, Promise<void>>()

function refuse(reason: string): never {
  console.error(`[chat-identity] chat refused: ${reason}`)
  throw error(503, UNAVAILABLE)
}

const SERVICE_REASON = 'MESSAGES_BACKEND=service still logs in by JWT'

/** The service client (the held leaf) asks this before it exchanges a token: in namespaced mode it is refused. */
export function refuseNamespacedServiceBackend(): void {
  if (matrixIdentityMode() === 'namespaced') refuse(SERVICE_REASON)
}

async function probeLoginFlows(baseUrl: string): Promise<void> {
  let flows: unknown
  try {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) refuse(`the login flow list answered ${res.status}`)
    flows = ((await res.json()) as { flows?: unknown }).flows
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'status' in err) throw err // the refusal above
    refuse(`the login flow list is not readable (${err instanceof Error ? err.name : typeof err})`)
  }
  if (!Array.isArray(flows)) refuse('the login flow list has no flows')
  for (const flow of flows as Array<{ type?: unknown }>) {
    const type = flow?.type
    if (typeof type === 'string' && (FOREIGN_FLOWS as readonly string[]).includes(type)) refuse(`the homeserver offers the ${type} login`)
  }
}

/**
 * Throws a 503 unless namespaced chat may run against this homeserver. A clean answer is cached for a
 * minute per homeserver, concurrent callers share one request, a failure is not cached.
 */
export async function assertNamespacedChatReady(baseUrl: string): Promise<void> {
  if (process.env.MESSAGES_BACKEND === 'service') refuse(SERVICE_REASON)
  const until = okUntil.get(baseUrl)
  if (until !== undefined && Date.now() < until) return
  let pending = probing.get(baseUrl)
  if (!pending) {
    pending = probeLoginFlows(baseUrl)
      .then(() => {
        okUntil.set(baseUrl, Date.now() + PROBE_TTL_MS)
      })
      .finally(() => {
        probing.delete(baseUrl)
      })
    probing.set(baseUrl, pending)
  }
  await pending
}

/** Test-only: forget every cached probe answer. */
export function __resetChatIdentityGuardForTests(): void {
  okUntil.clear()
  probing.clear()
}
