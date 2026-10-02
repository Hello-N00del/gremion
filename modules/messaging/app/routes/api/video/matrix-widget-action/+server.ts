// POST /api/video/matrix-widget-action
// Proxies Matrix Widget API send_event and read_events actions to the Matrix CS API
// on behalf of the authenticated user. Called by VideoCallPip.svelte's Widget API bridge
// when element-call sends fromWidget messages that require Matrix room operations
// (e.g. m.call.member state events for MatrixRTC call membership signaling).
import { json } from '@sveltejs/kit'
import type { RequestHandler } from '@sveltejs/kit'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import { getMessagesBackend } from '$lib/server/messages/backend'

interface SendEventRequest {
  action: 'send_event'
  roomId: string
  type: string
  content: Record<string, unknown>
  stateKey?: string
  // MSC4140 delayed events: delay in ms; parent_delay_id for chained delays
  delay?: number
  parentDelayId?: string
  // Widget API top-level field for m.room.redaction: the event ID to redact
  redacts?: string
}

interface ReadEventsRequest {
  action: 'read_events'
  roomId: string
  type: string
  stateKey?: string
}

interface UpdateDelayedEventRequest {
  action: 'update_delayed_event'
  delayId: string
  updateAction: 'restart' | 'cancel' | 'send'
}

type WidgetActionRequest = SendEventRequest | ReadEventsRequest | UpdateDelayedEventRequest

function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && roomId.startsWith('!')
}

function isValidEventType(type: unknown): type is string {
  if (typeof type !== 'string') return false
  const allowed = [
    // Legacy MatrixRTC call membership (MSC3401)
    'm.call.member',
    'org.matrix.msc3401.call',
    'org.matrix.msc3401.call.member',
    // New sticky RTC membership (MSC4143) — used by element-call latest-ci
    'org.matrix.msc4143.rtc.member',
    // Call notification / signalling (MSC4075, MSC4310)
    'org.matrix.msc4075.call.notify',
    'org.matrix.msc4075.rtc.notification',
    'org.matrix.msc4310.rtc.decline',
    // E2EE key exchange
    'io.element.call.encryption_keys',
    // In-call emoji reactions (custom element-call type) and standard Matrix reactions (raise-hand)
    'io.element.call.reaction',
    'm.reaction',
    // Redaction: used by element-call to clean up reactions and withdraw raised hands
    'm.room.redaction',
    // Standard room state that RoomWidgetClient reads during startClient()
    'm.room.create',
    'm.room.name',
    'm.room.member',
    'm.room.encryption',
  ]
  return allowed.some((prefix) => type === prefix || type.startsWith(prefix + '.'))
}

