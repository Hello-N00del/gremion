<script lang="ts">
  // FLOW-MSG-001 (TASK-009 lane B, rows-plan.md row 14 / S2.6): the
  // "Verwaltung -> Räume" overview. One row per org unit; the room actions
  // per state come straight off the FLOW states table (rows-plan.md §1).
  import { page } from '$app/state'
  import { invalidateAll } from '$app/navigation'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { hasRole, Role, type SessionUser } from '$lib/auth'
  import { toast } from 'svelte-sonner'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  let user = $derived(page.data.session?.user as SessionUser | undefined)
  // R23-4: hard delete is ITAdmin-only (CouncilAdmin reaches create/rename/archive).
  let isITAdmin = $derived(user ? hasRole(user.roles, Role.ITAdmin) : false)

  let units = $derived(data.units)
  let activeUnits = $derived(units.filter((u) => u.state !== 'archiviert'))
  let archivedUnits = $derived(units.filter((u) => u.state === 'archiviert'))

  let busyUnitId = $state<string | null>(null)
  // A per-unit confirm step for the two undoable-never actions (archive, delete).
  let confirmUnitId = $state<string | null>(null)
  let confirmAction = $state<'archive' | 'delete' | null>(null)
  // MEDIUM (house review, TASK-009 fix round 2): rename used the browser's
  // native window.prompt() — inconsistent styling/theming with the rest of
  // the app, untestable via @testing-library (jsdom has no prompt()), and
  // not the affordance the sibling /messages Einstellungen panel already
  // built for this identical action. In-app inline edit instead, same
  // input + Speichern/Abbrechen shape as that panel.
  let renameUnitId = $state<string | null>(null)
  let renameValue = $state('')

  const STATE_LABEL: Record<string, string> = {
    leer: 'Noch kein Raum',
    wird_angelegt: 'Raum wird angelegt',
    fehler: 'Raum konnte nicht angelegt werden',
    aktiv: 'Aktiv',
    archiviert: 'Archiviert',
  }

  function requestConfirm(unitId: string, action: 'archive' | 'delete') {
    confirmUnitId = unitId
    confirmAction = action
  }
  function cancelConfirm() {
    confirmUnitId = null
    confirmAction = null
  }

  function startRename(unitId: string, currentName: string) {
    renameUnitId = unitId
    renameValue = currentName
  }
  function cancelRename() {
    renameUnitId = null
    renameValue = ''
  }

  async function createRoom(unitId: string) {
    busyUnitId = unitId
    try {
      const res = await fetch('/api/messages/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: unitId }),
      })
      if (!res.ok) {
        toast.error('Raum konnte nicht angelegt werden')
        return
      }
      await invalidateAll()
    } catch {
      toast.error('Raum konnte nicht angelegt werden')
    } finally {
      busyUnitId = null
    }
  }

  async function submitRename(unitId: string, roomId: string, currentName: string) {
    const name = renameValue.trim()
    if (!name || name === currentName) {
      cancelRename()
      return
    }
    busyUnitId = unitId
    try {
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(roomId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: unitId, name }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        console.error('[messages/manage] submitRename failed', { unitId, roomId, status: res.status, body })
        toast.error('Raum konnte nicht umbenannt werden')
        return
      }
      await invalidateAll()
    } catch (err) {
      console.error('[messages/manage] submitRename threw', { unitId, roomId, error: err instanceof Error ? err.message : String(err) })
      toast.error('Raum konnte nicht umbenannt werden')
    } finally {
      busyUnitId = null
      cancelRename()
    }
  }

  async function archiveRoom(unitId: string, roomId: string) {
    busyUnitId = unitId
    try {
      const res = await fetch(`/api/messages/rooms/${encodeURIComponent(roomId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgUnitId: unitId }),
      })
      if (!res.ok) {
        toast.error('Raum konnte nicht archiviert werden')
        return
      }
      await invalidateAll()
    } catch {
      toast.error('Raum konnte nicht archiviert werden')
    } finally {
      busyUnitId = null
      cancelConfirm()
    }
  }

  async function deleteRoom(unitId: string, roomId: string) {
    busyUnitId = unitId
    try {
      const res = await fetch(
        `/api/messages/rooms/${encodeURIComponent(roomId)}?orgUnitId=${encodeURIComponent(unitId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        toast.error('Raum konnte nicht gelöscht werden')
        return
      }
      await invalidateAll()
    } catch {
      toast.error('Raum konnte nicht gelöscht werden')
    } finally {
      busyUnitId = null
      cancelConfirm()
    }
  }
</script>

<PageTitle title="Räume" />

<div class="rooms-manage">
  {#if data.matrix === 'unreachable'}
    <!-- PRD-DEP-002: shown separate from ordinary Gremion errors — the rest
         of the page (and every admin action below) keeps working (PRD-DEP-004). -->
    <div class="matrix-banner" role="alert">
      <Icon name="alert-triangle" size={16} />
      Matrix-Dienst nicht erreichbar — Aktionen können fehlschlagen, werden aber automatisch nachgeholt.
    </div>
  {/if}

  <section class="rooms-section">
    <h2 class="section-title">Gremien &amp; Initiativen</h2>
    <div class="rooms-table">
      {#each activeUnits as unit (unit.unitId)}
        <div class="room-row">
          <div class="room-row-main">
            <span class="unit-name">{unit.unitName}</span>
            <span class="state-pill state-{unit.state}">{STATE_LABEL[unit.state] ?? unit.state}</span>
            {#if unit.state === 'fehler' && unit.lastError}
              <span class="last-error mono">{unit.lastError}</span>
            {/if}
          </div>
          <div class="room-row-actions">
            {#if unit.state === 'leer'}
              <button type="button" class="btn btn-sm" disabled={busyUnitId === unit.unitId} onclick={() => createRoom(unit.unitId)}>
                Raum anlegen
              </button>
            {:else if unit.state === 'fehler'}
              <button type="button" class="btn btn-sm" disabled={busyUnitId === unit.unitId} onclick={() => createRoom(unit.unitId)}>
                Erneut versuchen
              </button>
            {:else if unit.state === 'wird_angelegt'}
              <span class="mono ink-muted">wird angelegt…</span>
            {:else if unit.state === 'aktiv' && unit.roomId}
              {#if renameUnitId === unit.unitId}
                <input
                  class="rename-input"
                  bind:value={renameValue}
                  maxlength="200"
                  aria-label="Neuer Raumname"
                  onkeydown={(e) => {
                    if (e.key === 'Enter') submitRename(unit.unitId, unit.roomId!, unit.unitName)
                    if (e.key === 'Escape') cancelRename()
                  }}
                />
                <button type="button" class="btn btn-sm btn-primary" disabled={busyUnitId === unit.unitId || !renameValue.trim()} onclick={() => submitRename(unit.unitId, unit.roomId!, unit.unitName)}>
                  Speichern
                </button>
                <button type="button" class="btn btn-sm btn-ghost" onclick={cancelRename}>Abbrechen</button>
              {:else}
                <button type="button" class="btn btn-sm" disabled={busyUnitId === unit.unitId} onclick={() => startRename(unit.unitId, unit.unitName)}>
                  Umbenennen
                </button>
              {/if}
              {#if confirmUnitId === unit.unitId && confirmAction === 'archive'}
                <button type="button" class="btn btn-sm btn-danger" onclick={() => archiveRoom(unit.unitId, unit.roomId!)}>Bestätigen</button>
                <button type="button" class="btn btn-sm btn-ghost" onclick={cancelConfirm}>Abbrechen</button>
              {:else}
                <button type="button" class="btn btn-sm" disabled={busyUnitId === unit.unitId} onclick={() => requestConfirm(unit.unitId, 'archive')}>
                  Archivieren
                </button>
              {/if}
              {#if isITAdmin}
                {#if confirmUnitId === unit.unitId && confirmAction === 'delete'}
                  <button type="button" class="btn btn-sm btn-danger" onclick={() => deleteRoom(unit.unitId, unit.roomId!)}>Bestätigen</button>
                  <button type="button" class="btn btn-sm btn-ghost" onclick={cancelConfirm}>Abbrechen</button>
                {:else}
                  <button type="button" class="btn btn-sm btn-ghost" disabled={busyUnitId === unit.unitId} onclick={() => requestConfirm(unit.unitId, 'delete')}>
                    Löschen
                  </button>
                {/if}
              {/if}
            {/if}
          </div>
        </div>
      {:else}
        <div class="rooms-empty mono">Keine Gremien/Initiativen gefunden.</div>
      {/each}
    </div>
  </section>

  {#if archivedUnits.length > 0}
    <section class="rooms-section">
      <h2 class="section-title">Archiv</h2>
      <div class="rooms-table">
        {#each archivedUnits as unit (unit.unitId)}
          <div class="room-row">
            <div class="room-row-main">
              <span class="unit-name">{unit.unitName}</span>
              <span class="state-pill state-archiviert">Archiviert</span>
            </div>
            <div class="room-row-actions">
              {#if unit.roomId}
                <a class="btn btn-sm btn-ghost" href={`/messages?ou=${unit.unitId}`}>Verlauf lesen</a>
              {/if}
              {#if isITAdmin && unit.roomId}
                {#if confirmUnitId === unit.unitId && confirmAction === 'delete'}
                  <button type="button" class="btn btn-sm btn-danger" onclick={() => deleteRoom(unit.unitId, unit.roomId!)}>Bestätigen</button>
                  <button type="button" class="btn btn-sm btn-ghost" onclick={cancelConfirm}>Abbrechen</button>
                {:else}
                  <button type="button" class="btn btn-sm btn-ghost" disabled={busyUnitId === unit.unitId} onclick={() => requestConfirm(unit.unitId, 'delete')}>
                    Löschen
                  </button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .rooms-manage {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 920px;
  }
  .matrix-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--ember) 14%, var(--surface));
    color: var(--ember-ink);
    border: 1px solid color-mix(in srgb, var(--ember) 35%, transparent);
    font-size: 13px;
  }
  .rooms-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .section-title {
    font-size: 13px;
    font-weight: 600;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    margin: 0;
  }
  .rooms-table {
    display: flex;
    flex-direction: column;
  }
  .room-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .room-row:last-child { border-bottom: none; }
  .room-row-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .unit-name { font-size: 13.5px; font-weight: 500; color: var(--ink); }
  .state-pill {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border: 1px solid var(--border);
    color: var(--ink-muted);
  }
  .state-pill.state-aktiv {
    color: var(--pine-ink);
    background: color-mix(in srgb, var(--pine) 14%, var(--surface));
    border-color: color-mix(in srgb, var(--pine) 35%, transparent);
  }
  .state-pill.state-fehler {
    color: var(--rust-ink, var(--rust));
    background: color-mix(in srgb, var(--rust) 14%, var(--surface));
    border-color: color-mix(in srgb, var(--rust) 35%, transparent);
  }
  .state-pill.state-wird_angelegt,
  .state-pill.state-leer {
    color: var(--ink-muted);
  }
  .last-error { font-size: 11px; color: var(--rust-ink, var(--rust)); }
  .room-row-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .rename-input {
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--ink);
    min-width: 160px;
  }
  .rooms-empty { padding: 16px; color: var(--ink-muted); font-size: 12.5px; }
  .ink-muted { color: var(--ink-muted); }
  .btn-danger {
    color: #fff;
    background: var(--rust);
    border-color: var(--rust);
  }
  .mono { font-family: var(--font-mono); }
</style>
