import { error } from '@sveltejs/kit'
import type { RequestEvent, RequestHandler } from '@sveltejs/kit'
import { getMessagesBackend } from '$lib/server/messages/backend'
import type { SessionUser } from '$lib/auth'

function requireAuth(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  return user
}

async function getKeycloakJwt(event: RequestEvent): Promise<string> {
  const authHeader = event.request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  const session = await event.locals.auth()
  const accessToken = (session as unknown as { accessToken?: string })?.accessToken
  if (!accessToken) throw error(401, 'No Keycloak access token in session')
  return accessToken
}

// GET — long-poll sync exposed as SSE stream
export const GET: RequestHandler = async (event) => {
  requireAuth(event)

  const mc = getMessagesBackend().matrix()
  let matrixToken: string
  try {
    const keycloakJwt = await getKeycloakJwt(event)
    matrixToken = await mc.getMatrixToken(keycloakJwt)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw error(502, `Matrix authentication failed: ${msg}`)
  }

  let since: string | undefined = event.url.searchParams.get('since') ?? undefined

  // Heartbeat timer — cleared on stream end or cancel.
  // Without this, the 30-second Synapse long-poll leaves the SSE connection
  // idle long enough for proxies and browsers to close it (→ "Fehler" status).
  let heartbeat: ReturnType<typeof setInterval> | null = null
  // Set by cancel(): the browser went away. The in-flight sync still resolves
  // afterwards and its write then throws — that is a disconnect, NOT a sync
  // failure, and must not be reported as one.
  let clientGone = false

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const write = (data: string) => controller.enqueue(encoder.encode(data))

      // SSE comment lines (: …) keep the connection alive without triggering onmessage.
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch { /* stream closed */ }
      }, 15_000)

      try {
        while (true) {
          try {
            const syncResp = await mc.sync(matrixToken, since)
            since = syncResp.nextBatch
            write(`data: ${JSON.stringify(syncResp)}\n\n`)
          } catch (e) {
            if (clientGone) break
            // Observable, not silent. The previous bare `catch {}` discarded the
            // cause entirely and emitted `{ error: 'sync failed' }` on the DEFAULT
            // message channel — a shape the client cannot consume: its onmessage
            // parses the payload as the `{ nextBatch, rooms }` sync snapshot and
            // iterates `sync.rooms`, so the resulting TypeError was swallowed by
            // its own `catch` and the failure vanished on both sides.
            // The error now leaves as a NAMED `sync-error` event (never reaches
            // onmessage) that /messages listens for, and the cause is logged here.
            const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
            console.error('[messages/sync] Matrix sync failed — closing SSE stream:', msg)
            try {
              // `retry:` lifts the browser's reconnect delay off its ~3 s default so
              // a persistently failing sync cannot hot-loop Synapse via reconnects.
              write(`retry: 15000\nevent: sync-error\ndata: ${JSON.stringify({ error: 'sync failed' })}\n\n`)
            } catch { /* client already disconnected */ }
            break
          }
        }
      } finally {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
        // The response MUST terminate. Without close() the ReadableStream stayed
        // open forever after the break — no data, no heartbeat, no FIN — so the
        // browser's EventSource neither fired onerror nor reconnected and the UI
        // kept reporting "live" against a stream that had already stopped.
        try { controller.close() } catch { /* already closed / cancelled */ }
      }
    },
    cancel() {
      // browser disconnected — clear heartbeat immediately
      clientGone = true
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}