export const POST: RequestHandler = async (event) => {
  const session = await event.locals.auth()
  const keycloakJwt = (session as unknown as { accessToken?: string })?.accessToken
  if (!keycloakJwt) return json({ error: 'Unauthenticated' }, { status: 401 })

  let body: WidgetActionRequest
  try {
    body = (await event.request.json()) as WidgetActionRequest
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // update_delayed_event has no roomId or type — handle it before the shared validators
  if (body.action === 'update_delayed_event') {
    const validActions = ['restart', 'cancel', 'send'] as const
    if (!validActions.includes(body.updateAction)) {
      return json({ error: 'Invalid updateAction' }, { status: 400 })
    }
    if (typeof body.delayId !== 'string' || !body.delayId) {
      return json({ error: 'Missing delayId' }, { status: 400 })
    }
    const matrixBase2 = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')
    try {
      const matrixToken2 = await getMessagesBackend().matrix().getMatrixToken(keycloakJwt)
      const mgmtUrl = `${matrixBase2}/_matrix/client/unstable/org.matrix.msc4140/delayed_events/${encodeURIComponent(body.delayId)}/${body.updateAction}`
      const res = await fetch(mgmtUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${matrixToken2}` }
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        return json({ error: err.error ?? `Matrix error ${res.status}` }, { status: res.status })
      }
      return json({})
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 })
    }
  }

  if (!isValidRoomId(body.roomId)) {
    return json({ error: 'Invalid or missing roomId' }, { status: 400 })
  }
  if (!isValidEventType(body.type)) {
    return json({ error: `Event type '${String(body.type)}' not allowed` }, { status: 403 })
  }

  const matrixBase = (defaultTenantEnv('MATRIX_URL') ?? 'http://matrix:8008').replace(/\/$/, '')

  try {
    const matrixToken = await getMessagesBackend().matrix().getMatrixToken(keycloakJwt)
    const encodedRoom = encodeURIComponent(body.roomId)

    if (body.action === 'send_event') {
      // Redactions use the dedicated /redact/{eventId}/{txnId} endpoint.
      // The Widget API passes the event_id to redact in the top-level `redacts` field.
      if (body.type === 'm.room.redaction') {
        const eventIdToRedact = body.redacts ?? (body.content?.redacts as string | undefined)
        if (!eventIdToRedact) {
          return json({ error: 'Missing redacts field for m.room.redaction' }, { status: 400 })
        }
        const txnId = crypto.randomUUID()
        const redactUrl = `${matrixBase}/_matrix/client/v3/rooms/${encodedRoom}/redact/${encodeURIComponent(eventIdToRedact)}/${txnId}`
        const redactRes = await fetch(redactUrl, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${matrixToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body.content ?? {}),
        })
        const redactData = (await redactRes.json()) as { event_id?: string; error?: string }
        if (!redactRes.ok) {
          return json({ error: redactData.error ?? `Matrix error ${redactRes.status}` }, { status: redactRes.status })
        }
        return json({ eventId: redactData.event_id })
      }

      const isState = typeof body.stateKey === 'string'
      const hasDelay = typeof body.delay === 'number'
      // All events (delayed or not) use the standard v3 path.
      // MSC4140 delayed events use the ?org.matrix.msc4140.delay=N query param.
      const prefix = `${matrixBase}/_matrix/client/v3`

      let url: string
      if (isState) {
        url = `${prefix}/rooms/${encodedRoom}/state/${encodeURIComponent(body.type)}/${encodeURIComponent(body.stateKey!)}`
      } else {
        const txnId = crypto.randomUUID()
        url = `${prefix}/rooms/${encodedRoom}/send/${encodeURIComponent(body.type)}/${txnId}`
      }

      if (hasDelay) {
        const params = new URLSearchParams({ 'org.matrix.msc4140.delay': String(body.delay) })
        url += `?${params}`
      }

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${matrixToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body.content ?? {})
      })
      const data = (await res.json()) as {
        event_id?: string
        delay_id?: string
        errcode?: string
        error?: string
      }
      if (!res.ok) {
        // Synapse rejects duplicate m.reaction annotations ("Can't send same reaction twice").
        // This happens when a call crashed while the hand was raised — the previous
        // m.reaction is still in the room. Recover by finding the existing event_id so
        // element-call can track it and send m.room.redaction to lower the hand.
        if (
          body.type === 'm.reaction' &&
          res.status === 400 &&
          typeof data.error === 'string' &&
          data.error.toLowerCase().includes('same reaction')
        ) {
          const relatesTo = body.content?.['m.relates_to'] as
            | { event_id?: string; key?: string }
            | undefined
          if (relatesTo?.event_id && relatesTo?.key) {
            try {
              const whoamiRes = await fetch(`${matrixBase}/_matrix/client/v3/account/whoami`, {
                headers: { Authorization: `Bearer ${matrixToken}` },
              })
              const whoami = (await whoamiRes.json()) as { user_id?: string }
              if (whoami.user_id) {
                // Relations endpoint: /{eventId}/{relType}/{eventType}
                // eventType is "m.reaction" (the type of the relating event), NOT the key.
                // Filter by key from the content after fetching.
                const relUrl = `${matrixBase}/_matrix/client/v1/rooms/${encodedRoom}/relations/${encodeURIComponent(relatesTo.event_id)}/m.annotation/m.reaction`
                const relRes = await fetch(relUrl, {
                  headers: { Authorization: `Bearer ${matrixToken}` },
                })
                if (relRes.ok) {
                  const relData = (await relRes.json()) as {
                    chunk?: Array<{
                      sender: string
                      event_id: string
                      content?: { 'm.relates_to'?: { key?: string } }
                    }>
                  }
                  const existing = relData.chunk?.find(
                    (e) =>
                      e.sender === whoami.user_id &&
                      e.content?.['m.relates_to']?.key === relatesTo.key,
                  )
                  if (existing) {
                    return json({ eventId: existing.event_id })
                  }
                }
              }
            } catch {
              // fall through to return the original error
            }
          }
        }
        return json({ error: data.error ?? `Matrix error ${res.status}` }, { status: res.status })
      }
      // Return whichever identifier Synapse gave back (delayed or immediate event)
      return json(hasDelay ? { delay_id: data.delay_id } : { eventId: data.event_id })
    }

    if (body.action === 'read_events') {
      // The Matrix CS API /state/{type} and /state/{type}/{key} endpoints return
      // CONTENT only (not full event objects). Element-call needs full events
      // (type, state_key, room_id, sender, event_id, content). Fetch all room state
      // and filter client-side — the only Matrix API that returns full state event objects.
      const stateKey = body.stateKey
      const stateUrl = `${matrixBase}/_matrix/client/v3/rooms/${encodedRoom}/state`

      const res = await fetch(stateUrl, {
        headers: { Authorization: `Bearer ${matrixToken}` }
      })
      if (res.status === 404) return json({ events: [] })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        return json({ error: err.error ?? `Matrix error ${res.status}` }, { status: res.status })
      }
      const allState = (await res.json()) as Array<{ type?: string; state_key?: string }>

      // Filter by requested event type
      let events = allState.filter((ev) => ev.type === body.type)

      // Filter by state_key when a specific key is requested (not wildcard)
      if (typeof stateKey === 'string' && stateKey !== '*') {
        events = events.filter((ev) => ev.state_key === stateKey)
      }

      return json({ events })
    }

    return json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
