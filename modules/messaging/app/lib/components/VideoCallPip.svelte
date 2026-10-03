<!-- gremion-ui/src/lib/components/VideoCallPip.svelte -->
<script lang="ts">
  import { untrack } from 'svelte'
  import { callStore, endCall, setFullscreen, setExpanded } from '$lib/stores/call-store.svelte'
  import { draggable } from '$lib/actions/draggable'
  import { env } from '$env/dynamic/public'
  import type { SessionUser } from '$lib/auth/types'

  interface MatrixCredentials {
    userId: string
    matrixBaseUrl: string
    openidToken: {
      access_token: string
      token_type: string
      matrix_server_name: string
      expires_in: number
    }
  }

  let { user }: { user: SessionUser | undefined } = $props()

  let dmRoomAlias = $state<string | null>(null)
  let error = $state<string | null>(null)
  // Separate loading flags so group + DM loading states don't race each other
  let matrixCredsLoading = $state(false)
  let dmAliasLoading = $state(false)
  let loading = $derived(matrixCredsLoading || dmAliasLoading)

  // Matrix credentials for element-call widget mode auth.
  // Fetched once per call; provides userId, homeserver URL, and OpenID token.
  let matrixCreds = $state<MatrixCredentials | null>(null)

  // Ref to whichever iframe is currently mounted (PiP or fullscreen).
  let iframeRef = $state<HTMLIFrameElement | null>(null)

  const elementCallBase = env.PUBLIC_ELEMENT_CALL_URL ?? 'http://localhost:8085'
  // Scheme+host+port only — used for postMessage targetOrigin and event.origin checks.
  // When element-call is proxied under /element-call/, the origin is the same as the
  // host page (localhost:3001) even though elementCallBase has a path component.
  const elementCallOrigin = (() => { try { return new URL(elementCallBase).origin } catch { return elementCallBase } })()
  const parentUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:3001'
  const WIDGET_ID = 'element-call-pip'

  // Tracks the open Document Picture-in-Picture window (Chrome 116+).
  // When non-null the main container is hidden but the iframe stays alive,
  // keeping all WebRTC connections and media streams intact.
  let pipWindow = $state<Window | null>(null)
  const supportsDocPip = $derived(typeof window !== 'undefined' && 'documentPictureInPicture' in window)

  async function openDocumentPip(): Promise<void> {
    const dpip = (
      window as {
        documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> }
      }
    ).documentPictureInPicture
    if (!dpip) return

    // Collect live video streams from the same-origin iframe before opening the
    // window so we can size it correctly.  Falls back gracefully if cross-origin
    // (e.g. proxy not configured) or if streams haven't started yet.
    let sourceVideos: HTMLVideoElement[] = []
    try {
      const iframeDoc = iframeRef?.contentDocument
      if (iframeDoc) {
        sourceVideos = (Array.from(iframeDoc.querySelectorAll('video')) as HTMLVideoElement[]).filter(
          (v) => v.srcObject instanceof MediaStream && (v.srcObject as MediaStream).active,
        )
      }
    } catch { /* cross-origin iframe — no video capture */ }

    const hasVideo = sourceVideos.length > 0

    let pw: Window
    try {
      pw = await dpip.requestWindow({
        width: hasVideo ? 400 : 320,
        height: hasVideo ? 300 : 140,
      })
    } catch {
      return
    }

    // Copy stylesheets so CSS variables (dark-mode tokens, etc.) work in the PiP window
    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        if (sheet.href) {
          const link = pw.document.createElement('link')
          link.rel = 'stylesheet'
          link.href = sheet.href
          pw.document.head.appendChild(link)
        } else {
          const style = pw.document.createElement('style')
          style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n')
          pw.document.head.appendChild(style)
        }
      } catch { /* cross-origin stylesheet — skip */ }
    })

    const animStyle = pw.document.createElement('style')
    animStyle.textContent = '@keyframes pip-pulse{0%,100%{opacity:1}50%{opacity:.4}}'
    pw.document.head.appendChild(animStyle)

    const body = pw.document.body
    body.style.cssText =
      'margin:0;padding:0;background:#09090b;color:#fafafa;font-family:system-ui,sans-serif;height:100%;display:flex;flex-direction:column;user-select:none;overflow:hidden;'

    const header = pw.document.createElement('div')
    header.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #27272a;min-width:0;flex-shrink:0;'
    const dot = pw.document.createElement('span')
    dot.style.cssText =
      'display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;animation:pip-pulse 2s ease-in-out infinite;'
    const nameEl = pw.document.createElement('span')
    nameEl.style.cssText =
      'font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    nameEl.textContent = callStore.roomDisplayName
    header.appendChild(dot)
    header.appendChild(nameEl)
    body.appendChild(header)

    // Live video grid — only shown when same-origin iframe streams are available.
    // Audio stays muted here; the main window's iframe is already playing audio.
    if (hasVideo) {
      const cols = sourceVideos.length === 1 ? 1 : 2
      const videoGrid = pw.document.createElement('div')
      videoGrid.style.cssText =
        `flex:1;display:grid;grid-template-columns:repeat(${cols},1fr);gap:1px;background:#000;overflow:hidden;`
      for (const src of sourceVideos) {
        const vid = pw.document.createElement('video')
        vid.srcObject = src.srcObject
        vid.autoplay = true
        vid.muted = true
        vid.playsInline = true
        vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;'
        videoGrid.appendChild(vid)
        vid.play().catch(() => {})
      }
      body.appendChild(videoGrid)
    }

    const controls = pw.document.createElement('div')
    controls.style.cssText = hasVideo
      ? 'display:flex;gap:10px;padding:8px 14px;align-items:center;justify-content:center;flex-shrink:0;border-top:1px solid #27272a;'
      : 'display:flex;gap:10px;padding:14px;flex:1;align-items:center;justify-content:center;'

    function makeBtn(text: string, bg: string, hoverBg: string, border: string): HTMLButtonElement {
      const btn = pw.document.createElement('button')
      btn.textContent = text
      btn.style.cssText = `padding:7px 14px;border-radius:6px;border:${border};background:${bg};color:#fafafa;font-size:12px;cursor:pointer;white-space:nowrap;`
      btn.addEventListener('mouseenter', () => { btn.style.background = hoverBg })
      btn.addEventListener('mouseleave', () => { btn.style.background = bg })
      return btn
    }

    const expandBtn = makeBtn('⤢ Öffnen', '#18181b', '#27272a', '1px solid #3f3f46')
    expandBtn.addEventListener('click', () => {
      setFullscreen(true)
      window.focus()
      pw.close()
    })

    const endBtn = makeBtn('✕ Beenden', '#ef4444', '#dc2626', 'none')
    endBtn.addEventListener('click', () => {
      endCall()
      pw.close()
    })

    controls.appendChild(expandBtn)
    controls.appendChild(endBtn)
    body.appendChild(controls)

    pipWindow = pw
    pw.addEventListener('pagehide', () => { pipWindow = null })
  }

  let iframeUrl = $derived.by(() => {
    if (!callStore.matrixRoomId || callStore.status === 'idle' || !matrixCreds) return null

    const { userId, matrixBaseUrl } = matrixCreds
    const displayName = user?.name ?? 'Unbekannt'
    const params = new URLSearchParams({
      skipLobby: 'true',
      lang: 'de',
      displayName,
      // Widget API params — enable widget mode so element-call skips the login
      // screen and instead uses postMessage to get OpenID credentials from us.
      widgetId: WIDGET_ID,
      parentUrl,
      userId,
      baseUrl: matrixBaseUrl,
      // element-call's aGe() initializer requires roomId + deviceId as query params
      // in widget mode or it throws and falls back to standalone/guest mode.
      // deviceId is a stable pseudonym; actual Matrix API calls use the server-side
      // user token, so Synapse doesn't need this device to exist.
      deviceId: 'ECPIP',
    })

    if (callStore.matrixRoomId.startsWith('!')) {
      // Group call: room ID in both path (for React Router) and query param (for widget API init)
      const roomId = callStore.matrixRoomId
      params.set('roomId', roomId)
      return `${elementCallBase}/room/${encodeURIComponent(roomId)}?${params}`
    }

    // DM call: use the derived alias resolved from the API.
    // roomId not set for DM because we don't have a Matrix room ID — widget mode
    // aGe() will throw and fall back gracefully; LiveKit media still works.
    if (dmRoomAlias) {
      return `${elementCallBase}/room/${encodeURIComponent(dmRoomAlias)}?${params}`
    }

    return null
  })

  // Fetch Matrix credentials (userId + OpenID token) when a call starts.
  // Runs once per call; clears when the call ends.
  $effect(() => {
    if (callStore.status === 'idle') {
      matrixCreds = null
      return
    }

    // Don't re-fetch if already resolved — untrack prevents a reactive loop
    if (untrack(() => matrixCreds !== null)) return

    let cancelled = false
    matrixCredsLoading = true

    fetch('/api/video/openid-token')
      .then((r) => r.json())
      .then((data: MatrixCredentials | { error?: string }) => {
        if (cancelled) return
        if ('userId' in data) {
          matrixCreds = data as MatrixCredentials
        } else {
          error = (data as { error?: string }).error ?? 'Matrix auth fehlgeschlagen'
        }
      })
      .catch(() => {
        if (!cancelled) error = 'Matrix-Verbindung fehlgeschlagen'
      })
      .finally(() => {
        if (!cancelled) matrixCredsLoading = false
      })

    return () => {
      cancelled = true
    }
  })

  // For DM calls, resolve a deterministic Matrix room alias via the API.
  $effect(() => {
    const mid = callStore.matrixRoomId
    if (callStore.status === 'idle' || !mid || mid.startsWith('!')) {
      dmRoomAlias = null
      dmAliasLoading = false
      error = null
      return
    }

    // DM call: matrixRoomId is the peer's Matrix user ID (@peer:server)
    dmRoomAlias = null
    error = null
    dmAliasLoading = true

    const serverName = mid.includes(':') ? mid.split(':').slice(1).join(':') : 'localhost'

    fetch('/api/video/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomType: 'dm', peerMatrixId: mid }),
    })
      .then((res) => res.json())
      .then((data: { success: boolean; roomName?: string; error?: string }) => {
        if (data.success && data.roomName) {
          dmRoomAlias = `#${data.roomName}:${serverName}`
        } else {
          error = data.error ?? 'Raum-Fehler'
        }
      })
      .catch(() => {
        error = 'Verbindungsfehler'
      })
      .finally(() => {
        dmAliasLoading = false
      })
  })

  // All capabilities element-call needs for MatrixRTC widget mode.
  // Sent proactively to the widget after content_loaded so it can proceed
  // without waiting (v0.0.1 flow: host initiates capability grant).
  const ELEMENT_CALL_CAPABILITIES = [
    'org.matrix.msc2762.receive.event:m.call.member',
    'org.matrix.msc2762.send.event:m.call.member',
    'org.matrix.msc2762.receive.state.event:m.call.member',
    'org.matrix.msc2762.send.state.event:m.call.member',
    'org.matrix.msc2762.receive.state.event:org.matrix.msc3401.call',
    'org.matrix.msc2762.send.state.event:org.matrix.msc3401.call',
    'org.matrix.msc2762.receive.state.event:org.matrix.msc3401.call.member',
    'org.matrix.msc2762.send.state.event:org.matrix.msc3401.call.member',
    'org.matrix.msc2762.receive.event:io.element.call.encryption_keys',
    'org.matrix.msc2762.send.event:io.element.call.encryption_keys',
    // In-call emoji reactions
    'org.matrix.msc2762.send.event:io.element.call.reaction',
    'org.matrix.msc2762.receive.event:io.element.call.reaction',
    // Raise/lower hand (m.reaction with m.annotation rel_type)
    'org.matrix.msc2762.send.event:m.reaction',
    'org.matrix.msc2762.receive.event:m.reaction',
    // Redaction: cleans up reactions and withdraws raised hands
    'org.matrix.msc2762.send.event:m.room.redaction',
    'org.matrix.msc2762.receive.event:m.room.redaction',
    'org.matrix.msc2762.get_openid',
    'io.element.call.encryption_keys',
    'io.element.device_mute',
    'm.always_on_screen',
  ]

  // Widget API bridge — handles fromWidget postMessages sent by element-call.
  // element-call enters widget mode because widgetId + parentUrl are in the iframe URL.
  // We approve capabilities and supply OpenID tokens on demand.
  function handleWidgetMessage(event: MessageEvent): void {
    // Validate origin — only accept messages from our element-call instance
    if (event.origin !== elementCallOrigin) return

    const msg = event.data as {
      api?: string
      widgetId?: string
      requestId?: string
      action?: string
      data?: unknown
    }
    if (msg.api !== 'fromWidget' || msg.widgetId !== WIDGET_ID) return

    // event.source is the iframe's contentWindow — always valid when a message
    // arrives from the frame, regardless of whether iframeRef has been set yet.
    const source = event.source as Window | null
    if (!source) return

    function respond(response: unknown, topLevel?: Record<string, unknown>): void {
      // Prefer iframeRef for async callbacks (e.g. after a fetch) in case the
      // iframe was remounted (PiP ↔ fullscreen toggle); fall back to source.
      const target = iframeRef?.contentWindow ?? source
      // element-call's PostmessageTransport.handleResponse resolves promises with
      // the full message object `e` (not e.response), so fields like event_id must
      // also be present at the top level of the message for the widget client to see them.
      target?.postMessage(
        {
          api: 'fromWidget',
          widgetId: WIDGET_ID,
          requestId: msg.requestId,
          action: msg.action,
          response,
          ...topLevel,
        },
        elementCallOrigin
      )
    }

    // Proactive host→widget message (not a response to any fromWidget request).
    // Used to initiate capability negotiation after content_loaded.
    function sendToWidget(action: string, data: unknown): void {
      const target = iframeRef?.contentWindow ?? source
      target?.postMessage(
        {
          api: 'toWidget',
          widgetId: WIDGET_ID,
          requestId: `host-${Math.random().toString(36).slice(2)}-${Date.now()}`,
          action,
          data,
        },
        elementCallOrigin
      )
    }

    switch (msg.action) {
      // element-call announces which API versions it supports; acknowledge
      case 'supported_api_versions':
        respond({ supported_versions: ['0.0.1', '0.0.2'] })
        break

      // element-call signals it has finished loading its UI.
      // Respond immediately, then proactively send our capability grant so
      // element-call can proceed with MatrixRTC without waiting (v0.0.1 flow).
      case 'content_loaded':
        respond({})
        sendToWidget('capabilities', { capabilities: ELEMENT_CALL_CAPABILITIES })
        break

      // element-call declares required capabilities; approve all of them.
      // Handles both the v0.0.2 fromWidget request and any response to our
      // proactive toWidget capabilities grant above.
      case 'capabilities':
      case 'org.matrix.msc2762.capabilities': {
        const caps = (msg.data as { capabilities?: string[] })?.capabilities ?? []
        respond({ capabilities: caps })
        break
      }

      // element-call requests an OpenID token to authenticate with LiveKit SFU
      // latest-ci sends plain 'get_openid'; older widget-api used the MSC namespace
      case 'get_openid':
      case 'org.matrix.msc2762.get_openid':
        fetch('/api/video/openid-token')
          .then((r) => r.json())
          .then((data: MatrixCredentials | { error?: string }) => {
            if ('openidToken' in data) {
              matrixCreds = data as MatrixCredentials
              respond({ state: 'allowed', ...data.openidToken })
            } else {
              respond({ state: 'blocked' })
            }
          })
          .catch(() => respond({ state: 'blocked' }))
        break

      // element-call wants to send a Matrix event (e.g. m.call.member state event)
      // latest-ci uses plain 'send_event'; older widget-api used the MSC namespace
      case 'send_event':
      case 'org.matrix.msc2762.send_event': {
        const d = msg.data as {
          type?: string
          content?: Record<string, unknown>
          state_key?: string
          room_id?: string
          // MSC4140 delayed events: delay in ms, parent_delay_id for chained delays
          delay?: number
          parent_delay_id?: string
          // Widget API top-level field for m.room.redaction
          redacts?: string
        }
        fetch('/api/video/matrix-widget-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'send_event',
            roomId: d.room_id ?? callStore.matrixRoomId,
            type: d.type,
            content: d.content ?? {},
            stateKey: d.state_key,
            delay: d.delay,
            parentDelayId: d.parent_delay_id,
            redacts: d.redacts,
          }),
        })
          .then((r) => r.json())
          .then((result: { eventId?: string; delay_id?: string; error?: string }) => {
            if (result.delay_id) {
              const delayResponse = { room_id: d.room_id ?? callStore.matrixRoomId, delay_id: result.delay_id }
              respond(delayResponse, delayResponse)
            } else if (result.eventId) {
              const eventResponse = { room_id: d.room_id ?? callStore.matrixRoomId, event_id: result.eventId }
              respond(eventResponse, eventResponse)
              if (typeof d.state_key === 'string' && matrixCreds) {
                // State event: push via update_state so element-call's RoomWidgetClient
                // injects it into local room state (triggers MatrixRTCSession.memberships).
                sendToWidget('update_state', {
                  state: [
                    {
                      type: d.type,
                      state_key: d.state_key,
                      content: d.content ?? {},
                      room_id: d.room_id ?? callStore.matrixRoomId,
                      event_id: result.eventId,
                      sender: matrixCreds.userId,
                      origin_server_ts: Date.now(),
                    },
                  ],
                })
              } else if (matrixCreds) {
                // Timeline event: inject via send_event toWidget so element-call's
                // ReactionsReader sees its own outgoing events. Without this push,
                // redactions never fire MatrixRoomEvent.Redaction in the local room
                // model and raised hands cannot be lowered.
                const injectPayload: Record<string, unknown> = {
                  type: d.type,
                  content: d.content ?? {},
                  room_id: d.room_id ?? callStore.matrixRoomId,
                  event_id: result.eventId,
                  sender: matrixCreds.userId,
                  origin_server_ts: Date.now(),
                }
                // m.room.redaction: expose the redacted event_id at top level
                // so matrix-js-sdk can apply the redaction to its local timeline.
                const redactsId = d.redacts ?? (d.content?.redacts as string | undefined)
                if (d.type === 'm.room.redaction' && redactsId) {
                  injectPayload.redacts = redactsId
                }
                sendToWidget('send_event', injectPayload)
              }
            } else {
              // element-call's PostmessageTransport.handleResponse checks Joe(response),
              // which requires { error: { message: string } } to reject the promise.
              // A plain string error resolves instead of rejects, causing updatePendingEvent
              // to be called with undefined event_id and throw a confusing error.
              respond({ error: { message: result.error ?? 'send failed' } })
            }
          })
          .catch(() => {
            respond({ error: { message: 'network error' } })
          })
        break
      }

      // element-call wants to read Matrix state events (e.g. to see other call members)
      // MSC2876 is the dedicated read_events action (used by element-call latest-ci);
      // MSC2762 is the older combined send/receive MSC — handle both for compatibility.
      case 'org.matrix.msc2876.read_events':
      case 'org.matrix.msc2762.read_events': {
        const d = msg.data as {
          type?: string
          state_key?: string | boolean
          room_id?: string
        }
        fetch('/api/video/matrix-widget-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'read_events',
            roomId: d.room_id ?? callStore.matrixRoomId,
            type: d.type,
            stateKey: d.state_key === true ? '*' : (d.state_key ?? '*'),
          }),
        })
          .then((r) => r.json())
          .then((result: { events?: unknown[]; error?: string }) => {
            respond({ events: result.events ?? [] })
          })
          .catch(() => respond({ events: [] }))
        break
      }

      // element-call restarts/cancels/sends the MSC4140 delayed "safe leave" event.
      // Without this, the delayed event fires after ~8s and removes call membership.
      case 'org.matrix.msc4157.update_delayed_event': {
        const d = msg.data as { delay_id?: string; action?: string }
        fetch('/api/video/matrix-widget-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_delayed_event',
            delayId: d.delay_id,
            updateAction: d.action,
          }),
        })
          .then((r) => r.json())
          .then((result: { error?: string }) => {
            if (result.error) {
              respond({ error: { message: result.error } })
            } else {
              respond({})
            }
          })
          .catch(() => respond({ error: { message: 'network error' } }))
        break
      }

      // element-call signals the call has ended (user hung up or session closed).
      // Respond before calling endCall so the iframe receives the ack.
      case 'io.element.close':
        respond({})
        endCall()
        break

      default:
        // Unhandled actions: respond with empty success so element-call doesn't hang
        respond({})
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Esc steps the chrome down one level: fullscreen/expanded → floating PiP.
    if (e.key === 'Escape' && (callStore.status === 'fullscreen' || callStore.status === 'expanded')) {
      setExpanded(false)
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onmessage={handleWidgetMessage} />

{#if callStore.status !== 'idle'}
  <!--
    Single persistent container: class/style updates reactively on mode switch.
    The <iframe> is a sibling to the header {#if} block — Svelte reuses its DOM
    node across fullscreen ↔ PiP transitions, keeping media streams alive.
  -->
  <div
    use:draggable={{
      position: callStore.pipPosition,
      onMove: (pos) => { callStore.pipPosition = pos },
      enabled: callStore.status === 'active' && !pipWindow,
    }}
    style="{pipWindow ? 'visibility:hidden;pointer-events:none;' : ''}{callStore.status === 'active' ? `right:${callStore.pipPosition.x}px;bottom:${callStore.pipPosition.y}px;` : ''}"
    class="call-chrome call-{callStore.status}"
    role="dialog"
    aria-label={callStore.status === 'fullscreen'
      ? 'Videoanruf — Vollbild'
      : callStore.status === 'expanded'
        ? 'Videoanruf — Seitenleiste'
        : 'Videoanruf'}
  >
    <!-- App-owned chrome (v5 tokens). The Element Call in-iframe controls
         are NOT re-skinned — only this outer frame/header/bar. -->
    {#if callStore.status === 'fullscreen'}
      <div class="call-head call-head-lg">
        <div class="call-head-title">
          <span class="call-live-dot"></span>
          <div>
            <div class="call-name">{callStore.roomDisplayName}</div>
            <div class="call-sub mono">LiveKit Bridge · Element Call</div>
          </div>
        </div>
        <div class="call-head-actions">
          <button class="call-btn" onclick={() => setExpanded(true)} title="Seitenleiste" aria-label="In Seitenleiste andocken">Seitenleiste</button>
          <button class="call-btn" onclick={() => { setFullscreen(false); openDocumentPip() }} aria-label="Als schwebendes Fenster öffnen">PiP</button>
          <button class="call-btn call-btn-danger" onclick={endCall}>Anruf beenden</button>
        </div>
      </div>
    {:else if callStore.status === 'expanded'}
      <div class="call-head call-head-md">
        <div class="call-head-title">
          <span class="call-live-dot"></span>
          <div>
            <div class="call-name">{callStore.roomDisplayName}</div>
            <div class="call-sub mono">LiveKit · Element Call</div>
          </div>
        </div>
        <div class="call-head-actions">
          <button class="call-icon-btn" onclick={() => setExpanded(false)} title="Minimieren" aria-label="Minimieren">⊟</button>
          <button class="call-icon-btn" onclick={() => setFullscreen(true)} title="Vollbild" aria-label="Vollbild">⤢</button>
          <button class="call-icon-btn call-icon-danger" onclick={endCall} title="Anruf beenden" aria-label="Anruf beenden">✕</button>
        </div>
      </div>
    {:else}
      <div class="call-head call-head-sm call-head-grab">
        <div class="call-head-title">
          <span class="call-live-dot"></span>
          <span class="call-name call-name-sm">{callStore.roomDisplayName}</span>
        </div>
        <div class="call-head-actions">
          {#if supportsDocPip}
            <button class="call-icon-btn" onclick={() => openDocumentPip()} title="Schwebendes Fenster" aria-label="Schwebendes Fenster">⊞</button>
          {/if}
          <button class="call-icon-btn" onclick={() => setExpanded(true)} title="Seitenleiste" aria-label="In Seitenleiste andocken">⇥</button>
          <button class="call-icon-btn" onclick={() => setFullscreen(true)} title="Vollbild" aria-label="Vollbild">⤢</button>
          <button class="call-icon-btn call-icon-danger" onclick={endCall} title="Anruf beenden" aria-label="Anruf beenden">✕</button>
        </div>
      </div>
    {/if}

    {#if iframeUrl}
      <iframe
        bind:this={iframeRef}
        src={iframeUrl}
        title="Videoanruf"
        class="call-iframe"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        allow="camera; microphone; display-capture; fullscreen; screen-wake-lock; picture-in-picture"
      ></iframe>
    {:else if loading}
      <div class="call-placeholder">Verbinde…</div>
    {:else if error}
      <div class="call-placeholder call-error">
        <span>{error}</span>
        <button onclick={endCall} class="call-error-close">Schließen</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* v5 Task 4.6 — app-owned call chrome on the institutional token system.
     Three outer layouts: floating PiP (active), docked side-panel (expanded),
     full-bleed (fullscreen). The Element Call iframe controls are untouched. */
  .call-chrome {
    position: fixed;
    z-index: 9999;
    background: var(--surface);
    color: var(--ink);
    overflow: hidden;
    user-select: none;
    display: flex;
    flex-direction: column;
  }
  /* active — floating PiP corner card */
  .call-active {
    width: 320px;
    border: 1px solid var(--border);
    border-radius: var(--r-md, 12px);
    box-shadow: var(--shadow-3, 0 10px 30px rgba(0, 0, 0, 0.25));
  }
  /* expanded — docked side-panel on the right edge */
  .call-expanded {
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-width: 90vw;
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-3, -8px 0 30px rgba(0, 0, 0, 0.2));
  }
  /* fullscreen — full-bleed */
  .call-fullscreen {
    inset: 0;
    z-index: 9998;
    width: 100%;
    background: var(--surface-2);
  }

  .call-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    flex-shrink: 0;
  }
  .call-head-sm { padding: 8px 12px; }
  .call-head-md { padding: 12px 16px; }
  .call-head-lg { padding: 12px 18px; }
  .call-head-grab { cursor: grab; }
  .call-head-grab:active { cursor: grabbing; }

  .call-head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .call-live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--pine);
    flex-shrink: 0;
    animation: call-pulse 2s ease-in-out infinite;
  }
  @keyframes call-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .call-name {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .call-name-sm { font-size: 12.5px; }
  .call-sub { font-size: 10.5px; color: var(--ink-muted); margin-top: 2px; }

  .call-head-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  .call-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--r-sm, 6px);
    background: transparent;
    color: var(--ink-2);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    transition: background var(--d-fast, 0.12s), color var(--d-fast, 0.12s);
  }
  .call-icon-btn:hover { background: var(--surface-3); color: var(--ink); }
  .call-icon-danger:hover { background: var(--rust); color: #fff; }

  .call-btn {
    padding: 6px 12px;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface);
    color: var(--ink);
    font-size: 12px;
    cursor: pointer;
    transition: background var(--d-fast, 0.12s);
  }
  .call-btn:hover { background: var(--surface-3); }
  .call-btn-danger {
    background: var(--rust);
    color: #fff;
    border-color: transparent;
  }
  .call-btn-danger:hover { opacity: 0.9; background: var(--rust); }

  .call-iframe {
    width: 100%;
    border: 0;
    display: block;
  }
  .call-active .call-iframe { height: 256px; }
  .call-expanded .call-iframe { flex: 1; }
  .call-fullscreen .call-iframe { flex: 1; }

  .call-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    font-size: 13px;
    color: var(--ink-muted);
    text-align: center;
  }
  .call-active .call-placeholder { height: 256px; }
  .call-expanded .call-placeholder,
  .call-fullscreen .call-placeholder { flex: 1; }
  .call-error { color: var(--rust); }
  .call-error-close {
    font-size: 12px;
    text-decoration: underline;
    background: none;
    border: none;
    color: var(--rust);
    cursor: pointer;
  }
</style>
