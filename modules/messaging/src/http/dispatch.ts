// services/messages/src/http/dispatch.ts
// The messages+video leaf's per-op forwarding router. Given a matched Operation +
// the parsed JSON body + the resolved LeafDeps, it performs the Matrix / LiveKit /
// Synapse op AS the per-request caller and returns the EXACT JSON envelope the
// kernel ServiceMessagesClient (backend/service-client.ts) expects — pinned by
// test/forwarding.test.ts against contracts/messages/openapi.messages-internal.json.
//
// This is the code the MESSAGES_BACKEND=service cutover switches on; flag OFF the
// kernel uses its in-process clients and never reaches here. Any upstream failure
// is mapped to a 502 UpstreamError envelope (never thrown out of dispatch) so the
// http server always sends a well-formed response.
import { randomUUID } from 'node:crypto'
import type { Operation } from '../operations.js'
import type { LeafDeps } from './deps.js'
import { mintLivekitToken } from '../livekit/livekit-client.js'

export interface DispatchResult {
  status: number
  body: unknown
}

const OK = { success: true }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export async function dispatchOp(op: Operation, body: Record<string, unknown>, deps: LeafDeps): Promise<DispatchResult> {
  try {
    return { status: 200, body: await route(op, body, deps) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 502, body: { success: false, error: message } }
  }
}

async function route(op: Operation, body: Record<string, unknown>, deps: LeafDeps): Promise<unknown> {
  const { matrix, synapse, livekit } = deps
  switch (op.op) {
    // ── messages.* (per-request user Matrix token) ────────────────────────────
    case 'messages.sync':
      return matrix.sync(str(body.userToken), optStr(body.since))

    case 'messages.rooms': {
      if (body.unread === true) {
        const counts = await matrix.unreadMessageCountsByRoom(str(body.userToken))
        return { counts: Object.fromEntries(counts) }
      }
      return { rooms: await matrix.getJoinedRooms(str(body.userToken)) }
    }

    case 'messages.list':
      return matrix.getMessages(str(body.userToken), str(body.roomId), optStr(body.from))

    case 'messages.send': {
      const content = (isObj(body.content) ? body.content : {}) as { msgtype: string; body: string; url?: string }
      return { eventId: await matrix.sendMessage(str(body.userToken), str(body.roomId), content) }
    }

    case 'messages.read':
      await matrix.setReadMarker(str(body.userToken), str(body.roomId), str(body.eventId))
      return OK

    case 'messages.typing':
      await matrix.sendTyping(str(body.userToken), str(body.roomId), str(body.userId), body.typing === true)
      return OK

    case 'messages.media.upload': {
      const buf = Buffer.from(str(body.data), 'base64')
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const mxc = await matrix.uploadMedia(str(body.userToken), ab, str(body.mimeType), str(body.filename))
      return { mxc }
    }

    case 'messages.media.download': {
      const { data, contentType } = await matrix.downloadMedia(str(body.mxcUri))
      return { data: Buffer.from(data).toString('base64'), contentType }
    }

    // ── video.* ───────────────────────────────────────────────────────────────
    case 'video.token':
      return {
        token: mintLivekitToken(livekit, str(body.roomName), {
          identity: str(body.identity),
          displayName: str(body.displayName),
          canPublish: body.canPublish === true,
        }),
      }

    case 'video.meeting-room':
      return meetingRoom(body, deps)

    case 'video.openid-token': {
      const userToken = str(body.userToken)
      const { userId } = await matrix.whoami(userToken)
      const openidToken = await matrix.cs('POST', `/_matrix/client/v3/user/${encodeURIComponent(userId)}/openid/request_token`, userToken, {})
      return { userId, openidToken }
    }

    case 'video.widget-action':
      return widgetAction(body, deps)

    // ── auth.* (Keycloak→Synapse token exchange + device admin) ───────────────
    case 'auth.matrix-token': {
      const matrixToken = await matrix.getMatrixToken(str(body.keycloakJwt), optStr(body.deviceId))
      const { userId, deviceId } = await matrix.whoami(matrixToken)
      return { matrixToken, matrixUserId: userId, matrixDeviceId: deviceId }
    }

    case 'auth.matrix-device':
      await synapse.deleteDevice(str(body.localpart), str(body.deviceId))
      return OK

    default:
      // Unreachable: OPERATION_BY_PATH only yields the 14 known ops.
      throw new Error(`unhandled op: ${op.op}`)
  }
}

