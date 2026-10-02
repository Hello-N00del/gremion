<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { onMount, onDestroy } from 'svelte'
  import { page } from '$app/stores'
  import { invalidate } from '$app/navigation'
  import { roomStore, selectedRoomId, syncStatus } from '$lib/stores/matrix'
  import type { MatrixMessage, RoomState } from '$lib/stores/matrix'
  import { callStore, startRoomCall } from '$lib/stores/call-store.svelte'
  import { hasRole, Role, type SessionUser } from '$lib/auth'
  import { resolveBrand } from '$lib/brand'
  import { deriveHue, deriveAbbr } from '$lib/governance/committee-color'
  import { toast } from 'svelte-sonner'

  let rooms = $derived(Object.values($roomStore))
  // FLOW-MSG-001 (TASK-009 lane B, row 15): archived rooms move to their own
  // "Archiv" section and lose the composer (R23-5 — read-only, history kept).
  let activeRooms = $derived(rooms.filter((r) => !r.archived))
  let archivedRooms = $derived(rooms.filter((r) => r.archived))
  let activeRoom = $derived(
    $selectedRoomId ? $roomStore[$selectedRoomId] : null
  )

  let user = $derived($page.data.session?.user as SessionUser | undefined)
  let brand = $derived(resolveBrand($page.data.brand))
  let canStartCall = $derived(user ? hasRole(user.roles, Role.Member) : false)
  // R23-4: create/rename/archive = CouncilAdmin (ITAdmin inherits); hard
  // delete stays ITAdmin-only, checked separately below.
  let isRoomAdmin = $derived(user ? hasRole(user.roles, Role.CouncilAdmin) : false)
  let isITAdmin = $derived(user ? hasRole(user.roles, Role.ITAdmin) : false)
  let callActiveInThisRoom = $derived(
    callStore.status !== 'idle' && callStore.matrixRoomId === ($selectedRoomId ?? '')
  )

  let messageInput = $state('')
  let sending = $state(false)
  let eventSource: EventSource | null = null
  // One toast per outage, not one per reconnect attempt.
  let syncErrorNotified = false
  // MEDIUM (house review, TASK-009 fix round 2): a failed loadRooms() fetch
  // used to fall straight into the same "Keine Räume gefunden." empty-list
  // hint as a genuinely empty account — indistinguishable to the user, and
  // silent to us (no logging at all). Tracked separately so the room list
  // can show a real error state with a retry action instead.
  let roomsLoadError = $state(false)

  let totalUnread = $derived(activeRooms.reduce((sum, r) => sum + (r.unreadCount ?? 0), 0))

  // Stable per-room hue + monogram. Matrix rooms carry no org-unit colour, so we
  // derive both deterministically from the roomId (hue) and name (abbr) — the
  // same mechanism the calendar/committee surfaces use (committee-color.ts), so
  // a given room keeps a consistent OU-style colour across reloads.
  function roomHue(roomId: string): number {
    return deriveHue(roomId)
  }
  function roomAbbr(name: string): string {
    return deriveAbbr(name)
  }

  // Room-list timestamp: HH:MM for today, else DD.MM. (lastMessageTs is in the
  // DTO but was previously unrendered.) 0 / falsy → no time shown.
  function fmtRoomTs(ts: number | undefined): string {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    return sameDay
      ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  }

  function senderInitials(sender: string): string {
    const local = sender.replace(/^@/, '').split(':')[0] ?? sender
    const parts = local.split(/[._-]/).filter(Boolean)
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
    return local.slice(0, 2).toUpperCase()
  }

  async function loadRooms() {
    try {
      const res = await fetch('/api/messages/rooms')
      const json = await res.json()
      if (json.success) {
        roomsLoadError = false
        const loaded: Record<string, RoomState> = {}
        for (const r of json.data as Array<{
          roomId: string; name: string; unreadCount: number; lastMessageTs: number; archived?: boolean
        }>) {
          loaded[r.roomId] = { ...r, messages: $roomStore[r.roomId]?.messages ?? [] }
        }
        roomStore.set(loaded)
        if (!$selectedRoomId) {
          const firstActive = json.data.find((r: { archived?: boolean }) => !r.archived)
          if (firstActive) selectedRoomId.set(firstActive.roomId)
        }
      } else {
        // A resolved-but-unsuccessful response (json.success === false) is
        // also a load failure, not "zero rooms" — same distinction as below.
        roomsLoadError = true
        console.error('[messages] loadRooms: server reported failure', { body: json })
      }
    } catch (err) {
      roomsLoadError = true
      console.error('[messages] loadRooms failed', { error: err instanceof Error ? err.message : String(err) })
      toast.error('Räume konnten nicht geladen werden')
    }
  }

  onMount(async () => {
    syncStatus.set('connecting')
    await loadRooms()

    eventSource = new EventSource('/api/messages/sync')
    eventSource.onopen = () => syncStatus.set('live')
    eventSource.onerror = () => syncStatus.set('error')
    // Server-side sync failure. It arrives as a NAMED event so it never reaches
    // onmessage below, whose parser only understands the { nextBatch, rooms }
    // snapshot shape — an error object there was silently dropped. The server
    // closes the stream right after sending this, so EventSource reconnects on
    // its own retry interval (onopen then restores "live").
    eventSource.addEventListener('sync-error', () => {
      syncStatus.set('error')
      if (!syncErrorNotified) {
        syncErrorNotified = true
        toast.error('Matrix-Sync unterbrochen – Verbindung wird neu aufgebaut')
      }
    })
    eventSource.onmessage = (e) => {
      try {
        const sync = JSON.parse(e.data as string) as {
          nextBatch: string
          rooms: Array<{ roomId: string; events: MatrixMessage[]; unreadCount: number }>
        }
        // Real data flowed again — re-arm the outage toast. Deliberately NOT on
        // onopen: a permanently failing sync reconnects every 15 s, and re-arming
        // there would toast on every cycle.
        syncErrorNotified = false
        roomStore.update((store) => {
          const updated = { ...store }
          for (const r of sync.rooms) {
            if (updated[r.roomId]) {
              updated[r.roomId] = {
                ...updated[r.roomId],
                messages: [...updated[r.roomId].messages, ...r.events],
                unreadCount: r.unreadCount
              }
            }
          }
          return updated
        })
      } catch {
        // ignore parse errors
      }
    }
  })

  onDestroy(() => {
    eventSource?.close()
  })

  // Open a room: select it, then mark it read so its unread count clears both
  // here (room list) and in the shell/sidebar badge. We optimistically zero the
  // local unreadCount, POST the read marker (passing the newest known eventId if
  // we have one — else the server resolves the room's latest event), and
  // invalidate('app:unread') so +layout.server re-runs loadUnread and the bell /
  // sidebar badge re-derive from the authoritative Matrix count.
  async function openRoom(roomId: string) {
    selectedRoomId.set(roomId)

    const room = $roomStore[roomId]
    if (!room || room.unreadCount === 0) return

    roomStore.update((store) =>
      store[roomId] ? { ...store, [roomId]: { ...store[roomId], unreadCount: 0 } } : store
    )

    const lastEventId = room.messages.at(-1)?.eventId
    try {
      await fetch(`/api/messages/rooms/${encodeURIComponent(roomId)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastEventId ? { eventId: lastEventId } : {})
      })
      await invalidate('app:unread')
    } catch {
      // Non-fatal — the badge will reconcile on the next navigation / sync.
    }
  }

  async function sendMessage() {
    const roomId = $selectedRoomId
    if (!roomId || !messageInput.trim()) return
    sending = true
    try {
      // #208: a non-2xx response does not throw — check res.ok before clearing
      // the input so a rejected send isn't silently treated as delivered.
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: messageInput.trim() })
      })
      if (!res.ok) {
        toast.error('Nachricht konnte nicht gesendet werden')
        return
      }
      messageInput = ''
    } catch {
      toast.error('Nachricht konnte nicht gesendet werden')
    } finally {
      sending = false
    }
  }

  // ── Row 15: admin-only "Raum erstellen" (FLOW-MSG-001 / rows-plan.md S2.6) ──
  let showCreateDialog = $state(false)
  let creatableUnits = $state<Array<{ id: string; name: string }>>([])
  let createUnitId = $state('')
  let createRoomName = $state('')
  let creating = $state(false)

  async function openCreateDialog() {
    showCreateDialog = true
    createUnitId = ''
    createRoomName = ''
    creatableUnits = []
    try {
      const res = await fetch('/api/governance/committees')
      if (res.ok) {
        const json = await res.json()
        creatableUnits = (json.data as Array<{ id: string; name: string; wants_matrix_room: boolean }>)
          .filter((u) => !u.wants_matrix_room)
          .map((u) => ({ id: u.id, name: u.name }))
      }
    } catch {
      creatableUnits = []
    }
  }
  function closeCreateDialog() {
    showCreateDialog = false
  }

  // LOW (house review, TASK-009 fix round 2): the dialog backdrops were
  // click-to-dismiss divs whose a11y warnings were suppressed rather than
  // addressed. Genuinely keyboard-operable now: Enter/Space on a focused
  // backdrop (tabindex="0", role="button") dismisses it the same as a
  // click, and each dialog itself closes on Escape (attached at the
  // markup sites below).
  function handleBackdropKeydown(e: KeyboardEvent, close: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      close()
    }
  }

  async function submitCreateRoom() {
    if (!createUnitId) {
      toast.error('Bitte ein Gremium oder eine Initiative wählen')
      return
    }
    creating = true
    try {
      const res = await fetch('/api/messages/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: createUnitId, name: createRoomName || undefined })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        console.error('[messages] submitCreateRoom failed', { status: res.status, body })
        toast.error(body?.error ?? 'Raum konnte nicht erstellt werden')
        return
      }
      const body = await res.json()
      const roomId = body.data.roomId as string
      const unitName = creatableUnits.find((u) => u.id === createUnitId)?.name ?? roomId
      roomStore.update((store) => ({
        ...store,
        [roomId]: {
          roomId, name: createRoomName || unitName, unreadCount: 0, lastMessageTs: 0, messages: [], archived: false
        }
      }))
      selectedRoomId.set(roomId)
      closeCreateDialog()
    } catch (err) {
      console.error('[messages] submitCreateRoom threw', { error: err instanceof Error ? err.message : String(err) })
      toast.error('Raum konnte nicht erstellt werden')
    } finally {
      creating = false
    }
  }

  // ── Row 15: room header "Einstellungen" — rename / archive / (ITAdmin) delete ──
  let settingsRoomId = $state<string | null>(null)
  let settingsName = $state('')
  let settingsOrgUnitId = $state<string | null>(null)
  // DEFECT 2 (TASK-009 fu1, live e2e): the unit lookup below is async (an
  // O(units) sequential-ledger-reads GET on the server) — Speichern /
  // Archivieren / Löschen used to be enabled the instant the dialog opened,
  // before settingsOrgUnitId ever resolved. A click in that window hit the
  // "Raum-Zuordnung nicht gefunden" toast-and-noop path in
  // saveSettingsName/confirmArchive/confirmDelete, and a 404 from the lookup
  // was indistinguishable from "still loading" to the user. These two flags
  // gate the actions explicitly instead.
  let settingsLoading = $state(false)
  let settingsLoadError = $state(false)
  let settingsBusy = $state(false)
  let settingsConfirm = $state<'archive' | 'delete' | null>(null)
  // LOW (TASK-009 fu1 round 2 verifier): the previous stale-response guard
  // compared only roomId, so a rapid close/reopen of the SAME room (open A,
  // close, reopen A while the first /unit lookup is still in flight) let a
  // slower first call's failure land AFTER a second, successful call for
  // that same room had already resolved — settingsLoadError stuck at true
  // forever even though a good settingsOrgUnitId was already in hand. A
  // monotonic per-call token (bumped on every openSettings(), never
  // reused/reset by roomId) makes each in-flight call check "am I still the
  // MOST RECENT call", not "is the room still the same one", so two calls
  // for the same room are still ordered correctly.
  let settingsReqToken = 0

  async function openSettings(room: RoomState) {
    const req = ++settingsReqToken
    const openedRoomId = room.roomId
    settingsRoomId = openedRoomId
    settingsName = room.name
    settingsOrgUnitId = null
    settingsConfirm = null
    settingsLoading = true
    settingsLoadError = false
    try {
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(openedRoomId)}/unit`)
      // Only apply the result if this is still the MOST RECENT openSettings()
      // call — a later call (even for the same room) always wins over an
      // earlier one still in flight.
      if (res.ok) {
        const json = await res.json()
        // Re-check after the second await too — res.json() is itself async,
        // so a newer call could have started in the time it took to parse
        // the body.
        if (req === settingsReqToken) settingsOrgUnitId = json.data.orgUnitId
      } else if (req === settingsReqToken) {
        console.error('[messages] openSettings: unit lookup returned non-2xx', {
          roomId: openedRoomId, status: res.status,
        })
        settingsLoadError = true
      }
    } catch (err) {
      console.error('[messages] openSettings: unit lookup failed', {
        roomId: openedRoomId, error: err instanceof Error ? err.message : String(err),
      })
      if (req === settingsReqToken) settingsLoadError = true
    } finally {
      // Same guard as above: a slower PREVIOUS lookup finishing after a
      // newer openSettings() call has already started its own (and set
      // settingsLoading = true again) must not clear the newer call's
      // loading state out from under it.
      if (req === settingsReqToken) settingsLoading = false
    }
  }
  function closeSettings() {
    settingsRoomId = null
    settingsConfirm = null
  }
  let settingsActionsDisabled = $derived(settingsBusy || settingsLoading || settingsLoadError)

  async function saveSettingsName() {
    if (!settingsRoomId || !settingsOrgUnitId) {
      toast.error('Raum-Zuordnung nicht gefunden')
      return
    }
    settingsBusy = true
    try {
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(settingsRoomId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: settingsOrgUnitId, name: settingsName })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        console.error('[messages] saveSettingsName failed', { roomId: settingsRoomId, status: res.status, body })
        toast.error('Raum konnte nicht umbenannt werden')
        return
      }
      const roomId = settingsRoomId
      const newName = settingsName
      roomStore.update((store) =>
        store[roomId] ? { ...store, [roomId]: { ...store[roomId], name: newName } } : store
      )
      closeSettings()
    } catch (err) {
      console.error('[messages] saveSettingsName threw', { roomId: settingsRoomId, error: err instanceof Error ? err.message : String(err) })
      toast.error('Raum konnte nicht umbenannt werden')
    } finally {
      settingsBusy = false
    }
  }

  async function confirmArchive() {
    if (!settingsRoomId || !settingsOrgUnitId) return
    settingsBusy = true
    try {
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(settingsRoomId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: settingsOrgUnitId })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        console.error('[messages] confirmArchive failed', { roomId: settingsRoomId, status: res.status, body })
        toast.error('Raum konnte nicht archiviert werden')
        return
      }
      const roomId = settingsRoomId
      roomStore.update((store) =>
        store[roomId] ? { ...store, [roomId]: { ...store[roomId], archived: true } } : store
      )
      closeSettings()
    } catch (err) {
      console.error('[messages] confirmArchive threw', { roomId: settingsRoomId, error: err instanceof Error ? err.message : String(err) })
      toast.error('Raum konnte nicht archiviert werden')
    } finally {
      settingsBusy = false
    }
  }

  async function confirmDelete() {
    if (!settingsRoomId || !settingsOrgUnitId) return
    settingsBusy = true
    try {
      const res = await fetch(
        `/api/messages/rooms/${encodeURIComponent(settingsRoomId)}?orgUnitId=${encodeURIComponent(settingsOrgUnitId)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        console.error('[messages] confirmDelete failed', { roomId: settingsRoomId, status: res.status, body })
        toast.error('Raum konnte nicht gelöscht werden')
        return
      }
      const roomId = settingsRoomId
      roomStore.update((store) => {
        const { [roomId]: _removed, ...rest } = store
        return rest
      })
      if ($selectedRoomId === roomId) selectedRoomId.set(null)
      closeSettings()
    } catch (err) {
      console.error('[messages] confirmDelete threw', { roomId: settingsRoomId, error: err instanceof Error ? err.message : String(err) })
      toast.error('Raum konnte nicht gelöscht werden')
    } finally {
      settingsBusy = false
    }
  }
</script>

<PageTitle title="Nachrichten" />

<div class="chat-shell">
  <!-- Room list -->
  <aside class="room-list">
    <div class="room-list-head">
      <div class="eyebrow">Matrix · {brand.matrixHomeserver}</div>
      <div class="room-list-title-row">
        <h3 class="room-list-title">Räume</h3>
        {#if isRoomAdmin}
          <button type="button" class="btn btn-ghost btn-sm" onclick={openCreateDialog} title="Raum erstellen">
            <Icon name="plus" size={14} /> Raum erstellen
          </button>
        {/if}
        <div class="sync-state">
          {#if $syncStatus === 'live'}
            <span class="sync-dot live" aria-hidden="true"></span><span class="mono">live</span>
          {:else if $syncStatus === 'connecting'}
            <span class="sync-dot" aria-hidden="true"></span><span class="mono">verbinde…</span>
          {:else}
            <span class="sync-dot err" aria-hidden="true"></span><span class="mono">Fehler</span>
          {/if}
        </div>
      </div>
      {#if rooms.length > 0}
        <div class="room-list-sub mono">{activeRooms.length} Räume · {totalUnread} ungelesen</div>
      {/if}
    </div>

    {#each activeRooms as room (room.roomId)}
      {@const hue = roomHue(room.roomId)}
      <button
        type="button"
        class="room-item"
        class:active={$selectedRoomId === room.roomId}
        onclick={() => void openRoom(room.roomId)}
      >
        <div class="ravatar" style="--c-hue: {hue};">{roomAbbr(room.name)}</div>
        <div class="r-meta">
          <div class="r-top">
            <span class="r-name">{room.name}</span>
            {#if room.lastMessageTs}
              <span class="r-time mono">{fmtRoomTs(room.lastMessageTs)}</span>
            {/if}
          </div>
          <div class="r-preview">
            <span class="mono r-members">Matrix-Raum</span>
            {#if room.unreadCount > 0}
              <span class="unread" aria-label="{room.unreadCount} ungelesene Nachrichten">{room.unreadCount}</span>
            {/if}
          </div>
        </div>
      </button>
    {:else}
      {#if roomsLoadError}
        <div class="room-empty mono">
          Räume konnten nicht geladen werden.
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => void loadRooms()}>Erneut versuchen</button>
        </div>
      {:else}
        <div class="room-empty mono">Keine Räume gefunden.</div>
      {/if}
    {/each}

    {#if archivedRooms.length > 0}
      <div class="archiv-section">
        <div class="archiv-head mono">Archiv</div>
        {#each archivedRooms as room (room.roomId)}
          {@const hue = roomHue(room.roomId)}
          <button
            type="button"
            class="room-item archived"
            class:active={$selectedRoomId === room.roomId}
            onclick={() => selectedRoomId.set(room.roomId)}
          >
            <div class="ravatar" style="--c-hue: {hue};">{roomAbbr(room.name)}</div>
            <div class="r-meta">
              <div class="r-top"><span class="r-name">{room.name}</span></div>
              <div class="r-preview"><span class="mono r-members">Archiviert · schreibgeschützt</span></div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </aside>

  <!-- Message area -->
  <div class="chat-main">
    {#if activeRoom}
      {@const hue = roomHue(activeRoom.roomId)}
      <div class="chat-head">
        <div class="ravatar" style="--c-hue: {hue};">{roomAbbr(activeRoom.name)}</div>
        <div class="chat-head-text">
          <div class="chat-head-name">{activeRoom.name}</div>
          <div class="chat-head-sub mono">
            {activeRoom.messages.length} Nachrichten · Ende-zu-Ende
            {#if activeRoom.archived} · archiviert{/if}
          </div>
        </div>

        {#if isRoomAdmin && !activeRoom.archived}
          <button type="button" class="btn btn-sm" onclick={() => openSettings(activeRoom!)} title="Einstellungen">
            <Icon name="settings" size={14} /> Einstellungen
          </button>
        {/if}

        {#if canStartCall && !activeRoom.archived}
          {#if callActiveInThisRoom}
            <span class="call-live" aria-label="Anruf läuft">
              <span class="call-live-dot" aria-hidden="true"></span> Anruf läuft
            </span>
          {:else}
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => startRoomCall(activeRoom.roomId, activeRoom.name)}
              title="Element Call starten"
            >
              <Icon name="video" size={14} /> Element Call
            </button>
          {/if}
        {/if}
      </div>

      <div class="chat-body">
        {#if activeRoom.messages.length > 0}
          <div class="divider-label">Heute · {new Date().toLocaleDateString('de-DE')}</div>
        {/if}
        {#each activeRoom.messages as msg (msg.eventId)}
          <div class="msg">
            <div class="mav">{senderInitials(msg.senderDisplayName || msg.sender)}</div>
            <div class="mbody">
              <div class="mhead">
                <span class="mname">{msg.senderDisplayName || msg.sender}</span>
                {#if msg.ts}<span class="mtime mono">{fmtRoomTs(msg.ts)}</span>{/if}
              </div>
              <div class="mtext">{msg.body}</div>
            </div>
          </div>
        {:else}
          <div class="chat-empty mono">Noch keine Nachrichten in diesem Raum.</div>
        {/each}
      </div>

      {#if activeRoom.archived}
        <div class="chat-input archived-notice mono">Dieser Raum ist archiviert und schreibgeschützt.</div>
      {:else}
        <div class="chat-input">
          <button type="button" class="btn btn-ghost btn-sm" title="Anhang" aria-label="Anhang hinzufügen">
            <Icon name="attach" size={15} />
          </button>
          <input
            bind:value={messageInput}
            placeholder={`Nachricht an ${activeRoom.name}…`}
            onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() } }}
          />
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onclick={() => void sendMessage()}
            disabled={sending || !messageInput.trim()}
            title="Senden"
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      {/if}
    {:else}
      <div class="chat-placeholder mono">Wählen Sie einen Raum aus.</div>
    {/if}
  </div>
</div>

{#if showCreateDialog}
  <div
    class="dialog-backdrop"
    role="button"
    tabindex="0"
    aria-label="Dialog schließen"
    onclick={closeCreateDialog}
    onkeydown={(e) => handleBackdropKeydown(e, closeCreateDialog)}
  >
    <div
      class="dialog"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Raum erstellen"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') closeCreateDialog() }}
    >
      <div class="dialog-head">
        <h3>Raum erstellen</h3>
        <button class="dlg-close" onclick={closeCreateDialog} aria-label="Schließen"><Icon name="x" size={16} /></button>
      </div>
      <div class="dialog-body">
        <label class="field">
          <span>Gremium oder Initiative</span>
          <select bind:value={createUnitId}>
            <option value="" disabled>Bitte wählen…</option>
            {#each creatableUnits as unit (unit.id)}
              <option value={unit.id}>{unit.name}</option>
            {/each}
          </select>
          {#if creatableUnits.length === 0}
            <span class="field-hint mono">Alle Gremien/Initiativen haben bereits einen Raum.</span>
          {/if}
        </label>
        <label class="field">
          <span>Raumname (optional)</span>
          <input bind:value={createRoomName} maxlength="200" placeholder="Übernimmt sonst den Namen der Einheit" />
        </label>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn btn-ghost btn-sm" onclick={closeCreateDialog}>Abbrechen</button>
        <button type="button" class="btn btn-sm btn-primary" disabled={creating || !createUnitId} onclick={submitCreateRoom}>
          Erstellen
        </button>
      </div>
    </div>
  </div>
{/if}

{#if settingsRoomId}
  <div
    class="dialog-backdrop"
    role="button"
    tabindex="0"
    aria-label="Dialog schließen"
    onclick={closeSettings}
    onkeydown={(e) => handleBackdropKeydown(e, closeSettings)}
  >
    <div
      class="dialog"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Einstellungen"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (e.key === 'Escape') closeSettings() }}
    >
      <div class="dialog-head">
        <h3>Einstellungen</h3>
        <button class="dlg-close" onclick={closeSettings} aria-label="Schließen"><Icon name="x" size={16} /></button>
      </div>
      <div class="dialog-body">
        <label class="field">
          <span>Raumname</span>
          <input bind:value={settingsName} maxlength="200" />
        </label>
        {#if settingsLoading}
          <div class="field-hint mono">Raum-Zuordnung wird geladen…</div>
        {:else if settingsLoadError}
          <div class="field-hint settings-load-error mono">Raum-Zuordnung konnte nicht geladen werden</div>
        {/if}

        <div class="settings-actions">
          <button type="button" class="btn btn-sm btn-primary" disabled={settingsActionsDisabled || !settingsName.trim()} onclick={saveSettingsName}>
            Speichern
          </button>

          {#if settingsConfirm === 'archive'}
            <span class="confirm-text mono">Wirklich archivieren? Kann nicht rückgängig gemacht werden.</span>
            <button type="button" class="btn btn-sm btn-danger" disabled={settingsActionsDisabled} onclick={confirmArchive}>Bestätigen</button>
            <button type="button" class="btn btn-sm btn-ghost" onclick={() => (settingsConfirm = null)}>Abbrechen</button>
          {:else}
            <button type="button" class="btn btn-sm" disabled={settingsActionsDisabled} onclick={() => (settingsConfirm = 'archive')}>
              Archivieren
            </button>
          {/if}

          {#if isITAdmin}
            {#if settingsConfirm === 'delete'}
              <span class="confirm-text mono">Endgültig löschen? Kann nicht rückgängig gemacht werden.</span>
              <button type="button" class="btn btn-sm btn-danger" disabled={settingsActionsDisabled} onclick={confirmDelete}>Bestätigen</button>
              <button type="button" class="btn btn-sm btn-ghost" onclick={() => (settingsConfirm = null)}>Abbrechen</button>
            {:else}
              <button type="button" class="btn btn-sm btn-ghost" disabled={settingsActionsDisabled} onclick={() => (settingsConfirm = 'delete')}>
                Löschen
              </button>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Chat-shell (Task 3.2) — ported from the v5 prototype (screens-v4.jsx:19-126).
     Generic primitives (.btn, .mono, .eyebrow, .divider-label) come from app.css;
     bespoke classes below resolve to design tokens so .dark auto-switches. */
  .chat-shell {
    display: grid;
    grid-template-columns: 264px 1fr;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--surface);
  }

  .room-list {
    border-right: 1px solid var(--border);
    background: var(--surface-2);
    overflow-y: auto;
    min-height: 0;
  }
  .room-list-head {
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }
  .room-list-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .room-list-title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    flex: 1;
  }
  .sync-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--ink-muted);
  }
  .sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ink-faint);
  }
  .sync-dot.live {
    background: var(--pine);
  }
  .sync-dot.err {
    background: var(--rust);
  }
  .room-list-sub {
    font-size: 10.5px;
    color: var(--ink-muted);
    margin-top: 4px;
  }

  .room-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 10px 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
    color: inherit;
  }
  .room-item:hover {
    background: var(--surface);
  }
  .room-item.active {
    background: var(--accent-soft);
  }
  .room-item.archived {
    opacity: 0.75;
  }
  .archiv-section {
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .archiv-head {
    padding: 8px 14px 4px;
    font-size: 10.5px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ravatar {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: oklch(94% 0.04 var(--c-hue, 252));
    color: oklch(38% 0.11 var(--c-hue, 252));
  }
  :global(.dark) .ravatar {
    background: oklch(28% 0.06 var(--c-hue, 252));
    color: oklch(82% 0.10 var(--c-hue, 252));
  }
  .r-meta {
    flex: 1;
    min-width: 0;
  }
  .r-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .r-name {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--ink);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .r-time {
    font-size: 10px;
    color: var(--ink-faint);
    flex-shrink: 0;
  }
  .r-preview {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }
  .r-members {
    font-size: 10px;
    color: var(--ink-faint);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 100px;
    background: var(--accent);
    /* #343 R5: `--on-accent` already resolves to dark ink in dark mode, so the
       hand-rolled `:global(.dark)` override this replaced is now dead. */
    color: var(--on-accent);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
  }
  .room-empty {
    padding: 16px;
    font-size: 11.5px;
    color: var(--ink-muted);
  }

  .chat-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface);
  }
  .chat-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  .chat-head-text {
    flex: 1;
    min-width: 0;
  }
  .chat-head-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-head-sub {
    font-size: 11.5px;
    color: var(--ink-muted);
    margin-top: 2px;
  }
  .call-live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: var(--r-sm);
    background: var(--pine-soft);
    color: var(--pine-ink);
  }
  .call-live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--pine);
    animation: chat-pulse 1.6s infinite;
  }
  @keyframes chat-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .chat-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .mav {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--surface-2);
    color: var(--ink-muted);
  }
  .mbody {
    min-width: 0;
    flex: 1;
  }
  .mhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .mname {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mtime {
    font-size: 10px;
    color: var(--ink-faint);
    flex-shrink: 0;
  }
  .mtext {
    font-size: 13.5px;
    color: var(--ink-2);
    margin-top: 2px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .chat-empty,
  .chat-placeholder {
    color: var(--ink-muted);
    font-size: 12.5px;
  }
  .chat-placeholder {
    flex: 1;
    display: grid;
    place-items: center;
  }

  .chat-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .chat-input.archived-notice {
    color: var(--ink-muted);
    font-size: 12px;
    justify-content: center;
  }
  .chat-input input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--ink);
    padding: 8px 12px;
    font-size: 13.5px;
    font-family: inherit;
  }
  .chat-input input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* Row 15 dialogs (create room / settings) — same shape as PromoteDialog.svelte. */
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .dialog {
    background: var(--surface);
    color: var(--ink);
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    box-shadow: var(--sh-3);
    width: 100%;
    max-width: 480px;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .dialog-head {
    padding: 16px 20px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .dialog-head h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }
  .dialog-body {
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
  }
  .dialog-foot {
    padding: 12px 20px 16px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .field span {
    font-size: 11px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .field input,
  .field select {
    font: inherit;
    font-size: 13.5px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--ink);
  }
  .field-hint {
    font-size: 11px;
    color: var(--ink-muted);
  }
  .settings-load-error {
    color: var(--rust-ink, var(--rust));
  }
  .settings-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .confirm-text {
    font-size: 11.5px;
    color: var(--rust-ink, var(--rust));
  }
  .btn-danger {
    color: #fff;
    background: var(--rust);
    border-color: var(--rust);
  }
  .dlg-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink-muted);
    display: grid;
    place-items: center;
    padding: 4px;
    border-radius: var(--r-sm);
  }
  .dlg-close:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
</style>