// video.meeting-room is the admin/room-ops multiplex — the same endpoint the
// kernel ServiceMessagesClient routes createRoom / inviteUser / joinRoom /
// synapse.forceJoinRoom / (#370) synapse.listAllRoomIds through. Dispatch on the
// discriminant key; the default (no key) is createRoom.
async function meetingRoom(body: Record<string, unknown>, deps: LeafDeps): Promise<unknown> {
  const { matrix, synapse } = deps
  if (body.listRooms === true) return { roomIds: await synapse.listAllRoomIds() }
  const forceJoin = body.forceJoin
  if (isObj(forceJoin)) {
    await synapse.forceJoinRoom(str(forceJoin.roomId), str(forceJoin.userId))
    return OK
  }
  const invite = body.invite
  if (isObj(invite)) {
    await matrix.inviteUser(str(invite.roomId), str(invite.userId))
    return OK
  }
  const join = body.join
  if (isObj(join)) {
    await matrix.joinRoom(str(join.userToken), str(join.roomIdOrAlias))
    return OK
  }
  return { roomId: await matrix.createRoom(str(body.name), str(body.topic), optStr(body.aliasLocalpart)) }
}

// Proxy an element-call Widget API action (send_event / read_events /
// update_delayed_event) as the caller. Mirrors the kernel matrix-widget-action
// route's core paths (state vs timeline send, MSC4140 delayed send, redaction is
// a send_event of type m.room.redaction handled generically by the caller).
async function widgetAction(body: Record<string, unknown>, deps: LeafDeps): Promise<unknown> {
  const { matrix } = deps
  const userToken = str(body.userToken)
  const action = str(body.action)

  if (action === 'update_delayed_event') {
    const delayId = str(body.delayId)
    const updateAction = str(body.updateAction)
    await matrix.cs('POST', `/_matrix/client/unstable/org.matrix.msc4140/delayed_events/${encodeURIComponent(delayId)}/${encodeURIComponent(updateAction)}`, userToken)
    return {}
  }

  const roomId = str(body.roomId)
  const encodedRoom = encodeURIComponent(roomId)
  const type = str(body.type)

  if (action === 'read_events') {
    const state = (await matrix.cs('GET', `/_matrix/client/v3/rooms/${encodedRoom}/state`, userToken)) as Array<{ type?: string; state_key?: string }>
    let events = state.filter((ev) => ev.type === type)
    const stateKey = optStr(body.stateKey)
    if (typeof stateKey === 'string' && stateKey !== '*') events = events.filter((ev) => ev.state_key === stateKey)
    return { events }
  }

  // send_event (timeline, state, or MSC4140 delayed).
  const content = isObj(body.content) ? body.content : {}
  const stateKey = optStr(body.stateKey)
  const delay = typeof body.delay === 'number' ? body.delay : undefined
  let path: string
  if (typeof stateKey === 'string') {
    path = `/_matrix/client/v3/rooms/${encodedRoom}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`
  } else {
    path = `/_matrix/client/v3/rooms/${encodedRoom}/send/${encodeURIComponent(type)}/${randomUUID()}`
  }
  if (delay !== undefined) path += `?${new URLSearchParams({ 'org.matrix.msc4140.delay': String(delay) })}`
  const res = (await matrix.cs('PUT', path, userToken, content)) as { event_id?: string; delay_id?: string }
  return delay !== undefined ? { delay_id: res.delay_id } : { eventId: res.event_id }
}
